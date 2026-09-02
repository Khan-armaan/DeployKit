import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalFrameLine, parseGatewayOutputStream } from "../gateway/protocol.js";
import {
  CONTRACT_KEY_ORDER,
  GATEWAY_PROTOCOL_LIMITS,
  type GatewayInputFrame,
  type GatewayOutputFrame,
} from "./contracts.js";
import {
  processAdministratorCommandRunner,
  type AdministratorCommandRunner,
} from "./administrator-ssh.js";
import type { GatewayConnection, GatewayExchange, GatewayTransportPort } from "./dependencies.js";
import { orchestratorError } from "./failures.js";

/**
 * Phase 12: the production gateway transport.
 *
 * This is the client half of the Phase 6 protocol, used locally for the two
 * non-mutating operations DeployKit performs itself — the key-rotation
 * handshake and the final deployment inspection. The mutating `apply` is sent
 * by the reviewed workflow's own bounded client, never from here, which is why
 * this module has no way to frame a manifest or a secret beyond serializing
 * whatever the caller yields.
 *
 * Three properties make it safe to point at a host holding root-equivalent
 * capability.
 *
 * There is no command. The gateway account's `authorized_keys` entry carries a
 * forced command, so the invocation deliberately passes no program and no
 * arguments; a client that supplied one would be refused by the far side, and
 * not supplying one means there is nothing for a configured value to become.
 *
 * The host is pinned by content, not by trust on first use. The caller supplies
 * `known_hosts` bytes — the same pinned line the workflow receives through the
 * target Environment — and they are written to a mode-0600 file inside a
 * mode-0700 directory that is removed whether the exchange succeeded or not.
 *
 * Every bound is checked before a byte is sent and before a byte is parsed.
 * `gh`-style hygiene applies to diagnostics too: neither the far side's stderr
 * nor the raw stream is ever attached to a failure, because a malformed stream
 * is exactly the case where an unparsed fragment might be a secret frame.
 */

const EXCHANGE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const GATEWAY_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const GATEWAY_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

/** The most output a conforming gateway can produce for one request. */
const MAX_OUTPUT_BYTES =
  GATEWAY_PROTOCOL_LIMITS.maxProgressEvents * GATEWAY_PROTOCOL_LIMITS.maxProgressEventBytes +
  GATEWAY_PROTOCOL_LIMITS.maxResultBytes;

function protocolFailure(message: string, details: Record<string, unknown> = {}): Error {
  return orchestratorError("DK_GATEWAY_PROTOCOL_INVALID", message, { details });
}

export function assertGatewayConnection(connection: GatewayConnection): void {
  if (!GATEWAY_HOST_PATTERN.test(connection.host)) {
    throw orchestratorError("DK_SSH_UNREACHABLE", "The gateway host is not a DNS name or IPv4 address");
  }
  if (!GATEWAY_USER_PATTERN.test(connection.user)) {
    throw orchestratorError("DK_SSH_UNREACHABLE", "The gateway user is not a Linux account name");
  }
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) {
    throw orchestratorError("DK_SSH_UNREACHABLE", "The gateway port is not a TCP port number");
  }
  if (connection.identityFile.length === 0 || !connection.identityFile.startsWith("/")) {
    throw orchestratorError("DK_SSH_UNREACHABLE", "The gateway identity file is not an absolute path");
  }
  if (connection.knownHosts.trim() === "") {
    throw orchestratorError(
      "DK_SSH_HOST_KEY_MISMATCH",
      "The gateway connection carries no pinned host key",
    );
  }
}

/** The frozen key order each input frame is serialized under. */
function keyOrderFor(frame: GatewayInputFrame): readonly string[] {
  switch (frame.frame) {
    case "request":
      return CONTRACT_KEY_ORDER.gatewayRequestFrame;
    case "manifest":
      return CONTRACT_KEY_ORDER.gatewayManifestFrame;
    case "secret":
      return CONTRACT_KEY_ORDER.gatewaySecretFrame;
    default:
      return CONTRACT_KEY_ORDER.gatewayEndFrame;
  }
}

