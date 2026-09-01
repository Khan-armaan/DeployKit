import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeployKitError } from "../src/errors.js";
import { clearRedactedValues, redact } from "../src/output.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { compileRuntimeManifest, makeOrchestratorTargetId } from "../src/orchestrator/compile.js";
import { parseOperatorConfig } from "../src/orchestrator/config-schema.js";
import {
  createDesiredStatePlanner,
  gatewayBindingIdentityDigest,
  makeManagedResourceNames,
  type DeploymentContext,
} from "../src/orchestrator/planner.js";
import { runDeployment, parseOperationRecord } from "../src/orchestrator/deploy.js";
import { OPERATION_RECORD_API_VERSION } from "../src/orchestrator/contracts.js";
import {
  BACKEND_SECRET_CANARY,
  FIXTURE_COMMIT_SHA,
  FIXTURE_MOVED_SHA,
  FIXTURE_REQUEST_ID,
  FIXTURE_RUNTIME_BUNDLE,
  FakeWorld,
  SECOND_REQUEST_ID,
  GATEWAY_KEY_CANARY,
  InterruptedError,
  createHarness,
  fixtureGatewayAccess,
  renderFixtureWorkflow,
  type FakeHarness,
  type WorldOptions,
} from "./helpers/orchestrator-fakes.js";

const SOURCE_ROOT = resolve("test", "fixtures", "static-compose");
const FIXTURE_CONFIG = resolve(SOURCE_ROOT, "deploykit.config.fixture.yaml");

let fixtureSource = "";

beforeEach(async () => {
  if (fixtureSource === "") {
    // The fixture's backend value is replaced with a canary so every leak
    // assertion below is about a value the run really carried.
    fixtureSource = (await readFile(FIXTURE_CONFIG, "utf8")).replace(
      '"static-fixture-ops@static.example.test"',
      `"${BACKEND_SECRET_CANARY}"`,
    );
  }
});

afterEach(() => {
  clearRedactedValues();
});

function harness(options: WorldOptions = {}): FakeHarness {
  return createHarness(new FakeWorld(options), SOURCE_ROOT, fixtureSource);
}

function run(
  fixture: FakeHarness,
  overrides: Partial<Parameters<typeof runDeployment>[1]> = {},
): ReturnType<typeof runDeployment> {
  return runDeployment(fixture.deps, {
    cwd: SOURCE_ROOT,
    requestId: FIXTURE_REQUEST_ID,
    renderWorkflow: renderFixtureWorkflow,
    runtimeBundle: FIXTURE_RUNTIME_BUNDLE,
    gatewayAccess: fixtureGatewayAccess(),
    polling: { intervalMs: 1, correlationAttempts: 3, runAttempts: 6 },
    ...overrides,
  });
}

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

