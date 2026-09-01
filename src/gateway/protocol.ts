import { createHash } from "node:crypto";

import type { ErrorCode } from "../errors.js";
import { compareCodePoints } from "../orchestrator/canonical.js";
import {
  CONTRACT_KEY_ORDER,
  GATEWAY_PROTOCOL_LIMITS,
  GATEWAY_PROTOCOL_VERSION,
  GIT_COMMIT_SHA_PATTERN,
  MANIFEST_DIGEST_API_VERSION,
  REQUEST_ID_PATTERN,
  RUNTIME_MANIFEST_CANONICALIZATION,
  SHA256_HEX_PATTERN,
  type CompiledRuntimeManifest,
  type GatewayEndFrame,
  type GatewayOperation,
  type GatewayOutputFrame,
  type GatewayRequestFrame,
  type ManifestDigest,
} from "../orchestrator/contracts.js";
import { RECOVERY_INSTRUCTIONS, failureContract } from "../orchestrator/failures.js";
import { gatewayError, protocolError } from "./failures.js";
import { parseCanonicalRuntimeManifest } from "./runtime-manifest.js";

/**
 * Phase 6 owns the only thing a restricted gateway ever reads: one bounded,
 * canonical JSON Lines stream on stdin. Everything here fails closed. A frame
 * that is too large, out of order, noncanonical, duplicated, undeclared, or
 * trailing is refused before the runtime is touched, and nothing in this module
 * writes to disk, spawns a process, or consults the network.
 *
 * The parser deliberately re-derives every claim: the manifest digest is
 * recomputed from the received bytes, the declared frame counts are compared
 * with the frames that actually arrived, and the caller's repository, target,
 * and Environment are only *confirmed* against the root-owned binding by
 * `confirmGatewayBinding`. Caller input never chooses identity.
 */

export type GatewayFrameKind = "request" | "manifest" | "secret" | "end" | "progress" | "result";

export const GATEWAY_OPERATIONS: readonly GatewayOperation[] = Object.freeze([
  "handshake",
  "apply",
  "retry",
  "inspect",
] as const);

const MUTATING_OPERATIONS: ReadonlySet<string> = new Set(["apply", "retry"]);

const FRAME_KEY_ORDER: Readonly<Record<GatewayFrameKind, readonly string[]>> = Object.freeze({
  request: CONTRACT_KEY_ORDER.gatewayRequestFrame,
  manifest: CONTRACT_KEY_ORDER.gatewayManifestFrame,
  secret: CONTRACT_KEY_ORDER.gatewaySecretFrame,
  end: CONTRACT_KEY_ORDER.gatewayEndFrame,
  progress: CONTRACT_KEY_ORDER.gatewayProgressEvent,
  result: CONTRACT_KEY_ORDER.gatewayResult,
});

/**
 * The digest record is the only nested value with a frozen key order. It is
 * keyed by property name because the same record appears as `manifestDigest`
 * in a request, as `digest` in a manifest frame, and as `runtimeManifestDigest`
 * in an ownership marker.
 */
const NESTED_KEY_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  manifestDigest: CONTRACT_KEY_ORDER.manifestDigest,
  digest: CONTRACT_KEY_ORDER.manifestDigest,
  runtimeManifestDigest: CONTRACT_KEY_ORDER.manifestDigest,
});

const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

type Json = Record<string, unknown>;

function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Frozen contract order first, then remaining keys in ascending code point. */
function orderedEntries(source: Json, order: readonly string[]): [string, unknown][] {
  const head = order.filter((key) => Object.hasOwn(source, key));
  const claimed = new Set(head);
  const tail = Object.keys(source).filter((key) => !claimed.has(key)).sort(compareCodePoints);
  return [...head, ...tail].map((key) => [key, source[key]]);
}

function canonicalValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, key));
  if (isJsonObject(value)) {
    const order = key === undefined ? [] : NESTED_KEY_ORDER[key] ?? [];
    return Object.fromEntries(
      orderedEntries(value, order).map(([name, entry]) => [name, canonicalValue(entry, name)]),
    );
  }
  return value;
}

