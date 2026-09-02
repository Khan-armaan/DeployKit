import { createHash } from "node:crypto";

import {
  GATEWAY_PROTOCOL_VERSION,
  type GatewayHandshakeResult,
  type GatewayInputFrame,
  type GatewayOutputFrame,
  type GitCommitSha,
  type LocalOperationRecord,
  type RootOwnedGatewayBinding,
  type Sha256Hex,
} from "../../src/orchestrator/contracts.js";
import type {
  AdministratorSshConnection,
  AdministratorSshPort,
  AdministratorSshPreflight,
  ClockPort,
  ConfigFileSystemPort,
  ConfigScaffoldRequest,
  ControlArtifactsState,
  DesiredControlArtifacts,
  DesiredGitHubEnvironment,
  DesiredRepositoryDeployKey,
  GatewayBootstrapRequest,
  GatewayBootstrapResult,
  GatewayExchange,
  GatewayTransportPort,
  GitHubEnvironmentState,
  GitHubPort,
  GitHubRepositoryFacts,
  GitHubResolvedCommit,
  OperationStatePort,
  OrchestratorDependencies,
  OrchestratorProgressEvent,
  OrchestratorResult,
  OutputPort,
  RepositoryDeployKeyState,
  WorkflowDispatchReceipt,
  WorkflowDispatchRequest,
  WorkflowRunIdentity,
  WorkflowRunState,
} from "../../src/orchestrator/dependencies.js";
import {
  gatewayBindingIdentityDigest,
  type DeploymentContext,
  type GatewayAccessFacts,
  type RuntimeBundleReference,
} from "../../src/orchestrator/planner.js";

/**
 * Phase 4 fakes. They are deliberately *reconcilers*, not stubs: each one keeps
 * external state, decides "already reconciled" the same way a real adapter
 * would, and records every call. That is what lets the suite assert the two
 * properties the phase gate is about — a rerun duplicates nothing, and a dry
 * run mutates nothing.
 */

export const FIXTURE_COMMIT_SHA: GitCommitSha = "1".repeat(39) + "a";
export const FIXTURE_DEFAULT_BRANCH_SHA: GitCommitSha = "2".repeat(39) + "b";
export const FIXTURE_MOVED_SHA: GitCommitSha = "3".repeat(39) + "c";
export const FIXTURE_REQUEST_ID = "0f9c4f3a-1d2e-4b5c-8a7d-6e5f4a3b2c1d";
export const SECOND_REQUEST_ID = "9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d";

export const FIXTURE_RUNTIME_BUNDLE: RuntimeBundleReference = {
  version: "0.1.3",
  packageName: "@deploykit001/deploykit",
  packageFile: "/tmp/deploykit-server-bundle.tgz",
  packageSha256: "f".repeat(64),
};

export const GATEWAY_KEY_CANARY = "DK_CANARY_GATEWAY_PRIVATE_KEY_9f13ab";
export const BACKEND_SECRET_CANARY = "DK_CANARY_BACKEND_CERTBOT_EMAIL_44de07";

