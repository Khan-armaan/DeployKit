import type { ErrorCode } from "../errors.js";

/**
 * Phase 1 freezes data exchanged across orchestration trust boundaries. These
 * declarations intentionally contain no parsing, persistence, or transport
 * behavior; later phases must validate untrusted values before constructing
 * them.
 */

export const OPERATOR_CONFIG_API_VERSION = "deploykit/config/v1alpha1" as const;
export const RUNTIME_MANIFEST_API_VERSION = "deploykit/runtime/v1alpha1" as const;
export const MANIFEST_DIGEST_API_VERSION = "deploykit/digest/v1alpha1" as const;
export const GATEWAY_PROTOCOL_VERSION = "deploykit/gateway/v1alpha1" as const;
export const GATEWAY_BINDING_API_VERSION = "deploykit/gateway-binding/v1alpha1" as const;
export const DEPLOYMENT_IDENTITY_API_VERSION = "deploykit/deployment-identity/v1alpha1" as const;
export const GITHUB_OWNERSHIP_API_VERSION = "deploykit/github-ownership/v1alpha1" as const;
export const OPERATION_RECORD_API_VERSION = "deploykit/operation/v1alpha1" as const;

/**
 * Canonical runtime bytes are UTF-8 YAML 1.2, use two-space indentation and LF
 * line endings, end in one LF, contain no aliases/tags/comments, and emit every
 * object key in the frozen contract order followed by remaining map keys in
 * ascending Unicode code-point order. Array ordering is supplied by the
 * normalized runtime manifest contract and is never changed by serialization.
 */
export const RUNTIME_MANIFEST_CANONICALIZATION =
  "deploykit/runtime-yaml-canonical/v1" as const;

export const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
export const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type GitCommitSha = string;
export type Sha256Hex = string;
export type RequestId = string;

export const GATEWAY_PROTOCOL_LIMITS = Object.freeze({
  maxRequestFrameBytes: 32 * 1024,
  maxManifestBytes: 2 * 1024 * 1024,
  maxSecretFrames: 256,
  maxSecretNameBytes: 128,
  maxSecretValueBytes: 256 * 1024,
  maxTotalSecretBytes: 8 * 1024 * 1024,
  maxFrameBytes: 3 * 1024 * 1024,
  maxInputBytes: 12 * 1024 * 1024,
  maxProgressEventBytes: 64 * 1024,
  maxProgressEvents: 10_000,
  maxResultBytes: 256 * 1024,
} as const);

export const CONTRACT_KEY_ORDER = Object.freeze({
  operatorConfig: ["apiVersion", "kind", "project", "target", "server", "compose", "services", "frontend", "routes", "database", "environment"],
  runtimeManifest: ["apiVersion", "metadata", "target", "compose", "services", "frontend", "routes", "database", "secrets"],
  manifestDigest: ["apiVersion", "algorithm", "encoding", "canonicalization", "value"],
  gatewayRequestFrame: ["protocolVersion", "frame", "requestId", "operation", "repository", "githubEnvironment", "targetName", "targetId", "applicationRef", "commitSha", "manifestDigest", "expectedPayload", "flags"],
  gatewayManifestFrame: ["protocolVersion", "frame", "requestId", "mediaType", "encoding", "byteLength", "digest", "payload"],
  gatewaySecretFrame: ["protocolVersion", "frame", "requestId", "name", "encoding", "byteLength", "payload"],
  gatewayEndFrame: ["protocolVersion", "frame", "requestId", "manifestFrames", "secretFrames", "payloadBytes"],
  gatewayProgressEvent: ["protocolVersion", "frame", "requestId", "sequence", "time", "level", "phase", "code", "message"],
  gatewayResult: ["protocolVersion", "frame", "requestId", "sequence", "time", "ok", "code", "recovery", "result"],
  gatewayBinding: ["apiVersion", "bindingId", "repository", "githubEnvironment", "targetName", "targetId", "gatewayUser", "forcedCommand", "runtimeVersion", "runtimeBundleSha256", "repositoryKeyId", "repositoryKeyFingerprint", "activeGatewayKeyId", "pendingGatewayKeyId"],
  deploymentIdentity: ["apiVersion", "targetId", "commitSha", "manifestDigest"],
  githubOwnership: ["apiVersion", "owner", "repository", "targetName", "targetId", "githubEnvironment", "managed", "workflowDigest", "runtimeManifestDigest"],
  operationRecord: ["apiVersion", "requestId", "repository", "targetName", "targetId", "commitSha", "manifestDigest", "status", "setupPullRequestNumber", "workflowRunId", "readiness", "lastFailure", "createdAt", "updatedAt"],
} as const);

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type HostPortInput = "auto" | number;

