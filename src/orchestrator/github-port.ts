import { GIT_COMMIT_SHA_PATTERN, REQUEST_ID_PATTERN, type RequestId } from "./contracts.js";
import { createControlArtifactsReconciler } from "./control-artifacts.js";
import type {
  ControlArtifactsState,
  DesiredControlArtifacts,
  DesiredGitHubEnvironment,
  DesiredRepositoryDeployKey,
  GitHubEnvironmentState,
  GitHubPort,
  GitHubRepositoryFacts,
  GitHubResolvedCommit,
  RepositoryDeployKeyState,
  WorkflowDispatchReceipt,
  WorkflowDispatchRequest,
  WorkflowRunIdentity,
  WorkflowRunState,
} from "./dependencies.js";
import { orchestratorError } from "./failures.js";
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubWorkflowRun,
  type GitHubWorkflowRunConclusion,
  type GitHubWorkflowRunStatus,
} from "./github.js";
import {
  createEnvironmentReconciler,
  createRepositoryDeployKeyReconciler,
} from "./github-environment.js";

/**
 * Phase 12: the production `GitHubPort`.
 *
 * Everything below already existed — the bounded `gh` client from Phase 9 and
 * the three reconcilers from Phases 10 and 11. This module is the seam that
 * lets the state machine reach them through one injected object, plus the two
 * operations no earlier phase owned: dispatching the reviewed workflow and
 * correlating the run it produced.
 *
 * Correlation is the part that needs care, because GitHub does not report a
 * workflow run's `workflow_dispatch` inputs. What it does report is the run's
 * name, and the managed workflow's `run-name` is
 * `DeployKit <target> <request uuid>` — so the request UUID DeployKit chose is
 * readable off the run itself. That is the only correlation key that is
 * genuinely observable, and the adapter refuses to invent a second one: a run
 * whose name is not that exact shape is not correlated at all.
 *
 * A rerun that has lost its local record would otherwise generate a new UUID
 * and dispatch a duplicate. It cannot, because an *active* run of the same
 * workflow for the same target is adopted instead of dispatched over. That is
 * strictly safer than dispatching: the workflow's concurrency group is keyed by
 * target id, so a second dispatch would have queued behind the first anyway,
 * and the caller re-verifies the adopted run's identity before following it.
 * A run that already finished without success is never adopted, so a genuine
 * retry still dispatches.
 */

/** How many recent runs of the managed workflow are searched for a match. */
const DEFAULT_MAX_RUNS = 100;

const RUN_NAME_PATTERN = /^DeployKit (?<target>.+) (?<requestId>[0-9a-fA-F-]{36})$/u;

export interface GitHubPortOptions {
  readonly client?: GitHubClient;
  /**
   * Block until the setup pull request merges. `--no-wait` sets this false and
   * the run stops resumably at `DK_SETUP_PR_REVIEW_REQUIRED` instead.
   */
  readonly waitForMerge?: boolean;
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly maxRuns?: number;
}

/** Parsed identity of a managed run, or `undefined` when it is somebody else's. */
export function readRunIdentity(
  repository: string,
  run: GitHubWorkflowRun,
): WorkflowRunIdentity | undefined {
  const match = RUN_NAME_PATTERN.exec(run.name) ?? RUN_NAME_PATTERN.exec(run.displayTitle);
  const requestId = match?.groups?.requestId;
  const targetName = match?.groups?.target;
  if (requestId === undefined || targetName === undefined) return undefined;
  if (!REQUEST_ID_PATTERN.test(requestId)) return undefined;
  if (run.event !== "workflow_dispatch") return undefined;
  if (!GIT_COMMIT_SHA_PATTERN.test(run.headSha)) return undefined;
  return {
    id: run.id,
    repository,
    url: run.url,
    workflowPath: run.path,
    event: "workflow_dispatch",
    workflowRef: run.headBranch,
    workflowSha: run.headSha,
    actor: run.actorLogin,
    requestId: requestId as RequestId,
    targetName,
  };
}

/**
 * GitHub reports six statuses and nine conclusions; the port declares four and
 * five. The mapping is deliberately lossy in one direction only: every status
 * that is not yet final becomes a waiting state, and every conclusion that is
 * not `success` and not a distinguished pause becomes `failure`, because
 * "finished without success" is what the caller acts on.
 */
export function normalizeRunStatus(status: GitHubWorkflowRunStatus): WorkflowRunState["status"] {
  if (status === "completed") return "completed";
  if (status === "waiting") return "waiting";
  if (status === "in_progress") return "in_progress";
  return "queued";
}

