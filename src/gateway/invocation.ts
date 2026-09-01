import { protocolError } from "./failures.js";

/**
 * The gateway is reached through one `authorized_keys` forced command and
 * nothing else. SSH still hands the invoked program whatever the client asked
 * for, so the forced command has to refuse the request itself rather than trust
 * that `restrict` was configured correctly on the far side.
 *
 * Every refusal here happens before stdin is read, so a caller who asks for a
 * shell, a PTY, or a forwarded channel never reaches the protocol at all.
 */

/**
 * Variables SSH sets when the client requested a channel the gateway must never
 * provide. Their mere presence is the signal; their values are never inspected.
 */
const FORBIDDEN_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  SSH_TTY: "a pseudo-terminal",
  SSH_AUTH_SOCK: "agent forwarding",
  DISPLAY: "X11 forwarding",
  XAUTHORITY: "X11 forwarding",
});

/** The only environment a gateway-spawned process inherits. */
export const GATEWAY_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" as const;

export interface GatewayInvocation {
  readonly environment: NodeJS.ProcessEnv;
  /** Arguments after the gateway command itself; the forced command takes none. */
  readonly argv: readonly string[];
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
}

/**
 * Refuses every invocation shape the forced command does not serve. A non-empty
 * `SSH_ORIGINAL_COMMAND` means the client tried to run something of its own
 * choosing; the forced command overrode it, and DeployKit refuses rather than
 * silently ignoring the attempt.
 */
export function assertRestrictedInvocation(invocation: GatewayInvocation): void {
  const original = invocation.environment.SSH_ORIGINAL_COMMAND;
  if (typeof original === "string" && original.trim() !== "") {
    throw protocolError("the gateway forced command accepts no client-supplied command");
  }
  if (invocation.argv.length > 0) {
    throw protocolError("the gateway forced command accepts no arguments", {
      received: invocation.argv.length,
    });
  }
  for (const [name, description] of Object.entries(FORBIDDEN_ENVIRONMENT)) {
    if (invocation.environment[name] !== undefined) {
      throw protocolError(`the gateway refuses a session that requested ${description}`, { variable: name });
    }
  }
  if (invocation.stdinIsTty || invocation.stdoutIsTty) {
    throw protocolError("the gateway refuses an interactive session");
  }
}

/**
 * The minimal environment every gateway-spawned process receives. Nothing is
 * inherited: a caller cannot reach the runtime's child processes through
 * `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_*`, proxy variables, or anything else.
 */
export function minimalGatewayEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    PATH: GATEWAY_PATH,
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    DEPLOYKIT_SERVER_RUNTIME: "1",
    ...overrides,
  };
}
