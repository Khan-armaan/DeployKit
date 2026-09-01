import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { exitCodeFor, type ErrorCode } from "../src/errors.js";
import {
  CONTRACT_KEY_ORDER,
  DEPLOYMENT_IDENTITY_API_VERSION,
  GATEWAY_BINDING_API_VERSION,
  GATEWAY_FORCED_COMMAND,
  GATEWAY_PROTOCOL_LIMITS,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_USER,
  GITHUB_OWNERSHIP_API_VERSION,
  GIT_COMMIT_SHA_PATTERN,
  MANAGED_OWNERSHIP_PATH,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_WORKFLOW_PATH,
  MANIFEST_DIGEST_API_VERSION,
  OPERATION_RECORD_API_VERSION,
  OPERATOR_CONFIG_API_VERSION,
  REQUEST_ID_PATTERN,
  RUNTIME_MANIFEST_API_VERSION,
  RUNTIME_MANIFEST_CANONICALIZATION,
  SHA256_HEX_PATTERN,
} from "../src/orchestrator/contracts.js";
import {
  FAILURE_CONTRACTS,
  ORCHESTRATOR_BOUNDARIES,
  ORCHESTRATOR_FAILURES,
  RECOVERY_INSTRUCTIONS,
  failureContract,
  failuresForBoundary,
} from "../src/orchestrator/failures.js";

type Json = Record<string, unknown>;
type Violation = { readonly kind: string; readonly detail: string };

const FIXTURE_ROOT = resolve("test", "fixtures", "orchestrator");
const LOCAL_OPERATION_STATUSES = ["pending", "waiting", "running", "failed", "completed"];
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const SECRET_LIKE_PATTERN = /(^|_)(SECRET|PASSWORD|TOKEN|CREDENTIALS|PRIVATE_KEY)(_|$)/u;
const OPERATOR_CONFIG_KEYS: readonly string[] = CONTRACT_KEY_ORDER.operatorConfig;
const PLACEHOLDER_TOKENS = ["your-org", "your-repo", "vps.example.com", "/home/you/", "changeme"];

interface ExpectationCase {
  readonly fixture: string;
  readonly code: ErrorCode;
  readonly recovery: string;
  readonly boundary: string;
  readonly violation: string;
}

interface Expectations {
  readonly apiVersion: string;
  readonly canaries: readonly string[];
  readonly canaryBearingFixtures: readonly string[];
  readonly cases: readonly ExpectationCase[];
}

let expectations: Expectations;
let fixtureFiles: string[];

function asJson(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Json;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else found.push(relative(FIXTURE_ROOT, full).split(sep).join(posix.sep));
  }
  return found.sort();
}

beforeAll(async () => {
  expectations = JSON.parse(await readFile(join(FIXTURE_ROOT, "expectations.json"), "utf8")) as Expectations;
  fixtureFiles = (await walk(FIXTURE_ROOT)).filter((file) => file !== "expectations.json");
});

// --------------------------------------------------------------- canonical --

const NESTED_KEY_ORDER: Readonly<Record<string, readonly string[]>> = {
  manifestDigest: CONTRACT_KEY_ORDER.manifestDigest,
  digest: CONTRACT_KEY_ORDER.manifestDigest,
  runtimeManifestDigest: CONTRACT_KEY_ORDER.manifestDigest,
};

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Frozen contract order first, then remaining keys by code point. */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, key));
  if (value !== null && typeof value === "object") {
    const source = value as Json;
    const frozen = key === undefined ? [] : NESTED_KEY_ORDER[key] ?? [];
    const head = frozen.filter((name) => Object.hasOwn(source, name));
    const tail = Object.keys(source).filter((name) => !frozen.includes(name)).sort(compare);
    return Object.fromEntries([...head, ...tail].map((name) => [name, canonical(source[name], name)]));
  }
  return value;
}

function canonicalFrame(frame: Json, order: readonly string[]): string {
  const head = order.filter((key) => Object.hasOwn(frame, key));
  const tail = Object.keys(frame).filter((key) => !order.includes(key)).sort(compare);
  return JSON.stringify(Object.fromEntries([...head, ...tail].map((key) => [key, canonical(frame[key], key)])));
}