/** Canonical UTF-8 JSON for one frame, without the terminating LF. */
export function canonicalFrameLine(frame: Json, order: readonly string[]): string {
  return JSON.stringify(
    Object.fromEntries(
      orderedEntries(frame, order).map(([key, value]) => [key, canonicalValue(value, key)]),
    ),
  );
}

/** One canonical frame plus its single trailing LF, ready to write. */
export function encodeGatewayFrame(frame: GatewayOutputFrame): string {
  const order = FRAME_KEY_ORDER[frame.frame as GatewayFrameKind];
  return `${canonicalFrameLine(frame as unknown as Json, order)}\n`;
}

export function encodeGatewayFrames(frames: readonly GatewayOutputFrame[]): string {
  return frames.map((frame) => encodeGatewayFrame(frame)).join("");
}

/** Base64 whose re-encoding is byte-identical to the transmitted string. */
export function isCanonicalBase64(payload: unknown): payload is string {
  return typeof payload === "string" &&
    Buffer.from(payload, "base64").toString("base64") === payload;
}

function frameOrder(kind: unknown): readonly string[] | undefined {
  return typeof kind === "string" && Object.hasOwn(FRAME_KEY_ORDER, kind)
    ? FRAME_KEY_ORDER[kind as GatewayFrameKind]
    : undefined;
}

function frameSizeLimit(kind: GatewayFrameKind): number {
  switch (kind) {
    case "request": return GATEWAY_PROTOCOL_LIMITS.maxRequestFrameBytes;
    case "progress": return GATEWAY_PROTOCOL_LIMITS.maxProgressEventBytes;
    case "result": return GATEWAY_PROTOCOL_LIMITS.maxResultBytes;
    default: return GATEWAY_PROTOCOL_LIMITS.maxFrameBytes;
  }
}

interface DecodedFrame {
  readonly kind: GatewayFrameKind;
  readonly body: Json;
  readonly index: number;
}

/**
 * Splits and structurally validates every line before a single field is
 * interpreted. A version mismatch is reported first and separately, because the
 * client and gateway then disagree about what the remaining bytes even mean.
 */
function decodeFrames(text: string): DecodedFrame[] {
  if (Buffer.byteLength(text, "utf8") > GATEWAY_PROTOCOL_LIMITS.maxInputBytes) {
    throw protocolError("the request stream exceeds the frozen input bound", {
      limit: GATEWAY_PROTOCOL_LIMITS.maxInputBytes,
    });
  }
  if (text === "") throw protocolError("the request stream is empty");
  if (!text.endsWith("\n")) throw protocolError("the request stream does not end with LF");

  const lines = text.slice(0, -1).split("\n");
  const frames: DecodedFrame[] = [];
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    if (line === "") throw protocolError(`line ${position} is empty`, { line: position });
    if (Buffer.byteLength(line, "utf8") > GATEWAY_PROTOCOL_LIMITS.maxFrameBytes) {
      throw protocolError(`line ${position} exceeds the frozen frame bound`, {
        line: position,
        limit: GATEWAY_PROTOCOL_LIMITS.maxFrameBytes,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw protocolError(`line ${position} is not parsable JSON`, { line: position, cause: String(error) });
    }
    if (!isJsonObject(parsed)) {
      throw protocolError(`line ${position} is not a JSON object`, { line: position });
    }
    if (parsed.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
      throw gatewayError(
        "DK_GATEWAY_VERSION_MISMATCH",
        `line ${position} declares a gateway protocol version this runtime does not implement`,
        { details: { line: position, supported: GATEWAY_PROTOCOL_VERSION } },
      );
    }
    const order = frameOrder(parsed.frame);
    if (order === undefined) {
      throw protocolError(`line ${position} declares an unknown frame kind`, { line: position });
    }
    const kind = parsed.frame as GatewayFrameKind;
    if (Buffer.byteLength(line, "utf8") > frameSizeLimit(kind)) {
      throw protocolError(`line ${position} exceeds the frozen ${kind} frame bound`, {
        line: position,
        limit: frameSizeLimit(kind),
      });
    }
    const actual = Object.keys(parsed).sort(compareCodePoints);
    const expected = [...order].sort(compareCodePoints);
    if (actual.length !== expected.length || actual.some((key, at) => key !== expected[at])) {
      throw protocolError(`line ${position} key set differs from the frozen ${kind} contract`, {
        line: position,
      });
    }
    if (canonicalFrameLine(parsed, order) !== line) {
      throw protocolError(`line ${position} is not in canonical contract order`, { line: position });
    }
    frames.push({ kind, body: parsed, index: position });
  }
  return frames;
}

function requireString(body: Json, key: string, label: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw protocolError(`${label} ${key} must be a non-empty string`);
  }
  return value;
}