export interface HealthTimingInput {
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly retries?: number;
  readonly startPeriodSeconds?: number;
}

export interface HttpHealthCheckInput extends HealthTimingInput {
  readonly type: "http";
  readonly path: string;
  readonly port?: number;
  readonly expectedStatuses?: readonly number[];
}

export interface TcpHealthCheckInput extends HealthTimingInput {
  readonly type: "tcp";
  readonly port?: number;
}

export interface CommandHealthCheckInput extends HealthTimingInput {
  readonly type: "command";
  readonly command: readonly string[];
}

export interface ProcessHealthCheckInput extends HealthTimingInput {
  readonly type: "process";
}

export type HealthCheckInput =
  | HttpHealthCheckInput
  | TcpHealthCheckInput
  | CommandHealthCheckInput
  | ProcessHealthCheckInput;

export interface OperatorComposeService {
  readonly type: "compose";
  readonly service: string;
  readonly internalPort: number;
  readonly hostPort?: HostPortInput;
  readonly healthCheck: HealthCheckInput;
}

interface OperatorPm2ServiceBase {
  readonly type: "pm2";
  readonly workingDirectory?: string;
  readonly nodeVersion: string;
  readonly packageManager: PackageManager;
  readonly installCommand?: readonly string[];
  readonly buildScript?: string;
  readonly startScript: string;
  readonly healthCheck: HealthCheckInput;
}

export interface OperatorPm2NetworkService extends OperatorPm2ServiceBase {
  readonly role: "api" | "ssr";
  readonly portEnvironmentVariable: string;
  readonly hostPort?: HostPortInput;
}

export interface OperatorPm2WorkerService extends OperatorPm2ServiceBase {
  readonly role: "worker";
}

export type OperatorPm2Service = OperatorPm2NetworkService | OperatorPm2WorkerService;

export type OperatorService = OperatorComposeService | OperatorPm2Service;

export interface OperatorStaticFrontend {
  readonly type: "static";
  readonly workingDirectory?: string;
  readonly nodeVersion: string;
  readonly packageManager: PackageManager;
  readonly installCommand?: readonly string[];
  readonly buildScript?: string;
  readonly outputDirectory: string;
  readonly spaFallback?: boolean;
}

export interface OperatorServiceFrontend {
  readonly type: "service";
  readonly service: string;
}

export type OperatorFrontend = OperatorStaticFrontend | OperatorServiceFrontend;

export interface OperatorRoute {
  readonly hostname?: "@primary" | string;
  readonly path: string;
  readonly match?: "exact" | "prefix";
  readonly target: string;
  readonly preservePrefix?: boolean;
  readonly websocket?: boolean;
  readonly sse?: boolean;
  readonly buffering?: boolean;
  readonly requestBuffering?: boolean;
  readonly uploadLimit?: string;
  readonly timeouts?: {
    readonly connect?: number;
    readonly send?: number;
    readonly read?: number;
  };
}

export interface OperatorDeploymentHook {
  readonly service: string;
  readonly command: readonly string[];
}

