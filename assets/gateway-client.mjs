/**
 * The bounded gateway client the DeployKit workflow runs on a GitHub-hosted
 * runner. It is embedded verbatim in `.github/workflows/deploykit.yml`, so its
 * bytes are part of the setup pull request an operator reviews, and its digest
 * is recorded in `.github/deploykit/ownership.json`.
 *
 * It has one job: turn the reviewed control artifacts plus the Environment's
 * secrets into one canonical gateway request stream, hand that stream to a
 * strictly verified SSH forced command, and report what came back.
 *
 * Four rules shape it.
 *
 * **Nothing is trusted before it is checked.** The committed ownership marker
 * must name this repository, target, and Environment; the committed runtime
 * manifest must hash to the dispatched digest; and the workflow file running
 * right now must hash to the digest the marker recorded. A dispatch that
 * disagrees with the reviewed bytes never reaches the VPS.
 *
 * **Secret values leave through one door.** They are read from the injected
 * Environment secrets, selected by name from the marker, and written to the
 * gateway's stdin. No secret is ever an argument, a file, a log line, or part
 * of a failure message.
 *
 * **Everything is bounded.** Control files, the manifest, each secret, the
 * total secret payload, and the gateway's own output all have ceilings, and
 * exceeding one is a refusal rather than a truncation.
 *
 * **The host is pinned.** The connection uses the reviewed `known_hosts` with
 * strict checking, no agent, no forwarding, and no interactivity, so a
 * substituted host fails the connection instead of receiving the secrets.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

const PROTOCOL_VERSION = "deploykit/gateway/v1alpha1";
const DIGEST_API_VERSION = "deploykit/digest/v1alpha1";
const CANONICALIZATION = "deploykit/runtime-yaml-canonical/v1";
const OWNERSHIP_API_VERSION = "deploykit/github-ownership/v1alpha1";

const LIMITS = {
  controlFileBytes: 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024,
  secretFrames: 256,
  secretValueBytes: 256 * 1024,
  totalSecretBytes: 8 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024,
  progressEvents: 10000,
  stderrCharacters: 4096,
};

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;
const RESERVED_SECRET_PREFIX = "DEPLOYKIT_";

/** A refusal the top-level handler turns into one annotated, bounded message. */
class ClientFailure extends Error {}

function fail(message) {
  throw new ClientFailure(message);
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") fail(`${name} is not set`);
  return value;
}

function flag(name) {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false") fail(`${name} must be true or false`);
  return value === "true";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBounded(path, limit, subject) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail(`${subject} could not be read from the checked-out default branch`);
  }
  if (bytes.byteLength > limit) fail(`${subject} exceeds its ${String(limit)}-byte bound`);
  return bytes;
}

/** The frozen digest record, in contract key order. */
function digestRecord(value) {
  return {
    apiVersion: DIGEST_API_VERSION,
    algorithm: "sha256",
    encoding: "hex",
    canonicalization: CANONICALIZATION,
    value,
  };
}

/**
 * Frames are built with their keys already in the frozen contract order and
 * serialized without insignificant whitespace, because the gateway re-encodes
 * every line and refuses one whose bytes differ.
 */
function frameLine(frame) {
  return `${JSON.stringify(frame)}\n`;
}

// ------------------------------------------------------- control artifacts --

function verifiedOwnership(bytes, identity, workflowDigest) {
  let marker;
  try {
    marker = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("the committed ownership marker is not parsable JSON");
  }
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    fail("the committed ownership marker is not an object");
  }
  if (marker.apiVersion !== OWNERSHIP_API_VERSION || marker.owner !== "deploykit") {
    fail("the file at the DeployKit ownership path is owned by another tool");
  }
  for (const field of ["repository", "targetName", "targetId", "githubEnvironment"]) {
    if (marker[field] !== identity[field]) {
      fail(`the committed ownership marker names a different ${field}`);
    }
  }
  if (marker.workflowDigest !== workflowDigest) {
    fail("the running workflow does not match the workflow digest recorded in the ownership marker");
  }
  const managed = marker.managed;
  if (typeof managed !== "object" || managed === null || Array.isArray(managed)) {
    fail("the committed ownership marker has no managed block");
  }
  return marker;
}

