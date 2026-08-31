import { ZodError } from "zod";

import { DeployKitError, asDeployKitError, type ErrorCode } from "./errors.js";
import { ManifestFileError } from "./manifest.js";
import { redact } from "./output.js";
import { isServerError, type ServerErrorCode } from "./server/errors.js";
import { ManifestValidationError } from "./validation.js";

function deployKitCodeForServerError(code: ServerErrorCode): ErrorCode {
  switch (code) {
    case "SERVER_DEPLOYMENT_EXISTS":
      return "DK_ALREADY_DEPLOYED";
    case "SERVER_SECRET_MISSING":
      return "DK_SECRET_MISSING";
    case "SERVER_UNSUPPORTED_OS":
    case "SERVER_UNSUPPORTED_ARCH":
      return "DK_UNSUPPORTED";
    case "SERVER_LOCK_TIMEOUT":
    case "SERVER_LOCK_FAILED":
    case "SERVER_DEPLOYMENT_IN_PROGRESS":
    case "SERVER_PORT_COLLISION":
    case "SERVER_PORT_EXHAUSTED":
    case "SERVER_DOMAIN_COLLISION":
      return "DK_CONFLICT";
    case "SERVER_INVALID_ID":
    case "SERVER_INVALID_DOMAIN":
    case "SERVER_STATE_INVALID":
    case "SERVER_CHECKPOINT_ORDER":
    case "SERVER_SECRET_INVALID":
    case "SERVER_DNS_MISMATCH":
    case "SERVER_DNS_EMPTY":
      return "DK_PREFLIGHT_FAILED";
    case "SERVER_DEPLOYMENT_REF_MISMATCH":
    case "SERVER_HEALTH_TIMEOUT":
    case "SERVER_COMMAND_FAILED":
    case "SERVER_APPLY_FAILED":
      return "DK_DEPLOYMENT_FAILED";
  }
}

export function normalizeCliError(error: unknown): DeployKitError {
  if (isServerError(error)) {
    return new DeployKitError(
      deployKitCodeForServerError(error.code),
      error.message,
      { cause: error, details: { serverCode: error.code, ...error.details } },
    );
  }
  if (error instanceof ManifestFileError) {
    const missing = error.code === "MANIFEST_READ_FAILED" &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return new DeployKitError(
      missing ? "DK_MANIFEST_NOT_FOUND" : error.code === "MANIFEST_YAML_INVALID" ? "DK_MANIFEST_INVALID" : "DK_COMMAND_FAILED",
      error.message,
      { cause: error, details: error.filePath ? { file: error.filePath } : undefined },
    );
  }
  if (error instanceof ZodError) {
    return new DeployKitError("DK_MANIFEST_INVALID", "Manifest does not match deploykit/v1alpha1", {
      cause: error,
      details: { issues: error.issues },
    });
  }
  if (error instanceof ManifestValidationError) {
    return new DeployKitError("DK_VALIDATION_FAILED", error.message, {
      cause: error,
      details: { issues: error.issues },
    });
  }
  return asDeployKitError(error);
}

export function renderCliError(error: unknown, options: { json?: boolean; verbose?: boolean } = {}): { exitCode: number; output: string } {
  const normalized = normalizeCliError(error);
  const message = String(redact(normalized.message));
  const details = redact(normalized.details);
  if (options.json) {
    const payload: Record<string, unknown> = { ok: false, code: normalized.code, message };
    if (details !== undefined) payload.details = details;
    return { exitCode: normalized.exitCode, output: `${JSON.stringify(payload)}\n` };
  }
  const detailOutput = options.verbose && details !== undefined ? `${JSON.stringify(details, null, 2)}\n` : "";
  return { exitCode: normalized.exitCode, output: `${normalized.code}: ${message}\n${detailOutput}` };
}