function frameOrder(frame: unknown): readonly string[] | undefined {
  switch (frame) {
    case "request": return CONTRACT_KEY_ORDER.gatewayRequestFrame;
    case "manifest": return CONTRACT_KEY_ORDER.gatewayManifestFrame;
    case "secret": return CONTRACT_KEY_ORDER.gatewaySecretFrame;
    case "end": return CONTRACT_KEY_ORDER.gatewayEndFrame;
    case "progress": return CONTRACT_KEY_ORDER.gatewayProgressEvent;
    case "result": return CONTRACT_KEY_ORDER.gatewayResult;
    default: return undefined;
  }
}

function isCanonicalBase64(payload: unknown): payload is string {
  return typeof payload === "string" &&
    Buffer.from(payload, "base64").toString("base64") === payload;
}

// -------------------------------------------------------- protocol checker --

/**
 * Validates a stream against the frozen contract only. It is deliberately not
 * a production parser: Phase 1 ships no gateway behavior, and this exists so a
 * hostile fixture cannot silently be a valid one.
 */
function checkStream(text: string, binding: Json, declaredSecretNames: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  const push = (kind: string, detail: string): void => { violations.push({ kind, detail }); };

  if (!text.endsWith("\n")) push("framing", "stream does not end with LF");
  const lines = text.slice(0, -1).split("\n");
  if (Buffer.byteLength(text) > GATEWAY_PROTOCOL_LIMITS.maxInputBytes) push("input-size", "stream exceeds maxInputBytes");

  const frames: { readonly body: Json; readonly line: string }[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      push("json", `line ${index + 1} is not parsable JSON`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      push("json", `line ${index + 1} is not a JSON object`);
      continue;
    }
    const body = parsed as Json;
    const order = frameOrder(body.frame);
    if (order === undefined) {
      push("frame", `line ${index + 1} declares an unknown frame kind`);
      continue;
    }
    const actual = Object.keys(body).sort(compare).join(",");
    if (actual !== [...order].sort(compare).join(",")) {
      push("keys", `line ${index + 1} key set differs from the frozen ${String(body.frame)} contract`);
    } else if (canonicalFrame(body, order) !== line) {
      push("canonical-order", `line ${index + 1} is not in canonical contract order`);
    }
    if (body.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
      push("version", `line ${index + 1} declares protocol version ${String(body.protocolVersion)}`);
    }
    const size = Buffer.byteLength(line);
    if (size > GATEWAY_PROTOCOL_LIMITS.maxFrameBytes) push("frame-size", `line ${index + 1} exceeds maxFrameBytes`);
    if (body.frame === "request" && size > GATEWAY_PROTOCOL_LIMITS.maxRequestFrameBytes) {
      push("frame-size", `line ${index + 1} exceeds maxRequestFrameBytes`);
    }
    if (body.frame === "progress" && size > GATEWAY_PROTOCOL_LIMITS.maxProgressEventBytes) {
      push("frame-size", `line ${index + 1} exceeds maxProgressEventBytes`);
    }
    if (body.frame === "result" && size > GATEWAY_PROTOCOL_LIMITS.maxResultBytes) {
      push("frame-size", `line ${index + 1} exceeds maxResultBytes`);
    }
    frames.push({ body, line });
  }

  const kinds = frames.map((entry) => entry.body.frame);
  const isOutput = kinds[0] === "progress" || kinds[0] === "result";
  const requestIds = new Set(frames.map((entry) => entry.body.requestId).filter((id) => id !== null));
  if (requestIds.size > 1) push("request-id", "frames do not share one request UUID");
  for (const id of requestIds) {
    if (typeof id !== "string" || !REQUEST_ID_PATTERN.test(id)) push("request-id", `${String(id)} is not a frozen request UUID`);
  }

  if (isOutput) {
    let previous = 0;
    for (const { body } of frames) {
      const sequence = body.sequence;
      if (typeof sequence !== "number" || sequence <= previous) {
        push("sequence", `sequence ${String(sequence)} is not strictly increasing`);
      } else {
        previous = sequence;
      }
    }
    const resultCount = kinds.filter((kind) => kind === "result").length;
    if (resultCount !== 1) push("framing", `output stream carries ${resultCount} result frames`);
    else if (kinds.at(-1) !== "result") push("framing", "result frame is not last");
    for (const { body } of frames) {
      if (body.frame !== "result") continue;
      if (body.ok === true) {
        if (body.code !== "DK_GATEWAY_OK" || body.recovery !== "none") push("result", "success result must be DK_GATEWAY_OK with recovery none");
      } else if (body.ok === false) {
        if (!Object.hasOwn(RECOVERY_INSTRUCTIONS, String(body.recovery)) || body.recovery === "none") {
          push("result", `failure recovery ${String(body.recovery)} is not an actionable frozen recovery action`);
        }
        if (failureContract(body.code as ErrorCode) === undefined) {
          push("result", `failure code ${String(body.code)} is not in the frozen catalog`);
        }
      } else {
        push("result", "result frame ok flag is not boolean");
      }
    }
    return violations;
  }

  // Input stream: request, optional manifest, secrets, end -- and nothing after.
  if (kinds[0] !== "request") push("framing", "input stream does not begin with a request frame");
  const endIndex = kinds.indexOf("end");
  if (endIndex === -1) push("framing", "input stream has no end frame");
  else if (endIndex !== kinds.length - 1) push("framing", "frames follow the end frame");

  const request = frames.find((entry) => entry.body.frame === "request")?.body;
  const end = frames.find((entry) => entry.body.frame === "end")?.body;
  const manifests = frames.filter((entry) => entry.body.frame === "manifest");
  const secrets = frames.filter((entry) => entry.body.frame === "secret");

  if (request !== undefined) {
    const operation = request.operation;
    if (!["handshake", "apply", "retry", "inspect"].includes(String(operation))) {
      push("operation", `${String(operation)} is not an exposed gateway operation`);
    }
    if (request.commitSha !== null && !GIT_COMMIT_SHA_PATTERN.test(String(request.commitSha))) {
      push("commit-sha", `${String(request.commitSha)} is not a lower-case 40-character Git SHA`);
    }
    for (const field of ["repository", "githubEnvironment", "targetName", "targetId"] as const) {
      if (request[field] !== binding[field]) {
        push("binding", `request ${field} does not confirm the root-owned binding`);
      }
    }
    const expected = asJson(request.expectedPayload ?? {}, "expectedPayload");
    if ((operation === "handshake" || operation === "inspect") &&
        (expected.manifestFrames !== 0 || expected.secretFrames !== 0 || manifests.length > 0 || secrets.length > 0)) {
      push("framing", "a non-mutating operation declares or sends payload frames");
    }
    if (expected.manifestFrames !== manifests.length) push("declared-count", "manifest frame count differs from expectedPayload");
    if (expected.secretFrames !== secrets.length) push("declared-count", "secret frame count differs from expectedPayload");
  }

  if (secrets.length > GATEWAY_PROTOCOL_LIMITS.maxSecretFrames) push("declared-count", "stream exceeds maxSecretFrames");

  const seenSecretNames = new Set<string>();
  let payloadBytes = 0;
  let secretBytes = 0;
  for (const { body } of [...manifests, ...secrets]) {
    const declared = body.byteLength;
    if (!isCanonicalBase64(body.payload)) {
      push("base64", `${String(body.frame)} payload is not canonical base64`);
      continue;
    }
    const decoded = Buffer.from(body.payload, "base64");
    if (decoded.byteLength !== declared) {
      push("byte-length", `${String(body.frame)} byteLength ${String(declared)} differs from the decoded ${decoded.byteLength}`);
    }
    payloadBytes += decoded.byteLength;
    if (body.frame === "manifest") {
      if (decoded.byteLength > GATEWAY_PROTOCOL_LIMITS.maxManifestBytes) push("payload-size", "manifest exceeds maxManifestBytes");
      const digest = asJson(body.digest ?? {}, "digest");
      if (digest.apiVersion !== MANIFEST_DIGEST_API_VERSION || digest.algorithm !== "sha256" ||
          digest.encoding !== "hex" || digest.canonicalization !== RUNTIME_MANIFEST_CANONICALIZATION) {
        push("digest", "manifest digest record is not the frozen shape");
      }
      if (createHash("sha256").update(decoded).digest("hex") !== digest.value) {
        push("digest", "claimed manifest digest does not match the received canonical bytes");
      }
      if (request !== undefined && JSON.stringify(canonical(request.manifestDigest, "manifestDigest")) !== JSON.stringify(canonical(body.digest, "digest"))) {
        push("digest", "request and manifest frames claim different digests");
      }
    } else {
      const name = String(body.name);
      secretBytes += decoded.byteLength;
      if (Buffer.byteLength(name) > GATEWAY_PROTOCOL_LIMITS.maxSecretNameBytes) push("secret-name", `${name.slice(0, 16)}... exceeds maxSecretNameBytes`);
      if (!SECRET_NAME_PATTERN.test(name)) push("secret-name", `${name.slice(0, 32)} is not a valid environment name`);
      if (seenSecretNames.has(name)) push("duplicate-secret", `${name} is sent more than once`);
      seenSecretNames.add(name);
      if (!declaredSecretNames.includes(name)) push("undeclared-secret", `${name.slice(0, 32)} is not declared by the runtime manifest`);
      if (decoded.byteLength > GATEWAY_PROTOCOL_LIMITS.maxSecretValueBytes) push("payload-size", `${name} exceeds maxSecretValueBytes`);
    }
  }
  if (secretBytes > GATEWAY_PROTOCOL_LIMITS.maxTotalSecretBytes) push("payload-size", "stream exceeds maxTotalSecretBytes");

  if (end !== undefined) {
    if (end.manifestFrames !== manifests.length) push("declared-count", "end frame manifest count differs from the stream");
    if (end.secretFrames !== secrets.length) push("declared-count", "end frame secret count differs from the stream");
    if (end.payloadBytes !== payloadBytes) push("declared-count", "end frame payloadBytes differs from the decoded stream");
  }

  return violations;
}