/**
 * Secret *names* come from the reviewed marker, never from the injected secret
 * bundle: the workflow sends exactly what the merged control artifacts declare
 * and nothing the Environment happens to carry.
 */
function declaredSecretNames(managed) {
  const names = managed.backendSecrets;
  const generated = managed.generatedSecrets;
  if (!Array.isArray(names) || !Array.isArray(generated)) {
    fail("the committed ownership marker does not list its managed secret names");
  }
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !SECRET_NAME_PATTERN.test(name)) {
      fail("the committed ownership marker lists a value that is not a secret name");
    }
    if (name.startsWith(RESERVED_SECRET_PREFIX)) {
      fail(`the committed ownership marker claims the reserved ${RESERVED_SECRET_PREFIX} prefix`);
    }
    if (seen.has(name)) fail("the committed ownership marker repeats a secret name");
    seen.add(name);
  }
  // Generated secrets have no value anywhere off the VPS: the runtime creates
  // and preserves them, so sending a name we cannot hold would be a lie.
  for (const name of generated) {
    if (typeof name === "string" && seen.has(name)) {
      fail(`${name} is declared as both an operator secret and a generated secret`);
    }
  }
  return [...seen].sort();
}

function selectedSecrets(names) {
  let bundle;
  try {
    bundle = JSON.parse(required("DK_SECRETS_JSON"));
  } catch {
    fail("the injected Environment secrets are not parsable JSON");
  }
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    fail("the injected Environment secrets are not an object");
  }
  const missing = [];
  const selected = [];
  let total = 0;
  for (const name of names) {
    const value = bundle[name];
    if (typeof value !== "string" || value === "") {
      missing.push(name);
      continue;
    }
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength > LIMITS.secretValueBytes) {
      fail(`the Environment secret ${name} exceeds its ${String(LIMITS.secretValueBytes)}-byte bound`);
    }
    if (bytes.includes(0)) fail(`the Environment secret ${name} contains a NUL byte`);
    total += bytes.byteLength;
    if (total > LIMITS.totalSecretBytes) {
      fail(`the request exceeds its ${String(LIMITS.totalSecretBytes)}-byte total secret bound`);
    }
    selected.push({ name, payload: bytes.toString("base64"), byteLength: bytes.byteLength });
  }
  if (missing.length > 0) {
    fail(`the ${required("DK_ENVIRONMENT")} Environment is missing ${missing.join(", ")}`);
  }
  if (selected.length > LIMITS.secretFrames) {
    fail(`the request exceeds its ${String(LIMITS.secretFrames)}-secret-frame bound`);
  }
  return { frames: selected, byteLength: total };
}

// --------------------------------------------------------------- transport --

function sshArguments(identityFile, knownHostsFile, host, port, user) {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", "IdentitiesOnly=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "PubkeyAuthentication=yes",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=30",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=40",
    "-o", "LogLevel=ERROR",
    // `-n` is deliberately absent: the request stream is written to stdin.
    "-T", "-a", "-x",
    "-i", identityFile,
    "-p", port,
    `${user}@${host}`,
  ];
}

function exchange(args, input) {
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let overflowed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > LIMITS.outputBytes) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < LIMITS.stderrCharacters) stderr += chunk;
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: error.message, overflowed });
    });
    child.on("close", (code) => {
      resolve({ code: code === null ? 255 : code, stdout, stderr, overflowed });
    });
    child.stdin.end(input);
  });
}

/**
 * Parses the gateway's own JSON Lines output with the same discipline the
 * gateway applies to ours: bounded lines, strictly increasing sequence numbers,
 * one terminating result frame, and no frame from another request.
 */
