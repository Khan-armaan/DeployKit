import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeployKitError } from "../src/errors.js";
import { Reporter, clearRedactedValues } from "../src/output.js";
import { run as runProcess } from "../src/process.js";
import {
  MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
  MANAGED_OWNERSHIP_PATH,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_WORKFLOW_PATH,
} from "../src/orchestrator/contracts.js";
import { runProductionDeployment } from "../src/orchestrator/production.js";
import { operationRecordPath } from "../src/orchestrator/operation-store.js";
import type { OrchestratorResult } from "../src/orchestrator/dependencies.js";
import {
  APPLICATION_REF,
  CANARY_BACKEND_SECRET,
  CANARY_GATEWAY_PRIVATE_KEY,
  HermeticGitHub,
  HermeticHost,
  HermeticKeyPairs,
  OPERATOR_LOGIN,
  createApplicationRepository,
  createRuntimeBundle,
  fingerprintOf,
} from "./helpers/hermetic-world.js";

/**
 * Phase 12: the full orchestrator, end to end, with only the two process
 * boundaries replaced.
 *
 * Every module between `runProductionDeployment` and `gh`/`ssh` is the real
 * one, so these tests prove the wiring rather than a rehearsal of it: the
 * canonical frames on the wire, the ownership checks, the digests, the
 * crash-safe key rotation, the readiness recheck, and the correlation of the
 * exact dispatched run.
 */

const REPOSITORY = "deploykit-fixtures/static-compose";
const ENVIRONMENT = "fixture-static-production";
const HOST = "vps.static.example.test";

class MemoryStream extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.text += String(chunk);
    done();
  }
}

interface Harness {
  readonly root: string;
  readonly applicationRoot: string;
  readonly stateRoot: string;
  readonly github: HermeticGitHub;
  readonly host: HermeticHost;
  readonly keyPairs: HermeticKeyPairs;
  readonly stdout: MemoryStream;
  readonly stderr: MemoryStream;
  readonly runtimeBundle: Awaited<ReturnType<typeof createRuntimeBundle>>;
  deploy(overrides?: Record<string, unknown>): Promise<OrchestratorResult>;
}

let temporaryRoots: string[] = [];

async function harness(
  options: {
    readonly autoMergeSetup?: boolean;
    readonly runConclusion?: string;
    readonly reviewers?: readonly string[];
  } = {},
): Promise<Harness> {
  // macOS resolves the temporary directory through a symlink; Git reports the
  // real path, and the config adapter compares the two.
  const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-hermetic-")));
  temporaryRoots.push(root);

  const applicationRoot = join(root, "app");
  const stateRoot = join(root, "state");
  await createApplicationRepository(applicationRoot, async (args) => {
    await runProcess("git", args, { cwd: root });
  });

  const runtimeBundle = await createRuntimeBundle(join(root, "bundle"));
  const github = new HermeticGitHub({
    repository: REPOSITORY,
    ...(options.autoMergeSetup === undefined ? {} : { autoMergeSetup: options.autoMergeSetup }),
    ...(options.runConclusion === undefined ? {} : { runConclusion: options.runConclusion }),
    ...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }),
  });
  const host = new HermeticHost({ host: HOST, repository: REPOSITORY });
  const keyPairs = new HermeticKeyPairs();
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  return {
    root,
    applicationRoot,
    stateRoot,
    github,
    host,
    keyPairs,
    stdout,
    stderr,
    runtimeBundle,
    deploy(overrides: Record<string, unknown> = {}): Promise<OrchestratorResult> {
      return runProductionDeployment({
        cwd: applicationRoot,
        githubRunner: github,
        administratorRunner: host,
        keyPairs,
        temporaryRoot: root,
        operationStateRoot: stateRoot,
        runtimeBundle,
        reporter: new Reporter("json", false, stdout, stderr),
        interactive: false,
        polling: { intervalMs: 0, correlationAttempts: 4, runAttempts: 8 },
        pollIntervalMs: 0,
        sleep: async () => undefined,
        ...overrides,
      });
    },
  };
}