// -------------------------------------------------------- document checkers --

function checkOwnership(marker: Json, reference: Json): Violation[] {
  const violations: Violation[] = [];
  const push = (kind: string, detail: string): void => { violations.push({ kind, detail }); };
  if (marker.apiVersion !== GITHUB_OWNERSHIP_API_VERSION) push("owner", "marker apiVersion is not the frozen ownership contract");
  if (marker.owner !== "deploykit") push("owner", `marker is owned by ${String(marker.owner)}`);
  if (marker.targetId !== reference.targetId) push("target-id", "marker binds the managed files to another target ID");
  const managed = asJson(marker.managed ?? {}, "managed");
  const files = Array.isArray(managed.files) ? managed.files : [];
  const expectedFiles = [MANAGED_WORKFLOW_PATH, MANAGED_RUNTIME_MANIFEST_PATH, MANAGED_OWNERSHIP_PATH];
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) push("managed-files", "marker claims files outside the three managed paths");
  for (const field of ["frontendVariables", "backendSecrets", "generatedSecrets"] as const) {
    for (const name of (Array.isArray(managed[field]) ? managed[field] : []) as unknown[]) {
      if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
        push("secret-value", `${field} holds ${String(name).slice(0, 24)} instead of a bare name`);
      }
    }
  }
  const referenceManifestDigest = asJson(reference.runtimeManifestDigest ?? {}, "runtimeManifestDigest");
  const markerManifestDigest = asJson(marker.runtimeManifestDigest ?? {}, "runtimeManifestDigest");
  if (marker.workflowDigest !== reference.workflowDigest) push("digest-drift", "workflow digest differs from the default-branch bytes");
  if (markerManifestDigest.value !== referenceManifestDigest.value) push("digest-drift", "runtime-manifest digest differs from the compiled manifest");
  if (!SHA256_HEX_PATTERN.test(String(marker.workflowDigest))) push("digest-drift", "workflow digest is not a SHA-256 hex string");
  return violations;
}