describe("orchestration state machine: fresh success", () => {
  it("runs every step in order and reports the deployed identity", async () => {
    const fixture = harness();
    const result = await run(fixture);

    expect(result.outcome).toBe("succeeded");
    expect(result.repository).toBe("deploykit-fixtures/static-compose");
    expect(result.targetName).toBe("production");
    expect(result.commitSha).toBe(FIXTURE_COMMIT_SHA);
    expect(result.manifestDigest?.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.httpsUrl).toBe("https://static.example.test/");
    expect(result.ports).toEqual([{ service: "api", address: "127.0.0.1", port: 41_101 }]);
    expect(result.healthy).toBe(true);
    expect(result.recovery).toBe("none");
    expect(fixture.output.results).toEqual([result]);

    expect(fixture.output.events.map((event) => event.phase)).toEqual([
      "config",
      "preflight",
      "commit",
      "control-artifacts",
      "gateway",
      "repository-key",
      "environment",
      "readiness",
      "dispatch",
      "workflow",
      "workflow",
      "inspect",
      "inspect",
      "complete",
    ]);

    expect(fixture.world.dispatches).toHaveLength(1);
    expect(fixture.world.dispatches[0]).toMatchObject({
      workflowPath: ".github/workflows/deploykit.yml",
      workflowRef: "main",
      commitSha: FIXTURE_COMMIT_SHA,
      requestId: FIXTURE_REQUEST_ID,
      resume: false,
      dryRun: false,
    });

    const record = fixture.state.stored as Record<string, unknown>;
    expect(record.status).toBe("completed");
    expect(record.apiVersion).toBe(OPERATION_RECORD_API_VERSION);
    expect(parseOperationRecord(record)?.readiness).toMatchObject({
      controlArtifacts: { ready: true },
      gateway: { ready: true },
      repositoryKey: { ready: true },
      environment: { ready: true },
      dispatch: { ready: true },
    });
  });

  it("re-verifies every readiness fact from GitHub and the VPS before dispatching", async () => {
    const fixture = harness();
    await run(fixture);

    const dispatchIndex = fixture.world.calls.indexOf("github.dispatchWorkflow");
    const before = fixture.world.calls.slice(0, dispatchIndex);
    // Each of these appears once during reconciliation and once in the final
    // recheck, so a stale local checkpoint can never authorize a dispatch.
    expect(before.filter((call) => call === "github.inspectControlArtifacts")).toHaveLength(2);
    expect(before.filter((call) => call === "github.inspectEnvironment")).toHaveLength(2);
    expect(before.filter((call) => call === "github.inspectRepositoryDeployKey")).toHaveLength(2);
    expect(before.filter((call) => call === "ssh.inspectGateway")).toHaveLength(2);
    expect(before.filter((call) => call === "github.resolveCommit")).toHaveLength(2);
  });

  it("reruns after success without dispatching or creating anything a second time", async () => {
    const fixture = harness();
    await run(fixture);
    const firstWrites = fixture.state.writes.length;

    const second = await run(fixture);
    expect(second.outcome).toBe("succeeded");
    expect(fixture.world.dispatches).toHaveLength(1);
    expect(fixture.world.deployKeys).toHaveLength(1);
    expect(fixture.world.setupBranches.size).toBe(0);
    expect(fixture.world.environments.size).toBe(1);
    expect(fixture.world.countCalls("github.reconcileControlArtifacts")).toBe(1);
    expect(fixture.world.countCalls("github.reconcileEnvironment")).toBe(1);
    expect(fixture.world.countCalls("github.reconcileRepositoryDeployKey")).toBe(1);
    expect(fixture.state.writes.length).toBeGreaterThan(firstWrites);
    // Bootstrap runs again because it is the only source of the repository
    // public key, but it must report that it changed nothing.
    expect(fixture.world.bootstrapCalls).toBe(2);
  });
});

describe("orchestration state machine: setup pull request", () => {
  it("waits for review, reuses one pull request, and continues after the merge", async () => {
    const fixture = harness({ autoMergeSetup: false });

    const failure = await expectFailure(run(fixture), "DK_SETUP_PR_REVIEW_REQUIRED");
    expect(failure.exitCode).toBe(9);
    expect(fixture.output.results.at(-1)).toMatchObject({
      outcome: "waiting-for-review",
      recovery: "review-setup-pull-request",
      setupPullRequestNumber: 41,
    });
    expect((fixture.state.stored as { status: string }).status).toBe("waiting");
    expect(fixture.world.dispatches).toHaveLength(0);
    expect(fixture.world.environments.size).toBe(0);
    expect(fixture.world.deployKeys).toHaveLength(0);

    // Rerunning while the review is still open must not open a second one.
    await expectFailure(run(fixture), "DK_SETUP_PR_REVIEW_REQUIRED");
    expect(fixture.world.setupBranches.size).toBe(1);
    expect(fixture.world.nextPullRequestNumber).toBe(42);

    fixture.world.mergeSetupPullRequest();
    const result = await run(fixture);
    expect(result.outcome).toBe("succeeded");
    expect(fixture.world.setupBranches.size).toBe(1);
    expect(fixture.world.dispatches).toHaveLength(1);
  });

  it("refuses control artifacts DeployKit does not own without reconciling them", async () => {
    const fixture = harness();
    fixture.world.foreignControlArtifact = true;

    const failure = await expectFailure(run(fixture), "DK_OWNERSHIP_CONFLICT");
    expect(failure.exitCode).toBe(4);
    expect(fixture.world.countCalls("github.reconcileControlArtifacts")).toBe(0);
    expect(fixture.world.dispatches).toHaveLength(0);
  });
});