export function normalizeRunConclusion(
  conclusion: GitHubWorkflowRunConclusion | null,
): WorkflowRunState["conclusion"] {
  if (conclusion === null) return null;
  if (
    conclusion === "success" ||
    conclusion === "failure" ||
    conclusion === "cancelled" ||
    conclusion === "timed_out" ||
    conclusion === "action_required"
  ) {
    return conclusion;
  }
  return "failure";
}

function runState(repository: string, run: GitHubWorkflowRun): WorkflowRunState | undefined {
  const identity = readRunIdentity(repository, run);
  if (identity === undefined) return undefined;
  return {
    ...identity,
    status: normalizeRunStatus(run.status),
    conclusion: normalizeRunConclusion(run.conclusion),
  };
}

/** A run that has not finished, or that finished successfully, may be followed. */
function usable(run: WorkflowRunState): boolean {
  return !(run.status === "completed" && run.conclusion !== "success");
}

function active(run: WorkflowRunState): boolean {
  return run.status !== "completed";
}

export function createGitHubPort(options: GitHubPortOptions = {}): GitHubPort {
  const client = options.client ?? createGitHubClient();
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const controlArtifacts = createControlArtifactsReconciler({
    client,
    ...(options.waitForMerge === undefined ? {} : { waitForMerge: options.waitForMerge }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const deployKeys = createRepositoryDeployKeyReconciler({ client });
  const environment = createEnvironmentReconciler({ client });

  async function candidates(request: WorkflowDispatchRequest): Promise<readonly WorkflowRunState[]> {
    const runs = await client.listWorkflowRuns({
      repository: request.repository,
      workflowPath: request.workflowPath,
      event: "workflow_dispatch",
      branch: request.workflowRef,
      maxRuns,
    });
    return runs
      .map((run) => runState(request.repository, run))
      .filter((run): run is WorkflowRunState => run !== undefined)
      .filter((run) => run.workflowPath === request.workflowPath && run.targetName === request.targetName);
  }

  return {
    async inspectRepository(repository: string): Promise<GitHubRepositoryFacts> {
      return client.getRepositoryFacts(repository);
    },

    async resolveCommit(repository: string, ref: string): Promise<GitHubResolvedCommit> {
      return client.resolveCommit(repository, ref);
    },

    async inspectControlArtifacts(desired: DesiredControlArtifacts): Promise<ControlArtifactsState> {
      return controlArtifacts.inspect(desired);
    },

    async reconcileControlArtifacts(desired: DesiredControlArtifacts): Promise<ControlArtifactsState> {
      return controlArtifacts.reconcile(desired);
    },

    async inspectRepositoryDeployKey(
      desired: DesiredRepositoryDeployKey,
    ): Promise<RepositoryDeployKeyState> {
      return deployKeys.inspect(desired);
    },

    async reconcileRepositoryDeployKey(
      desired: DesiredRepositoryDeployKey,
    ): Promise<RepositoryDeployKeyState> {
      return deployKeys.reconcile(desired);
    },

    async inspectEnvironment(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState> {
      return environment.inspect(desired);
    },

    async reconcileEnvironment(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState> {
      return environment.reconcile(desired);
    },

    async dispatchWorkflow(request: WorkflowDispatchRequest): Promise<WorkflowDispatchReceipt> {
      // Only these five values cross to the runner, and every one of them is
      // public: a UUID, a target name, a commit SHA, a manifest digest, and two
      // booleans. Secret values reach the workflow through the Environment.
      await client.dispatchWorkflow({
        repository: request.repository,
        workflowPath: request.workflowPath,
        workflowRef: request.workflowRef,
        inputs: {
          request_id: request.requestId,
          target: request.targetName,
          commit_sha: request.commitSha,
          manifest_digest: request.manifestDigest.value,
          resume: request.resume ? "true" : "false",
          dry_run: request.dryRun ? "true" : "false",
        },
      });
      return { requestId: request.requestId, acceptedAt: new Date().toISOString() };
    },

    async findWorkflowRun(request: WorkflowDispatchRequest): Promise<WorkflowRunState | undefined> {
      const runs = await candidates(request);
      const byRequest = runs.find((run) => run.requestId === request.requestId && usable(run));
      if (byRequest !== undefined) return byRequest;
      // No request UUID matched, so this run's record is gone or this is a
      // fresh UUID. An in-flight run for the same target is adopted rather than
      // raced: dispatching beside it would only queue a duplicate behind it.
      return runs.find((run) => active(run));
    },

    async inspectWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunState> {
      const run = await client.getWorkflowRun(identity.repository, identity.id);
      if (run !== undefined) {
        const state = runState(identity.repository, run);
        if (state !== undefined) return state;
      }
      throw orchestratorError(
        "DK_WORKFLOW_RUN_NOT_FOUND",
        `Workflow run ${String(identity.id)} could not be read back from GitHub`,
        { details: { run: identity.url } },
      );
    },
  };
}