function checkState(document: Json, identity: Json, canaries: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  const push = (kind: string, detail: string): void => { violations.push({ kind, detail }); };
  const raw = JSON.stringify(document);

  if (document.apiVersion === OPERATION_RECORD_API_VERSION) {
    const order: readonly string[] = CONTRACT_KEY_ORDER.operationRecord;
    for (const key of Object.keys(document)) {
      if (!order.includes(key)) push("operation-shape", `${key} is outside the frozen operation record`);
    }
    for (const key of order) {
      if (!Object.hasOwn(document, key)) push("operation-shape", `${key} is missing from the operation record`);
    }
    if (!LOCAL_OPERATION_STATUSES.includes(String(document.status))) {
      push("operation-status", `${String(document.status)} is outside the frozen status union`);
    }
    for (const canary of canaries) {
      if (raw.includes(canary)) push("secret-value", "the secret-free operation record carries a secret value");
    }
    return violations;
  }

  if (document.apiVersion !== DEPLOYMENT_IDENTITY_API_VERSION || document.manifestDigest === undefined) {
    push("legacy", "state predates manifest-digest identity binding");
    return violations;
  }
  if (document.phase === "complete" || document.status === "completed") {
    push("completed", "the target already completed its first deployment");
  }
  if (document.commitSha !== identity.commitSha) push("commit-sha", "identity names a different commit SHA");
  const digest = asJson(document.manifestDigest, "manifestDigest");
  const reference = asJson(identity.manifestDigest, "manifestDigest");
  if (digest.value !== reference.value) push("manifest-digest", "identity names a different manifest digest");
  return violations;
}