describe("orchestration state machine: interruption after every checkpoint", () => {
  // Every externally observable step, in the order the machine performs them.
  const CHECKPOINTS = [
    "config.secureRead",
    "github.inspectRepository",
    "ssh.preflight",
    "github.resolveCommit",
    "github.inspectControlArtifacts",
    "github.reconcileControlArtifacts",
    "ssh.inspectGateway",
    "ssh.bootstrapGateway",
    "github.inspectRepositoryDeployKey",
    "github.reconcileRepositoryDeployKey",
    "github.inspectEnvironment",
    "github.reconcileEnvironment",
    "github.dispatchWorkflow",
    "github.findWorkflowRun",
    "github.inspectWorkflowRun",
    "gateway.exchange",
    "state.write",
  ] as const;

  for (const checkpoint of CHECKPOINTS) {
    it(`resumes after an interruption at ${checkpoint}`, async () => {
      const fixture = harness();
      fixture.world.interruptAt = checkpoint;

      await expect(run(fixture)).rejects.toBeInstanceOf(InterruptedError);
      expect(fixture.world.calls).toContain(checkpoint);

      fixture.world.interruptAt = null;
      const result = await run(fixture);

      expect(result.outcome).toBe("succeeded");
      expect(result.commitSha).toBe(FIXTURE_COMMIT_SHA);
      // Nothing owned may be created twice, and exactly one run may exist.
      expect(fixture.world.dispatches).toHaveLength(1);
      expect(fixture.world.runs).toHaveLength(1);
      expect(fixture.world.deployKeys).toHaveLength(1);
      expect(fixture.world.environments.size).toBe(1);
      expect(fixture.world.setupBranches.size).toBe(0);
    });
  }

  it("keeps one open pull request when a protected-branch run is interrupted mid-reconciliation", async () => {
    const fixture = harness({ autoMergeSetup: false });
    fixture.world.interruptAt = "github.reconcileControlArtifacts";
    await expect(run(fixture)).rejects.toBeInstanceOf(InterruptedError);

    fixture.world.interruptAt = null;
    await expectFailure(run(fixture), "DK_SETUP_PR_REVIEW_REQUIRED");
    await expectFailure(run(fixture), "DK_SETUP_PR_REVIEW_REQUIRED");
    expect(fixture.world.setupBranches.size).toBe(1);

    fixture.world.mergeSetupPullRequest();
    expect((await run(fixture)).outcome).toBe("succeeded");
    expect(fixture.world.dispatches).toHaveLength(1);
  });
});