function requireBoundedString(body: Json, key: string, label: string, max: number): string {
  const value = requireString(body, key, label);
  if (Buffer.byteLength(value, "utf8") > max) {
    throw protocolError(`${label} ${key} exceeds ${String(max)} bytes`);
  }
  return value;
}

function requireInteger(body: Json, key: string, label: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw protocolError(`${label} ${key} must be a non-negative integer`);
  }
  return value;
}

function requireRequestId(body: Json, label: string): string {
  const value = requireString(body, "requestId", label);
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw protocolError(`${label} requestId is not a frozen request UUID`);
  }
  return value;
}

/** Accepts only the frozen digest record; a claimed digest is never trusted. */
function requireManifestDigest(value: unknown, label: string): ManifestDigest {
  if (
    !isJsonObject(value) ||
    value.apiVersion !== MANIFEST_DIGEST_API_VERSION ||
    value.algorithm !== "sha256" ||
    value.encoding !== "hex" ||
    value.canonicalization !== RUNTIME_MANIFEST_CANONICALIZATION ||
    typeof value.value !== "string" ||
    !SHA256_HEX_PATTERN.test(value.value)
  ) {
    throw protocolError(`${label} is not the frozen manifest digest record`);
  }
  return value as unknown as ManifestDigest;
}

function requireExpectedPayload(body: Json): {
  manifestFrames: number;
  manifestBytes: number;
  secretFrames: number;
  secretBytes: number;
} {
  const value = body.expectedPayload;
  if (!isJsonObject(value)) throw protocolError("request expectedPayload must be an object");
  const expected = {
    manifestFrames: requireInteger(value, "manifestFrames", "expectedPayload"),
    manifestBytes: requireInteger(value, "manifestBytes", "expectedPayload"),
    secretFrames: requireInteger(value, "secretFrames", "expectedPayload"),
    secretBytes: requireInteger(value, "secretBytes", "expectedPayload"),
  };
  if (Object.keys(value).length !== 4) {
    throw protocolError("request expectedPayload carries a key outside the frozen contract");
  }
  if (expected.manifestFrames > 1) throw protocolError("a request declares at most one manifest frame");
  if (expected.secretFrames > GATEWAY_PROTOCOL_LIMITS.maxSecretFrames) {
    throw protocolError("the request declares more secret frames than the frozen bound allows", {
      limit: GATEWAY_PROTOCOL_LIMITS.maxSecretFrames,
    });
  }
  return expected;
}

function requireFlags(body: Json): { dryRun: boolean } {
  const value = body.flags;
  if (!isJsonObject(value) || typeof value.dryRun !== "boolean" || Object.keys(value).length !== 1) {
    throw protocolError("request flags must declare exactly the boolean dryRun");
  }
  return { dryRun: value.dryRun };
}

function requireOperation(body: Json): GatewayOperation {
  const operation = body.operation;
  if (typeof operation !== "string" || !(GATEWAY_OPERATIONS as readonly string[]).includes(operation)) {
    throw protocolError("the request names an operation this gateway does not expose", {
      exposed: [...GATEWAY_OPERATIONS],
    });
  }
  return operation as GatewayOperation;
}

function requireCommitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_COMMIT_SHA_PATTERN.test(value)) {
    throw protocolError(`${label} is not a lower-case 40-character Git commit SHA`);
  }
  return value;
}