export interface OperatorComposeDatabase {
  readonly type: "compose";
  readonly service: string;
  readonly internalPort?: number;
  readonly consumers: readonly string[];
  readonly volume: string;
  readonly credentials: {
    readonly username: string;
    readonly database: string;
    readonly passwordSecret: string;
    readonly connectionStringSecret?: string;
    readonly connectionStringTemplate?: string;
  };
  readonly migrations?: OperatorDeploymentHook;
  readonly seed?: OperatorDeploymentHook;
}

export interface OperatorExternalDatabase {
  readonly type: "external";
  readonly connectionStringSecret: string;
  readonly tlsCaSecret?: string;
  readonly requireTls?: boolean;
}

export type OperatorDatabase = OperatorComposeDatabase | OperatorExternalDatabase;

/** The only hand-edited, secret-bearing deployment input. */
export interface DeployKitOperatorConfig {
  readonly apiVersion: typeof OPERATOR_CONFIG_API_VERSION;
  readonly kind: "Deployment";
  readonly project: {
    readonly name: string;
    readonly repository: string;
    readonly ref: string;
  };
  readonly target: {
    readonly name: string;
    readonly githubEnvironment: string;
    readonly primaryDomain: string;
    readonly aliases?: readonly string[];
  };
  readonly server: {
    readonly host: string;
    readonly user: string;
    readonly port: number;
    readonly identityFile: string;
    readonly hostKeyFingerprint: string;
    readonly configureFirewall?: boolean;
  };
  readonly compose?: {
    readonly files: readonly string[];
  };
  readonly services: Readonly<Record<string, OperatorService>>;
  readonly frontend?: OperatorFrontend;
  readonly routes?: readonly OperatorRoute[];
  readonly database?: OperatorDatabase;
  readonly environment: {
    readonly frontend: Readonly<Record<string, string>>;
    readonly backend: Readonly<Record<string, string>>;
    readonly generated: readonly string[];
  };
}

export interface RuntimeHealthTiming {
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly retries: number;
  readonly startPeriodSeconds: number;
}

export interface RuntimeHttpHealthCheck extends RuntimeHealthTiming {
  readonly type: "http";
  readonly path: string;
  readonly port?: number;
  readonly expectedStatuses: readonly number[];
}

export interface RuntimeTcpHealthCheck extends RuntimeHealthTiming {
  readonly type: "tcp";
  readonly port?: number;
}

export interface RuntimeCommandHealthCheck extends RuntimeHealthTiming {
  readonly type: "command";
  readonly command: readonly string[];
}

export interface RuntimeProcessHealthCheck extends RuntimeHealthTiming {
  readonly type: "process";
}

export type RuntimeHealthCheck =
  | RuntimeHttpHealthCheck
  | RuntimeTcpHealthCheck
  | RuntimeCommandHealthCheck
  | RuntimeProcessHealthCheck;

export interface RuntimeComposeService {
  readonly type: "compose";
  readonly service: string;
  readonly internalPort: number;
  /** Absent means the server allocates the port. */
  readonly hostPort?: number;
  readonly healthCheck: RuntimeHealthCheck;
}

interface RuntimePm2ServiceBase {
  readonly type: "pm2";
  readonly workingDirectory: string;
  readonly nodeVersion: string;
  readonly packageManager: PackageManager;
  readonly installCommand?: readonly string[];
  readonly buildScript?: string;
  readonly startScript: string;
  readonly healthCheck: RuntimeHealthCheck;
}

export interface RuntimePm2NetworkService extends RuntimePm2ServiceBase {
  readonly role: "api" | "ssr";
  readonly portEnvironmentVariable: string;
  /** Absent means the server allocates the port. */
  readonly hostPort?: number;
}

export interface RuntimePm2WorkerService extends RuntimePm2ServiceBase {
  readonly role: "worker";
}

export type RuntimePm2Service = RuntimePm2NetworkService | RuntimePm2WorkerService;

export type RuntimeService = RuntimeComposeService | RuntimePm2Service;

export interface RuntimeStaticFrontend {
  readonly type: "static";
  readonly workingDirectory: string;
  readonly nodeVersion: string;
  readonly packageManager: PackageManager;
  readonly installCommand?: readonly string[];
  readonly buildScript: string;
  readonly outputDirectory: string;
  readonly spaFallback: boolean;
  readonly publicEnvironment: Readonly<Record<string, string>>;
}

