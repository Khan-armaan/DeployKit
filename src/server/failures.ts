import type { ErrorCode } from "../errors.js";
import type { RecoveryAction } from "../orchestrator/contracts.js";
import { failureRecoveryDetails } from "../orchestrator/failures.js";

import type { ServerErrorCode } from "./errors.js";

/**
 * The single frozen translation from a runtime failure to the stable `DK_*`
 * vocabulary in `orchestrator-contracts.md`. Both the local CLI renderer and
 * the redacted inspection result read it, so an operator sees the same code and
 * the same recovery action whether the failure surfaced through the legacy
 * command or through the gateway.
 */
const DEPLOYKIT_CODES: Readonly<Record<ServerErrorCode, ErrorCode>> = Object.freeze({
  SERVER_INVALID_ID: "DK_PREFLIGHT_FAILED",
  SERVER_INVALID_DOMAIN: "DK_PREFLIGHT_FAILED",
  SERVER_LOCK_TIMEOUT: "DK_CONFLICT",
  SERVER_LOCK_FAILED: "DK_CONFLICT",
  SERVER_STATE_INVALID: "DK_PREFLIGHT_FAILED",
  SERVER_STATE_LEGACY: "DK_STATE_LEGACY",
  SERVER_IDENTITY_MISMATCH: "DK_IDENTITY_MISMATCH",
  SERVER_DEPLOYMENT_EXISTS: "DK_ALREADY_DEPLOYED",
  SERVER_DEPLOYMENT_IN_PROGRESS: "DK_CONFLICT",
  SERVER_CHECKPOINT_ORDER: "DK_PREFLIGHT_FAILED",
  SERVER_SOURCE_ROOT_INVALID: "DK_SOURCE_UNSAFE",
  SERVER_RELEASE_CONFLICT: "DK_CONFLICT",
  SERVER_PORT_COLLISION: "DK_CONFLICT",
  SERVER_PORT_EXHAUSTED: "DK_CONFLICT",
  SERVER_DOMAIN_COLLISION: "DK_CONFLICT",
  SERVER_SECRET_INVALID: "DK_PREFLIGHT_FAILED",
  SERVER_SECRET_MISSING: "DK_SECRET_MISSING",
  SERVER_DNS_MISMATCH: "DK_PREFLIGHT_FAILED",
  SERVER_DNS_EMPTY: "DK_PREFLIGHT_FAILED",
  SERVER_HEALTH_TIMEOUT: "DK_DEPLOYMENT_FAILED",
  SERVER_COMMAND_FAILED: "DK_DEPLOYMENT_FAILED",
  SERVER_APPLY_FAILED: "DK_DEPLOYMENT_FAILED",
  SERVER_UNSUPPORTED_OS: "DK_UNSUPPORTED",
  SERVER_UNSUPPORTED_ARCH: "DK_UNSUPPORTED",
} as const);

export function deployKitCodeForServerError(code: ServerErrorCode): ErrorCode {
  return DEPLOYKIT_CODES[code];
}

/**
 * The recovery action an operator must take. Codes outside the frozen catalog
 * (`DK_UNSUPPORTED`, for example) have no catalog entry and are not resumable.
 */
export function recoveryForDeployKitCode(code: ErrorCode): RecoveryAction {
  return failureRecoveryDetails(code)?.recovery ?? "not-resumable";
}

export function recoveryForServerError(code: ServerErrorCode): RecoveryAction {
  return recoveryForDeployKitCode(deployKitCodeForServerError(code));
}
