import { randomUUID } from "node:crypto";

import { DeployKitError, type ErrorCode } from "../errors.js";
import { registerRedactedValues } from "../output.js";
import { compileRuntimeManifest, type CompiledDeployment } from "./compile.js";
import { parseConfigDocument } from "./config.js";
import { parseOperatorConfig, type EnvironmentPartition } from "./config-schema.js";
import {
  GATEWAY_PROTOCOL_VERSION,
  GIT_COMMIT_SHA_PATTERN,
  OPERATION_RECORD_API_VERSION,
  REQUEST_ID_PATTERN,
  SHA256_HEX_PATTERN,
  type ControlArtifactsReadiness,
  type DeployKitOperatorConfig,
  type EnvironmentReadiness,
  type GatewayDeploymentResult,
  type GatewayHandshakeResult,
  type GatewayInputFrame,
  type GatewayReadiness,
  type GatewayResultFrame,
  type GitCommitSha,
  type LocalOperationRecord,
  type LocalOperationStatus,
  type ManifestDigest,
  type OperationReadiness,
  type RecoveryAction,
  type RepositoryKeyReadiness,
  type RequestId,
  type RootOwnedGatewayBinding,
} from "./contracts.js";
import type {
  AdministratorSshConnection,
  ControlArtifactsState,
  DesiredControlArtifacts,
  DesiredGitHubEnvironment,
  DesiredRepositoryDeployKey,
  GatewayConnection,
  GitHubEnvironmentState,
  GitHubRepositoryFacts,
  OrchestratorDependencies,
  OrchestratorProgressPhase,
  OrchestratorResult,
  RepositoryDeployKeyState,
  WorkflowDispatchRequest,
  WorkflowRunState,
} from "./dependencies.js";
import { orchestratorError } from "./failures.js";
import {
  createDesiredStatePlanner,
  gatewayBindingIdentityDigest,
  makeManagedResourceNames,
  type DeploymentContext,
  type DesiredStatePlanner,
  type GatewayAccessFacts,
  type RuntimeBundleReference,
} from "./planner.js";
import { validateCompiledProject } from "./project.js";
import { createManagedWorkflowRenderer } from "./workflow.js";

/**
 * Phase 4: the dependency-injected orchestration state machine.
 *
 * The design rule that shapes everything below is that **authoritative state
 * lives in GitHub and on the VPS, never in the local operation record**. Each
 * step inspects the real resource, reconciles only when the inspection says it
 * must, and re-inspects before the single irreversible action (workflow
 * dispatch). The local record is a hint that lets a rerun explain itself and
 * correlate a run by request ID; deleting or corrupting it costs nothing,
 * because every readiness fact is re-derived from the outside world.
 *
 * That is also why reruns cannot duplicate a resource: "already reconciled" is
 * decided by comparing an inspection against desired state that is a pure
 * function of the compiled deployment, and a dispatch is skipped whenever the
 * GitHub adapter can correlate an existing run for the same deployment
 * identity — request ID *or* (target, commit SHA, manifest digest).
 *
 * This module performs no I/O of its own beyond reading the application tree
 * during project validation: GitHub, SSH, the gateway, the config file, the
 * operation record, time, and output all arrive through
 * {@link OrchestratorDependencies}. Phase 4 exercises it only with fakes; it is
 * not reachable from `deploykit deploy` until Phase 13.
 */

// ------------------------------------------------------------------ options --

/**
 * Correlation and waiting are bounded so a hung external system fails with a
 * stable resumable code instead of blocking forever. Defaults assume the caller
 * wants a real deployment followed to completion.
 */
export interface OrchestratorPollingOptions {
  readonly intervalMs?: number;
  readonly correlationAttempts?: number;
  readonly runAttempts?: number;
}

export interface OrchestratorRunOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  /** Inspect everything, reconcile nothing, dispatch nothing, persist nothing. */
  readonly dryRun?: boolean;
  /** Dispatch and correlate the run, then return without following it. */
  readonly noWait?: boolean;
  readonly requestId?: RequestId;
  readonly newRequestId?: () => RequestId;
  /** Desired-state builder. Defaults require {@link renderWorkflow}. */
  readonly planner?: DesiredStatePlanner;
  /** Phase 10 owns the managed workflow bytes. */
  readonly renderWorkflow?: (context: DeploymentContext) => string;
  /** Phase 8 owns the checksum-verified standalone server bundle. */
  readonly runtimeBundle: RuntimeBundleReference;
  /** Phase 8/11 own gateway host facts and the gateway Environment secret. */
  readonly gatewayAccess: GatewayAccessProvider;
  /** Runs the existing filesystem/package/Compose project checks. Default on. */
  readonly validateSource?: boolean;
  readonly inspectComposeConfig?: boolean;
  readonly requiredVersion?: string;
  readonly polling?: OrchestratorPollingOptions;
}

/**
 * Everything a provider needs to reach the host it is being asked about. The
 * first two arguments are passed positionally as well, so a provider that only
 * needs the deployment context keeps its original shape.
 */
export interface GatewayAccessRequest {
  readonly context: DeploymentContext;
  readonly handshake: GatewayHandshakeResult;
  readonly connection: AdministratorSshConnection;
  readonly binding: RootOwnedGatewayBinding;
  /** The VPS-held read-only key this run proved, when it proved one. */
  readonly repositoryKeyFingerprint: string | null;
  /** True when nothing may be staged, uploaded, or rotated. */
  readonly dryRun: boolean;
}

/**
 * A gateway key that has been staged and proven but is not yet the host's
 * active entry. `activate` is called once the Environment holds the uploaded
 * private key, and `dispose` always runs before the invocation returns —
 * success, failure, or dry run — so the local private key never outlives it.
 */
export interface GatewayAccessSession {
  readonly facts: GatewayAccessFacts;
  activate?(): Promise<void>;
  dispose?(): Promise<void>;
}

export type GatewayAccessProvider = (
  context: DeploymentContext,
  handshake: GatewayHandshakeResult,
  request: GatewayAccessRequest,
) =>
  | Promise<GatewayAccessFacts | GatewayAccessSession>
  | GatewayAccessFacts
  | GatewayAccessSession;