describe("orchestration state machine: local operation record is disposable", () => {
  it("adopts the existing run when the record has been deleted", async () => {
    const fixture = harness();
    const dispatched = await run(fixture, { noWait: true });
    expect(dispatched.outcome).toBe("dispatched");
    expect(fixture.world.dispatches).toHaveLength(1);

    fixture.state.stored = undefined;
    fixture.state.writes.length = 0;

    const result = await run(fixture, { requestId: undefined, newRequestId: () => "5c1d9b6e-4a3f-4d2b-8e7c-1f0a9b8c7d6e" });
    expect(result.outcome).toBe("succeeded");
    expect(fixture.world.dispatches).toHaveLength(1);
    // The adopted run's request ID becomes this operation's, so the next rerun
    // correlates it exactly rather than by identity.
    expect(result.requestId).toBe(FIXTURE_REQUEST_ID);
  });

  it("discards a malformed record with a warning and still completes", async () => {
    const fixture = harness();
    fixture.state.stored = { apiVersion: "deploykit/operation/v0", status: "banana" };

    const result = await run(fixture);
    expect(result.outcome).toBe("succeeded");
    expect(
      fixture.output.events.filter(
        (event) => event.code === "DK_OPERATION_STATE_INVALID" && event.level === "warning",
      ),
    ).toHaveLength(1);
    expect(fixture.world.dispatches).toHaveLength(1);
  });

  it("discards an unreadable record with a warning and still completes", async () => {
    const fixture = harness();
    fixture.state.failRead = true;

    const result = await run(fixture);
    expect(result.outcome).toBe("succeeded");
    expect(fixture.output.codes()).toContain("DK_OPERATION_STATE_INVALID");
  });

  it("does not resume a record recorded for a different commit", async () => {
    const fixture = harness();
    await run(fixture, { noWait: true });
    const first = fixture.state.stored as { requestId: string };

    fixture.world.commitSha = FIXTURE_MOVED_SHA;
    const result = await run(fixture, {
      requestId: undefined,
      newRequestId: () => "7d6e5f4a-3b2c-4d1e-9f8a-7b6c5d4e3f2a",
    });
    expect(result.commitSha).toBe(FIXTURE_MOVED_SHA);
    expect(result.requestId).not.toBe(first.requestId);
    expect(fixture.world.dispatches).toHaveLength(2);
  });
});

describe("orchestration state machine: dry run", () => {
  it("inspects every boundary and mutates nothing", async () => {
    const fixture = harness();
    const result = await run(fixture, { dryRun: true });

    expect(result.outcome).toBe("dry-run");
    expect(result.commitSha).toBe(FIXTURE_COMMIT_SHA);
    expect(result.httpsUrl).toBeNull();
    expect(result.healthy).toBeNull();

    const mutations = [
      "github.reconcileControlArtifacts",
      "github.reconcileRepositoryDeployKey",
      "github.reconcileEnvironment",
      "github.dispatchWorkflow",
      "ssh.bootstrapGateway",
      "gateway.exchange",
      "state.write",
    ];
    for (const mutation of mutations) expect(fixture.world.calls).not.toContain(mutation);

    expect(fixture.state.writes).toEqual([]);
    expect(fixture.state.stored).toBeUndefined();
    expect(fixture.world.defaultBranchFiles.size).toBe(0);
    expect(fixture.world.setupBranches.size).toBe(0);
    expect(fixture.world.deployKeys).toEqual([]);
    expect(fixture.world.environments.size).toBe(0);
    expect(fixture.world.binding).toBeNull();
    expect(fixture.world.dispatches).toEqual([]);
    expect(fixture.world.calls).toContain("github.inspectControlArtifacts");
    expect(fixture.world.calls).toContain("ssh.inspectGateway");
    expect(fixture.output.codes()).toContain("DK_DRY_RUN_OK");
  });

  it("mutates nothing on a dry run of an already reconciled deployment", async () => {
    const fixture = harness();
    await run(fixture);
    const callsBefore = fixture.world.calls.length;
    const writesBefore = fixture.state.writes.length;

    const result = await run(fixture, { dryRun: true });
    expect(result.outcome).toBe("dry-run");
    expect(fixture.state.writes).toHaveLength(writesBefore);
    expect(fixture.world.dispatches).toHaveLength(1);
    expect(fixture.world.calls.slice(callsBefore)).not.toContain("github.dispatchWorkflow");
  });
});

describe("orchestration state machine: no-wait", () => {
  it("dispatches, correlates the run, and stops without following it", async () => {
    const fixture = harness();
    const result = await run(fixture, { noWait: true });

    expect(result.outcome).toBe("dispatched");
    expect(result.workflowRunId).toBe(fixture.world.runs[0]?.id);
    expect(result.recovery).toBe("none");
    expect(fixture.world.calls).not.toContain("github.inspectWorkflowRun");
    expect(fixture.world.calls).not.toContain("gateway.exchange");
    expect((fixture.state.stored as { status: string }).status).toBe("running");
  });
});