function checkConfig(config: Json): Violation[] {
  const violations: Violation[] = [];
  const push = (kind: string, detail: string): void => { violations.push({ kind, detail }); };

  for (const key of Object.keys(config)) {
    if (!OPERATOR_CONFIG_KEYS.includes(key)) push("unknown-key", `${key} is not a frozen operator config key`);
  }
  if (PLACEHOLDER_TOKENS.some((token) => JSON.stringify(config).includes(token))) {
    push("placeholder", "bundled example placeholders were never replaced");
  }

  const project = asJson(config.project ?? {}, "project");
  const ref = String(project.ref);
  if (ref.includes("..") || !/^[\w.\-/]+$/u.test(ref) || ref.endsWith("/")) push("invalid-ref", `${ref} is not a safe Git ref`);

  const server = asJson(config.server ?? {}, "server");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(String(server.hostKeyFingerprint))) {
    push("invalid-host-key-fingerprint", "hostKeyFingerprint is not a SHA256 fingerprint");
  }

  const services = asJson(config.services ?? {}, "services");
  const directories = [
    ...Object.values(services).map((service) => asJson(service, "service").workingDirectory),
    asJson(config.frontend ?? {}, "frontend").workingDirectory,
  ];
  for (const directory of directories) {
    if (typeof directory !== "string") continue;
    if (directory.startsWith("/") || directory.split("/").includes("..")) {
      push("escaping-working-directory", `${directory} escapes the application repository root`);
    }
  }

  const routes = Array.isArray(config.routes) ? config.routes : [];
  const seenRoutes = new Set<string>();
  for (const entry of routes) {
    const route = asJson(entry, "route");
    const key = `${String(route.hostname)}|${String(route.match)}|${String(route.path)}`;
    if (seenRoutes.has(key)) push("ambiguous-route", `${key} is declared twice`);
    seenRoutes.add(key);
    if (!Object.hasOwn(services, String(route.target))) push("unresolved-route-target", `${String(route.target)} is not a declared service`);
  }

  const environment = asJson(config.environment ?? {}, "environment");
  const frontend = asJson(environment.frontend ?? {}, "environment.frontend");
  const backend = asJson(environment.backend ?? {}, "environment.backend");
  const generated = (Array.isArray(environment.generated) ? environment.generated : []).map(String);
  for (const [partition, values] of [["frontend", frontend], ["backend", backend]] as const) {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== "string") push("non-string-environment-value", `environment.${partition}.${name} is not a string`);
    }
  }
  const names = [...Object.keys(frontend), ...Object.keys(backend), ...generated];
  const seenNames = new Set<string>();
  for (const name of names) {
    if (name.startsWith("DEPLOYKIT_")) push("reserved-name", `${name} uses the reserved DEPLOYKIT_ prefix`);
    if (seenNames.has(name)) push("duplicate-name", `${name} is declared in more than one partition`);
    seenNames.add(name);
  }
  for (const name of Object.keys(frontend)) {
    if (SECRET_LIKE_PATTERN.test(name)) push("secret-like-frontend-name", `${name} would be embedded in public assets`);
  }
  return violations;
}

// ------------------------------------------------------------------- tests --

describe("frozen orchestrator contract surface", () => {
  const surface = {
    apiVersions: {
      operatorConfig: OPERATOR_CONFIG_API_VERSION,
      runtimeManifest: RUNTIME_MANIFEST_API_VERSION,
      manifestDigest: MANIFEST_DIGEST_API_VERSION,
      gatewayProtocol: GATEWAY_PROTOCOL_VERSION,
      gatewayBinding: GATEWAY_BINDING_API_VERSION,
      deploymentIdentity: DEPLOYMENT_IDENTITY_API_VERSION,
      githubOwnership: GITHUB_OWNERSHIP_API_VERSION,
      operationRecord: OPERATION_RECORD_API_VERSION,
      canonicalization: RUNTIME_MANIFEST_CANONICALIZATION,
    },
    keyOrder: CONTRACT_KEY_ORDER,
    limits: GATEWAY_PROTOCOL_LIMITS,
    patterns: {
      commitSha: GIT_COMMIT_SHA_PATTERN.source,
      sha256: SHA256_HEX_PATTERN.source,
      requestId: REQUEST_ID_PATTERN.source,
    },
    gateway: { user: GATEWAY_USER, forcedCommand: GATEWAY_FORCED_COMMAND },
    managedFiles: [MANAGED_WORKFLOW_PATH, MANAGED_RUNTIME_MANIFEST_PATH, MANAGED_OWNERSHIP_PATH],
    recoveries: RECOVERY_INSTRUCTIONS,
    failures: FAILURE_CONTRACTS,
  };

  it("serializes to identical bytes on every evaluation", () => {
    const first = JSON.stringify(canonical(surface));
    expect(JSON.stringify(canonical(surface))).toBe(first);
    expect(JSON.stringify(canonical(JSON.parse(first)))).toBe(first);
  });

  it("matches the pinned Phase 1 contract digest", () => {
    const digest = createHash("sha256").update(JSON.stringify(canonical(surface))).digest("hex");
    expect(digest).toBe("ba1b6d0ed703eb4abeed2fc76300b85e3f4771f66d23479698364887bb348584");
  });
});

