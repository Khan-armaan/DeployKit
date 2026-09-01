import type { ErrorCode } from "../errors.js";
import type {
  GatewayDeploymentResult,
  GatewayProgressPhase,
  RecoveryAction,
} from "../orchestrator/contracts.js";
import type { ServerErrorCode } from "./errors.js";
import { deployKitCodeForServerError, recoveryForDeployKitCode } from "./failures.js";
import { InProcessLockProvider, type LockProvider } from "./lock.js";
import { DEFAULT_SERVER_ROOTS, serverPaths, type ServerRoots } from "./paths.js";
import { SecretRedactor, SecretsStore } from "./secrets.js";
import {
  DeploymentStateStore,
  type DeploymentState,
  type LegacyDeploymentState,
  type StoredDeploymentState,
} from "./state.js";

/**
 * The one structured answer to "what is the state of this target?". It carries
 * the frozen `GatewayDeploymentResult` payload plus the recovery action an
 * operator must take, contains only public values and declared names, and is
 * redacted before it leaves the runtime.
 */
export interface ServerInspectionResult {
  readonly result: GatewayDeploymentResult;
  readonly recovery: RecoveryAction;
}

export interface InspectionIdentity {
  readonly targetId: string;
  /** Supplied by the caller; the recorded name wins whenever state exists. */
  readonly targetName: string;
}

function isServerErrorCode(code: string): code is ServerErrorCode {
  return code.startsWith("SERVER_");
}

/** Failure codes are recorded as raw strings, so unknown values fail closed. */
export function deployKitCodeForFailure(code: string): ErrorCode {
  if (!isServerErrorCode(code)) return "DK_DEPLOYMENT_FAILED";
  const mapped = deployKitCodeForServerError(code) as ErrorCode | undefined;
  return mapped ?? "DK_DEPLOYMENT_FAILED";
}

function currentInspection(state: DeploymentState): ServerInspectionResult {
  const failure = state.status === "failed" ? state.failures.at(-1) : undefined;
  const failureCode = failure === undefined ? null : deployKitCodeForFailure(failure.code);
  return {
    result: {
      kind: "deployment",
      outcome: state.status,
      targetName: state.targetName,
      targetId: state.identity.targetId,
      commitSha: state.identity.commitSha,
      manifestDigest: state.identity.manifestDigest,
      phase: (state.checkpoints.at(-1)?.phase as GatewayProgressPhase | undefined) ?? null,
      domains: [...state.resources.domains],
      ports: [...state.resources.ports],
      health: [...state.health],
      resumed: state.attempt > 1,
      failureCode,
    },
    recovery: failureCode === null ? "none" : recoveryForDeployKitCode(failureCode),
  };
}

function legacyInspection(
  identity: InspectionIdentity,
  state: LegacyDeploymentState,
): ServerInspectionResult {
  const migrationRequired = state.status !== "succeeded";
  return {
    result: {
      kind: "deployment",
      outcome: state.status,
      targetName: identity.targetName,
      targetId: identity.targetId,
      commitSha: state.commitSha,
      manifestDigest: null,
      phase: state.phase,
      domains: [],
      ports: [],
      health: [],
      resumed: false,
      failureCode: migrationRequired ? "DK_STATE_LEGACY" : null,
    },
    recovery: migrationRequired ? "migrate-legacy-state" : "none",
  };
}

export interface BuildInspectionOptions {
  /** Reports a plan-only run that deliberately left the target untouched. */
  readonly dryRun?: boolean;
}

export function buildInspection(
  stored: StoredDeploymentState,
  identity: InspectionIdentity,
  options: BuildInspectionOptions = {},
): ServerInspectionResult {
  const inspection = stored.kind === "none"
    ? {
        result: {
          kind: "deployment",
          outcome: "not-deployed",
          targetName: identity.targetName,
          targetId: identity.targetId,
          commitSha: null,
          manifestDigest: null,
          phase: null,
          domains: [],
          ports: [],
          health: [],
          resumed: false,
          failureCode: null,
        } satisfies GatewayDeploymentResult,
        recovery: "none" as RecoveryAction,
      }
    : stored.kind === "legacy"
      ? legacyInspection(identity, stored.state)
      : currentInspection(stored.state);

  if (options.dryRun !== true) return inspection;
  return { ...inspection, result: { ...inspection.result, outcome: "dry-run" } };
}

export interface InspectDeploymentOptions extends BuildInspectionOptions {
  readonly targetId: string;
  readonly targetName?: string;
  readonly roots?: ServerRoots;
  readonly lock?: LockProvider;
  /** Defaults to a redactor built from the target's stored secret values. */
  readonly redactor?: SecretRedactor;
}

export async function inspectDeployment(
  options: InspectDeploymentOptions,
): Promise<ServerInspectionResult> {
  const roots = options.roots ?? DEFAULT_SERVER_ROOTS;
  const paths = serverPaths(options.targetId, roots);
  const targetName = options.targetName ?? "unknown";
  const store = new DeploymentStateStore({
    file: paths.deploymentStateFile,
    lockFile: paths.deploymentStateLockFile,
    targetId: paths.targetId,
    targetName,
    lock: options.lock ?? new InProcessLockProvider(),
  });
  const redactor = options.redactor ?? await new SecretsStore({
    file: paths.secretsFile,
    requirements: { required: [], generated: [] },
  }).redactor();
  const inspection = buildInspection(
    await store.readStored(),
    { targetId: paths.targetId, targetName },
    { dryRun: options.dryRun },
  );
  return redactor.redact(inspection);
}