/** The bounded, already-decoded contents of one accepted request stream. */
export interface GatewayRequestStream {
  readonly request: GatewayRequestFrame;
  readonly operation: GatewayOperation;
  readonly requestId: string;
  readonly dryRun: boolean;
  /** Present for `apply` and `retry` only. */
  readonly manifest: CompiledRuntimeManifest | null;
  readonly manifestBytes: Buffer | null;
  readonly manifestDigest: ManifestDigest | null;
  /** Secret values live only here and in the runtime's own store. */
  readonly secrets: ReadonlyMap<string, string>;
  readonly end: GatewayEndFrame;
}

function decodePayload(body: Json, kind: "manifest" | "secret", label: string): Buffer {
  if (body.encoding !== "base64") throw protocolError(`${label} encoding must be base64`);
  if (!isCanonicalBase64(body.payload)) {
    throw protocolError(`${label} payload is not canonical base64`);
  }
  const decoded = Buffer.from(body.payload, "base64");
  const declared = requireInteger(body, "byteLength", label);
  if (decoded.byteLength !== declared) {
    throw protocolError(`${label} byteLength differs from the decoded payload`, {
      declared,
      decoded: decoded.byteLength,
    });
  }
  const limit = kind === "manifest"
    ? GATEWAY_PROTOCOL_LIMITS.maxManifestBytes
    : GATEWAY_PROTOCOL_LIMITS.maxSecretValueBytes;
  if (decoded.byteLength > limit) {
    throw protocolError(`${label} exceeds its frozen payload bound`, { limit });
  }
  return decoded;
}

/**
 * Parses one complete gateway request stream.
 *
 * Callers must treat `text` as hostile: it arrives on the forced command's
 * stdin. Every returned value has been re-derived from the bytes, and the
 * manifest digest has been recomputed rather than believed.
 */
