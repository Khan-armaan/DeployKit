import { Readable } from "node:stream";

import { GATEWAY_PROTOCOL_LIMITS } from "../orchestrator/contracts.js";
import type { ServerRoots } from "../server/paths.js";
import { readGatewayBinding } from "./binding.js";
import { protocolError } from "./failures.js";
import type { GatewayInvocation } from "./invocation.js";
import { createGatewayOperations, type GatewaySourcePort } from "./runtime.js";
import { runGatewaySession, type GatewayOperations, type GatewaySessionResult } from "./session.js";

/**
 * The `deploykit gateway` entry point: the single program an
 * `authorized_keys` forced command may run on a bound VPS.
 *
 * It writes canonical JSON Lines to stdout and nothing else — no banner, no
 * human-readable summary, no diagnostics on stderr — because the far side
 * parses the whole stream. The process exit code is derived from the frozen
 * failure catalog, so a caller that cannot parse the stream still learns
 * whether the request was refused, and why in the coarse sense.
 */

/** Reads at most the frozen input bound and fails closed rather than truncating. */
export async function readBoundedInput(
  stream: NodeJS.ReadableStream,
  limit: number = GATEWAY_PROTOCOL_LIMITS.maxInputBytes,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limit) {
      throw protocolError("the request stream exceeds the frozen input bound", { limit });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface RunGatewayCommandOptions {
  /** Arguments after the gateway command; the forced command accepts none. */
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly roots?: ServerRoots;
  readonly now?: () => Date;
  /** Phase 7 supplies the verified exact-SHA source provider. */
  readonly source?: GatewaySourcePort;
  /** Overridden only by tests; production always reads the root-owned binding. */
  readonly operations?: GatewayOperations;
  readonly readBinding?: () => Promise<import("../orchestrator/contracts.js").RootOwnedGatewayBinding>;
}

export async function runGatewayCommand(
  options: RunGatewayCommandOptions = {},
): Promise<GatewaySessionResult> {
  const environment = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const invocation: GatewayInvocation = {
    environment,
    argv: options.argv ?? [],
    stdinIsTty: options.stdinIsTty ?? Boolean((process.stdin as NodeJS.ReadStream).isTTY),
    stdoutIsTty: options.stdoutIsTty ?? Boolean((process.stdout as NodeJS.WriteStream).isTTY),
  };

  const result = await runGatewaySession(() => readBoundedInput(stdin), {
    operations: options.operations ??
      createGatewayOperations({
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.roots === undefined ? {} : { roots: options.roots }),
      }),
    readBinding: options.readBinding ??
      (() => readGatewayBinding({ ...(options.roots === undefined ? {} : { roots: options.roots }) })),
    now: options.now ?? (() => new Date()),
    invocation,
  });

  const stdout = options.stdout ?? process.stdout;
  stdout.write(result.output);
  return result;
}

/** Convenience for tests and callers that already hold the request bytes. */
export function inputStreamFrom(text: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(text, "utf8")]);
}