export interface RuntimeServiceFrontend {
  readonly type: "service";
  readonly service: string;
  /**
   * Public build/runtime values for a containerized or server-rendered
   * frontend. Public by construction: `environment.frontend` refuses
   * secret-like names, and secret values never reach this contract.
   */
  readonly publicEnvironment: Readonly<Record<string, string>>;
}

export type RuntimeFrontend = RuntimeStaticFrontend | RuntimeServiceFrontend;

export interface RuntimeRoute {
  readonly hostname: "@primary" | string;
  readonly path: string;
  readonly match: "exact" | "prefix";
  readonly target: string;
  readonly preservePrefix: boolean;
  readonly websocket: boolean;
  readonly sse: boolean;
  readonly buffering: boolean;
  readonly requestBuffering: boolean;
  readonly uploadLimit?: string;
  readonly timeouts: {
    readonly connect: number;
    readonly send: number;
    readonly read: number;
  };
}

export interface RuntimeDeploymentHook {
  readonly service: string;
  readonly command: readonly string[];
}

export interface RuntimeComposeDatabase {
  readonly type: "compose";
  readonly service: string;
  readonly internalPort?: number;
  readonly consumers: readonly string[];
  readonly volume: string;
  readonly credentials: {
    readonly username: string;
    readonly database: string;
    readonly passwordSecret: string;
    readonly connectionStringSecret?: string;
    readonly connectionStringTemplate?: string;
  };
  readonly migrations?: RuntimeDeploymentHook;
  readonly seed?: RuntimeDeploymentHook;
}

export interface RuntimeExternalDatabase {
  readonly type: "external";
  readonly connectionStringSecret: string;
  readonly tlsCaSecret?: string;
  readonly requireTls: boolean;
}

export type RuntimeDatabase = RuntimeComposeDatabase | RuntimeExternalDatabase;

/** Normalized server input. It contains public values and secret names only. */
export interface CompiledRuntimeManifest {
  readonly apiVersion: typeof RUNTIME_MANIFEST_API_VERSION;
  readonly metadata: {
    readonly name: string;
    readonly requiredVersion: string;
  };
  readonly target: {
    readonly name: string;
    readonly targetId: string;
    readonly githubEnvironment: string;
    readonly primaryDomain: string;
    readonly aliases: readonly string[];
  };
  readonly compose?: {
    readonly files: readonly string[];
  };
  readonly services: Readonly<Record<string, RuntimeService>>;
  readonly frontend?: RuntimeFrontend;
  readonly routes: readonly RuntimeRoute[];
  readonly database?: RuntimeDatabase;
  readonly secrets: {
    readonly required: readonly string[];
    readonly generated: readonly string[];
  };
}

export interface ManifestDigest {
  readonly apiVersion: typeof MANIFEST_DIGEST_API_VERSION;
  readonly algorithm: "sha256";
  readonly encoding: "hex";
  readonly canonicalization: typeof RUNTIME_MANIFEST_CANONICALIZATION;
  readonly value: Sha256Hex;
}

export type GatewayOperation = "handshake" | "apply" | "retry" | "inspect";

interface GatewayRequestFrameBase {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "request";
  readonly requestId: RequestId;
  readonly repository: string;
  readonly githubEnvironment: string;
  readonly targetName: string;
  readonly targetId: string;
}

export interface GatewayExpectedPayload {
  readonly manifestFrames: 0 | 1;
  readonly manifestBytes: number;
  readonly secretFrames: number;
  readonly secretBytes: number;
}

export interface GatewayHandshakeRequestFrame extends GatewayRequestFrameBase {
  readonly operation: "handshake";
  readonly applicationRef: null;
  readonly commitSha: null;
  readonly manifestDigest: null;
  readonly expectedPayload: {
    readonly manifestFrames: 0;
    readonly manifestBytes: 0;
    readonly secretFrames: 0;
    readonly secretBytes: 0;
  };
  readonly flags: { readonly dryRun: false };
}

