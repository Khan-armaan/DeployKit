import { createHash } from "node:crypto";

import {
  CONTRACT_KEY_ORDER,
  MANIFEST_DIGEST_API_VERSION,
  RUNTIME_MANIFEST_CANONICALIZATION,
  SHA256_HEX_PATTERN,
  type CompiledRuntimeManifest,
  type ManifestDigest,
} from "./contracts.js";

/**
 * Phase 3 owns `deploykit/runtime-yaml-canonical/v1`: the single byte encoding
 * the manifest digest is taken over.
 *
 * The encoding is deliberately dull so two machines that agree on the manifest
 * value cannot disagree on its bytes: UTF-8 YAML 1.2, two-space indentation, LF
 * endings, exactly one trailing LF, every key and string double-quoted, no
 * aliases, tags, comments, or flow style except the empty collections, keys in
 * frozen contract order followed by ascending code-point order, and array order
 * supplied by the caller.
 *
 * Nothing here knows what a secret is. Callers pass a value that already
 * contains public values and secret names only.
 */

export type CanonicalScalar = string | number | boolean | null;
export type CanonicalValue =
  | CanonicalScalar
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

/**
 * Ascending Unicode code-point order. `String.prototype.localeCompare` is
 * locale-dependent and `<` compares UTF-16 code units, so neither is stable
 * enough for bytes a remote host recomputes a digest from.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Frozen contract order first, then every remaining key by code point. */
function orderedKeys(source: Record<string, unknown>, order: readonly string[] | undefined): string[] {
  const present = Object.keys(source).filter((key) => source[key] !== undefined);
  const head = (order ?? []).filter((key) => present.includes(key));
  const claimed = new Set(head);
  const tail = present.filter((key) => !claimed.has(key)).sort(compareCodePoints);
  return [...head, ...tail];
}

function scalar(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError("numbers must be finite", path);
    }
    // -0 and 0 are the same YAML value but different JavaScript renderings.
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") {
    // A YAML 1.2 double-quoted scalar accepts exactly the JSON string escapes.
    return JSON.stringify(value);
  }
  throw new CanonicalizationError(`unsupported ${typeof value} value`, path);
}

function emitSequence(items: readonly unknown[], indent: string, path: string, lines: string[]): void {
  items.forEach((item, index) => {
    emitNode(`${indent}-`, item, indent, `${path}[${index}]`, lines);
  });
}

function emitMapping(
  source: Record<string, unknown>,
  indent: string,
  order: readonly string[] | undefined,
  path: string,
  lines: string[],
): void {
  for (const key of orderedKeys(source, order)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    emitNode(`${indent}${JSON.stringify(key)}:`, source[key], indent, childPath, lines);
  }
}

/**
 * Emits one node behind `prefix`, which is either `"key":` or a sequence dash.
 * A sequence entry keeps its children at the dash's own indentation plus one
 * level, so `-` always sits alone on its line when it introduces a collection.
 */
function emitNode(
  prefix: string,
  value: unknown,
  indent: string,
  path: string,
  lines: string[],
): void {
  const childIndent = `${indent}  `;

  if (value === undefined) {
    throw new CanonicalizationError("undefined has no canonical encoding", path);
  }

  if (isPlainObject(value)) {
    if (orderedKeys(value, undefined).length === 0) {
      lines.push(`${prefix} {}`);
      return;
    }
    lines.push(prefix);
    emitMapping(value, childIndent, undefined, path, lines);
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix} []`);
      return;
    }
    lines.push(prefix);
    emitSequence(value, childIndent, path, lines);
    return;
  }

  // A scalar sequence entry stays on the dash line: `- "value"`.
  lines.push(`${prefix} ${scalar(value, path)}`);
}

/**
 * Serializes a value under `deploykit/runtime-yaml-canonical/v1`. `order` names
 * the frozen top-level key order; nested maps are always code-point ordered
 * because no contract freezes their order.
 */
export function canonicalYaml(value: CanonicalValue, order?: readonly string[]): string {
  if (!isPlainObject(value)) {
    throw new CanonicalizationError("the canonical document root must be a mapping", "<root>");
  }
  const lines: string[] = [];
  if (orderedKeys(value, order).length === 0) {
    throw new CanonicalizationError("the canonical document root must not be empty", "<root>");
  }
  emitMapping(value, "", order, "", lines);
  return `${lines.join("\n")}\n`;
}

/** The exact bytes the manifest digest is taken over and the gateway receives. */
export function canonicalRuntimeManifestBytes(manifest: CompiledRuntimeManifest): Buffer {
  return Buffer.from(
    canonicalYaml(manifest as unknown as CanonicalValue, CONTRACT_KEY_ORDER.runtimeManifest),
    "utf8",
  );
}

export function computeManifestDigest(bytes: Uint8Array): ManifestDigest {
  return {
    apiVersion: MANIFEST_DIGEST_API_VERSION,
    algorithm: "sha256",
    encoding: "hex",
    canonicalization: RUNTIME_MANIFEST_CANONICALIZATION,
    value: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Recomputes the digest of `bytes` and compares it with a claimed digest in
 * constant-shaped fashion. The gateway uses this before touching runtime state.
 */
export function manifestDigestMatches(bytes: Uint8Array, claimed: ManifestDigest): boolean {
  if (
    claimed.apiVersion !== MANIFEST_DIGEST_API_VERSION ||
    claimed.algorithm !== "sha256" ||
    claimed.encoding !== "hex" ||
    claimed.canonicalization !== RUNTIME_MANIFEST_CANONICALIZATION ||
    !SHA256_HEX_PATTERN.test(claimed.value)
  ) {
    return false;
  }
  return computeManifestDigest(bytes).value === claimed.value;
}