describe("orchestration state machine: refusals", () => {
  it("refuses a ref that moved between freezing and the readiness recheck", async () => {
    const fixture = harness();
    let inspected = 0;
    const github = fixture.deps.github;
    const resolveCommit = github.resolveCommit.bind(github);
    (github as { resolveCommit: typeof github.resolveCommit }).resolveCommit = async (repository, ref) => {
      const resolved = await resolveCommit(repository, ref);
      inspected += 1;
      return inspected === 1 ? resolved : { ...resolved, commitSha: FIXTURE_MOVED_SHA };
    };

    const failure = await expectFailure(run(fixture), "DK_REF_MOVED");
    expect(failure.exitCode).toBe(1);
    expect(fixture.world.dispatches).toHaveLength(0);
    expect(fixture.output.results.at(-1)?.recovery).toBe("rerun-same-command");
  });

  it("refuses a gateway bound to another repository or target before bootstrapping", async () => {
    const fixture = harness();
    fixture.world.foreignBinding = {
      apiVersion: "deploykit/gateway-binding/v1alpha1",
      bindingId: "0".repeat(32),
      repository: "someone-else/app",
      githubEnvironment: "production",
      targetName: "production",
      targetId: "9".repeat(32),
      gatewayUser: "deploykit-gateway",
      forcedCommand: "deploykit gateway",
      runtimeVersion: "0.1.3",
      runtimeBundleSha256: "e".repeat(64),
      repositoryKeyId: "other",
      repositoryKeyFingerprint: "SHA256:other",
      activeGatewayKeyId: null,
      pendingGatewayKeyId: null,
    };

    const failure = await expectFailure(run(fixture), "DK_GATEWAY_BINDING_MISMATCH");
    expect(failure.exitCode).toBe(4);
    expect(fixture.world.bootstrapCalls).toBe(0);
    expect(fixture.world.dispatches).toHaveLength(0);
  });

  it("refuses a foreign repository deploy key without rotating it", async () => {
    const fixture = harness();
    fixture.world.deployKeys.push({
      id: 1,
      title: `DeployKit repository key: ${managedTargetId()}`,
      fingerprint: "SHA256:foreign",
      readOnly: false,
      owner: "foreign",
    });

    const failure = await expectFailure(run(fixture), "DK_OWNERSHIP_CONFLICT");
    expect(failure.exitCode).toBe(4);
    expect(fixture.world.deployKeys).toHaveLength(1);
    expect(fixture.world.deployKeys[0]?.owner).toBe("foreign");
    expect(fixture.world.dispatches).toHaveLength(0);
  });

  it("refuses a GitHub Environment DeployKit does not own", async () => {
    const fixture = harness();
    fixture.world.environments.set("fixture-static-production", {
      variableNames: ["SOMETHING_ELSE"],
      secretNames: [],
      generatedSecretNames: [],
      managedResourceDigest: "0".repeat(64),
      owned: false,
    });

    const failure = await expectFailure(run(fixture), "DK_ENVIRONMENT_CONFLICT");
    expect(failure.exitCode).toBe(4);
    expect(fixture.world.countCalls("github.reconcileEnvironment")).toBe(0);
    expect(fixture.world.dispatches).toHaveLength(0);
  });

  it("refuses a host key that does not match the pinned fingerprint", async () => {
    const fixture = harness();
    fixture.world.presentedHostKeyFingerprint = "SHA256:unexpected";

    const failure = await expectFailure(run(fixture), "DK_SSH_HOST_KEY_MISMATCH");
    expect(failure.exitCode).toBe(4);
    expect(fixture.world.bootstrapCalls).toBe(0);
  });

  it("refuses missing GitHub permissions before touching the VPS", async () => {
    const fixture = harness();
    fixture.world.permissions = { ...fixture.world.permissions, environmentsWrite: false };

    const failure = await expectFailure(run(fixture), "DK_GITHUB_PERMISSION_DENIED");
    expect(failure.exitCode).toBe(4);
    expect(fixture.world.calls).not.toContain("ssh.preflight");
  });

  it("reports a failed workflow run and keeps the failure in the local record", async () => {
    const fixture = harness({ runConclusion: "failure" });

    const failure = await expectFailure(run(fixture), "DK_WORKFLOW_RUN_FAILED");
    expect(failure.exitCode).toBe(1);
    const record = fixture.state.stored as { status: string; lastFailure: { code: string; recovery: string } };
    expect(record.status).toBe("failed");
    expect(record.lastFailure).toMatchObject({ code: "DK_WORKFLOW_RUN_FAILED", recovery: "rerun-same-command" });
    expect(fixture.output.results.at(-1)?.outcome).toBe("failed");
  });

  it("retries a failed run with the resume flag and a new dispatch", async () => {
    const fixture = harness({ runConclusion: "failure" });
    await expectFailure(run(fixture), "DK_WORKFLOW_RUN_FAILED");

    fixture.world.runConclusion = "success";
    const result = await run(fixture, {
      requestId: undefined,
      newRequestId: () => SECOND_REQUEST_ID,
    });
    expect(result.outcome).toBe("succeeded");
    expect(fixture.world.dispatches).toHaveLength(2);
    expect(fixture.world.dispatches[1]?.resume).toBe(true);
  });

  it("surfaces an Environment approval as a waiting outcome", async () => {
    const fixture = harness({ runConclusion: "action_required", reviewers: ["release-team"] });

    const failure = await expectFailure(run(fixture), "DK_ENVIRONMENT_APPROVAL_REQUIRED");
    expect(failure.exitCode).toBe(9);
    expect(fixture.output.results.at(-1)).toMatchObject({
      outcome: "waiting-for-review",
      recovery: "wait-and-rerun",
    });
    expect(fixture.output.codes()).toContain("DK_ENVIRONMENT_PROTECTED");
  });
});