describe("DK_* failure and recovery catalog", () => {
  it("covers every orchestration boundary exactly once per code", () => {
    const codes = FAILURE_CONTRACTS.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const boundary of ORCHESTRATOR_BOUNDARIES) {
      expect(failuresForBoundary(boundary).length, `boundary ${boundary} has no frozen failure`).toBeGreaterThan(0);
    }
    for (const entry of FAILURE_CONTRACTS) {
      expect(ORCHESTRATOR_BOUNDARIES).toContain(entry.boundary);
    }
  });

  it("gives every failure an actionable resume instruction and a stable exit code", () => {
    for (const entry of FAILURE_CONTRACTS) {
      expect(Object.hasOwn(RECOVERY_INSTRUCTIONS, entry.recovery)).toBe(true);
      expect(RECOVERY_INSTRUCTIONS[entry.recovery].length).toBeGreaterThan(20);
      expect(entry.summary.endsWith(".")).toBe(true);
      expect(exitCodeFor(entry.code)).toBeGreaterThan(0);
      expect(exitCodeFor(entry.code)).toBe(exitCodeFor(entry.code));
      expect(failureContract(entry.code)).toBe(entry);
    }
    expect(Object.values(ORCHESTRATOR_FAILURES).every((entry) => entry.recovery !== "none")).toBe(true);
  });

  it("never promises resumption for a failure that cannot be resumed", () => {
    for (const entry of FAILURE_CONTRACTS) {
      if (entry.recovery !== "not-resumable") continue;
      expect(entry.mutationBoundary, `${entry.code} claims a runtime mutation but is not resumable`).not.toBe("runtime");
    }
  });
});

describe("failure expectations", () => {
  it("pairs every invalid fixture with exactly one frozen expectation", () => {
    const invalid = fixtureFiles.filter((file) => file.includes("/invalid/"));
    const listed = expectations.cases.map((entry) => entry.fixture);
    expect([...listed].sort(compare)).toEqual(invalid);
    expect(new Set(listed).size).toBe(listed.length);
    expect(fixtureFiles.filter((file) => file.includes("/valid/")).some((file) => listed.includes(file))).toBe(false);
  });

  it("names only codes, recoveries, and boundaries that the catalog freezes", () => {
    for (const entry of expectations.cases) {
      const contract = failureContract(entry.code);
      expect(contract, `${entry.fixture} names unknown code ${entry.code}`).toBeDefined();
      expect(contract?.recovery).toBe(entry.recovery);
      expect(contract?.boundary).toBe(entry.boundary);
      expect(entry.violation.length).toBeGreaterThan(20);
    }
  });
});