export interface GatewayInspectRequestFrame extends GatewayRequestFrameBase {
  readonly operation: "inspect";
  readonly applicationRef: null;
  readonly commitSha: GitCommitSha | null;
  readonly manifestDigest: ManifestDigest | null;
  readonly expectedPayload: {
    readonly manifestFrames: 0;
    readonly manifestBytes: 0;
    readonly secretFrames: 0;
    readonly secretBytes: 0;
  };
  readonly flags: { readonly dryRun: false };
}

export interface GatewayMutationRequestFrame extends GatewayRequestFrameBase {
  readonly operation: "apply" | "retry";
  readonly applicationRef: string;
  readonly commitSha: GitCommitSha;
  readonly manifestDigest: ManifestDigest;
  readonly expectedPayload: GatewayExpectedPayload & { readonly manifestFrames: 1 };
  readonly flags: { readonly dryRun: boolean };
}

export type GatewayRequestFrame =
  | GatewayHandshakeRequestFrame
  | GatewayInspectRequestFrame
  | GatewayMutationRequestFrame;

export interface GatewayManifestFrame {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "manifest";
  readonly requestId: RequestId;
  readonly mediaType: "application/yaml";
  readonly encoding: "base64";
  readonly byteLength: number;
  readonly digest: ManifestDigest;
  readonly payload: string;
}

/** Secret-bearing and valid only in the transient gateway input stream. */
export interface GatewaySecretFrame {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "secret";
  readonly requestId: RequestId;
  readonly name: string;
  readonly encoding: "base64";
  readonly byteLength: number;
  readonly payload: string;
}

export interface GatewayEndFrame {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "end";
  readonly requestId: RequestId;
  readonly manifestFrames: 0 | 1;
  readonly secretFrames: number;
  readonly payloadBytes: number;
}

export type GatewayInputFrame =
  | GatewayRequestFrame
  | GatewayManifestFrame
  | GatewaySecretFrame
  | GatewayEndFrame;

export type GatewayProgressPhase =
  | "handshake"
  | "request-validated"
  | "binding-verified"
  | "manifest-validated"
  | "dns-verified"
  | "resources-reserved"
  | "source-staged"
  | "workloads-ready"
  | "migrations-complete"
  | "health-verified"
  | "proxy-staged"
  | "tls-issued"
  | "activated"
  | "complete";

/** Progress is deliberately narrow: arbitrary data and raw logs are excluded. */
export interface GatewayProgressEvent {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "progress";
  readonly requestId: RequestId;
  readonly sequence: number;
  readonly time: string;
  readonly level: "info" | "warning";
  readonly phase: GatewayProgressPhase;
  readonly code: string;
  readonly message: string;
}

export type RecoveryAction =
  | "edit-config-and-rerun"
  | "secure-config-and-rerun"
  | "rerun-same-command"
  | "review-setup-pull-request"
  | "wait-and-rerun"
  | "resolve-ownership-conflict"
  | "restore-same-sha-and-digest"
  | "migrate-legacy-state"
  | "repair-vps-and-rerun"
  | "reauthenticate-github-and-rerun"
  | "verify-ssh-host-key-and-rerun"
  | "not-resumable"
  | "none";

export interface AllocatedPortResult {
  readonly service: string;
  readonly address: "127.0.0.1";
  readonly port: number;
}

export interface HealthResult {
  readonly service: string;
  readonly healthy: boolean;
  readonly check: "http" | "tcp" | "command" | "process";
}

export interface GatewayHandshakeResult {
  readonly kind: "handshake";
  readonly bindingId: string;
  readonly targetId: string;
  readonly runtimeVersion: string;
  readonly runtimeBundleSha256: Sha256Hex;
  readonly capabilities: readonly GatewayOperation[];
}

