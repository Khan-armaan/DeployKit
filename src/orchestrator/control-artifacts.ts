import { Buffer } from "node:buffer";

import { computeManifestDigest } from "./canonical.js";
import {
  MANAGED_SETUP_PULL_REQUEST_TITLE_PREFIX,
  type GitCommitSha,
  type GitHubManagedResourceNames,
  type Sha256Hex,
} from "./contracts.js";
import type {
  ControlArtifactsState,
  DesiredControlArtifacts,
  ManagedArtifact,
} from "./dependencies.js";
import { orchestratorError } from "./failures.js";
import type { GitHubClient, GitHubFileContents, GitHubPullRequest } from "./github.js";
import {
  MANAGED_FILE_PATHS,
  parseOwnershipMarker,
  resolveSetupPullRequestOwnership,
  type OwnershipExpectation,
} from "./github-ownership.js";

/**
 * Phase 10 puts the deployment control code where a human can review it before
 * a single secret is synchronized or a single workflow is dispatched.
 *
 * Three files are managed, and only three: the workflow, the secret-free
 * runtime manifest, and the ownership marker that says the other two are
 * DeployKit's. They are placed on a deterministic setup branch, offered as one
 * pull request, and then verified — byte for byte — on the protected default
 * branch. DeployKit does not merge, approve, or bypass anything; if the branch
 * is protected, the operator is the one who merges.
 *
 * The comparisons are exact, never heuristic. "Already reconciled" means the
 * bytes on the default branch equal the bytes the compiler produced, not that a
 * digest recorded in some marker happens to agree with itself. That is why a
 * rerun that changes nothing opens no second pull request, and why a file
 * edited after the merge is reported as drift rather than silently accepted.
 *
 * Ownership refusals are raised rather than returned. `ControlArtifactsState`
 * has one `conflict` status and no room for a reason, and "somebody else's file
 * sits at `.github/workflows/deploykit.yml`" is exactly the situation where the
 * operator needs to be told which resource and why. Drift, which a rerun fixes
 * by itself, stays a status.
 *
 * Nothing here touches Environment secrets or dispatches a workflow. Phase 11
 * and Phase 12 own those, and this module deliberately gives them no way in.
 */

const MANAGED_PATH_SET: ReadonlySet<string> = new Set(MANAGED_FILE_PATHS);

export const CONTROL_ARTIFACT_DEFAULTS = Object.freeze({
  pollIntervalMs: 15_000,
  /** Two hours: long enough for a human review, short enough to end a CI job. */
  maxWaitMs: 2 * 60 * 60 * 1000,
});

export interface ControlArtifactsOptions {
  readonly client: GitHubClient;
  /**
   * Block until the setup pull request is merged. `--no-wait` sets this false
   * and the run stops resumably at `DK_SETUP_PR_REVIEW_REQUIRED` instead.
   */
  readonly waitForMerge?: boolean;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface ControlArtifactsReconciler {
  inspect(desired: DesiredControlArtifacts): Promise<ControlArtifactsState>;
  reconcile(desired: DesiredControlArtifacts): Promise<ControlArtifactsState>;
}

function conflict(message: string, details: Record<string, unknown> = {}): Error {
  return orchestratorError("DK_OWNERSHIP_CONFLICT", message, { details });
}

function expectationFor(desired: DesiredControlArtifacts): OwnershipExpectation {
  return {
    repository: desired.ownership.repository,
    targetName: desired.ownership.targetName,
    targetId: desired.ownership.targetId,
    githubEnvironment: desired.ownership.githubEnvironment,
  };
}

function artifactAt(desired: DesiredControlArtifacts, path: string): ManagedArtifact {
  const artifact = desired.artifacts.find((entry) => entry.path === path);
  if (artifact === undefined) {
    throw orchestratorError(
      "DK_CONTROL_ARTIFACTS_DRIFTED",
      `The desired control artifacts do not include ${path}`,
      { details: { path } },
    );
  }
  return artifact;
}

/** The three managed artifacts in their frozen order, keyed by path. */
function managedArtifacts(desired: DesiredControlArtifacts): readonly ManagedArtifact[] {
  return [
    artifactAt(desired, desired.names.workflowPath),
    artifactAt(desired, desired.names.runtimeManifestPath),
    artifactAt(desired, desired.names.ownershipPath),
  ];
}

function pullRequestTitle(names: GitHubManagedResourceNames): string {
  const title = names.setupPullRequestTitle;
  if (!title.startsWith(MANAGED_SETUP_PULL_REQUEST_TITLE_PREFIX)) {
    throw conflict("The managed setup pull request title is not a DeployKit title");
  }
  return title;
}

function pullRequestBody(desired: DesiredControlArtifacts): string {
  return [
    `DeployKit prepared the deployment control artifacts for target \`${desired.ownership.targetName}\`.`,
    "",
    "This pull request adds only these files:",
    ...managedArtifacts(desired).map((artifact) => `- \`${artifact.path}\``),
    "",
    "They carry no secret values: the runtime manifest lists secret *names* only,",
    "and the workflow reads every value from the target GitHub Environment at run time.",
    "",
    "Review the workflow carefully — it runs with the Environment's secrets attached.",
    "DeployKit resumes once this pull request is merged into the protected default branch.",
  ].join("\n");
}

interface BranchSnapshot {
  readonly commitSha: GitCommitSha;
  readonly files: ReadonlyMap<string, GitHubFileContents>;
}

export function createControlArtifactsReconciler(
  options: ControlArtifactsOptions,
): ControlArtifactsReconciler {
  const client = options.client;
  const waitForMerge = options.waitForMerge ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? CONTROL_ARTIFACT_DEFAULTS.pollIntervalMs;
  const maxWaitMs = options.maxWaitMs ?? CONTROL_ARTIFACT_DEFAULTS.maxWaitMs;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((done) => {
      setTimeout(done, milliseconds);
    }));