describe("gateway protocol fixtures", () => {
  const expectedKindsFor = (code: ErrorCode): { readonly required?: string; readonly forbidden: readonly string[] } => {
    if (code === "DK_GATEWAY_VERSION_MISMATCH") return { required: "version", forbidden: [] };
    if (code === "DK_GATEWAY_BINDING_MISMATCH") return { required: "binding", forbidden: [] };
    return { forbidden: ["version", "binding"] };
  };

  let binding: Json;
  let declaredSecretNames: string[];

  beforeAll(async () => {
    binding = JSON.parse(await readFile(join(FIXTURE_ROOT, "binding", "valid", "binding.json"), "utf8")) as Json;
    const apply = await readFile(join(FIXTURE_ROOT, "protocol", "valid", "apply.jsonl"), "utf8");
    const manifestFrame = apply.split("\n").map((line) => JSON.parse(line || "null") as Json | null)
      .find((frame) => frame?.frame === "manifest");
    const manifest = asJson(parseYaml(Buffer.from(String(manifestFrame?.payload), "base64").toString("utf8")), "manifest");
    declaredSecretNames = (asJson(manifest.secrets, "manifest.secrets").required as string[]).slice();
  });

  it("accepts every valid stream without a single contract violation", async () => {
    const valid = fixtureFiles.filter((file) => file.startsWith("protocol/valid/"));
    expect(valid.length).toBeGreaterThan(5);
    for (const file of valid) {
      const text = await readFile(join(FIXTURE_ROOT, file), "utf8");
      expect(checkStream(text, binding, declaredSecretNames), file).toEqual([]);
    }
  });

  it("proves the declared manifest digest is reproducible from the canonical bytes", async () => {
    const text = await readFile(join(FIXTURE_ROOT, "protocol", "valid", "apply.jsonl"), "utf8");
    const frame = text.split("\n").map((line) => JSON.parse(line || "null") as Json | null)
      .find((entry) => entry?.frame === "manifest");
    const bytes = Buffer.from(String(frame?.payload), "base64");
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
    expect(asJson(frame?.digest, "digest").value).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("rejects every hostile stream with the violation its expectation names", async () => {
    const invalid = expectations.cases.filter((entry) => entry.fixture.startsWith("protocol/invalid/"));
    expect(invalid.length).toBeGreaterThan(15);
    for (const entry of invalid) {
      const text = await readFile(join(FIXTURE_ROOT, entry.fixture), "utf8");
      const kinds = checkStream(text, binding, declaredSecretNames).map((violation) => violation.kind);
      expect(kinds, `${entry.fixture} is accidentally valid`).not.toEqual([]);
      const { required, forbidden } = expectedKindsFor(entry.code);
      if (required !== undefined) expect(kinds, entry.fixture).toContain(required);
      else expect(kinds.some((kind) => !forbidden.includes(kind)), entry.fixture).toBe(true);
    }
  });
});

describe("ownership, state, and config fixtures", () => {
  const OWNERSHIP_KINDS: Readonly<Record<string, readonly string[]>> = {
    DK_OWNERSHIP_CONFLICT: ["owner", "target-id", "managed-files"],
    DK_CONTROL_ARTIFACTS_DRIFTED: ["secret-value", "digest-drift"],
  };
  const STATE_KINDS: Readonly<Record<string, readonly string[]>> = {
    DK_IDENTITY_MISMATCH: ["commit-sha", "manifest-digest"],
    DK_STATE_LEGACY: ["legacy"],
    DK_ALREADY_DEPLOYED: ["completed"],
    DK_OPERATION_STATE_INVALID: ["operation-shape", "operation-status", "secret-value"],
  };

  it("accepts the valid ownership marker, identity, and operation record", async () => {
    const marker = JSON.parse(await readFile(join(FIXTURE_ROOT, "ownership", "valid", "marker.json"), "utf8")) as Json;
    const identity = JSON.parse(await readFile(join(FIXTURE_ROOT, "state", "valid", "identity.json"), "utf8")) as Json;
    const operation = JSON.parse(await readFile(join(FIXTURE_ROOT, "state", "valid", "operation-record.json"), "utf8")) as Json;
    expect(checkOwnership(marker, marker)).toEqual([]);
    expect(checkState(identity, identity, expectations.canaries)).toEqual([]);
    expect(checkState(operation, identity, expectations.canaries)).toEqual([]);
  });

  it("rejects every hostile ownership marker with its expected violation", async () => {
    const reference = JSON.parse(await readFile(join(FIXTURE_ROOT, "ownership", "valid", "marker.json"), "utf8")) as Json;
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("ownership/invalid/"));
    expect(cases.length).toBeGreaterThan(3);
    for (const entry of cases) {
      const marker = JSON.parse(await readFile(join(FIXTURE_ROOT, entry.fixture), "utf8")) as Json;
      const kinds = checkOwnership(marker, reference).map((violation) => violation.kind);
      expect(kinds.some((kind) => OWNERSHIP_KINDS[entry.code]?.includes(kind)), `${entry.fixture} -> ${kinds.join(",")}`).toBe(true);
    }
  });

  it("rejects every hostile state document with its expected violation", async () => {
    const identity = JSON.parse(await readFile(join(FIXTURE_ROOT, "state", "valid", "identity.json"), "utf8")) as Json;
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("state/invalid/"));
    expect(cases.length).toBeGreaterThan(4);
    for (const entry of cases) {
      const document = JSON.parse(await readFile(join(FIXTURE_ROOT, entry.fixture), "utf8")) as Json;
      const kinds = checkState(document, identity, expectations.canaries).map((violation) => violation.kind);
      expect(kinds.some((kind) => STATE_KINDS[entry.code]?.includes(kind)), `${entry.fixture} -> ${kinds.join(",")}`).toBe(true);
    }
  });

  it("accepts every complete topology fixture as a clean operator config", async () => {
    for (const name of ["static-compose", "pm2-compose-db", "container-external"]) {
      const source = await readFile(resolve("test", "fixtures", name, "deploykit.config.fixture.yaml"), "utf8");
      expect(checkConfig(asJson(parseYaml(source), name)), name).toEqual([]);
    }
  });

  it("rejects every hostile config with its expected violation", async () => {
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("config/invalid/"));
    expect(cases.length).toBeGreaterThan(8);
    for (const entry of cases) {
      const source = await readFile(join(FIXTURE_ROOT, entry.fixture), "utf8");
      const kinds = checkConfig(asJson(parseYaml(source), entry.fixture)).map((violation) => violation.kind);
      expect(kinds, `${entry.fixture} is accidentally valid`).not.toEqual([]);
      if (entry.code === "DK_CONFIG_PLACEHOLDER") expect(kinds, entry.fixture).toContain("placeholder");
      else expect(kinds.filter((kind) => kind !== "placeholder"), entry.fixture).not.toEqual([]);
    }
  });
});