/**
 * The pinned host key the fixture config names is derived from the host's own
 * synthetic key, so the preflight pin is a real comparison rather than a stub.
 */
beforeEach(() => {
  temporaryRoots = [];
});

afterEach(async () => {
  clearRedactedValues();
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

async function expectFailure(promise: Promise<unknown>, code: string): Promise<DeployKitError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(DeployKitError);
  const failure = error as DeployKitError;
  expect(failure.code).toBe(code);
  return failure;
}

/** Rewrites the fixture's pinned fingerprint to the one the host will present. */
async function pinHostKey(fixture: Harness): Promise<void> {
  const configPath = join(fixture.applicationRoot, "deploykit.config.yaml");
  const source = await readFile(configPath, "utf8");
  const pinned = source.replace(
    /hostKeyFingerprint: .*/u,
    `hostKeyFingerprint: ${fingerprintOf(fixture.host.hostKeyLine.split(" ").slice(1).join(" "))}`,
  );
  // Rewriting in place keeps the mode-0600 the production adapter demands.
  await writeFile(configPath, pinned);
}

/** The single local operation record this harness could have written. */
async function readOperationRecord(fixture: Harness): Promise<Record<string, unknown>> {
  const directory = join(fixture.stateRoot, "operations");
  const entries = await readdir(directory);
  expect(entries).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, entries[0] ?? ""), "utf8")) as Record<string, unknown>;
}

async function prepared(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const fixture = await harness(options);
  await pinHostKey(fixture);
  return fixture;
}