  async function readBranch(
    desired: DesiredControlArtifacts,
    branch: string,
  ): Promise<BranchSnapshot | undefined> {
    const head = await client.getBranch(desired.repository, branch);
    if (head === undefined) return undefined;
    const files = new Map<string, GitHubFileContents>();
    for (const path of MANAGED_FILE_PATHS) {
      const contents = await client.readFile(desired.repository, path, branch);
      if (contents !== undefined) files.set(path, contents);
    }
    return { commitSha: head.commitSha, files };
  }

  /**
   * Proves the files on `branch` are DeployKit's before anything is compared to
   * them. A managed path occupied without our marker beside it belongs to the
   * operator, and the marker itself must name this deployment.
   */
  function assertOwned(desired: DesiredControlArtifacts, snapshot: BranchSnapshot, branch: string): void {
    const occupied = [...snapshot.files.keys()];
    if (occupied.length === 0) return;
    const marker = snapshot.files.get(desired.names.ownershipPath);
    if (marker === undefined) {
      throw conflict(
        `${desired.repository} carries DeployKit-managed paths on ${branch} without a DeployKit ownership marker`,
        { branch, paths: occupied.filter((path) => path !== desired.names.ownershipPath) },
      );
    }
    // Raises the ownership conflict for a foreign or another target's marker;
    // digest comparisons are deliberately left to the caller so a stale digest
    // reads as drift instead of a conflict.
    parseOwnershipMarker(marker.contents, expectationFor(desired));
  }

  function stateFrom(
    desired: DesiredControlArtifacts,
    snapshot: BranchSnapshot,
    pullRequest: { readonly number: number | null; readonly state: ControlArtifactsState["setupPullRequestState"] },
  ): ControlArtifactsState {
    const workflow = snapshot.files.get(desired.names.workflowPath);
    const manifest = snapshot.files.get(desired.names.runtimeManifestPath);
    const ownership = snapshot.files.get(desired.names.ownershipPath);
    const matches = managedArtifacts(desired).every(
      (artifact) => snapshot.files.get(artifact.path)?.contents === artifact.contents,
    );
    const status: ControlArtifactsState["status"] = matches
      ? "current"
      : snapshot.files.size === 0
        ? pullRequest.number === null ? "missing" : "setup-pull-request"
        : "drifted";
    return {
      status,
      defaultBranchCommitSha: snapshot.commitSha,
      setupPullRequestNumber: pullRequest.number,
      setupPullRequestState: pullRequest.state,
      workflowDigest: workflow === undefined ? null : digestOf(workflow.contents),
      runtimeManifestDigest:
        manifest === undefined ? null : computeManifestDigest(Buffer.from(manifest.contents, "utf8")),
      ownershipDigest: ownership === undefined ? null : digestOf(ownership.contents),
    };
  }

  async function findSetupPullRequest(
    desired: DesiredControlArtifacts,
  ): Promise<GitHubPullRequest | null> {
    const candidates = await client.listPullRequests(desired.repository, {
      headRef: desired.names.setupBranch,
      state: "all",
    });
    const ownership = resolveSetupPullRequestOwnership(candidates, desired.names);
    if (ownership.status === "conflict") {
      throw conflict(
        `The DeployKit setup branch in ${desired.repository} already carries a pull request DeployKit does not own`,
        { branch: desired.names.setupBranch, reason: ownership.reason },
      );
    }
    const pullRequest = ownership.pullRequest;
    if (pullRequest === null) return null;
    if (pullRequest.baseRef !== desired.defaultBranch) {
      throw conflict(
        `The DeployKit setup pull request in ${desired.repository} no longer targets ${desired.defaultBranch}`,
        { pullRequest: pullRequest.number, baseRef: pullRequest.baseRef },
      );
    }
    return pullRequest;
  }

  function pullRequestFacts(
    pullRequest: GitHubPullRequest | null,
  ): { readonly number: number | null; readonly state: ControlArtifactsState["setupPullRequestState"] } {
    if (pullRequest === null) return { number: null, state: null };
    return {
      number: pullRequest.number,
      state: pullRequest.merged ? "merged" : pullRequest.state === "open" ? "open" : "closed",
    };
  }