export interface GatewayDeploymentResult {
  readonly kind: "deployment";
  readonly outcome: "not-deployed" | "running" | "failed" | "succeeded" | "dry-run";
  readonly targetName: string;
  readonly targetId: string;
  readonly commitSha: GitCommitSha | null;
  readonly manifestDigest: ManifestDigest | null;
  readonly phase: GatewayProgressPhase | null;
  readonly domains: readonly string[];
  readonly ports: readonly AllocatedPortResult[];
  readonly health: readonly HealthResult[];
  readonly resumed: boolean;
  readonly failureCode: string | null;
}

export type GatewayResultPayload = GatewayHandshakeResult | GatewayDeploymentResult;

export interface GatewaySuccessResultFrame {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "result";
  readonly requestId: RequestId;
  readonly sequence: number;
  readonly time: string;
  readonly ok: true;
  readonly code: "DK_GATEWAY_OK";
  readonly recovery: "none";
  readonly result: GatewayResultPayload;
}

/** A malformed stream may fail before its request UUID can be trusted. */
export interface GatewayFailureResultFrame {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly frame: "result";
  readonly requestId: RequestId | null;
  readonly sequence: number;
  readonly time: string;
  readonly ok: false;
  readonly code: ErrorCode;
  readonly recovery: Exclude<RecoveryAction, "none">;
  readonly result: GatewayDeploymentResult | null;
}

export type GatewayResultFrame = GatewaySuccessResultFrame | GatewayFailureResultFrame;

export type GatewayOutputFrame = GatewayProgressEvent | GatewayResultFrame;

export const GATEWAY_USER = "deploykit-gateway" as const;
export const GATEWAY_FORCED_COMMAND = "deploykit gateway" as const;

export interface RootOwnedGatewayBinding {
  readonly apiVersion: typeof GATEWAY_BINDING_API_VERSION;
  readonly bindingId: string;
  readonly repository: string;
  readonly githubEnvironment: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly gatewayUser: typeof GATEWAY_USER;
  readonly forcedCommand: typeof GATEWAY_FORCED_COMMAND;
  readonly runtimeVersion: string;
  readonly runtimeBundleSha256: Sha256Hex;
  readonly repositoryKeyId: string;
  readonly repositoryKeyFingerprint: string;
  readonly activeGatewayKeyId: string | null;
  readonly pendingGatewayKeyId: string | null;
}

export interface DeploymentStateIdentity {
  readonly apiVersion: typeof DEPLOYMENT_IDENTITY_API_VERSION;
  readonly targetId: string;
  readonly commitSha: GitCommitSha;
  readonly manifestDigest: ManifestDigest;
}

export const MANAGED_WORKFLOW_PATH = ".github/workflows/deploykit.yml" as const;
export const MANAGED_RUNTIME_MANIFEST_PATH = ".github/deploykit/manifest.yaml" as const;
export const MANAGED_OWNERSHIP_PATH = ".github/deploykit/ownership.json" as const;
export const MANAGED_SETUP_BRANCH_PREFIX = "deploykit/setup-" as const;
export const MANAGED_SETUP_PULL_REQUEST_TITLE_PREFIX = "DeployKit setup: " as const;
export const MANAGED_REPOSITORY_KEY_TITLE_PREFIX = "DeployKit repository key: " as const;
export const MANAGED_GATEWAY_PRIVATE_KEY_SECRET = "DEPLOYKIT_GATEWAY_PRIVATE_KEY" as const;
export const MANAGED_GATEWAY_HOST_VARIABLE = "DEPLOYKIT_GATEWAY_HOST" as const;
export const MANAGED_GATEWAY_PORT_VARIABLE = "DEPLOYKIT_GATEWAY_PORT" as const;
export const MANAGED_GATEWAY_USER_VARIABLE = "DEPLOYKIT_GATEWAY_USER" as const;
export const MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE = "DEPLOYKIT_GATEWAY_KNOWN_HOSTS" as const;
export const MANAGED_TARGET_ID_VARIABLE = "DEPLOYKIT_TARGET_ID" as const;