function parseOutput(text, requestId) {
  if (text === "") fail("the gateway produced no output");
  if (!text.endsWith("\n")) fail("the gateway output does not end with LF");
  const events = [];
  let result;
  let previous = 0;
  const lines = text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    const position = index + 1;
    if (line === "") fail(`gateway output line ${String(position)} is empty`);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      fail(`gateway output line ${String(position)} is not parsable JSON`);
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      fail(`gateway output line ${String(position)} is not a JSON object`);
    }
    if (frame.protocolVersion !== PROTOCOL_VERSION) {
      fail(`gateway output line ${String(position)} declares an unsupported protocol version`);
    }
    if (frame.frame !== "progress" && frame.frame !== "result") {
      fail(`gateway output line ${String(position)} is not a progress or result frame`);
    }
    if (result !== undefined) fail("a frame follows the gateway result frame");
    if (typeof frame.sequence !== "number" || !Number.isSafeInteger(frame.sequence) ||
        frame.sequence <= previous) {
      fail(`gateway output line ${String(position)} does not advance the sequence`);
    }
    previous = frame.sequence;
    if (frame.frame === "progress") {
      if (frame.requestId !== requestId) {
        fail(`gateway output line ${String(position)} belongs to another request`);
      }
      events.push(frame);
      if (events.length > LIMITS.progressEvents) {
        fail(`the gateway exceeded its ${String(LIMITS.progressEvents)}-progress-event bound`);
      }
      continue;
    }
    if (frame.requestId !== null && frame.requestId !== requestId) {
      fail(`gateway output line ${String(position)} belongs to another request`);
    }
    if (typeof frame.ok !== "boolean") fail("the gateway result frame has no outcome");
    result = frame;
  }
  if (result === undefined) fail("the gateway output has no result frame");
  return { events, result };
}

function reportProgress(event) {
  const text = `[${String(event.phase)}] ${String(event.code)} ${String(event.message)}`;
  if (event.level === "warning") process.stdout.write(`::warning::${text}\n`);
  else process.stdout.write(`${text}\n`);
}

function reportDeployment(payload) {
  if (typeof payload !== "object" || payload === null) return;
  if (payload.kind !== "deployment") return;
  process.stdout.write(`outcome: ${String(payload.outcome)}\n`);
  if (payload.phase !== null) process.stdout.write(`phase: ${String(payload.phase)}\n`);
  for (const domain of payload.domains ?? []) process.stdout.write(`domain: ${String(domain)}\n`);
  for (const port of payload.ports ?? []) {
    process.stdout.write(`port: ${String(port.service)} ${String(port.address)}:${String(port.port)}\n`);
  }
  for (const health of payload.health ?? []) {
    process.stdout.write(
      `health: ${String(health.service)} ${health.healthy === true ? "healthy" : "unhealthy"}\n`,
    );
  }
}

// -------------------------------------------------------------------- main --