/**
 * Serializes the caller's frames into the exact canonical bytes the gateway
 * parser expects, failing closed on any bound rather than truncating.
 */
export function encodeGatewayInput(frames: readonly GatewayInputFrame[]): string {
  let total = 0;
  const lines: string[] = [];
  for (const frame of frames) {
    const line = `${canonicalFrameLine(frame as unknown as Record<string, unknown>, keyOrderFor(frame))}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > GATEWAY_PROTOCOL_LIMITS.maxFrameBytes) {
      throw protocolFailure("A gateway input frame exceeds the frozen frame size", { frame: frame.frame });
    }
    if (frame.frame === "request" && bytes > GATEWAY_PROTOCOL_LIMITS.maxRequestFrameBytes) {
      throw protocolFailure("The gateway request frame exceeds the frozen request size");
    }
    total += bytes;
    if (total > GATEWAY_PROTOCOL_LIMITS.maxInputBytes) {
      throw protocolFailure("The gateway input stream exceeds the frozen stream size");
    }
    lines.push(line);
  }
  if (lines.length === 0) throw protocolFailure("A gateway exchange must send at least a request frame");
  return lines.join("");
}

/** Deterministic, forwarding-free options for a forced-command session. */
export function gatewaySshOptions(
  connection: GatewayConnection,
  knownHostsFile: string,
): readonly string[] {
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "RequestTTY=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ConnectTimeout=30",
    "-i", connection.identityFile,
    "-T",
    "-p", String(connection.port),
    `${connection.user}@${connection.host}`,
  ];
}

export interface GatewayTransportOptions {
  readonly runner?: AdministratorCommandRunner;
  readonly timeoutMs?: number;
  /** Parent of the mode-0700 directory the pinned host key is written into. */
  readonly temporaryRoot?: string;
}

export function createGatewayTransport(
  options: GatewayTransportOptions = {},
): GatewayTransportPort {
  const runner = options.runner ?? processAdministratorCommandRunner;
  const timeoutMs = options.timeoutMs ?? EXCHANGE_TIMEOUT_MS;
  const temporaryRoot = options.temporaryRoot ?? tmpdir();

  return {
    async *exchange(request: GatewayExchange): AsyncIterable<GatewayOutputFrame> {
      const connection = request.connection;
      assertGatewayConnection(connection);

      const frames: GatewayInputFrame[] = [];
      for await (const frame of request.frames) frames.push(frame);
      const input = encodeGatewayInput(frames);

      const directory = await mkdtemp(join(temporaryRoot, "deploykit-gateway-hosts-"));
      await chmod(directory, 0o700);
      let stdout: string;
      let exitCode: number;
      try {
        const knownHostsFile = join(directory, "known_hosts");
        const pinned = connection.knownHosts.endsWith("\n")
          ? connection.knownHosts
          : `${connection.knownHosts}\n`;
        await writeFile(knownHostsFile, pinned, { mode: 0o600 });
        // No program and no arguments: the far side's forced command decides
        // what runs, and a client-supplied command is refused there.
        const result = await runner.run({
          command: "ssh",
          args: [...gatewaySshOptions(connection, knownHostsFile)],
          input,
          timeoutMs,
        });
        stdout = result.stdout;
        exitCode = result.exitCode;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }

      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
        throw protocolFailure("The gateway produced more output than the frozen bounds allow");
      }

      let output: readonly GatewayOutputFrame[];
      try {
        output = parseGatewayOutputStream(stdout);
      } catch (cause) {
        // A non-zero exit with unparsable output is a host that never reached
        // the gateway program — a broken installation, not a broken protocol.
        if (exitCode !== 0) {
          throw orchestratorError(
            "DK_GATEWAY_BOOTSTRAP_FAILED",
            `${connection.host} did not answer the DeployKit gateway`,
            { details: { host: connection.host, exitCode } },
          );
        }
        throw protocolFailure(`${connection.host} answered with a stream DeployKit refuses to parse`, {
          host: connection.host,
          cause: cause instanceof Error ? cause.name : "unknown",
        });
      }

      for (const frame of output) yield frame;
    },
  };
}