describe("orchestration state machine: secret handling", () => {
  it("keeps operator and gateway secret values out of every observable channel", async () => {
    const fixture = harness();
    await run(fixture);

    const observable = JSON.stringify({
      events: fixture.output.events,
      results: fixture.output.results,
      records: fixture.state.writes,
      dispatches: fixture.world.dispatches,
      defaultBranchFiles: [...fixture.world.defaultBranchFiles],
      binding: fixture.world.binding,
      environments: [...fixture.world.environments],
    });

    expect(observable).not.toContain(BACKEND_SECRET_CANARY);
    expect(observable).not.toContain(GATEWAY_KEY_CANARY);
    // The Environment holds secret *names*; the values never leave the request.
    expect(fixture.world.environments.get("fixture-static-production")?.secretNames).toContain("CERTBOT_EMAIL");
  });

  it("registers the operator's backend values with the shared redactor", async () => {
    const fixture = harness();
    await run(fixture);
    expect(redact(`value=${BACKEND_SECRET_CANARY}`)).not.toContain(BACKEND_SECRET_CANARY);
  });
});

// ------------------------------------------------------------------ helpers --

/** The managed deploy-key title is keyed by the compiled target ID. */
function managedTargetId(): string {
  return makeOrchestratorTargetId("deploykit-fixtures/static-compose", "production");
}

// ------------------------------------------------------------------ planner --

function contextFor(source: string): DeploymentContext {
  const parsed = parseOperatorConfig(parseYaml(source));
  const compiled = compileRuntimeManifest(parsed, { requiredVersion: "0.1.3" });
  return {
    compiled,
    environment: parsed.environment,
    repository: parsed.config.project.repository,
    targetName: compiled.targetName,
    targetId: compiled.targetId,
    githubEnvironment: parsed.config.target.githubEnvironment,
    primaryDomain: parsed.config.target.primaryDomain,
    applicationRef: parsed.config.project.ref,
    defaultBranch: "main",
    names: makeManagedResourceNames(compiled.targetId),
  };
}

