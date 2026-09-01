import { ZodError } from "zod";

import { DeployKitError, asDeployKitError } from "./errors.js";
import { ManifestFileError } from "./manifest.js";
import { redact } from "./output.js";
import { isServerError } from "./server/errors.js";
import { deployKitCodeForServerError, recoveryForServerError } from "./server/failures.js";
import { ManifestValidationError } from "./validation.js";

export function normalizeCliError(error: unknown): DeployKitError {
  if (isServerError(error)) {
    return new DeployKitError(
      deployKitCodeForServerError(error.code),
      error.message,
      {
        cause: error,
        details: {
          serverCode: error.code,
          recovery: recoveryForServerError(error.code),
          ...error.details,
        },
      },
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