export function parseGatewayRequestStream(text: string): GatewayRequestStream {
  const frames = decodeFrames(text);
  const kinds = frames.map((frame) => frame.kind);
  if (kinds.includes("progress") || kinds.includes("result")) {
    throw protocolError("an output frame appeared in the request stream");
  }
  if (kinds[0] !== "request") throw protocolError("the request stream does not begin with a request frame");
  if (kinds.filter((kind) => kind === "request").length !== 1) {
    throw protocolError("the request stream carries more than one request frame");
  }
  const endIndex = kinds.indexOf("end");
  if (endIndex === -1) throw protocolError("the request stream has no end frame");
  if (endIndex !== kinds.length - 1) throw protocolError("a frame follows the end frame");
  if (kinds.filter((kind) => kind === "end").length !== 1) {
    throw protocolError("the request stream carries more than one end frame");
  }

  const requestFrame = frames[0]!.body;
  const endFrame = frames[endIndex]!.body;
  const manifestFrames = frames.filter((frame) => frame.kind === "manifest");
  const secretFrames = frames.filter((frame) => frame.kind === "secret");

  const requestId = requireRequestId(requestFrame, "request frame");
  for (const frame of frames) {
    if (frame.body.requestId !== requestId) {
      throw protocolError(`line ${String(frame.index)} carries a different request UUID`, {
        line: frame.index,
      });
    }
  }

  const operation = requireOperation(requestFrame);
  const flags = requireFlags(requestFrame);
  const expected = requireExpectedPayload(requestFrame);
  const mutating = MUTATING_OPERATIONS.has(operation);

  requireBoundedString(requestFrame, "repository", "request frame", 512);
  requireBoundedString(requestFrame, "githubEnvironment", "request frame", 255);
  requireBoundedString(requestFrame, "targetName", "request frame", 64);
  requireBoundedString(requestFrame, "targetId", "request frame", 64);

  if (!mutating) {
    if (expected.manifestFrames !== 0 || expected.secretFrames !== 0 ||
        expected.manifestBytes !== 0 || expected.secretBytes !== 0 ||
        manifestFrames.length > 0 || secretFrames.length > 0) {
      throw protocolError(`a non-mutating ${operation} request declares or carries payload frames`);
    }
    if (flags.dryRun) throw protocolError(`a ${operation} request cannot request a dry run`);
    if (requestFrame.applicationRef !== null) {
      throw protocolError(`a non-mutating ${operation} request must not name an application ref`);
    }
    if (operation === "handshake" && (requestFrame.commitSha !== null || requestFrame.manifestDigest !== null)) {
      throw protocolError("a handshake request must not claim a deployment identity");
    }
    if (operation === "inspect") {
      if (requestFrame.commitSha !== null) requireCommitSha(requestFrame.commitSha, "request commitSha");
      if (requestFrame.manifestDigest !== null) requireManifestDigest(requestFrame.manifestDigest, "request manifestDigest");
    }
  } else {
    if (expected.manifestFrames !== 1) {
      throw protocolError(`a ${operation} request must declare exactly one manifest frame`);
    }
    requireBoundedString(requestFrame, "applicationRef", "request frame", 512);
    requireCommitSha(requestFrame.commitSha, "request commitSha");
    requireManifestDigest(requestFrame.manifestDigest, "request manifestDigest");
  }

  if (manifestFrames.length !== expected.manifestFrames || secretFrames.length !== expected.secretFrames) {
    throw protocolError("the received frame counts differ from the declared expectedPayload", {
      declaredManifestFrames: expected.manifestFrames,
      receivedManifestFrames: manifestFrames.length,
      declaredSecretFrames: expected.secretFrames,
      receivedSecretFrames: secretFrames.length,
    });
  }
  if (secretFrames.length > GATEWAY_PROTOCOL_LIMITS.maxSecretFrames) {
    throw protocolError("the request stream exceeds the frozen secret frame bound", {
      limit: GATEWAY_PROTOCOL_LIMITS.maxSecretFrames,
    });
  }

  let manifestBytes: Buffer | null = null;
  let manifestDigest: ManifestDigest | null = null;
  let manifest: CompiledRuntimeManifest | null = null;
  const manifestFrame = manifestFrames[0];
  if (manifestFrame !== undefined) {
    if (manifestFrame.body.mediaType !== "application/yaml") {
      throw protocolError("manifest frame mediaType must be application/yaml");
    }
    manifestBytes = decodePayload(manifestFrame.body, "manifest", "manifest frame");
    if (manifestBytes.byteLength !== expected.manifestBytes) {
      throw protocolError("the received manifest length differs from the declared expectedPayload", {
        declared: expected.manifestBytes,
        received: manifestBytes.byteLength,
      });
    }
    const claimed = requireManifestDigest(manifestFrame.body.digest, "manifest frame digest");
    const recomputed = createHash("sha256").update(manifestBytes).digest("hex");
    if (recomputed !== claimed.value) {
      throw protocolError("the claimed manifest digest does not match the received canonical bytes");
    }
    const requestDigest = requireManifestDigest(requestFrame.manifestDigest, "request manifestDigest");
    if (requestDigest.value !== claimed.value) {
      throw protocolError("the request and manifest frames claim different manifest digests");
    }
    manifestDigest = claimed;
    manifest = parseCanonicalRuntimeManifest(manifestBytes);
  }

  const declaredSecretNames = manifest === null
    ? new Set<string>()
    : new Set([...manifest.secrets.required, ...manifest.secrets.generated]);
  const secrets = new Map<string, string>();
  let secretBytes = 0;
  for (const frame of secretFrames) {
    const label = `line ${String(frame.index)}`;
    const name = requireString(frame.body, "name", label);
    if (Buffer.byteLength(name, "utf8") > GATEWAY_PROTOCOL_LIMITS.maxSecretNameBytes) {
      throw protocolError(`${label} secret name exceeds the frozen name bound`, {
        limit: GATEWAY_PROTOCOL_LIMITS.maxSecretNameBytes,
      });
    }
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw protocolError(`${label} secret name is not an environment-variable name`);
    }
    if (secrets.has(name)) {
      throw protocolError(`${label} repeats secret ${name}`, { name });
    }
    if (!declaredSecretNames.has(name)) {
      throw protocolError(`${label} carries secret ${name}, which the runtime manifest does not declare`, {
        name,
      });
    }
    const decoded = decodePayload(frame.body, "secret", `${label} secret ${name}`);
    secretBytes += decoded.byteLength;
    if (secretBytes > GATEWAY_PROTOCOL_LIMITS.maxTotalSecretBytes) {
      throw protocolError("the request stream exceeds the frozen total secret bound", {
        limit: GATEWAY_PROTOCOL_LIMITS.maxTotalSecretBytes,
      });
    }
    if (decoded.includes(0)) throw protocolError(`${label} secret ${name} contains a NUL byte`, { name });
    secrets.set(name, decoded.toString("utf8"));
  }
  if (secretBytes !== expected.secretBytes) {
    throw protocolError("the received secret length differs from the declared expectedPayload", {
      declared: expected.secretBytes,
      received: secretBytes,
    });
  }

  const payloadBytes = (manifestBytes?.byteLength ?? 0) + secretBytes;
  const declaredManifestFrames = requireInteger(endFrame, "manifestFrames", "end frame");
  const declaredSecretFrames = requireInteger(endFrame, "secretFrames", "end frame");
  const declaredPayloadBytes = requireInteger(endFrame, "payloadBytes", "end frame");
  if (declaredManifestFrames !== manifestFrames.length ||
      declaredSecretFrames !== secretFrames.length ||
      declaredPayloadBytes !== payloadBytes) {
    throw protocolError("the end frame does not describe the frames that arrived", {
      manifestFrames: manifestFrames.length,
      secretFrames: secretFrames.length,
      payloadBytes,
    });
  }

  return {
    request: requestFrame as unknown as GatewayRequestFrame,
    operation,
    requestId,
    dryRun: flags.dryRun,
    manifest,
    manifestBytes,
    manifestDigest,
    secrets,
    end: endFrame as unknown as GatewayEndFrame,
  };
}

