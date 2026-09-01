export type LegacyErrorCode =
  | "DK_USAGE"
  | "DK_MANIFEST_NOT_FOUND"
  | "DK_MANIFEST_INVALID"
  | "DK_VALIDATION_FAILED"
  | "DK_COMMAND_FAILED"
  | "DK_PREFLIGHT_FAILED"
  | "DK_CONFLICT"
  | "DK_DEPLOYMENT_FAILED"
  | "DK_ALREADY_DEPLOYED"
  | "DK_NOT_FOUND"
  | "DK_SECRET_MISSING"
  | "DK_SECURITY_ACK_REQUIRED"
  | "DK_UNSUPPORTED";

/**
 * Orchestrator boundary failures frozen by Phase 1. They are additive: no
 * existing code, message, or exit code changes, and no production path emits
 * them until the phase that owns the boundary is implemented.
 */
export type OrchestratorErrorCode =
  | "DK_CONFIG_SCAFFOLDED"
  | "DK_CONFIG_INSECURE"
  | "DK_CONFIG_INVALID"
  | "DK_CONFIG_PLACEHOLDER"
  | "DK_GITHUB_AUTH_REQUIRED"
  | "DK_GITHUB_PERMISSION_DENIED"
  | "DK_GITHUB_API_FAILED"
  | "DK_GITHUB_RATE_LIMITED"
  | "DK_REF_NOT_FOUND"
  | "DK_REF_MOVED"
  | "DK_SETUP_PR_REVIEW_REQUIRED"
  | "DK_CONTROL_ARTIFACTS_DRIFTED"
  | "DK_OWNERSHIP_CONFLICT"
  | "DK_SSH_UNREACHABLE"
  | "DK_SSH_HOST_KEY_MISMATCH"
  | "DK_GATEWAY_BOOTSTRAP_FAILED"
  | "DK_GATEWAY_BINDING_MISMATCH"
  | "DK_GATEWAY_PROTOCOL_INVALID"
  | "DK_GATEWAY_VERSION_MISMATCH"
  | "DK_KEY_ROTATION_FAILED"
  | "DK_ENVIRONMENT_CONFLICT"
  | "DK_ENVIRONMENT_APPROVAL_REQUIRED"
  | "DK_DISPATCH_NOT_READY"
  | "DK_WORKFLOW_RUN_NOT_FOUND"
  | "DK_WORKFLOW_RUN_FAILED"
  | "DK_SOURCE_UNVERIFIED"
  | "DK_SOURCE_UNSAFE"
  | "DK_IDENTITY_MISMATCH"
  | "DK_STATE_LEGACY"
  | "DK_OPERATION_STATE_INVALID";

export type ErrorCode = LegacyErrorCode | OrchestratorErrorCode;

export class DeployKitError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; details?: unknown; exitCode?: number }) {
    super(message, { cause: options?.cause });
    this.name = "DeployKitError";
    this.code = code;
    this.details = options?.details;
    this.exitCode = options?.exitCode ?? exitCodeFor(code);
  }
}

/** Exit code 9 means DeployKit is waiting on a human or external system. */
const WAITING_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "DK_SETUP_PR_REVIEW_REQUIRED",
  "DK_ENVIRONMENT_APPROVAL_REQUIRED",
  "DK_WORKFLOW_RUN_NOT_FOUND",
  "DK_GITHUB_RATE_LIMITED",
]);

const INVALID_INPUT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "DK_MANIFEST_INVALID",
  "DK_VALIDATION_FAILED",
  "DK_CONFIG_INSECURE",
  "DK_CONFIG_INVALID",
  "DK_CONFIG_PLACEHOLDER",
]);

const CONFLICT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "DK_PREFLIGHT_FAILED",
  "DK_CONFLICT",
  "DK_GITHUB_AUTH_REQUIRED",
  "DK_GITHUB_PERMISSION_DENIED",
  "DK_REF_NOT_FOUND",
  "DK_OWNERSHIP_CONFLICT",
  "DK_SSH_UNREACHABLE",
  "DK_SSH_HOST_KEY_MISMATCH",
  "DK_GATEWAY_BINDING_MISMATCH",
  "DK_ENVIRONMENT_CONFLICT",
  "DK_IDENTITY_MISMATCH",
  "DK_STATE_LEGACY",
]);

export function exitCodeFor(code: ErrorCode): number {
  if (code === "DK_USAGE" || code === "DK_MANIFEST_NOT_FOUND" || code === "DK_CONFIG_SCAFFOLDED") return 2;
  if (INVALID_INPUT_CODES.has(code)) return 3;
  if (CONFLICT_CODES.has(code)) return 4;
  if (code === "DK_ALREADY_DEPLOYED") return 5;
  if (code === "DK_SECRET_MISSING") return 6;
  if (code === "DK_SECURITY_ACK_REQUIRED") return 7;
  if (code === "DK_UNSUPPORTED" || code === "DK_GATEWAY_VERSION_MISMATCH") return 8;
  if (WAITING_CODES.has(code)) return 9;
  return 1;
}

export function asDeployKitError(error: unknown): DeployKitError {
  if (error instanceof DeployKitError) return error;
  if (error instanceof Error) {
    return new DeployKitError("DK_COMMAND_FAILED", error.message, { cause: error });
  }
  return new DeployKitError("DK_COMMAND_FAILED", String(error));
}