function asGatewayAccessSession(
  value: GatewayAccessFacts | GatewayAccessSession,
): GatewayAccessSession {
  return "facts" in value ? value : { facts: value };
}

const DEFAULT_POLLING = Object.freeze({
  intervalMs: 5_000,
  correlationAttempts: 24,
  runAttempts: 720,
});

// --------------------------------------------------------------- operation --

/** Readiness before anything has been verified in this run. */
const UNVERIFIED_READINESS: OperationReadiness = Object.freeze({
  controlArtifacts: Object.freeze({
    ready: false,
    defaultBranchCommitSha: null,
    workflowDigest: null,
    runtimeManifestDigest: null,
    ownershipDigest: null,
  }) as ControlArtifactsReadiness,
  gateway: Object.freeze({
    ready: false,
    bindingId: null,
    bindingDigest: null,
    runtimeVersion: null,
    runtimeBundleSha256: null,
  }) as GatewayReadiness,
  repositoryKey: Object.freeze({
    ready: false,
    deployKeyId: null,
    publicKeyFingerprint: null,
  }) as RepositoryKeyReadiness,
  environment: Object.freeze({ ready: false, managedResourceDigest: null }) as EnvironmentReadiness,
  dispatch: Object.freeze({ ready: false, requestId: null, workflowRunId: null }),
});

const OPERATION_STATUSES: ReadonlySet<string> = new Set<LocalOperationStatus>([
  "pending",
  "waiting",
  "running",
  "failed",
  "completed",
]);

function isManifestDigest(value: unknown): value is ManifestDigest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ManifestDigest).value === "string" &&
    SHA256_HEX_PATTERN.test((value as ManifestDigest).value)
  );
}

/**
 * Accepts only a record matching the frozen shape *and* the identity this run
 * is about. Anything else is treated exactly like a missing record: the run
 * continues from authoritative state, which is what makes local state
 * disposable.
 */
export function parseOperationRecord(value: unknown): LocalOperationRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as LocalOperationRecord;
  if (record.apiVersion !== OPERATION_RECORD_API_VERSION) return undefined;
  if (typeof record.requestId !== "string" || !REQUEST_ID_PATTERN.test(record.requestId)) return undefined;
  if (typeof record.repository !== "string" || record.repository === "") return undefined;
  if (typeof record.targetName !== "string" || record.targetName === "") return undefined;
  if (typeof record.targetId !== "string" || record.targetId === "") return undefined;
  if (typeof record.commitSha !== "string" || !GIT_COMMIT_SHA_PATTERN.test(record.commitSha)) return undefined;
  if (!isManifestDigest(record.manifestDigest)) return undefined;
  if (!OPERATION_STATUSES.has(record.status)) return undefined;
  if (typeof record.readiness !== "object" || record.readiness === null) return undefined;
  return record;
}

/**
 * Refuses to persist a record that contains an operator secret value. The
 * record shape cannot express one, so a hit means a caller assembled a field
 * from config input.
 */
function assertSecretFree(record: LocalOperationRecord, secrets: readonly string[]): void {
  if (secrets.length === 0) return;
  const serialized = JSON.stringify(record);
  for (const secret of secrets) {
    if (secret !== "" && serialized.includes(secret)) {
      throw orchestratorError(
        "DK_OPERATION_STATE_INVALID",
        "Refusing to persist a local operation record that contains a secret value.",
      );
    }
  }
}

// ------------------------------------------------------------------ helpers --

function administratorConnection(config: DeployKitOperatorConfig): AdministratorSshConnection {
  return {
    host: config.server.host,
    user: config.server.user,
    port: config.server.port,
    identityFile: config.server.identityFile,
    hostKeyFingerprint: config.server.hostKeyFingerprint,
  };
}

const REQUIRED_PERMISSIONS = Object.freeze([
  "read",
  "contentsWrite",
  "workflowsWrite",
  "environmentsWrite",
  "deployKeysWrite",
  "pullRequestsWrite",
] as const);

function missingPermissions(facts: GitHubRepositoryFacts): string[] {
  return REQUIRED_PERMISSIONS.filter((name) => facts.permissions[name] !== true);
}

function controlArtifactsMatch(state: ControlArtifactsState, desired: DesiredControlArtifacts): boolean {
  const workflow = desired.artifacts.find((entry) => entry.path === desired.names.workflowPath);
  const ownership = desired.artifacts.find((entry) => entry.path === desired.names.ownershipPath);
  return (
    state.status === "current" &&
    state.workflowDigest === (workflow?.sha256 ?? null) &&
    state.ownershipDigest === (ownership?.sha256 ?? null) &&
    state.runtimeManifestDigest?.value === desired.ownership.runtimeManifestDigest.value
  );
}

function handshakeMatches(
  handshake: GatewayHandshakeResult | undefined,
  expected: RootOwnedGatewayBinding,
): boolean {
  if (handshake === undefined) return false;
  return (
    handshake.bindingId === expected.bindingId &&
    handshake.targetId === expected.targetId &&
    handshake.runtimeVersion === expected.runtimeVersion &&
    handshake.runtimeBundleSha256 === expected.runtimeBundleSha256 &&
    handshake.capabilities.includes("apply") &&
    handshake.capabilities.includes("inspect")
  );
}

function environmentMatches(state: GitHubEnvironmentState, desired: DesiredGitHubEnvironment): boolean {
  return state.status === "current" && state.managedResourceDigest === desired.managedResourceDigest;
}

function deployKeyMatches(state: RepositoryDeployKeyState, desired: DesiredRepositoryDeployKey): boolean {
  return (
    state.status === "current" &&
    state.readOnly === true &&
    state.publicKeyFingerprint === desired.publicKeyFingerprint
  );
}

/** Which frozen outcome an escaping failure maps to. */
function outcomeFor(code: ErrorCode): OrchestratorResult["outcome"] {
  if (code === "DK_CONFIG_SCAFFOLDED") return "config-created";
  if (code === "DK_SETUP_PR_REVIEW_REQUIRED" || code === "DK_ENVIRONMENT_APPROVAL_REQUIRED") {
    return "waiting-for-review";
  }
  return "failed";
}