/**
 * Parses the gateway's own output. The orchestrator reads a stream it did not
 * produce over an SSH channel, so the same discipline applies in reverse:
 * strictly increasing sequence numbers, exactly one terminating result frame,
 * and only frozen codes and recovery actions.
 */
export function parseGatewayOutputStream(text: string): readonly GatewayOutputFrame[] {
  const frames = decodeFrames(text);
  let previous = 0;
  let progressEvents = 0;
  for (const frame of frames) {
    if (frame.kind !== "progress" && frame.kind !== "result") {
      throw protocolError(`line ${String(frame.index)} is not a gateway output frame`, { line: frame.index });
    }
    if (frame.kind === "progress") {
      progressEvents += 1;
      if (progressEvents > GATEWAY_PROTOCOL_LIMITS.maxProgressEvents) {
        throw protocolError("the output stream exceeds the frozen progress event bound", {
          limit: GATEWAY_PROTOCOL_LIMITS.maxProgressEvents,
        });
      }
    }
    const sequence = frame.body.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= previous) {
      throw protocolError(`line ${String(frame.index)} sequence is not strictly increasing`, {
        line: frame.index,
      });
    }
    previous = sequence;
  }

  const results = frames.filter((frame) => frame.kind === "result");
  if (results.length !== 1) {
    throw protocolError("the output stream must carry exactly one result frame", { received: results.length });
  }
  if (frames.at(-1)?.kind !== "result") {
    throw protocolError("the result frame is not the last frame of the output stream");
  }
  const result = results[0]!.body;
  if (result.ok === true) {
    if (result.code !== "DK_GATEWAY_OK" || result.recovery !== "none") {
      throw protocolError("a success result must report DK_GATEWAY_OK with recovery none");
    }
  } else if (result.ok === false) {
    const recovery = result.recovery;
    if (typeof recovery !== "string" || recovery === "none" || !Object.hasOwn(RECOVERY_INSTRUCTIONS, recovery)) {
      throw protocolError("a failure result must name an actionable frozen recovery action");
    }
    if (typeof result.code !== "string" || failureContract(result.code as ErrorCode) === undefined) {
      throw protocolError("a failure result must name a code from the frozen catalog");
    }
  } else {
    throw protocolError("the result frame ok flag is not a boolean");
  }

  return frames.map((frame) => frame.body as unknown as GatewayOutputFrame);
}
