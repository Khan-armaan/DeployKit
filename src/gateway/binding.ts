import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  GATEWAY_BINDING_API_VERSION,
  GATEWAY_FORCED_COMMAND,
  GATEWAY_USER,
  SHA256_HEX_PATTERN,
  type CompiledRuntimeManifest,
  type RootOwnedGatewayBinding,
} from "../orchestrator/contracts.js";
import { DEFAULT_SERVER_ROOTS, type ServerRoots } from "../server/paths.js";
import { gatewayError } from "./failures.js";
import type { GatewayRequestStream } from "./protocol.js";

/**
 * The binding is the gateway's only source of identity. It is written by root
 * during bootstrap and is never writable by the gateway user, so a caller who
 * reaches the forced command can *confirm* which repository, Environment,
 * target, and target ID this host serves but can never choose them.
 *
 * Reading it is therefore a trust decision, not a convenience: the file is
 * opened without following symlinks and the opened descriptor is checked for
 * root ownership and for the absence of group or world write permission before
 * a byte of it is parsed.
 */

export const MAX_BINDING_BYTES = 64 * 1024;

export function gatewayBindingFile(roots: ServerRoots = DEFAULT_SERVER_ROOTS): string {
  return join(roots.config, "gateway", "binding.json");
}

const bindingSchema = z.strictObject({
  apiVersion: z.literal(GATEWAY_BINDING_API_VERSION),
  bindingId: z.string().min(1).max(128),
  repository: z.string().min(1).max(512),
  githubEnvironment: z.string().min(1).max(255),
  targetName: z.string().min(1).max(64),
  targetId: z.string().regex(/^[0-9a-f]{32}$/u, "must be a 32-character lower-case target id"),
  gatewayUser: z.literal(GATEWAY_USER),
  forcedCommand: z.literal(GATEWAY_FORCED_COMMAND),
  runtimeVersion: z.string().min(1).max(128),
  runtimeBundleSha256: z.string().regex(SHA256_HEX_PATTERN, "must be a SHA-256 hexadecimal digest"),
  repositoryKeyId: z.string().min(1).max(255),
  repositoryKeyFingerprint: z.string().min(1).max(255),
  activeGatewayKeyId: z.string().min(1).max(255).nullable(),
  pendingGatewayKeyId: z.string().min(1).max(255).nullable(),
});

function bootstrapError(message: string, details: Record<string, unknown> = {}): Error {
  return gatewayError("DK_GATEWAY_BOOTSTRAP_FAILED", message, { details });
}

export interface ReadGatewayBindingOptions {
  readonly path?: string;
  readonly roots?: ServerRoots;
  /** Ownership checks are skipped only where the platform has no uid concept. */
  readonly requireRootOwnership?: boolean;
}

export async function readGatewayBinding(
  options: ReadGatewayBindingOptions = {},
): Promise<RootOwnedGatewayBinding> {
  const path = options.path ?? gatewayBindingFile(options.roots);
  const requireRootOwnership = options.requireRootOwnership ?? true;

  // O_NOFOLLOW refuses a symlink at the final component, and every further
  // check runs against the descriptor that was actually opened.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw bootstrapError(`the root-owned gateway binding at ${path} could not be opened securely`, {
      path,
      cause: (error as NodeJS.ErrnoException).code ?? "unknown",
    });
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw bootstrapError(`the gateway binding at ${path} is not a regular file`, { path });
    if (stats.size > MAX_BINDING_BYTES) {
      throw bootstrapError(`the gateway binding at ${path} exceeds ${String(MAX_BINDING_BYTES)} bytes`, { path });
    }
    if (requireRootOwnership && stats.uid !== 0) {
      throw bootstrapError(`the gateway binding at ${path} is not owned by root`, { path });
    }
    if ((stats.mode & 0o022) !== 0) {
      throw bootstrapError(`the gateway binding at ${path} is group- or world-writable`, { path });
    }
    const contents = await handle.readFile("utf8");
    let document: unknown;
    try {
      document = JSON.parse(contents);
    } catch (error) {
      throw bootstrapError(`the gateway binding at ${path} is not parsable JSON`, {
        path,
        cause: String(error),
      });
    }
    const parsed = bindingSchema.safeParse(document);
    if (!parsed.success) {
      throw bootstrapError(`the gateway binding at ${path} does not match the frozen binding contract`, {
        path,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map((segment) => String(segment)),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  } finally {
    await handle.close();
  }
}

/** Fields a caller may only confirm. Every one of them is root-owned. */
const CONFIRMED_FIELDS = ["repository", "githubEnvironment", "targetName", "targetId"] as const;

/**
 * Compares the request, and the manifest it carries, against the root-owned
 * binding. Any disagreement is a binding mismatch rather than a protocol
 * failure: the stream was well formed, it simply asked this host to act for a
 * deployment it is not bound to.
 */
export function confirmGatewayBinding(
  stream: Pick<GatewayRequestStream, "request" | "manifest">,
  binding: RootOwnedGatewayBinding,
): void {
  const request = stream.request as unknown as Record<string, unknown>;
  const mismatched = CONFIRMED_FIELDS.filter((field) => request[field] !== binding[field]);
  if (mismatched.length > 0) {
    throw gatewayError(
      "DK_GATEWAY_BINDING_MISMATCH",
      "the request does not confirm the root-owned gateway binding",
      { details: { fields: mismatched } },
    );
  }

  const manifest: CompiledRuntimeManifest | null = stream.manifest;
  if (manifest === null) return;
  const manifestMismatch: string[] = [];
  if (manifest.target.targetId !== binding.targetId) manifestMismatch.push("target.targetId");
  if (manifest.target.name !== binding.targetName) manifestMismatch.push("target.name");
  if (manifest.target.githubEnvironment !== binding.githubEnvironment) {
    manifestMismatch.push("target.githubEnvironment");
  }
  if (manifestMismatch.length > 0) {
    throw gatewayError(
      "DK_GATEWAY_BINDING_MISMATCH",
      "the runtime manifest names a target this host is not bound to",
      { details: { fields: manifestMismatch } },
    );
  }
}