async function main() {
  const identity = {
    repository: required("DK_REPOSITORY"),
    targetName: required("DK_TARGET_NAME"),
    targetId: required("DK_TARGET_ID"),
    githubEnvironment: required("DK_ENVIRONMENT"),
  };
  const applicationRef = required("DK_APPLICATION_REF");
  const requestId = required("DK_REQUEST_ID");
  const commitSha = required("DK_COMMIT_SHA");
  const manifestDigestValue = required("DK_MANIFEST_DIGEST");
  const dryRun = flag("DK_DRY_RUN");
  const resume = flag("DK_RESUME");

  if (!REQUEST_ID_PATTERN.test(requestId)) fail("request_id is not a DeployKit request UUID");
  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    fail("commit_sha is not a full lower-case 40-character commit SHA");
  }
  if (!SHA256_HEX_PATTERN.test(manifestDigestValue)) {
    fail("manifest_digest is not a lower-case SHA-256 digest");
  }
  if (required("DK_TARGET_INPUT") !== identity.targetName) {
    fail("the dispatched target is not the target this workflow deploys");
  }
  if (required("DK_ENVIRONMENT_TARGET_ID") !== identity.targetId) {
    fail("the Environment target id is not the target id this workflow deploys");
  }

  const workflowBytes = readBounded(
    required("DK_WORKFLOW_FILE"), LIMITS.controlFileBytes, "the managed workflow",
  );
  const manifestBytes = readBounded(
    required("DK_MANIFEST_FILE"), LIMITS.manifestBytes, "the committed runtime manifest",
  );
  const ownershipBytes = readBounded(
    required("DK_OWNERSHIP_FILE"), LIMITS.controlFileBytes, "the committed ownership marker",
  );

  const manifestDigest = sha256(manifestBytes);
  if (manifestDigest !== manifestDigestValue) {
    fail("the committed runtime manifest does not hash to the dispatched manifest digest");
  }
  const marker = verifiedOwnership(ownershipBytes, identity, sha256(workflowBytes));
  const recorded = marker.runtimeManifestDigest;
  if (typeof recorded !== "object" || recorded === null || recorded.value !== manifestDigest) {
    fail("the committed ownership marker records a different runtime manifest digest");
  }

  const secrets = selectedSecrets(declaredSecretNames(marker.managed));
  const operation = resume ? "retry" : "apply";
  const digest = digestRecord(manifestDigest);

  const stream = [
    frameLine({
      protocolVersion: PROTOCOL_VERSION,
      frame: "request",
      requestId,
      operation,
      repository: identity.repository,
      githubEnvironment: identity.githubEnvironment,
      targetName: identity.targetName,
      targetId: identity.targetId,
      applicationRef,
      commitSha,
      manifestDigest: digest,
      expectedPayload: {
        manifestBytes: manifestBytes.byteLength,
        manifestFrames: 1,
        secretBytes: secrets.byteLength,
        secretFrames: secrets.frames.length,
      },
      flags: { dryRun },
    }),
    frameLine({
      protocolVersion: PROTOCOL_VERSION,
      frame: "manifest",
      requestId,
      mediaType: "application/yaml",
      encoding: "base64",
      byteLength: manifestBytes.byteLength,
      digest,
      payload: manifestBytes.toString("base64"),
    }),
    ...secrets.frames.map((secret) =>
      frameLine({
        protocolVersion: PROTOCOL_VERSION,
        frame: "secret",
        requestId,
        name: secret.name,
        encoding: "base64",
        byteLength: secret.byteLength,
        payload: secret.payload,
      }),
    ),
    frameLine({
      protocolVersion: PROTOCOL_VERSION,
      frame: "end",
      requestId,
      manifestFrames: 1,
      secretFrames: secrets.frames.length,
      payloadBytes: manifestBytes.byteLength + secrets.byteLength,
    }),
  ].join("");

  const port = required("DK_GATEWAY_PORT");
  if (!PORT_PATTERN.test(port)) fail("DEPLOYKIT_GATEWAY_PORT is not a TCP port number");
  const args = sshArguments(
    required("DK_IDENTITY_FILE"),
    required("DK_KNOWN_HOSTS_FILE"),
    required("DK_GATEWAY_HOST"),
    port,
    required("DK_GATEWAY_USER"),
  );

  process.stdout.write(
    `Requesting ${operation} of ${identity.repository}@${commitSha} on ${identity.targetName}\n`,
  );
  const exchanged = await exchange(args, stream);
  if (exchanged.overflowed) fail("the gateway output exceeded its bound");
  if (exchanged.stdout === "") {
    const reason = exchanged.stderr.trim();
    fail(
      `the gateway connection produced no result frame (ssh exit ${String(exchanged.code)})` +
      `${reason === "" ? "" : `: ${reason}`}`,
    );
  }

  const { events, result } = parseOutput(exchanged.stdout, requestId);
  for (const event of events) reportProgress(event);
  reportDeployment(result.result);

  if (result.ok !== true) {
    process.stderr.write(
      `::error::DeployKit ${String(result.code)}: recovery ${String(result.recovery)}\n`,
    );
    process.exit(1);
  }
  const outcome = result.result?.outcome;
  if (outcome !== undefined && outcome !== "succeeded" && outcome !== "dry-run") {
    process.stderr.write(`::error::DeployKit finished with outcome ${String(outcome)}\n`);
    process.exit(1);
  }
  process.stdout.write("DeployKit deployment completed\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof ClientFailure ? error.message : "an unexpected client error occurred";
  process.stderr.write(`::error::DeployKit gateway client: ${message}\n`);
  process.exit(1);
}
