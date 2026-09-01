import { DeployKitError, type ErrorCode } from "../errors.js";
import type { RecoveryAction } from "../orchestrator/contracts.js";
import { failureRecoveryDetails } from "../orchestrator/failures.js";

/**
 * Phase 6 raises only codes from the frozen catalog. A gateway failure carries
 * its recovery action because the failure result frame reports it to the caller
 * verbatim: the operator must see the same instruction whether the refusal
 * happened locally or behind the forced command.
 *
 * Details attached here are secret-free by construction. Callers pass names,
 * counts, and limits; never a received secret value or a raw payload.
 */
export function gatewayRecovery(code: ErrorCode): RecoveryAction {
  return failureRecoveryDetails(code)?.recovery ?? "not-resumable";
}

export function gatewayError(
  code: ErrorCode,
  message: string,
  options: { cause?: unknown; details?: Record<string, unknown> } = {},
): DeployKitError {
  const recovery = failureRecoveryDetails(code);
  const details = { ...recovery, ...options.details };
  return new DeployKitError(code, message, {
    cause: options.cause,
    details: Object.keys(details).length > 0 ? details : undefined,
  });
}

/** A malformed, noncanonical, oversized, duplicated, or trailing frame. */
export function protocolError(
  message: string,
  details: Record<string, unknown> = {},
): DeployKitError {
  return gatewayError("DK_GATEWAY_PROTOCOL_INVALID", message, { details });
}
