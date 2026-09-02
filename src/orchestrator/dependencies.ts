import type {
  CompiledRuntimeManifest,
  DeployKitOperatorConfig,
  GatewayHandshakeResult,
  GatewayInputFrame,
  GatewayOutputFrame,
  GitCommitSha,
  GitHubManagedResourceNames,
  GitHubOwnershipMarker,
  LocalOperationRecord,
  ManifestDigest,
  RecoveryAction,
  RequestId,
  RootOwnedGatewayBinding,
  Sha256Hex,
} from "./contracts.js";

/** Repository facts verified through the authenticated GitHub CLI boundary. */
export interface GitHubRepositoryFacts {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly defaultBranchCommitSha: GitCommitSha;
  readonly private: boolean;
  readonly authenticatedActor: string;
  readonly permissions: {
    readonly read: boolean;
    readonly contentsWrite: boolean;
    readonly workflowsWrite: boolean;
    readonly environmentsWrite: boolean;
    readonly deployKeysWrite: boolean;
    readonly pullRequestsWrite: boolean;
  };
}

export interface GitHubResolvedCommit {
  readonly repository: string;
  readonly ref: string;
  readonly commitSha: GitCommitSha;
}

export interface ManagedArtifact {
  readonly path: string;
  readonly contents: string;
  readonly sha256: Sha256Hex;
}

export interface DesiredControlArtifacts {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly targetId: string;
  readonly names: GitHubManagedResourceNames;
  readonly artifacts: readonly ManagedArtifact[];
  readonly ownership: GitHubOwnershipMarker;
}

export interface ControlArtifactsState {
  readonly status: "missing" | "current" | "drifted" | "conflict" | "setup-pull-request";
  readonly defaultBranchCommitSha: GitCommitSha;
  readonly setupPullRequestNumber: number | null;
  readonly setupPullRequestState: "open" | "merged" | "closed" | null;
  readonly workflowDigest: Sha256Hex | null;
  readonly runtimeManifestDigest: ManifestDigest | null;
  readonly ownershipDigest: Sha256Hex | null;
}

export interface DesiredRepositoryDeployKey {
  readonly repository: string;
  readonly title: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
  readonly readOnly: true;
}

export interface RepositoryDeployKeyState {
  readonly status: "missing" | "current" | "conflict";
  readonly keyId: number | null;
  readonly title: string;
  readonly publicKeyFingerprint: string | null;
  readonly readOnly: boolean | null;
}

/** Values in `secrets` are secret-bearing and must be sent to `gh` on stdin. */
export interface DesiredGitHubEnvironment {
  readonly repository: string;
  readonly environment: string;
  readonly targetId: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly generatedSecretNames: readonly string[];
  readonly managedResourceDigest: Sha256Hex;
}

export interface GitHubEnvironmentState {
  readonly status: "missing" | "current" | "drifted" | "conflict";
  readonly environment: string;
  readonly variableNames: readonly string[];
  readonly secretNames: readonly string[];
  readonly generatedSecretNames: readonly string[];
  readonly managedResourceDigest: Sha256Hex | null;
  readonly protection: {
    readonly reviewers: readonly string[];
    readonly waitTimerMinutes: number;
    readonly protectedBranchesOnly: boolean;
  };
}

export interface WorkflowDispatchRequest {
  readonly repository: string;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly requestId: RequestId;
  readonly targetName: string;
  readonly commitSha: GitCommitSha;
  readonly manifestDigest: ManifestDigest;
  /** The freshly verified default-branch commit the workflow is read from. */
  readonly workflowSha: GitCommitSha;
  /** The authenticated GitHub actor the dispatched run must be attributed to. */
  readonly actor: string;
  readonly resume: boolean;
  readonly dryRun: boolean;
}

export interface WorkflowDispatchReceipt {
  readonly requestId: RequestId;
  readonly acceptedAt: string;
}

export interface WorkflowRunIdentity {
  readonly id: number;
  readonly repository: string;
  readonly url: string;
  readonly workflowPath: string;
  readonly event: "workflow_dispatch";
  readonly workflowRef: string;
  readonly workflowSha: GitCommitSha;
  readonly actor: string;
  readonly requestId: RequestId;
  readonly targetName: string;
}

export interface WorkflowRunState extends WorkflowRunIdentity {
  readonly status: "queued" | "waiting" | "in_progress" | "completed";
  readonly conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | null;
}