describe("full orchestrator: fresh deployment", () => {
  it("reaches a complete deployment from one config and one command", async () => {
    const fixture = await prepared();
    const result = await fixture.deploy();

    expect(result.outcome).toBe("succeeded");
    expect(result.repository).toBe(REPOSITORY);
    expect(result.targetName).toBe("production");
    expect(result.commitSha).toBe(fixture.github.applicationCommitSha);
    expect(result.httpsUrl).toBe("https://static.example.test/");
    expect(result.ports).toEqual([{ service: "api", address: "127.0.0.1", port: 41_101 }]);
    expect(result.healthy).toBe(true);
    expect(result.recovery).toBe("none");

    // The reviewed control artifacts are on the protected default branch.
    const main = fixture.github.branches.get("main");
    expect([...(main?.files.keys() ?? [])].sort()).toEqual(
      [MANAGED_OWNERSHIP_PATH, MANAGED_RUNTIME_MANIFEST_PATH, MANAGED_WORKFLOW_PATH].sort(),
    );
    expect(fixture.github.pulls).toHaveLength(1);
    expect(fixture.github.pulls[0]?.merged).toBe(true);

    // The VPS holds exactly one active gateway key and no pending one, and the
    // repository key GitHub registered is the read-only one the host proved.
    expect(fixture.host.activeKeys()).toHaveLength(1);
    expect(fixture.host.pendingKeys()).toHaveLength(0);
    expect(fixture.github.deployKeys).toHaveLength(1);
    expect(fixture.github.deployKeys[0]?.readOnly).toBe(true);
    expect(fixture.github.deployKeys[0]?.key).toBe(fixture.host.repositoryPublicKey);

    // The Environment carries public values plus the two managed secrets.
    const environment = fixture.github.environments.get(ENVIRONMENT);
    expect([...(environment?.secrets.keys() ?? [])].sort()).toEqual(
      ["CERTBOT_EMAIL", MANAGED_GATEWAY_PRIVATE_KEY_SECRET].sort(),
    );
    expect(environment?.variables.get("DEPLOYKIT_GATEWAY_HOST")).toBe(HOST);
    expect(environment?.variables.get("VITE_API_BASE_URL")).toBe("/api");
    expect(environment?.variables.get("DEPLOYKIT_GATEWAY_KEY_FINGERPRINT")).toBe(
      fingerprintOf(fixture.host.activeKeys()[0] === undefined
        ? ""
        : `${fixture.host.activeKeys()[0]?.type ?? ""} ${fixture.host.activeKeys()[0]?.key ?? ""}`),
    );

    // Exactly one run was dispatched, carrying only public correlation inputs.
    expect(fixture.github.runs).toHaveLength(1);
    expect(fixture.github.runs[0]?.inputs).toEqual({
      request_id: result.requestId,
      target: "production",
      commit_sha: fixture.github.applicationCommitSha,
      manifest_digest: result.manifestDigest?.value,
      resume: "false",
      dry_run: "false",
    });
    expect(fixture.github.runs[0]?.actor).toBe(OPERATOR_LOGIN);
    expect(result.workflowRunId).toBe(fixture.github.runs[0]?.id);
    // The run page is reported instead of raw workflow logs.
    expect(result.workflowRunUrl).toBe(
      `https://github.com/${REPOSITORY}/actions/runs/${String(fixture.github.runs[0]?.id)}`,
    );
  });

  it("writes a mode-0600 operation record outside the application repository", async () => {
    const fixture = await prepared();
    const result = await fixture.deploy();

    const record = await readOperationRecord(fixture);
    expect(record["status"]).toBe("completed");
    expect(record["requestId"]).toBe(result.requestId);

    // The file name is derived from identity alone, never from either value.
    const path = operationRecordPath(fixture.stateRoot, {
      repository: REPOSITORY,
      targetId: String(record["targetId"]),
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    // Nothing was written into the application tree beyond the config itself.
    const tracked = await runProcess("git", ["-C", fixture.applicationRoot, "status", "--porcelain"]);
    expect(tracked.stdout).not.toContain(".deploykit");
  });
});

describe("full orchestrator: dry run", () => {
  it("inspects every boundary and mutates neither GitHub nor the host", async () => {
    const fixture = await prepared();
    const result = await fixture.deploy({ dryRun: true });

    expect(result.outcome).toBe("dry-run");
    expect(result.commitSha).toBe(fixture.github.applicationCommitSha);

    expect(fixture.github.branches.get("main")?.files.size).toBe(0);
    expect(fixture.github.pulls).toEqual([]);
    expect(fixture.github.deployKeys).toEqual([]);
    expect(fixture.github.environments.size).toBe(0);
    expect(fixture.github.runs).toEqual([]);
    expect(fixture.host.binding).toBeNull();
    expect(fixture.host.keys).toEqual([]);
    expect(fixture.keyPairs.generated).toEqual([]);
    await expect(readdir(join(fixture.stateRoot, "operations"))).rejects.toThrow();

    // Reading is still real: the repository, the ref, and the host were probed.
    expect(fixture.github.endpoints().some((path) => path.startsWith(`repos/${REPOSITORY}/commits/`))).toBe(true);
    expect(fixture.host.arguments()).toContain("ssh-keyscan");
  });
});

describe("full orchestrator: no-wait", () => {
  it("dispatches, correlates the exact run, and stops without following it", async () => {
    const fixture = await prepared({ autoMergeSetup: false });
    // With review pending the run stops resumably instead of blocking.
    const pending = await expectFailure(
      fixture.deploy({ noWait: true }),
      "DK_SETUP_PR_REVIEW_REQUIRED",
    );
    expect(pending.exitCode).toBe(9);
    expect(fixture.github.pulls).toHaveLength(1);

    fixture.github.mergePullRequest(fixture.github.pulls[0]?.number ?? 0);
    const result = await fixture.deploy({ noWait: true });

    expect(result.outcome).toBe("dispatched");
    expect(result.workflowRunId).toBe(fixture.github.runs[0]?.id);
    expect(fixture.github.runs[0]?.status).toBe("queued");
    // Nothing followed the run, so no deployment inspection was performed.
    expect(result.healthy).toBeNull();
    expect(fixture.github.pulls).toHaveLength(1);
  });
});

describe("full orchestrator: interruption and recovery", () => {
  it("keeps one usable gateway key when the run dies between upload and activation", async () => {
    const fixture = await prepared();
    fixture.host.failAt = "key.activate";
    await expect(fixture.deploy()).rejects.toThrow(/interrupted/u);

    // The Environment already holds a private key, but the entry that would
    // accept it is still pending, so nothing was promoted and nothing ran.
    expect(fixture.host.activeKeys()).toHaveLength(0);
    expect(fixture.host.pendingKeys()).toHaveLength(1);
    expect(fixture.github.environments.get(ENVIRONMENT)?.secrets.has(MANAGED_GATEWAY_PRIVATE_KEY_SECRET)).toBe(true);
    expect(fixture.github.runs).toEqual([]);

    const result = await fixture.deploy();
    expect(result.outcome).toBe("succeeded");
    expect(fixture.host.activeKeys()).toHaveLength(1);
    expect(fixture.host.pendingKeys()).toHaveLength(0);
    // Recovery is a fresh rotation, never an assumption about the stored secret.
    expect(fixture.keyPairs.generated).toHaveLength(2);
    expect(fixture.host.activeKeys()[0]?.keyId).toBe(fixture.keyPairs.generated[1]);
  });

  it("reconciles the same control artifacts, deploy key, and binding exactly once", async () => {
    const fixture = await prepared();
    // Dies after the reviewed artifacts merged but before the repository key
    // was registered — the point at which a naive rerun would open a second
    // setup pull request.
    fixture.github.failAt = "deployKey.create";
    await expect(fixture.deploy()).rejects.toThrow(/interrupted/u);
    expect(fixture.github.pulls).toHaveLength(1);
    expect(fixture.github.branches.get("main")?.files.size).toBe(3);

    const bindingId = fixture.host.binding?.bindingId;
    const result = await fixture.deploy();

    expect(result.outcome).toBe("succeeded");
    expect(fixture.github.pulls).toHaveLength(1);
    expect(fixture.github.deployKeys).toHaveLength(1);
    expect(fixture.github.branches.get("main")?.files.size).toBe(3);
    expect(fixture.github.runs).toHaveLength(1);
    // The binding is identical, so the installer reconciles rather than rebinds.
    expect(fixture.host.binding?.bindingId).toBe(bindingId);
    expect(fixture.host.activeKeys()).toHaveLength(1);
  });
});

describe("full orchestrator: failure and retry", () => {
  it("reports a failed workflow run and resumes the same identity on rerun", async () => {
    const fixture = await prepared({ runConclusion: "failure" });
    const failure = await expectFailure(fixture.deploy(), "DK_WORKFLOW_RUN_FAILED");
    expect(failure.exitCode).toBe(1);

    const record = (await readOperationRecord(fixture)) as unknown as {
      status: string;
      commitSha: string;
      lastFailure: { code: string };
    };
    expect(record.status).toBe("failed");
    expect(record.lastFailure.code).toBe("DK_WORKFLOW_RUN_FAILED");

    // The same SHA and digest retry as a new request rather than re-reading the
    // old failure forever.
    fixture.github.runConclusion = "success";
    const result = await fixture.deploy();
    expect(result.outcome).toBe("succeeded");
    expect(result.commitSha).toBe(record.commitSha);
    expect(fixture.github.runs).toHaveLength(2);
    expect(fixture.github.runs[1]?.inputs["resume"]).toBe("true");
    expect(fixture.github.runs[1]?.inputs["commit_sha"]).toBe(record.commitSha);
  });

  it("refuses to dispatch when the frozen ref moved during preparation", async () => {
    const fixture = await prepared();
    const original = fixture.github.applicationCommitSha;
    // The application branch advances while the Environment is being
    // reconciled — after the commit was frozen, before the readiness recheck.
    fixture.github.beforeGate = (label) => {
      if (label !== `environment.create:${ENVIRONMENT}`) return;
      const branch = fixture.github.branches.get(APPLICATION_REF);
      if (branch !== undefined) branch.commitSha = ("f".repeat(39) + "e") as typeof branch.commitSha;
    };

    const moved = await expectFailure(fixture.deploy(), "DK_REF_MOVED");
    expect(moved.exitCode).toBe(1);
    expect(fixture.github.applicationCommitSha).not.toBe(original);
    // Nothing was dispatched, because a readiness fact could not be reverified.
    expect(fixture.github.runs).toEqual([]);
  });
});

describe("full orchestrator: secret canaries", () => {
  it("keeps operator and gateway secrets out of every channel but Environment stdin", async () => {
    // The canaries are carried through a failed run and its retry as well as a
    // clean one, so the failure and resume paths are scanned too.
    const fixture = await prepared({ runConclusion: "failure" });
    await expectFailure(fixture.deploy(), "DK_WORKFLOW_RUN_FAILED");
    fixture.github.runConclusion = "success";
    const result = await fixture.deploy();
    expect(result.outcome).toBe("succeeded");

    const canaries = [CANARY_BACKEND_SECRET, CANARY_GATEWAY_PRIVATE_KEY];

    // Process arguments, on both boundaries.
    for (const canary of canaries) {
      expect(fixture.github.arguments().join(" ")).not.toContain(canary);
      expect(fixture.host.arguments().join(" ")).not.toContain(canary);
    }

    // Committed control artifacts and the dispatch payload.
    for (const contents of fixture.github.branches.get("main")?.files.values() ?? []) {
      for (const canary of canaries) expect(contents).not.toContain(canary);
    }
    for (const canary of canaries) {
      expect(JSON.stringify(fixture.github.runs)).not.toContain(canary);
      expect(JSON.stringify([...(fixture.github.environments.get(ENVIRONMENT)?.variables ?? [])]))
        .not.toContain(canary);
    }

    // Durable local state and operator-facing output.
    const operations = join(fixture.stateRoot, "operations");
    for (const entry of await readdir(operations)) {
      const contents = await readFile(join(operations, entry), "utf8");
      for (const canary of canaries) expect(contents).not.toContain(canary);
    }
    for (const canary of canaries) {
      expect(fixture.stdout.text).not.toContain(canary);
      expect(fixture.stderr.text).not.toContain(canary);
    }

    // The operator saw a bounded result envelope for both attempts — the
    // failure with its recovery action and the success with its run URL —
    // rather than any raw workflow output.
    expect(fixture.stdout.text).toContain('"outcome":"failed"');
    expect(fixture.stdout.text).toContain('"recovery":"rerun-same-command"');
    expect(fixture.stdout.text).toContain(result.workflowRunUrl ?? "");

    // The one approved channel really did carry them.
    const secrets = fixture.github.environments.get(ENVIRONMENT)?.secrets;
    expect(secrets?.get("CERTBOT_EMAIL")).toBe(CANARY_BACKEND_SECRET);
    expect(secrets?.get(MANAGED_GATEWAY_PRIVATE_KEY_SECRET)).toContain(CANARY_GATEWAY_PRIVATE_KEY);

    // And the local private key did not outlive the invocation.
    const leftovers = (await readdir(fixture.root)).filter((entry) =>
      entry.startsWith("deploykit-gateway-key-"),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("full orchestrator: phase boundary", () => {
  it("keeps the production orchestrator out of the package API and the CLI", async () => {
    const index = await readFile("src/index.ts", "utf8");
    const cli = await readFile("src/cli.ts", "utf8");
    for (const source of [index, cli]) {
      expect(source).not.toContain("orchestrator/production");
      expect(source).not.toContain("orchestrator/github-port");
      expect(source).not.toContain("orchestrator/gateway-transport");
      expect(source).not.toContain("orchestrator/operation-store");
      expect(source).not.toContain("runProductionDeployment");
    }
    // Bare `deploykit deploy` still stops after compiling; Phase 13 owns the
    // cutover, and `test/cli.test.ts` pins the DK_UNSUPPORTED result.
    expect(cli).toContain("DK_UNSUPPORTED");
  });
});
