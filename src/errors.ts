export type ErrorCode =
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

export function exitCodeFor(code: ErrorCode): number {
  if (code === "DK_USAGE" || code === "DK_MANIFEST_NOT_FOUND") return 2;
  if (code === "DK_MANIFEST_INVALID" || code === "DK_VALIDATION_FAILED") return 3;
  if (code === "DK_PREFLIGHT_FAILED" || code === "DK_CONFLICT") return 4;
  if (code === "DK_ALREADY_DEPLOYED") return 5;
  if (code === "DK_SECRET_MISSING") return 6;
  if (code === "DK_SECURITY_ACK_REQUIRED") return 7;
  if (code === "DK_UNSUPPORTED") return 8;
  return 1;
}

export function asDeployKitError(error: unknown): DeployKitError {
  if (error instanceof DeployKitError) return error;
  if (error instanceof Error) {
    return new DeployKitError("DK_COMMAND_FAILED", error.message, { cause: error });
  }
  return new DeployKitError("DK_COMMAND_FAILED", String(error));
}
