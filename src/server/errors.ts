export type ServerErrorCode =
  | "SERVER_INVALID_ID"
  | "SERVER_INVALID_DOMAIN"
  | "SERVER_LOCK_TIMEOUT"
  | "SERVER_LOCK_FAILED"
  | "SERVER_STATE_INVALID"
  | "SERVER_STATE_LEGACY"
  | "SERVER_IDENTITY_MISMATCH"
  | "SERVER_DEPLOYMENT_EXISTS"
  | "SERVER_DEPLOYMENT_IN_PROGRESS"
  | "SERVER_CHECKPOINT_ORDER"
  | "SERVER_SOURCE_ROOT_INVALID"
  | "SERVER_RELEASE_CONFLICT"
  | "SERVER_PORT_COLLISION"
  | "SERVER_PORT_EXHAUSTED"
  | "SERVER_DOMAIN_COLLISION"
  | "SERVER_SECRET_INVALID"
  | "SERVER_SECRET_MISSING"
  | "SERVER_DNS_MISMATCH"
  | "SERVER_DNS_EMPTY"
  | "SERVER_HEALTH_TIMEOUT"
  | "SERVER_COMMAND_FAILED"
  | "SERVER_APPLY_FAILED"
  | "SERVER_UNSUPPORTED_OS"
  | "SERVER_UNSUPPORTED_ARCH";

export class ServerError extends Error {
  readonly code: ServerErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ServerErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServerError";
    this.code = code;
    this.details = details;
  }
}

export function isServerError(error: unknown): error is ServerError {
  return error instanceof ServerError;
}