export interface GitHubManagedResourceNames {
  readonly workflowPath: typeof MANAGED_WORKFLOW_PATH;
  readonly runtimeManifestPath: typeof MANAGED_RUNTIME_MANIFEST_PATH;
  readonly ownershipPath: typeof MANAGED_OWNERSHIP_PATH;
  readonly setupBranch: string;
  readonly setupPullRequestTitle: string;
  readonly repositoryDeployKeyTitle: string;
  readonly gatewayPrivateKeySecret: typeof MANAGED_GATEWAY_PRIVATE_KEY_SECRET;
  readonly gatewayHostVariable: typeof MANAGED_GATEWAY_HOST_VARIABLE;
  readonly gatewayPortVariable: typeof MANAGED_GATEWAY_PORT_VARIABLE;
  readonly gatewayUserVariable: typeof MANAGED_GATEWAY_USER_VARIABLE;
  readonly gatewayKnownHostsVariable: typeof MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE;
  readonly targetIdVariable: typeof MANAGED_TARGET_ID_VARIABLE;
}

export interface GitHubOwnershipMarker {
  readonly apiVersion: typeof GITHUB_OWNERSHIP_API_VERSION;
  readonly owner: "deploykit";
  readonly repository: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly githubEnvironment: string;
  readonly managed: {
    readonly names: GitHubManagedResourceNames;
    readonly files: readonly [
      typeof MANAGED_WORKFLOW_PATH,
      typeof MANAGED_RUNTIME_MANIFEST_PATH,
      typeof MANAGED_OWNERSHIP_PATH,
    ];
    readonly frontendVariables: readonly string[];
    readonly backendSecrets: readonly string[];
    readonly generatedSecrets: readonly string[];
  };
  readonly workflowDigest: Sha256Hex;
  readonly runtimeManifestDigest: ManifestDigest;
}

export type LocalOperationStatus = "pending" | "waiting" | "running" | "failed" | "completed";

export interface ControlArtifactsReadiness {
  readonly ready: boolean;
  readonly defaultBranchCommitSha: GitCommitSha | null;
  readonly workflowDigest: Sha256Hex | null;
  readonly runtimeManifestDigest: ManifestDigest | null;
  readonly ownershipDigest: Sha256Hex | null;
}

export interface GatewayReadiness {
  readonly ready: boolean;
  readonly bindingId: string | null;
  readonly bindingDigest: Sha256Hex | null;
  readonly runtimeVersion: string | null;
  readonly runtimeBundleSha256: Sha256Hex | null;
}

export interface RepositoryKeyReadiness {
  readonly ready: boolean;
  readonly deployKeyId: number | null;
  readonly publicKeyFingerprint: string | null;
}

export interface EnvironmentReadiness {
  readonly ready: boolean;
  readonly managedResourceDigest: Sha256Hex | null;
}

export interface DispatchReadiness {
  readonly ready: boolean;
  readonly requestId: RequestId | null;
  readonly workflowRunId: number | null;
}

export interface OperationReadiness {
  readonly controlArtifacts: ControlArtifactsReadiness;
  readonly gateway: GatewayReadiness;
  readonly repositoryKey: RepositoryKeyReadiness;
  readonly environment: EnvironmentReadiness;
  readonly dispatch: DispatchReadiness;
}

export interface OperationFailureRecord {
  readonly code: ErrorCode;
  readonly recovery: RecoveryAction;
  readonly failedAt: string;
}

/** A non-authoritative, secret-free local cache of orchestration progress. */
export interface LocalOperationRecord {
  readonly apiVersion: typeof OPERATION_RECORD_API_VERSION;
  readonly requestId: RequestId;
  readonly repository: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly commitSha: GitCommitSha;
  readonly manifestDigest: ManifestDigest;
  readonly status: LocalOperationStatus;
  readonly setupPullRequestNumber: number | null;
  readonly workflowRunId: number | null;
  readonly readiness: OperationReadiness;
  readonly lastFailure: OperationFailureRecord | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