function recoveryFor(error: unknown): RecoveryAction {
  if (error instanceof DeployKitError) {
    const details = error.details;
    if (typeof details === "object" && details !== null && "recovery" in details) {
      const recovery = (details as { recovery?: unknown }).recovery;
      if (typeof recovery === "string") return recovery as RecoveryAction;
    }
  }
  return "rerun-same-command";
}

// ------------------------------------------------------------ state machine --

interface RunState {
  requestId: RequestId;
  status: LocalOperationStatus;
  readiness: OperationReadiness;
  setupPullRequestNumber: number | null;
  workflowRunId: number | null;
  /** Reported to the operator instead of raw logs; never persisted. */
  workflowRunUrl: string | null;
  createdAt: string;
}

export async function runDeployment(
  deps: OrchestratorDependencies,
  options: OrchestratorRunOptions,
): Promise<OrchestratorResult> {
  const dryRun = options.dryRun === true;
  const polling = { ...DEFAULT_POLLING, ...options.polling };
  const planner =
    options.planner ??
    createDesiredStatePlanner({
      // Phase 10 owns these bytes; the bundled renderer is the default so a
      // caller cannot accidentally reconcile a workflow of its own invention.
      renderWorkflow: options.renderWorkflow ?? createManagedWorkflowRenderer(),
      runtimeBundle: options.runtimeBundle,
    });

  const emit = (
    level: "info" | "warning",
    phase: OrchestratorProgressPhase,
    code: string,
    message: string,
  ): void | Promise<void> =>
    deps.output.progress({ time: deps.clock.now().toISOString(), level, code, phase, message });

  // Values discovered as the machine advances. They stay `null` until their
  // step has run, so the failure result reports exactly what was established.
  let context: DeploymentContext | undefined;
  let run: RunState | undefined;
  let deployment: GatewayDeploymentResult | undefined;
  let secretValues: readonly string[] = [];
  let gatewaySession: GatewayAccessSession | undefined;

  const failureResult = (error: unknown): OrchestratorResult => ({
    outcome: outcomeFor(error instanceof DeployKitError ? error.code : "DK_COMMAND_FAILED"),
    requestId: run?.requestId ?? null,
    repository: context?.repository ?? null,
    targetName: context?.targetName ?? null,
    commitSha: context?.compiled === undefined ? null : commitSha,
    manifestDigest: context?.compiled.digest ?? null,
    setupPullRequestNumber: run?.setupPullRequestNumber ?? null,
    workflowRunId: run?.workflowRunId ?? null,
    workflowRunUrl: run?.workflowRunUrl ?? null,
    httpsUrl: null,
    ports: [],
    healthy: null,
    recovery: recoveryFor(error),
  });

  let commitSha: GitCommitSha | null = null;

  const persist = async (status: LocalOperationStatus, failure?: DeployKitError): Promise<void> => {
    if (dryRun || context === undefined || run === undefined || commitSha === null) return;
    run.status = status;
    const record: LocalOperationRecord = {
      apiVersion: OPERATION_RECORD_API_VERSION,
      requestId: run.requestId,
      repository: context.repository,
      targetName: context.targetName,
      targetId: context.targetId,
      commitSha,
      manifestDigest: context.compiled.digest,
      status,
      setupPullRequestNumber: run.setupPullRequestNumber,
      workflowRunId: run.workflowRunId,
      readiness: run.readiness,
      lastFailure:
        failure === undefined
          ? null
          : {
              code: failure.code,
              recovery: recoveryFor(failure),
              failedAt: deps.clock.now().toISOString(),
            },
      createdAt: run.createdAt,
      updatedAt: deps.clock.now().toISOString(),
    };
    assertSecretFree(record, secretValues);
    await deps.operationState.write(record);
  };

  try {
    // ---------------------------------------------------------------- config --

    const scaffold = await deps.configFileSystem.scaffold({
      cwd: options.cwd ?? process.cwd(),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    });

    if (scaffold.status === "created") {
      await emit(
        "info",
        "config",
        "DK_CONFIG_SCAFFOLDED",
        `Created ${scaffold.configPath} with mode 0600 and excluded it through ${scaffold.excludePath}`,
      );
      const confirmation = await deps.configFileSystem.waitForConfirmation(scaffold.configPath);
      if (!confirmation.confirmed) {
        throw orchestratorError(
          "DK_CONFIG_SCAFFOLDED",
          `Created ${scaffold.configPath} with mode 0600 from the bundled example. Fill it in, then run the same command again.`,
          { details: { config: scaffold.configPath, excludeFile: scaffold.excludePath } },
        );
      }
    }

    const read = await deps.configFileSystem.secureRead(scaffold.configPath);
    const parsed = parseOperatorConfig(parseConfigDocument(read.source, read.configPath));
    // Redact the operator's exact secret values before any later diagnostic,
    // progress event, or error message can quote one.
    secretValues = Object.values(parsed.environment.backendValues);
    registerRedactedValues(secretValues);

    const compiled: CompiledDeployment = compileRuntimeManifest(parsed, {
      ...(options.requiredVersion === undefined ? {} : { requiredVersion: options.requiredVersion }),
    });
    const config = parsed.config;
    const environment: EnvironmentPartition = parsed.environment;

    await emit(
      "info",
      "config",
      "DK_CONFIG_OK",
      `Compiled ${read.configPath} for target '${compiled.targetName}' (manifest digest ${compiled.digest.value}, ${compiled.canonicalBytes.byteLength} bytes)`,
    );

    // -------------------------------------------------------------- preflight --

    if (options.validateSource !== false) {
      const validation = await validateCompiledProject(compiled, {
        sourceRoot: read.repositoryRoot,
        inspectComposeConfig: options.inspectComposeConfig ?? false,
      });
      if (!validation.valid) {
        throw new DeployKitError("DK_VALIDATION_FAILED", "The application tree does not satisfy the compiled manifest", {
          details: validation.issues,
        });
      }
    }

    const facts = await deps.github.inspectRepository(config.project.repository);
    if (facts.repository !== config.project.repository) {
      throw orchestratorError(
        "DK_GITHUB_API_FAILED",
        `GitHub returned facts for '${facts.repository}' while '${config.project.repository}' was requested`,
      );
    }
    const missing = missingPermissions(facts);
    if (missing.length > 0) {
      throw orchestratorError(
        "DK_GITHUB_PERMISSION_DENIED",
        `${facts.authenticatedActor} lacks required ${config.project.repository} permission(s): ${missing.join(", ")}`,
        { details: { missing } },
      );
    }

    const connection = administratorConnection(config);
    const ssh = await deps.administratorSsh.preflight(connection);
    if (!ssh.reachable) {
      throw orchestratorError("DK_SSH_UNREACHABLE", `${connection.host} did not accept an administrator SSH connection`);
    }
    if (ssh.hostKeyFingerprint !== connection.hostKeyFingerprint) {
      throw orchestratorError(
        "DK_SSH_HOST_KEY_MISMATCH",
        `${connection.host} presented a host key that does not match server.hostKeyFingerprint`,
      );
    }
    if (!ssh.administrator) {
      throw orchestratorError(
        "DK_SSH_UNREACHABLE",
        `${connection.user}@${connection.host} connected but cannot administer the host`,
      );
    }

    await emit(
      "info",
      "preflight",
      "DK_PREFLIGHT_OK",
      `Verified ${config.project.repository} permissions and ${ssh.operatingSystem}/${ssh.architecture} administrator access`,
    );

    // ----------------------------------------------------------------- commit --

    const resolved = await deps.github.resolveCommit(config.project.repository, config.project.ref);
    if (!GIT_COMMIT_SHA_PATTERN.test(resolved.commitSha)) {
      throw orchestratorError(
        "DK_REF_NOT_FOUND",
        `'${config.project.ref}' did not resolve to a full commit SHA in ${config.project.repository}`,
      );
    }
    commitSha = resolved.commitSha;

    context = {
      compiled,
      environment,
      repository: config.project.repository,
      targetName: compiled.targetName,
      targetId: compiled.targetId,
      githubEnvironment: config.target.githubEnvironment,
      primaryDomain: config.target.primaryDomain,
      applicationRef: config.project.ref,
      defaultBranch: facts.defaultBranch,
      names: makeManagedResourceNames(compiled.targetId),
    };

    // A stored record for a different SHA or digest describes a different
    // deployment identity, so it is discarded rather than resumed.
    const stored = await readOperationRecord(deps, context, emit);
    const resumable =
      stored !== undefined && stored.commitSha === commitSha && stored.manifestDigest.value === compiled.digest.value;
    const now = deps.clock.now().toISOString();
    // A recorded failure is retried as a *new* request for the same deployment
    // identity, so the old run's request ID can never correlate the new run.
    const retrying = resumable && stored.status === "failed";
    run = {
      requestId:
        options.requestId ??
        (resumable && !retrying ? stored.requestId : (options.newRequestId ?? randomUUID)()),
      status: "pending",
      readiness: resumable ? stored.readiness : UNVERIFIED_READINESS,
      setupPullRequestNumber: resumable ? stored.setupPullRequestNumber : null,
      workflowRunId: resumable ? stored.workflowRunId : null,
      workflowRunUrl: null,
      createdAt: resumable ? stored.createdAt : now,
    };
    if (!REQUEST_ID_PATTERN.test(run.requestId)) {
      throw new DeployKitError("DK_USAGE", "requestId must be a UUID");
    }

    await emit(
      "info",
      "commit",
      "DK_COMMIT_FROZEN",
      `Froze ${config.project.repository}@${config.project.ref} to ${commitSha}`,
    );
    await persist("pending");

    // ------------------------------------------------------ control artifacts --

    const desiredArtifacts = planner.controlArtifacts(context);
    let artifactsState = await deps.github.inspectControlArtifacts(desiredArtifacts);
    if (artifactsState.status === "conflict") {
      throw ownershipConflict(`${config.project.repository} holds control artifacts DeployKit does not own`);
    }
    if (!controlArtifactsMatch(artifactsState, desiredArtifacts)) {
      if (dryRun) {
        await emit(
          "info",
          "control-artifacts",
          "DK_DRY_RUN_PENDING",
          `Would reconcile ${desiredArtifacts.artifacts.length} control artifact(s) on ${context.defaultBranch}`,
        );
      } else {
        artifactsState = await deps.github.reconcileControlArtifacts(desiredArtifacts);
        if (artifactsState.status === "conflict") {
          throw ownershipConflict(`${config.project.repository} holds control artifacts DeployKit does not own`);
        }
      }
    }

    run.setupPullRequestNumber = artifactsState.setupPullRequestNumber;
    run.readiness = {
      ...run.readiness,
      controlArtifacts: {
        ready: controlArtifactsMatch(artifactsState, desiredArtifacts),
        defaultBranchCommitSha: artifactsState.defaultBranchCommitSha,
        workflowDigest: artifactsState.workflowDigest,
        runtimeManifestDigest: artifactsState.runtimeManifestDigest,
        ownershipDigest: artifactsState.ownershipDigest,
      },
    };

    if (!dryRun && !run.readiness.controlArtifacts.ready) {
      if (artifactsState.status === "drifted") {
        await persist("pending");
        throw orchestratorError(
          "DK_CONTROL_ARTIFACTS_DRIFTED",
          `Control artifacts on ${context.defaultBranch} do not match the bytes DeployKit expects`,
        );
      }
      await persist("waiting");
      throw orchestratorError(
        "DK_SETUP_PR_REVIEW_REQUIRED",
        artifactsState.setupPullRequestNumber === null
          ? `Merge the DeployKit setup pull request on ${context.defaultBranch}, then run the same command again.`
          : `Review and merge setup pull request #${artifactsState.setupPullRequestNumber} on ${context.defaultBranch}, then run the same command again.`,
        { details: { pullRequest: artifactsState.setupPullRequestNumber, defaultBranch: context.defaultBranch } },
      );
    }

    await emit(
      "info",
      "control-artifacts",
      "DK_CONTROL_ARTIFACTS_READY",
      dryRun
        ? `Inspected control artifacts on ${context.defaultBranch}`
        : `Verified control artifacts on ${context.defaultBranch} at ${artifactsState.defaultBranchCommitSha}`,
    );
    await persist("pending");

    // ---------------------------------------------------------------- gateway --

    const expectedBinding = planner.gatewayBinding(context);
    let handshake = await deps.administratorSsh.inspectGateway(connection, expectedBinding);
    if (
      handshake !== undefined &&
      (handshake.bindingId !== expectedBinding.bindingId || handshake.targetId !== expectedBinding.targetId)
    ) {
      throw orchestratorError(
        "DK_GATEWAY_BINDING_MISMATCH",
        `${connection.host} is bound to a different repository, Environment, or target than ${context.repository}/${context.targetName}`,
      );
    }

    let repositoryPublicKey: string | null = null;
    let repositoryPublicKeyFingerprint: string | null = null;

    if (dryRun) {
      if (!handshakeMatches(handshake, expectedBinding)) {
        await emit("info", "gateway", "DK_DRY_RUN_PENDING", `Would bootstrap the DeployKit gateway on ${connection.host}`);
      }
    } else {
      // Bootstrap is idempotent for an identical binding and is the only
      // operation that returns the VPS-held repository public key the next step
      // needs, so it runs on every real invocation.
      const bootstrap = await deps.administratorSsh.bootstrapGateway({
        connection,
        binding: expectedBinding,
        packageFile: options.runtimeBundle.packageFile,
        packageName: options.runtimeBundle.packageName,
        packageSha256: options.runtimeBundle.packageSha256,
        configureFirewall: config.server.configureFirewall === true,
      });
      handshake = bootstrap.handshake;
      repositoryPublicKey = bootstrap.repositoryPublicKey;
      repositoryPublicKeyFingerprint = bootstrap.repositoryPublicKeyFingerprint;
      if (!handshakeMatches(handshake, expectedBinding)) {
        throw orchestratorError(
          "DK_GATEWAY_BOOTSTRAP_FAILED",
          `${connection.host} did not report the expected gateway binding after bootstrap`,
        );
      }
      await emit(
        "info",
        "gateway",
        bootstrap.changed ? "DK_GATEWAY_BOOTSTRAPPED" : "DK_GATEWAY_READY",
        bootstrap.changed
          ? `Installed the DeployKit gateway and runtime ${handshake.runtimeVersion} on ${connection.host}`
          : `Verified the existing DeployKit gateway and runtime ${handshake.runtimeVersion} on ${connection.host}`,
      );
    }

    run.readiness = {
      ...run.readiness,
      gateway: {
        ready: handshakeMatches(handshake, expectedBinding),
        bindingId: handshake?.bindingId ?? null,
        bindingDigest: gatewayBindingIdentityDigest(expectedBinding),
        runtimeVersion: handshake?.runtimeVersion ?? null,
        runtimeBundleSha256: handshake?.runtimeBundleSha256 ?? null,
      },
    };
    await persist("pending");

    // --------------------------------------------------------- repository key --

    let deployKeyState: RepositoryDeployKeyState | undefined;
    if (!dryRun && repositoryPublicKey !== null && repositoryPublicKeyFingerprint !== null) {
      const desiredKey = planner.repositoryDeployKey(context, {
        publicKey: repositoryPublicKey,
        publicKeyFingerprint: repositoryPublicKeyFingerprint,
      });
      deployKeyState = await deps.github.inspectRepositoryDeployKey(desiredKey);
      if (deployKeyState.status === "conflict") {
        throw ownershipConflict(
          `${context.repository} already has a deploy key titled '${desiredKey.title}' that DeployKit does not own`,
        );
      }
      if (!deployKeyMatches(deployKeyState, desiredKey)) {
        deployKeyState = await deps.github.reconcileRepositoryDeployKey(desiredKey);
      }
      if (deployKeyState.status === "conflict") {
        throw ownershipConflict(
          `${context.repository} already has a deploy key titled '${desiredKey.title}' that DeployKit does not own`,
        );
      }
      if (deployKeyState.readOnly !== true) {
        throw ownershipConflict(`The DeployKit repository key on ${context.repository} is not read-only`);
      }
      if (!deployKeyMatches(deployKeyState, desiredKey)) {
        throw orchestratorError(
          "DK_KEY_ROTATION_FAILED",
          `The read-only repository key on ${context.repository} does not match the key held by ${connection.host}`,
        );
      }
      // Registration proves GitHub accepted the key. It does not prove the host
      // can use it, nor that it opens *this* repository and no other, so the
      // VPS is asked to demonstrate both before the gateway is trusted to fetch
      // source with it.
      if (deps.administratorSsh.proveRepositoryAccess !== undefined) {
        const proof = await deps.administratorSsh.proveRepositoryAccess(connection, expectedBinding);
        if (proof.authenticatedAs !== context.repository || proof.keyFingerprint !== repositoryPublicKeyFingerprint) {
          throw ownershipConflict(
            `The read-only key held by ${connection.host} does not authenticate as ${context.repository}`,
          );
        }
      }

      run.readiness = {
        ...run.readiness,
        repositoryKey: {
          ready: true,
          deployKeyId: deployKeyState.keyId,
          publicKeyFingerprint: deployKeyState.publicKeyFingerprint,
        },
      };
      await emit(
        "info",
        "repository-key",
        "DK_REPOSITORY_KEY_READY",
        `Verified the read-only ${context.repository} deploy key held by ${connection.host}`,
      );
      await persist("pending");
    } else if (dryRun) {
      await emit(
        "info",
        "repository-key",
        "DK_DRY_RUN_PENDING",
        `Would register the VPS-held read-only deploy key on ${context.repository}`,
      );
    }

    // ------------------------------------------------------------ environment --

    let desiredEnvironment: DesiredGitHubEnvironment | undefined;
    let environmentState: GitHubEnvironmentState | undefined;
    let access: GatewayAccessFacts | undefined;
    let environmentReconciled = false;

    // Secrets are uploaded in this step, so both readiness facts that make an
    // upload safe are asserted first rather than assumed from the flow above:
    // the reviewed control artifacts are on the default branch, and the host
    // answering for this binding is the one whose key the secrets will carry. A
    // dry run mutates nothing and is allowed to inspect without them.
    if (!dryRun && !run.readiness.controlArtifacts.ready) {
      throw notReady(`control artifacts on ${context.defaultBranch} were not verified before secret synchronization`);
    }
    if (!dryRun && !run.readiness.gateway.ready) {
      throw notReady(`the gateway on ${connection.host} was not verified before secret synchronization`);
    }

    if (handshake !== undefined) {
      gatewaySession = asGatewayAccessSession(
        await options.gatewayAccess(context, handshake, {
          context,
          handshake,
          connection,
          binding: expectedBinding,
          repositoryKeyFingerprint: repositoryPublicKeyFingerprint,
          dryRun,
        }),
      );
      access = gatewaySession.facts;
      desiredEnvironment = planner.environment(context, access);
      environmentState = await deps.github.inspectEnvironment(desiredEnvironment);
      if (environmentState.status === "conflict") {
        throw orchestratorError(
          "DK_ENVIRONMENT_CONFLICT",
          `GitHub Environment '${context.githubEnvironment}' holds a value DeployKit has not marked as owned`,
        );
      }
      if (!environmentMatches(environmentState, desiredEnvironment)) {
        if (dryRun) {
          await emit(
            "info",
            "environment",
            "DK_DRY_RUN_PENDING",
            `Would reconcile GitHub Environment '${context.githubEnvironment}'`,
          );
        } else {
          environmentState = await deps.github.reconcileEnvironment(desiredEnvironment);
          environmentReconciled = true;
          if (environmentState.status === "conflict") {
            throw orchestratorError(
              "DK_ENVIRONMENT_CONFLICT",
              `GitHub Environment '${context.githubEnvironment}' holds a value DeployKit has not marked as owned`,
            );
          }
          if (!environmentMatches(environmentState, desiredEnvironment)) {
            throw orchestratorError(
              "DK_GITHUB_API_FAILED",
              `GitHub Environment '${context.githubEnvironment}' did not report the expected managed-resource digest after reconciliation`,
            );
          }
        }
      }

      run.readiness = {
        ...run.readiness,
        environment: {
          ready: environmentMatches(environmentState, desiredEnvironment),
          managedResourceDigest: environmentState.managedResourceDigest,
        },
      };

      // The private key is only now in the target Environment, so the staged
      // public entry can become the host's active one. Before this promotion
      // the previously proven key still works and the new entry is inert;
      // after it the new key works and the old owned entry is gone. There is
      // no window in which neither is accepted.
      if (!dryRun && gatewaySession.activate !== undefined) {
        if (!environmentReconciled) {
          throw orchestratorError(
            "DK_KEY_ROTATION_FAILED",
            `The '${context.githubEnvironment}' Environment did not receive the gateway key staged on ${connection.host}, so it was left inert`,
          );
        }
        await gatewaySession.activate();
        await emit(
          "info",
          "environment",
          "DK_GATEWAY_KEY_ACTIVATED",
          `Activated the workflow-to-VPS gateway key on ${connection.host} and removed the previous DeployKit entry`,
        );
      }

      if (!dryRun) {
        await emit(
          "info",
          "environment",
          "DK_ENVIRONMENT_READY",
          `Reconciled GitHub Environment '${context.githubEnvironment}' with ${environmentState.variableNames.length} variable(s) and ${environmentState.secretNames.length} secret(s)`,
        );
        if (environmentState.protection.reviewers.length > 0 || environmentState.protection.waitTimerMinutes > 0) {
          await emit(
            "info",
            "environment",
            "DK_ENVIRONMENT_PROTECTED",
            `Environment '${context.githubEnvironment}' keeps its existing reviewers and wait timer; the workflow run may pause for approval`,
          );
        }
        await persist("pending");
      }
    }

    // -------------------------------------------------------------- readiness --

    if (dryRun) {
      const result = successResult(run, context, commitSha, "dry-run", null, null);
      await emit("info", "complete", "DK_DRY_RUN_OK", `Dry run inspected every boundary and mutated nothing`);
      await deps.output.result(result);
      return result;
    }

    if (desiredEnvironment === undefined || environmentState === undefined || access === undefined) {
      throw orchestratorError(
        "DK_DISPATCH_NOT_READY",
        `The gateway on ${connection.host} did not report a usable handshake, so no deployment was dispatched`,
      );
    }

    // Local checkpoints are never trusted before the irreversible step; every
    // readiness fact is read again from GitHub and the VPS here.
    const recheckCommit = await deps.github.resolveCommit(context.repository, context.applicationRef);
    if (recheckCommit.commitSha !== commitSha) {
      throw orchestratorError(
        "DK_REF_MOVED",
        `'${context.applicationRef}' moved from ${commitSha} to ${recheckCommit.commitSha} while DeployKit was preparing the deployment`,
      );
    }
    const recheckArtifacts = await deps.github.inspectControlArtifacts(desiredArtifacts);
    if (!controlArtifactsMatch(recheckArtifacts, desiredArtifacts)) {
      throw notReady(`control artifacts on ${context.defaultBranch} are no longer the bytes DeployKit expects`);
    }
    const recheckHandshake = await deps.administratorSsh.inspectGateway(connection, expectedBinding);
    if (!handshakeMatches(recheckHandshake, expectedBinding)) {
      throw notReady(`the gateway on ${connection.host} no longer reports the expected binding`);
    }
    if (deployKeyState !== undefined) {
      const recheckKey = await deps.github.inspectRepositoryDeployKey(
        planner.repositoryDeployKey(context, {
          publicKey: repositoryPublicKey ?? "",
          publicKeyFingerprint: repositoryPublicKeyFingerprint ?? "",
        }),
      );
      if (recheckKey.status !== "current" || recheckKey.readOnly !== true) {
        throw notReady(`the read-only ${context.repository} deploy key is no longer current`);
      }
    }
    const recheckEnvironment = await deps.github.inspectEnvironment(desiredEnvironment);
    if (!environmentMatches(recheckEnvironment, desiredEnvironment)) {
      throw notReady(`GitHub Environment '${context.githubEnvironment}' no longer holds the expected managed resources`);
    }

    await emit(
      "info",
      "readiness",
      "DK_READINESS_VERIFIED",
      `Re-verified control artifacts, gateway binding, repository key, and Environment for ${commitSha}`,
    );

    // --------------------------------------------------------------- dispatch --

    const dispatchRequest: WorkflowDispatchRequest = {
      repository: context.repository,
      workflowPath: context.names.workflowPath,
      workflowRef: context.defaultBranch,
      requestId: run.requestId,
      targetName: context.targetName,
      commitSha,
      manifestDigest: compiled.digest,
      // The default-branch commit whose control-artifact bytes were verified a
      // moment ago, and the actor GitHub answered the preflight as. A run that
      // does not carry both is not the run this invocation asked for.
      workflowSha: recheckArtifacts.defaultBranchCommitSha,
      actor: facts.authenticatedActor,
      resume: run.workflowRunId !== null || stored?.lastFailure != null,
      // A local `--dry-run` never reaches dispatch. The frozen flag exists for a
      // future remote dry run and is deliberately false here.
      dryRun: false,
    };

    let workflowRun = await deps.github.findWorkflowRun(dispatchRequest);
    let dispatchedNow = false;
    if (workflowRun === undefined) {
      dispatchedNow = true;
      await deps.github.dispatchWorkflow(dispatchRequest);
      await emit(
        "info",
        "dispatch",
        "DK_DISPATCHED",
        `Dispatched ${context.names.workflowPath} on ${context.defaultBranch} for ${commitSha} as request ${run.requestId}`,
      );
      run.readiness = {
        ...run.readiness,
        dispatch: { ready: true, requestId: run.requestId, workflowRunId: null },
      };
      await persist("running");

      for (let attempt = 0; attempt < polling.correlationAttempts && workflowRun === undefined; attempt += 1) {
        await deps.clock.sleep(polling.intervalMs);
        workflowRun = await deps.github.findWorkflowRun(dispatchRequest);
      }
      if (workflowRun === undefined) {
        throw orchestratorError(
          "DK_WORKFLOW_RUN_NOT_FOUND",
          `No workflow run for request ${run.requestId} has appeared yet; run the same command again to correlate it`,
        );
      }
    } else {
      await emit(
        "info",
        "dispatch",
        "DK_RUN_ADOPTED",
        `Adopted the existing workflow run ${workflowRun.id} for ${commitSha} instead of dispatching a duplicate`,
      );
    }

    verifyRunIdentity(workflowRun, dispatchRequest, context.defaultBranch, dispatchedNow);
    // A run correlated by deployment identity rather than by request ID becomes
    // this operation's run, so a later rerun correlates it exactly.
    run.requestId = workflowRun.requestId;
    run.workflowRunId = workflowRun.id;
    run.workflowRunUrl = workflowRun.url;
    run.readiness = {
      ...run.readiness,
      dispatch: { ready: true, requestId: workflowRun.requestId, workflowRunId: workflowRun.id },
    };
    await emit("info", "workflow", "DK_RUN_CORRELATED", `Following workflow run ${workflowRun.url}`);
    await persist("running");

    if (options.noWait === true) {
      const result = successResult(run, context, commitSha, "dispatched", null, null);
      await deps.output.result(result);
      return result;
    }

    // ----------------------------------------------------------- follow a run --

    let completed = workflowRun;
    for (let attempt = 0; attempt < polling.runAttempts && completed.status !== "completed"; attempt += 1) {
      if (completed.status === "waiting") {
        await emit(
          "info",
          "workflow",
          "DK_RUN_WAITING",
          `Workflow run ${completed.id} is waiting on the '${context.githubEnvironment}' Environment protection rules`,
        );
      }
      await deps.clock.sleep(polling.intervalMs);
      completed = await deps.github.inspectWorkflowRun(workflowRun);
    }

    if (completed.status !== "completed") {
      await persist("running");
      throw orchestratorError(
        "DK_WORKFLOW_RUN_NOT_FOUND",
        `Workflow run ${completed.id} did not finish within the wait budget; run the same command again to keep following it`,
        { details: { run: completed.url, status: completed.status } },
      );
    }
    if (completed.conclusion === "action_required") {
      await persist("waiting");
      throw orchestratorError(
        "DK_ENVIRONMENT_APPROVAL_REQUIRED",
        `Workflow run ${completed.id} needs approval on the '${context.githubEnvironment}' Environment`,
        { details: { run: completed.url } },
      );
    }
    if (completed.conclusion !== "success") {
      await persist("failed");
      throw orchestratorError(
        "DK_WORKFLOW_RUN_FAILED",
        `Workflow run ${completed.id} finished with '${completed.conclusion ?? "no conclusion"}'`,
        { details: { run: completed.url } },
      );
    }

    await emit("info", "workflow", "DK_RUN_COMPLETED", `Workflow run ${completed.id} succeeded`);

    // ---------------------------------------------------------------- inspect --

    if (access.identityFile !== undefined) {
      deployment = await inspectDeployment(deps, {
        connection: {
          host: access.host,
          user: access.user,
          port: access.port,
          identityFile: access.identityFile,
          knownHosts: access.knownHosts,
        },
        requestId: run.requestId,
        context,
        commitSha,
      });
      await emit(
        "info",
        "inspect",
        "DK_INSPECTED",
        `The gateway reports target '${deployment.targetName}' at phase '${deployment.phase ?? "unknown"}'`,
      );
    }

    const result = successResult(run, context, commitSha, "succeeded", deployment ?? null, completed.id);
    await persist("completed");
    await emit(
      "info",
      "complete",
      "DK_DEPLOY_COMPLETE",
      `Deployed ${context.repository}@${commitSha} to '${context.targetName}'`,
    );
    await deps.output.result(result);
    return result;
  } catch (error) {
    const result = failureResult(error);
    if (error instanceof DeployKitError && result.outcome !== "config-created") {
      await persist(result.outcome === "waiting-for-review" ? "waiting" : "failed", error);
    }
    await deps.output.result(result);
    throw error;
  } finally {
    // The local gateway private key never outlives the invocation that made
    // it, whether the run succeeded, failed, or was interrupted after the
    // inspection that needed it.
    await gatewaySession?.dispose?.().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- internals --

function ownershipConflict(message: string): DeployKitError {
  return orchestratorError("DK_OWNERSHIP_CONFLICT", message);
}

function notReady(reason: string): DeployKitError {
  return orchestratorError(
    "DK_DISPATCH_NOT_READY",
    `Nothing was dispatched because ${reason}; run the same command again`,
  );
}

async function readOperationRecord(
  deps: OrchestratorDependencies,
  context: DeploymentContext,
  emit: (
    level: "info" | "warning",
    phase: OrchestratorProgressPhase,
    code: string,
    message: string,
  ) => void | Promise<void>,
): Promise<LocalOperationRecord | undefined> {
  let raw: unknown;
  try {
    raw = await deps.operationState.read({ repository: context.repository, targetId: context.targetId });
  } catch {
    await emit(
      "warning",
      "commit",
      "DK_OPERATION_STATE_INVALID",
      "The local operation record could not be read; continuing from authoritative GitHub and VPS state",
    );
    return undefined;
  }
  if (raw === undefined) return undefined;

  const record = parseOperationRecord(raw);
  if (
    record === undefined ||
    record.repository !== context.repository ||
    record.targetId !== context.targetId
  ) {
    await emit(
      "warning",
      "commit",
      "DK_OPERATION_STATE_INVALID",
      "The local operation record does not match its frozen shape or this target; continuing from authoritative GitHub and VPS state",
    );
    return undefined;
  }
  return record;
}

/**
 * A correlated run must be the managed workflow, dispatched manually from the
 * protected default branch, by this actor, for this target. Anything else is a
 * different run that happens to share a request ID or identity.
 *
 * The workflow SHA is checked exactly when this invocation dispatched the run,
 * because only then is "the default branch DeployKit just verified" the same
 * commit the run was started from. An *adopted* run legitimately predates a
 * later default-branch commit, so requiring the SHA there would refuse a run
 * that is still the right one to follow.
 */
function verifyRunIdentity(
  run: WorkflowRunState,
  request: WorkflowDispatchRequest,
  defaultBranch: string,
  dispatchedNow: boolean,
): void {
  const problems: string[] = [];
  if (run.repository !== request.repository) problems.push("repository");
  if (run.workflowPath !== request.workflowPath) problems.push("workflow path");
  if (run.event !== "workflow_dispatch") problems.push("event");
  if (run.workflowRef !== defaultBranch) problems.push("workflow ref");
  if (run.targetName !== request.targetName) problems.push("target");
  if (!REQUEST_ID_PATTERN.test(run.requestId)) problems.push("request id");
  if (!GIT_COMMIT_SHA_PATTERN.test(run.workflowSha)) problems.push("workflow sha");
  else if (dispatchedNow && run.workflowSha !== request.workflowSha) problems.push("workflow sha");
  if (run.actor !== request.actor) problems.push("actor");
  if (problems.length > 0) {
    throw orchestratorError(
      "DK_DISPATCH_NOT_READY",
      `Workflow run ${run.id} does not match the dispatched deployment (${problems.join(", ")})`,
      { details: { run: run.url, problems } },
    );
  }
}

async function* inspectFrames(
  requestId: RequestId,
  context: DeploymentContext,
  commitSha: GitCommitSha,
): AsyncGenerator<GatewayInputFrame> {
  const empty = { manifestFrames: 0, manifestBytes: 0, secretFrames: 0, secretBytes: 0 } as const;
  yield {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    frame: "request",
    requestId,
    operation: "inspect",
    repository: context.repository,
    githubEnvironment: context.githubEnvironment,
    targetName: context.targetName,
    targetId: context.targetId,
    applicationRef: null,
    commitSha,
    manifestDigest: context.compiled.digest,
    expectedPayload: empty,
    flags: { dryRun: false },
  };
  yield {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    frame: "end",
    requestId,
    manifestFrames: 0,
    secretFrames: 0,
    payloadBytes: 0,
  };
}

async function inspectDeployment(
  deps: OrchestratorDependencies,
  request: {
    readonly connection: GatewayConnection;
    readonly requestId: RequestId;
    readonly context: DeploymentContext;
    readonly commitSha: GitCommitSha;
  },
): Promise<GatewayDeploymentResult> {
  let result: GatewayResultFrame | undefined;
  const stream = deps.gateway.exchange({
    connection: request.connection,
    frames: inspectFrames(request.requestId, request.context, request.commitSha),
  });
  for await (const frame of stream) {
    if (frame.frame === "progress") {
      await deps.output.progress({
        time: frame.time,
        level: frame.level,
        code: frame.code,
        phase: "inspect",
        message: frame.message,
      });
      continue;
    }
    result = frame;
  }

  if (result === undefined) {
    throw orchestratorError(
      "DK_GATEWAY_PROTOCOL_INVALID",
      `${request.connection.host} closed the gateway stream without a result frame`,
    );
  }
  if (!result.ok) {
    throw orchestratorError(result.code, `The gateway refused the inspection of '${request.context.targetName}'`, {
      details: { gatewayRecovery: result.recovery },
    });
  }
  if (result.result.kind !== "deployment") {
    throw orchestratorError(
      "DK_GATEWAY_PROTOCOL_INVALID",
      `${request.connection.host} answered an inspect request with a handshake result`,
    );
  }
  return result.result;
}

function successResult(
  run: RunState,
  context: DeploymentContext,
  commitSha: GitCommitSha,
  outcome: "dry-run" | "dispatched" | "succeeded",
  deployment: GatewayDeploymentResult | null,
  workflowRunId: number | null,
): OrchestratorResult {
  const health = deployment?.health ?? [];
  return {
    outcome,
    requestId: run.requestId,
    repository: context.repository,
    targetName: context.targetName,
    commitSha,
    manifestDigest: context.compiled.digest,
    setupPullRequestNumber: run.setupPullRequestNumber,
    workflowRunId: workflowRunId ?? run.workflowRunId,
    workflowRunUrl: run.workflowRunUrl,
    httpsUrl: outcome === "succeeded" ? `https://${context.primaryDomain}/` : null,
    ports: deployment?.ports ?? [],
    healthy: deployment === null ? null : health.length > 0 && health.every((entry) => entry.healthy),
    recovery: "none",
  };
}