  /** Refuses a setup branch carrying anything but the three managed files. */
  async function assertOnlyManagedChanges(desired: DesiredControlArtifacts): Promise<void> {
    const comparison = await client.compareCommits(
      desired.repository,
      desired.defaultBranch,
      desired.names.setupBranch,
    );
    if (comparison === undefined) return;
    if (comparison.truncated) {
      throw conflict(
        `The DeployKit setup branch in ${desired.repository} changes more files than DeployKit can verify`,
        { branch: desired.names.setupBranch },
      );
    }
    const unrelated = comparison.files.filter((path) => !MANAGED_PATH_SET.has(path));
    if (unrelated.length > 0) {
      throw conflict(
        `The DeployKit setup branch in ${desired.repository} carries changes outside the DeployKit-managed files`,
        { branch: desired.names.setupBranch, paths: unrelated },
      );
    }
  }

  async function ensureSetupBranch(
    desired: DesiredControlArtifacts,
    defaultBranchSha: GitCommitSha,
  ): Promise<void> {
    const existing = await client.getBranch(desired.repository, desired.names.setupBranch);
    if (existing === undefined) {
      await client.createBranch(desired.repository, desired.names.setupBranch, defaultBranchSha);
      return;
    }
    await assertOnlyManagedChanges(desired);
  }

  /** Writes only the artifacts whose bytes on the setup branch already differ. */
  async function writeArtifacts(desired: DesiredControlArtifacts): Promise<void> {
    for (const artifact of managedArtifacts(desired)) {
      const existing = await client.readFile(
        desired.repository,
        artifact.path,
        desired.names.setupBranch,
      );
      if (existing !== undefined && existing.contents === artifact.contents) continue;
      await client.writeFile({
        repository: desired.repository,
        path: artifact.path,
        branch: desired.names.setupBranch,
        message: `DeployKit setup: ${artifact.path}`,
        contents: artifact.contents,
        ...(existing === undefined ? {} : { expectedBlobSha: existing.blobSha }),
      });
    }
  }

  async function awaitMerge(
    desired: DesiredControlArtifacts,
    pullRequest: GitHubPullRequest,
  ): Promise<GitHubPullRequest> {
    const deadline = now() + maxWaitMs;
    let latest = pullRequest;
    while (!latest.merged && latest.state === "open" && now() < deadline) {
      await sleep(pollIntervalMs);
      const refreshed = await client.getPullRequest(desired.repository, latest.number);
      // A pull request that disappeared cannot be waited on; the next run
      // re-reads authoritative state and opens a fresh one.
      if (refreshed === undefined) return latest;
      latest = refreshed;
    }
    return latest;
  }

  async function inspect(desired: DesiredControlArtifacts): Promise<ControlArtifactsState> {
    const snapshot = await readBranch(desired, desired.defaultBranch);
    if (snapshot === undefined) {
      throw orchestratorError(
        "DK_GITHUB_API_FAILED",
        `${desired.repository} does not have a branch named ${desired.defaultBranch}`,
        { details: { repository: desired.repository, defaultBranch: desired.defaultBranch } },
      );
    }
    assertOwned(desired, snapshot, desired.defaultBranch);
    const facts = pullRequestFacts(await findSetupPullRequest(desired));
    return stateFrom(desired, snapshot, facts);
  }

  async function reconcile(desired: DesiredControlArtifacts): Promise<ControlArtifactsState> {
    const initial = await inspect(desired);
    if (initial.status === "current") return initial;

    await ensureSetupBranch(desired, initial.defaultBranchCommitSha);
    await writeArtifacts(desired);
    // The post-condition matters as much as the pre-condition: a branch that
    // grew an unrelated commit between the check and the writes must not be
    // offered for review as if it held only DeployKit's files.
    await assertOnlyManagedChanges(desired);

    let pullRequest = await findSetupPullRequest(desired);
    if (pullRequest === null || pullRequest.state === "closed") {
      pullRequest = await client.createPullRequest({
        repository: desired.repository,
        headRef: desired.names.setupBranch,
        baseRef: desired.defaultBranch,
        title: pullRequestTitle(desired.names),
        body: pullRequestBody(desired),
      });
    }

    // DeployKit never merges, approves, or bypasses protection for the
    // operator: it only waits for the review to finish.
    if (waitForMerge) pullRequest = await awaitMerge(desired, pullRequest);

    const snapshot = await readBranch(desired, desired.defaultBranch);
    if (snapshot === undefined) {
      throw orchestratorError(
        "DK_GITHUB_API_FAILED",
        `${desired.repository} does not have a branch named ${desired.defaultBranch}`,
        { details: { repository: desired.repository, defaultBranch: desired.defaultBranch } },
      );
    }
    assertOwned(desired, snapshot, desired.defaultBranch);
    const facts = pullRequestFacts(pullRequest);
    const verified = stateFrom(desired, snapshot, facts);
    if (verified.status === "current") return verified;
    // Merged, yet the default branch still does not carry the reviewed bytes:
    // that is drift a rerun reconciles, not a review still pending.
    if (facts.state === "merged") return { ...verified, status: "drifted" };
    return { ...verified, status: "setup-pull-request" };
  }

  return { inspect, reconcile };
}

function digestOf(contents: string): Sha256Hex {
  return computeManifestDigest(Buffer.from(contents, "utf8")).value;
}