describe("secret canary containment", () => {
  it("uses synthetic canaries and no credential-shaped material", () => {
    expect(expectations.canaries.length).toBeGreaterThan(2);
    for (const canary of expectations.canaries) expect(canary.startsWith("DK_CANARY_")).toBe(true);
  });

  it("keeps canaries out of every fixture that is not deliberately secret-bearing", async () => {
    const allowed = new Set(expectations.canaryBearingFixtures);
    for (const file of fixtureFiles) {
      const text = await readFile(join(FIXTURE_ROOT, file), "utf8");
      const encoded = expectations.canaries.flatMap((canary) => [canary, Buffer.from(canary).toString("base64")]);
      const found = encoded.filter((needle) => text.includes(needle));
      if (allowed.has(file)) expect(found, `${file} is listed as secret-bearing but holds no canary`).not.toEqual([]);
      else expect(found, `${file} leaks a secret canary`).toEqual([]);
    }
  });

  it("keeps canaries out of shipped source, assets, and documentation", async () => {
    for (const directory of ["src", "docs", "assets"]) {
      const files = await walkAbsolute(resolve(directory));
      for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const canary of expectations.canaries) {
          expect(text.includes(canary), `${file} leaks a secret canary`).toBe(false);
        }
      }
    }
  });
});

describe("documentation stays bound to the frozen catalog", () => {
  const RECOVERY_MENTION = /`([a-z][a-z0-9-]*(?:-and-rerun|-conflict|-digest|-command|-request|-migration|-resumable|-pull-request))`|`(none)`/gu;

  it("names only recovery actions the contract defines", async () => {
    for (const file of ["docs/acceptance.md", "docs/orchestrator-contracts.md"]) {
      const text = await readFile(resolve(file), "utf8");
      const mentioned = [...text.matchAll(RECOVERY_MENTION)]
        .map((match) => match[1] ?? match[2])
        .filter((name): name is string => name !== undefined);
      expect(mentioned.length, file).toBeGreaterThan(5);
      for (const recovery of new Set(mentioned)) {
        expect(Object.hasOwn(RECOVERY_INSTRUCTIONS, recovery), `${file} names unknown recovery ${recovery}`).toBe(true);
      }
    }
  });

  it("documents every frozen failure code and recovery action exactly once", async () => {
    const text = await readFile(resolve("docs", "orchestrator-contracts.md"), "utf8");
    for (const entry of FAILURE_CONTRACTS) {
      expect(text.split(`\`${entry.code}\``).length - 1, `${entry.code} is not documented exactly once`).toBe(1);
    }
    for (const [recovery, instruction] of Object.entries(RECOVERY_INSTRUCTIONS)) {
      expect(text, `recovery ${recovery} is undocumented`).toContain(instruction);
    }
  });

  it("keeps the acceptance matrix pointed at this contract document", async () => {
    const text = await readFile(resolve("docs", "acceptance.md"), "utf8");
    expect(text).toContain("orchestrator-contracts.md");
  });
});

async function walkAbsolute(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walkAbsolute(full)));
    else found.push(full);
  }
  return found;
}