function fixturePlanner() {
  return createDesiredStatePlanner({
    renderWorkflow: renderFixtureWorkflow,
    runtimeBundle: FIXTURE_RUNTIME_BUNDLE,
  });
}

describe("desired state is a deterministic function of the compiled deployment", () => {
  it("produces byte-identical control artifacts for equivalent configurations", () => {
    const planner = fixturePlanner();
    const original = planner.controlArtifacts(contextFor(fixtureSource));
    // Reformatting the operator's YAML must not move a single artifact byte.
    const reformatted = planner.controlArtifacts(
      contextFor(stringifyYaml(parseYaml(fixtureSource), { indent: 4, lineWidth: 40 })),
    );
    expect(reformatted.artifacts).toEqual(original.artifacts);
    expect(reformatted.ownership).toEqual(original.ownership);
    expect(original.artifacts.map((entry) => entry.path)).toEqual([
      ".github/workflows/deploykit.yml",
      ".github/deploykit/manifest.yaml",
      ".github/deploykit/ownership.json",
    ]);
  });

  it("keeps artifacts and every digest stable when a backend secret value rotates", () => {
    const planner = fixturePlanner();
    const original = contextFor(fixtureSource);
    const rotated = contextFor(fixtureSource.replace(BACKEND_SECRET_CANARY, "DK_CANARY_ROTATED_0f2b"));
    const access = fixtureGatewayAccess()();

    expect(planner.controlArtifacts(rotated).artifacts).toEqual(planner.controlArtifacts(original).artifacts);
    expect(planner.environment(rotated, access).managedResourceDigest).toBe(
      planner.environment(original, access).managedResourceDigest,
    );
  });

  it("never puts a secret value in a committed artifact, marker, or digest input", () => {
    const planner = fixturePlanner();
    const context = contextFor(fixtureSource);
    const artifacts = planner.controlArtifacts(context);
    const serialized = JSON.stringify({ artifacts, binding: planner.gatewayBinding(context) });

    expect(serialized).not.toContain(BACKEND_SECRET_CANARY);
    expect(serialized).not.toContain(GATEWAY_KEY_CANARY);
    expect(artifacts.ownership.managed.backendSecrets).toEqual(["CERTBOT_EMAIL"]);
    expect(artifacts.ownership.managed.generatedSecrets).toEqual(["DATABASE_URL", "POSTGRES_PASSWORD"]);
    expect(artifacts.ownership.runtimeManifestDigest).toEqual(context.compiled.digest);
  });

  it("keys every managed resource name by target ID so a rename cannot claim another target", () => {
    const context = contextFor(fixtureSource);
    expect(context.names.setupBranch).toBe(`deploykit/setup-${context.targetId}`);
    expect(context.names.repositoryDeployKeyTitle).toBe(`DeployKit repository key: ${context.targetId}`);
    expect(context.names.setupPullRequestTitle).toBe(`DeployKit setup: ${context.targetId}`);
  });

  it("ignores host-owned key fields when comparing gateway bindings", () => {
    const context = contextFor(fixtureSource);
    const binding = fixturePlanner().gatewayBinding(context);
    const installed = {
      ...binding,
      repositoryKeyId: "repo-1",
      repositoryKeyFingerprint: "SHA256:installed",
      activeGatewayKeyId: "gateway-1",
      pendingGatewayKeyId: "gateway-2",
    };
    expect(gatewayBindingIdentityDigest(installed)).toBe(gatewayBindingIdentityDigest(binding));
    expect(gatewayBindingIdentityDigest({ ...binding, targetId: "0".repeat(32) })).not.toBe(
      gatewayBindingIdentityDigest(binding),
    );
  });
});