function sha256(value: string): Sha256Hex {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Thrown by an interruption point so a test can resume the same world. */
export class InterruptedError extends Error {
  constructor(readonly label: string) {
    super(`interrupted at ${label}`);
    this.name = "InterruptedError";
  }
}

export interface DeployKeyEntry {
  readonly id: number;
  readonly title: string;
  readonly fingerprint: string;
  readonly readOnly: boolean;
  readonly owner: "deploykit" | "foreign";
}

export interface EnvironmentEntry {
  variableNames: string[];
  secretNames: string[];
  generatedSecretNames: string[];
  managedResourceDigest: Sha256Hex;
  owned: boolean;
}

/** The world advances a run's status, so its fields cannot stay readonly. */
export type MutableWorkflowRun = { -readonly [K in keyof WorkflowRunState]: WorkflowRunState[K] };

export interface WorldOptions {
  /** Merge the setup pull request automatically, as an unprotected branch would. */
  readonly autoMergeSetup?: boolean;
  readonly runConclusion?: WorkflowRunState["conclusion"];
  readonly reviewers?: readonly string[];
  readonly waitTimerMinutes?: number;
}

/**
 * The mutable "outside world": GitHub plus one VPS. Every fake port reads and
 * writes this object, so a test can interrupt a run, inspect what survived, and
 * rerun against the same state.
 */
export class FakeWorld {
  readonly calls: string[] = [];
  interruptAt: string | null = null;

  readonly repository = "deploykit-fixtures/static-compose";
  readonly defaultBranch = "main";
  commitSha: GitCommitSha = FIXTURE_COMMIT_SHA;
  defaultBranchCommitSha: GitCommitSha = FIXTURE_DEFAULT_BRANCH_SHA;
  permissions = {
    read: true,
    contentsWrite: true,
    workflowsWrite: true,
    environmentsWrite: true,
    deployKeysWrite: true,
    pullRequestsWrite: true,
  };

  /** Committed control-artifact bytes on the protected default branch. */
  readonly defaultBranchFiles = new Map<string, string>();
  /** Bytes proposed on the DeployKit setup branch, keyed by branch name. */
  readonly setupBranches = new Map<string, { number: number; state: "open" | "merged"; files: Map<string, string> }>();
  foreignControlArtifact = false;
  nextPullRequestNumber = 41;

  readonly deployKeys: DeployKeyEntry[] = [];
  nextDeployKeyId = 7001;

  readonly environments = new Map<string, EnvironmentEntry>();

  readonly dispatches: WorkflowDispatchRequest[] = [];
  readonly runs: MutableWorkflowRun[] = [];
  /** Dispatch inputs a real adapter would read back off the run. */
  readonly runIdentities = new Map<number, { commitSha: GitCommitSha; manifestDigest: Sha256Hex }>();
  nextRunId = 900_001;

  binding: RootOwnedGatewayBinding | null = null;
  foreignBinding: RootOwnedGatewayBinding | null = null;
  bootstrapCalls = 0;
  sshReachable = true;
  /** Conclusion the next completed workflow run reports. Mutable for retries. */
  runConclusion: WorkflowRunState["conclusion"];
  presentedHostKeyFingerprint: string | null = null;
  administrator = true;

  readonly repositoryPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeRepositoryKey deploykit";
  get repositoryPublicKeyFingerprint(): string {
    return `SHA256:${sha256(this.repositoryPublicKey).slice(0, 43)}`;
  }

  constructor(readonly options: WorldOptions = {}) {
    this.runConclusion = options.runConclusion ?? "success";
  }

  /** Records the call and honours a pending interruption. */
  gate(label: string): void {
    this.calls.push(label);
    if (this.interruptAt === label) throw new InterruptedError(label);
  }

  countCalls(label: string): number {
    return this.calls.filter((entry) => entry === label).length;
  }

  /** Simulates the operator reviewing and merging the DeployKit setup PR. */
  mergeSetupPullRequest(): void {
    for (const [, branch] of this.setupBranches) {
      if (branch.state !== "open") continue;
      branch.state = "merged";
      for (const [path, contents] of branch.files) this.defaultBranchFiles.set(path, contents);
      this.defaultBranchCommitSha = sha256(`merged:${this.defaultBranchCommitSha}`).slice(0, 40);
    }
  }
}

export class FakeGitHub implements GitHubPort {
  constructor(private readonly world: FakeWorld) {}

  async inspectRepository(repository: string): Promise<GitHubRepositoryFacts> {
    this.world.gate("github.inspectRepository");
    return {
      repository,
      defaultBranch: this.world.defaultBranch,
      defaultBranchCommitSha: this.world.defaultBranchCommitSha,
      private: true,
      authenticatedActor: "fixture-operator",
      permissions: { ...this.world.permissions },
    };
  }

  async resolveCommit(repository: string, ref: string): Promise<GitHubResolvedCommit> {
    this.world.gate("github.resolveCommit");
    return { repository, ref, commitSha: this.world.commitSha };
  }

  private artifactState(desired: DesiredControlArtifacts): ControlArtifactsState {
    const branch = this.world.setupBranches.get(desired.names.setupBranch);
    const digestFor = (path: string): string | null => this.world.defaultBranchFiles.get(path) ?? null;
    const current = desired.artifacts.every((entry) => digestFor(entry.path) === entry.sha256);
    const workflow = desired.artifacts.find((entry) => entry.path === desired.names.workflowPath);
    const ownership = desired.artifacts.find((entry) => entry.path === desired.names.ownershipPath);

    if (this.world.foreignControlArtifact) {
      return {
        status: "conflict",
        defaultBranchCommitSha: this.world.defaultBranchCommitSha,
        setupPullRequestNumber: branch?.number ?? null,
        setupPullRequestState: branch?.state ?? null,
        workflowDigest: null,
        runtimeManifestDigest: null,
        ownershipDigest: null,
      };
    }

    return {
      status: current
        ? "current"
        : branch !== undefined && branch.state === "open"
          ? "setup-pull-request"
          : this.world.defaultBranchFiles.has(desired.names.workflowPath)
            ? "drifted"
            : "missing",
      defaultBranchCommitSha: this.world.defaultBranchCommitSha,
      setupPullRequestNumber: branch?.number ?? null,
      setupPullRequestState: branch?.state ?? null,
      workflowDigest: current ? (workflow?.sha256 ?? null) : digestFor(desired.names.workflowPath),
      runtimeManifestDigest: current ? desired.ownership.runtimeManifestDigest : null,
      ownershipDigest: current ? (ownership?.sha256 ?? null) : digestFor(desired.names.ownershipPath),
    };
  }

  async inspectControlArtifacts(desired: DesiredControlArtifacts): Promise<ControlArtifactsState> {
    this.world.gate("github.inspectControlArtifacts");
    return this.artifactState(desired);
  }

  async reconcileControlArtifacts(desired: DesiredControlArtifacts): Promise<ControlArtifactsState> {
    this.world.gate("github.reconcileControlArtifacts");
    if (this.world.foreignControlArtifact) return this.artifactState(desired);

    const files = new Map(desired.artifacts.map((entry) => [entry.path, entry.sha256] as const));
    if (this.world.options.autoMergeSetup !== false) {
      for (const [path, digest] of files) this.world.defaultBranchFiles.set(path, digest);
      this.world.defaultBranchCommitSha = sha256(`direct:${this.world.defaultBranchCommitSha}`).slice(0, 40);
      return this.artifactState(desired);
    }

    // Protected branch: reuse the existing DeployKit branch instead of opening
    // a second pull request for the same target.
    const existing = this.world.setupBranches.get(desired.names.setupBranch);
    if (existing === undefined) {
      this.world.setupBranches.set(desired.names.setupBranch, {
        number: this.world.nextPullRequestNumber++,
        state: "open",
        files,
      });
    } else if (existing.state === "open") {
      existing.files = files;
    }
    return this.artifactState(desired);
  }

  private deployKeyState(desired: DesiredRepositoryDeployKey): RepositoryDeployKeyState {
    const entry = this.world.deployKeys.find((key) => key.title === desired.title);
    if (entry === undefined) {
      return { status: "missing", keyId: null, title: desired.title, publicKeyFingerprint: null, readOnly: null };
    }
    if (entry.owner !== "deploykit") {
      return {
        status: "conflict",
        keyId: entry.id,
        title: entry.title,
        publicKeyFingerprint: entry.fingerprint,
        readOnly: entry.readOnly,
      };
    }
    return {
      status: entry.fingerprint === desired.publicKeyFingerprint ? "current" : "missing",
      keyId: entry.id,
      title: entry.title,
      publicKeyFingerprint: entry.fingerprint,
      readOnly: entry.readOnly,
    };
  }

  async inspectRepositoryDeployKey(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState> {
    this.world.gate("github.inspectRepositoryDeployKey");
    return this.deployKeyState(desired);
  }

  async reconcileRepositoryDeployKey(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState> {
    this.world.gate("github.reconcileRepositoryDeployKey");
    const index = this.world.deployKeys.findIndex((key) => key.title === desired.title);
    if (index >= 0 && this.world.deployKeys[index]!.owner !== "deploykit") return this.deployKeyState(desired);
    const entry: DeployKeyEntry = {
      id: index >= 0 ? this.world.deployKeys[index]!.id : this.world.nextDeployKeyId++,
      title: desired.title,
      fingerprint: desired.publicKeyFingerprint,
      readOnly: desired.readOnly,
      owner: "deploykit",
    };
    if (index >= 0) this.world.deployKeys[index] = entry;
    else this.world.deployKeys.push(entry);
    return this.deployKeyState(desired);
  }

  private environmentState(desired: DesiredGitHubEnvironment): GitHubEnvironmentState {
    const entry = this.world.environments.get(desired.environment);
    const protection = {
      reviewers: [...(this.world.options.reviewers ?? [])],
      waitTimerMinutes: this.world.options.waitTimerMinutes ?? 0,
      protectedBranchesOnly: true,
    };
    if (entry === undefined) {
      return {
        status: "missing",
        environment: desired.environment,
        variableNames: [],
        secretNames: [],
        generatedSecretNames: [],
        managedResourceDigest: null,
        protection,
      };
    }
    return {
      status: !entry.owned
        ? "conflict"
        : entry.managedResourceDigest === desired.managedResourceDigest
          ? "current"
          : "drifted",
      environment: desired.environment,
      variableNames: [...entry.variableNames],
      secretNames: [...entry.secretNames],
      generatedSecretNames: [...entry.generatedSecretNames],
      managedResourceDigest: entry.managedResourceDigest,
      protection,
    };
  }

  async inspectEnvironment(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState> {
    this.world.gate("github.inspectEnvironment");
    return this.environmentState(desired);
  }

  async reconcileEnvironment(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState> {
    this.world.gate("github.reconcileEnvironment");
    const existing = this.world.environments.get(desired.environment);
    if (existing !== undefined && !existing.owned) return this.environmentState(desired);
    this.world.environments.set(desired.environment, {
      variableNames: Object.keys(desired.variables).sort(),
      secretNames: Object.keys(desired.secrets).sort(),
      generatedSecretNames: [...desired.generatedSecretNames],
      managedResourceDigest: desired.managedResourceDigest,
      owned: true,
    });
    return this.environmentState(desired);
  }

  async dispatchWorkflow(request: WorkflowDispatchRequest): Promise<WorkflowDispatchReceipt> {
    this.world.gate("github.dispatchWorkflow");
    this.world.dispatches.push(request);
    const id = this.world.nextRunId++;
    this.world.runIdentities.set(id, {
      commitSha: request.commitSha,
      manifestDigest: request.manifestDigest.value,
    });
    this.world.runs.push({
      id,
      repository: request.repository,
      url: `https://github.com/${request.repository}/actions/runs/${id}`,
      workflowPath: request.workflowPath,
      event: "workflow_dispatch",
      workflowRef: request.workflowRef,
      workflowSha: this.world.defaultBranchCommitSha,
      actor: "fixture-operator",
      requestId: request.requestId,
      targetName: request.targetName,
      status: "queued",
      conclusion: null,
    });
    return { requestId: request.requestId, acceptedAt: "2026-01-01T00:00:00.000Z" };
  }

  /**
   * Correlates by request ID first, then by deployment identity. Adopting a run
   * whose request ID this machine has never seen is what makes a deleted local
   * operation record harmless: the rerun follows the existing run instead of
   * dispatching a second one. A run that already failed is *not* adopted, so a
   * genuine retry can dispatch.
   */
  async findWorkflowRun(request: WorkflowDispatchRequest): Promise<WorkflowRunState | undefined> {
    this.world.gate("github.findWorkflowRun");
    // A run that already failed is never correlated, so a retry dispatches a
    // new one instead of re-reading the old failure forever.
    const usable = (run: MutableWorkflowRun): boolean =>
      !(run.status === "completed" && run.conclusion !== "success");
    const sameIdentity = (run: MutableWorkflowRun): boolean => {
      const identity = this.world.runIdentities.get(run.id);
      return (
        identity !== undefined &&
        identity.commitSha === request.commitSha &&
        identity.manifestDigest === request.manifestDigest.value &&
        run.targetName === request.targetName &&
        run.workflowPath === request.workflowPath
      );
    };
    const byRequest = this.world.runs.find((run) => run.requestId === request.requestId && usable(run));
    if (byRequest !== undefined) return { ...byRequest };
    const adoptable = [...this.world.runs].reverse().find((run) => usable(run) && sameIdentity(run));
    return adoptable === undefined ? undefined : { ...adoptable };
  }

  async inspectWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunState> {
    this.world.gate("github.inspectWorkflowRun");
    const run = this.world.runs.find((entry) => entry.id === identity.id);
    if (run === undefined) throw new Error(`unknown workflow run ${identity.id}`);
    // Each inspection advances the run one step, so waiting is deterministic.
    if (run.status === "queued") run.status = "in_progress";
    else if (run.status === "in_progress") {
      run.status = "completed";
      run.conclusion = this.world.runConclusion;
    }
    return { ...run };
  }
}

export class FakeAdministratorSsh implements AdministratorSshPort {
  constructor(private readonly world: FakeWorld) {}

  async preflight(connection: AdministratorSshConnection): Promise<AdministratorSshPreflight> {
    this.world.gate("ssh.preflight");
    return {
      reachable: this.world.sshReachable,
      hostKeyFingerprint: this.world.presentedHostKeyFingerprint ?? connection.hostKeyFingerprint,
      operatingSystem: "ubuntu-24.04",
      architecture: "amd64",
      administrator: this.world.administrator,
    };
  }

  private handshake(binding: RootOwnedGatewayBinding): GatewayHandshakeResult {
    return {
      kind: "handshake",
      bindingId: binding.bindingId,
      targetId: binding.targetId,
      runtimeVersion: binding.runtimeVersion,
      runtimeBundleSha256: binding.runtimeBundleSha256,
      capabilities: ["handshake", "apply", "retry", "inspect"],
    };
  }

  async inspectGateway(): Promise<GatewayHandshakeResult | undefined> {
    this.world.gate("ssh.inspectGateway");
    const installed = this.world.foreignBinding ?? this.world.binding;
    return installed === null ? undefined : this.handshake(installed);
  }

  async bootstrapGateway(request: GatewayBootstrapRequest): Promise<GatewayBootstrapResult> {
    this.world.gate("ssh.bootstrapGateway");
    this.world.bootstrapCalls += 1;
    const previous = this.world.binding;
    const changed =
      previous === null ||
      gatewayBindingIdentityDigest(previous) !== gatewayBindingIdentityDigest(request.binding);
    this.world.binding = {
      ...request.binding,
      repositoryKeyId: `repo-${request.binding.targetId}`,
      repositoryKeyFingerprint: this.world.repositoryPublicKeyFingerprint,
      activeGatewayKeyId: previous?.activeGatewayKeyId ?? null,
      pendingGatewayKeyId: null,
    };
    return {
      changed,
      binding: this.world.binding,
      handshake: this.handshake(this.world.binding),
      repositoryPublicKey: this.world.repositoryPublicKey,
      repositoryPublicKeyFingerprint: this.world.repositoryPublicKeyFingerprint,
    };
  }
}

export class FakeGatewayTransport implements GatewayTransportPort {
  constructor(private readonly world: FakeWorld) {}

  async *exchange(request: GatewayExchange): AsyncIterable<GatewayOutputFrame> {
    this.world.gate("gateway.exchange");
    const frames: GatewayInputFrame[] = [];
    for await (const frame of request.frames) frames.push(frame);
    const first = frames[0];
    if (first === undefined || first.frame !== "request") {
      throw new Error("gateway received no request frame");
    }
    this.world.calls.push(`gateway.${first.operation}`);

    yield {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "progress",
      requestId: first.requestId,
      sequence: 1,
      time: "2026-01-01T00:00:05.000Z",
      level: "info",
      phase: "handshake",
      code: "DK_GATEWAY_OK",
      message: "gateway accepted the inspection request",
    };
    yield {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "result",
      requestId: first.requestId,
      sequence: 2,
      time: "2026-01-01T00:00:06.000Z",
      ok: true,
      code: "DK_GATEWAY_OK",
      recovery: "none",
      result: {
        kind: "deployment",
        outcome: "succeeded",
        targetName: first.targetName,
        targetId: first.targetId,
        commitSha: first.commitSha,
        manifestDigest: first.manifestDigest,
        phase: "complete",
        domains: ["static.example.test", "www.static.example.test"],
        ports: [{ service: "api", address: "127.0.0.1", port: 41_101 }],
        health: [{ service: "api", healthy: true, check: "http" }],
        resumed: false,
        failureCode: null,
      },
    };
  }
}

export class FakeConfigFileSystem implements ConfigFileSystemPort {
  scaffoldStatus: "created" | "existing" = "existing";
  confirmed = true;

  constructor(
    private readonly world: FakeWorld,
    private readonly repositoryRoot: string,
    private readonly configPath: string,
    private source: string,
  ) {}

  setSource(source: string): void {
    this.source = source;
  }

  async scaffold(request: ConfigScaffoldRequest) {
    this.world.gate("config.scaffold");
    return {
      status: this.scaffoldStatus,
      repositoryRoot: this.repositoryRoot,
      configPath: request.configPath ?? this.configPath,
      excludePath: `${this.repositoryRoot}/.git/info/exclude`,
    };
  }

  async secureRead(configPath: string) {
    this.world.gate("config.secureRead");
    return {
      repositoryRoot: this.repositoryRoot,
      configPath,
      source: this.source,
      mode: 0o600 as const,
      ownerUid: 501,
      ignored: true as const,
      tracked: false as const,
      staged: false as const,
    };
  }

  async waitForConfirmation() {
    this.world.gate("config.waitForConfirmation");
    return { confirmed: this.confirmed, interactive: true };
  }
}

export class FakeOperationState implements OperationStatePort {
  stored: unknown;
  readonly writes: LocalOperationRecord[] = [];
  failRead = false;

  constructor(private readonly world: FakeWorld) {}

  async read(): Promise<LocalOperationRecord | undefined> {
    this.world.gate("state.read");
    if (this.failRead) throw new Error("operation record is unreadable");
    return this.stored as LocalOperationRecord | undefined;
  }

  async write(record: LocalOperationRecord): Promise<void> {
    this.world.gate("state.write");
    this.stored = record;
    this.writes.push(record);
  }
}

export class FakeClock implements ClockPort {
  private millis = Date.parse("2026-01-01T00:00:00.000Z");
  slept = 0;

  now(): Date {
    this.millis += 1_000;
    return new Date(this.millis);
  }

  async sleep(milliseconds: number): Promise<void> {
    this.slept += milliseconds;
    this.millis += milliseconds;
  }
}

export class RecordingOutput implements OutputPort {
  readonly events: OrchestratorProgressEvent[] = [];
  readonly results: OrchestratorResult[] = [];

  progress(event: OrchestratorProgressEvent): void {
    this.events.push(event);
  }

  result(result: OrchestratorResult): void {
    this.results.push(result);
  }

  codes(): string[] {
    return this.events.map((event) => event.code);
  }
}

export interface FakeHarness {
  readonly world: FakeWorld;
  readonly deps: OrchestratorDependencies;
  readonly config: FakeConfigFileSystem;
  readonly state: FakeOperationState;
  readonly output: RecordingOutput;
  readonly clock: FakeClock;
}

export function createHarness(
  world: FakeWorld,
  repositoryRoot: string,
  source: string,
): FakeHarness {
  const config = new FakeConfigFileSystem(world, repositoryRoot, `${repositoryRoot}/deploykit.config.yaml`, source);
  const state = new FakeOperationState(world);
  const output = new RecordingOutput();
  const clock = new FakeClock();
  return {
    world,
    config,
    state,
    output,
    clock,
    deps: {
      github: new FakeGitHub(world),
      administratorSsh: new FakeAdministratorSsh(world),
      gateway: new FakeGatewayTransport(world),
      configFileSystem: config,
      operationState: state,
      clock,
      output,
    },
  };
}

/** Phase 10 owns the real bytes; the digest is all Phase 4 needs. */
export function renderFixtureWorkflow(context: DeploymentContext): string {
  return [
    "# deploykit-owned",
    `name: DeployKit ${context.targetName}`,
    `on: { workflow_dispatch: {} }`,
    `# target: ${context.targetId}`,
    `# manifest: ${context.compiled.digest.value}`,
    "",
  ].join("\n");
}

export function fixtureGatewayAccess(withIdentityFile = true) {
  return (): GatewayAccessFacts => ({
    host: "vps.static.example.test",
    port: 22,
    user: "deploykit-gateway",
    knownHosts: "vps.static.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey",
    secrets: { DEPLOYKIT_GATEWAY_PRIVATE_KEY: GATEWAY_KEY_CANARY },
    ...(withIdentityFile ? { identityFile: "/tmp/deploykit-gateway-key" } : {}),
  });
}