/** A repository-scoped self-hosted runner GitHub could still route a job to. */
export interface SelfHostedRunnerRegistration {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly busy: boolean;
  readonly labels: readonly string[];
}

export interface GitHubPort {
  inspectRepository(repository: string): Promise<GitHubRepositoryFacts>;
  resolveCommit(repository: string, ref: string): Promise<GitHubResolvedCommit>;
  inspectControlArtifacts(desired: DesiredControlArtifacts): Promise<ControlArtifactsState>;
  reconcileControlArtifacts(desired: DesiredControlArtifacts): Promise<ControlArtifactsState>;
  inspectRepositoryDeployKey(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState>;
  reconcileRepositoryDeployKey(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState>;
  inspectEnvironment(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState>;
  reconcileEnvironment(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState>;
  dispatchWorkflow(request: WorkflowDispatchRequest): Promise<WorkflowDispatchReceipt>;
  findWorkflowRun(request: WorkflowDispatchRequest): Promise<WorkflowRunState | undefined>;
  inspectWorkflowRun(identity: WorkflowRunIdentity): Promise<WorkflowRunState>;

  /**
   * Phase 13's legacy-runner migration. Both are optional so an adapter that
   * predates the migration stays valid; when either is absent the state machine
   * refuses to retire a runner rather than removing one it cannot then prove
   * GitHub has stopped routing to.
   */
  listSelfHostedRunners?(repository: string): Promise<readonly SelfHostedRunnerRegistration[]>;
  deleteSelfHostedRunner?(repository: string, runnerId: number): Promise<void>;
}

export interface AdministratorSshConnection {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly identityFile: string;
  readonly hostKeyFingerprint: string;
}

export interface AdministratorSshPreflight {
  readonly reachable: boolean;
  readonly hostKeyFingerprint: string;
  readonly operatingSystem: "ubuntu-22.04" | "ubuntu-24.04";
  readonly architecture: "amd64" | "arm64";
  readonly administrator: boolean;
}

export interface GatewayBootstrapRequest {
  readonly connection: AdministratorSshConnection;
  readonly binding: RootOwnedGatewayBinding;
  readonly packageFile: string;
  readonly packageName: string;
  readonly packageSha256: Sha256Hex;
  readonly configureFirewall: boolean;
}

export interface GatewayBootstrapResult {
  readonly changed: boolean;
  readonly binding: RootOwnedGatewayBinding;
  readonly handshake: GatewayHandshakeResult;
  readonly repositoryPublicKey: string;
  readonly repositoryPublicKeyFingerprint: string;
}

/** Nonsecret proof that the VPS-held read-only key opens the bound repository. */
export interface RepositoryAccessProofFacts {
  readonly repository: string;
  readonly authenticatedAs: string;
  readonly keyFingerprint: string;
  readonly reachable: true;
}

/**
 * A repository-scoped GitHub Actions runner a DeployKit v0.1.x bootstrap
 * installed on this host as root.
 *
 * `agentId` is the registration id GitHub itself issued, read out of the
 * runner's own `.runner` file, so the host and GitHub are matched by the key
 * both sides already agree on rather than by a reconstructed name.
 */
export interface LegacyRunnerFacts {
  readonly present: boolean;
  readonly root: string | null;
  readonly agentId: number | null;
  readonly agentName: string | null;
  /** The repository URL the runner is registered against, as it recorded it. */
  readonly gitHubUrl: string | null;
  readonly serviceUnit: string | null;
  readonly serviceActive: boolean;
}

export interface LegacyRunnerRetirement {
  readonly stopped: boolean;
  readonly disabled: boolean;
  readonly serviceActive: boolean;
  /** Always true: the runner's directory is kept so the host stays recoverable. */
  readonly filesRetained: true;
  readonly root: string;
}

export interface AdministratorSshPort {
  preflight(connection: AdministratorSshConnection): Promise<AdministratorSshPreflight>;
  inspectGateway(
    connection: AdministratorSshConnection,
    expectedBinding: RootOwnedGatewayBinding,
  ): Promise<GatewayHandshakeResult | undefined>;
  bootstrapGateway(request: GatewayBootstrapRequest): Promise<GatewayBootstrapResult>;
  /**
   * Phase 11's read-only source-key proof. Optional so an adapter that cannot
   * reach GitHub from the host — a hermetic test double — stays valid; when it
   * is present the state machine refuses to continue on an unproven key.
   */
  proveRepositoryAccess?(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
  ): Promise<RepositoryAccessProofFacts>;

  /**
   * Phase 13's legacy-runner migration. Read-only; it installs nothing and
   * removes nothing. Optional for the same reason as above.
   */
  inspectLegacyRunner?(
    connection: AdministratorSshConnection,
    repository: string,
  ): Promise<LegacyRunnerFacts>;

  /**
   * Stops and disables the legacy runner's service. Its directory, work tree,
   * registration file, and logs are deliberately left in place so an operator
   * can restore the old path if the migration has to be undone.
   */
  retireLegacyRunner?(
    connection: AdministratorSshConnection,
    facts: LegacyRunnerFacts,
  ): Promise<LegacyRunnerRetirement>;
}

export interface GatewayConnection {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly identityFile: string;
  readonly knownHosts: string;
}

export interface GatewayExchange {
  readonly connection: GatewayConnection;
  readonly frames: AsyncIterable<GatewayInputFrame>;
}

export interface GatewayTransportPort {
  exchange(request: GatewayExchange): AsyncIterable<GatewayOutputFrame>;
}

export interface ConfigScaffoldRequest {
  readonly cwd: string;
  readonly configPath?: string;
}

export interface ConfigScaffoldResult {
  readonly status: "created" | "existing";
  readonly repositoryRoot: string;
  readonly configPath: string;
  readonly excludePath: string;
}

export interface SecureConfigReadResult {
  readonly repositoryRoot: string;
  readonly configPath: string;
  readonly source: string;
  readonly mode: 0o600;
  readonly ownerUid: number;
  readonly ignored: true;
  readonly tracked: false;
  readonly staged: false;
}

export interface ConfigConfirmationResult {
  readonly confirmed: boolean;
  readonly interactive: boolean;
}

export interface ConfigFileSystemPort {
  scaffold(request: ConfigScaffoldRequest): Promise<ConfigScaffoldResult>;
  secureRead(configPath: string): Promise<SecureConfigReadResult>;
  waitForConfirmation(configPath: string): Promise<ConfigConfirmationResult>;
}

export interface OperationStateKey {
  readonly repository: string;
  readonly targetId: string;
}

export interface OperationStatePort {
  read(key: OperationStateKey): Promise<LocalOperationRecord | undefined>;
  write(record: LocalOperationRecord): Promise<void>;
}

export interface ClockPort {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export type OrchestratorProgressPhase =
  | "config"
  | "preflight"
  | "commit"
  | "control-artifacts"
  | "gateway"
  | "legacy-runner"
  | "repository-key"
  | "environment"
  | "readiness"
  | "dispatch"
  | "workflow"
  | "inspect"
  | "complete";

export interface OrchestratorProgressEvent {
  readonly time: string;
  readonly level: "info" | "warning";
  readonly code: string;
  readonly phase: OrchestratorProgressPhase;
  readonly message: string;
}

export interface OrchestratorResult {
  readonly outcome:
    | "config-created"
    | "waiting-for-review"
    | "dispatched"
    | "dry-run"
    | "failed"
    | "succeeded";
  readonly requestId: RequestId | null;
  readonly repository: string | null;
  readonly targetName: string | null;
  readonly commitSha: GitCommitSha | null;
  readonly manifestDigest: ManifestDigest | null;
  readonly setupPullRequestNumber: number | null;
  readonly workflowRunId: number | null;
  /** The GitHub run page, so an operator never needs raw workflow logs. */
  readonly workflowRunUrl: string | null;
  readonly httpsUrl: string | null;
  readonly ports: readonly {
    readonly service: string;
    readonly address: "127.0.0.1";
    readonly port: number;
  }[];
  readonly healthy: boolean | null;
  readonly recovery: RecoveryAction;
}

export interface OutputPort {
  progress(event: OrchestratorProgressEvent): void | Promise<void>;
  result(result: OrchestratorResult): void | Promise<void>;
}

/** Fully injected boundary used by the future pure orchestration state machine. */
export interface OrchestratorDependencies {
  readonly github: GitHubPort;
  readonly administratorSsh: AdministratorSshPort;
  readonly gateway: GatewayTransportPort;
  readonly configFileSystem: ConfigFileSystemPort;
  readonly operationState: OperationStatePort;
  readonly clock: ClockPort;
  readonly output: OutputPort;
}

/** Parsed/compiled values held in memory; never persist this object as a whole. */
export interface LoadedDeploymentInput {
  readonly config: DeployKitOperatorConfig;
  readonly manifest: CompiledRuntimeManifest;
  readonly manifestDigest: ManifestDigest;
}
