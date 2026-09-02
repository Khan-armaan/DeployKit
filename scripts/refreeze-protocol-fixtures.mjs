/**
 * Restamps the frozen gateway-protocol fixtures onto the current package
 * version.
 *
 * The compiled runtime manifest carries `requiredVersion: VERSION`, and Phase 1
 * froze the exact manifest bytes and their digest into
 * `test/fixtures/orchestrator/protocol/`. A release therefore changes a frozen
 * contract, which `test/package.test.ts` deliberately fails on so the change
 * cannot happen silently. This script is how that change is *made* — narrowly,
 * and in a way a reviewer can check.
 *
 * It rewrites exactly one thing: the `requiredVersion` scalar inside each
 * base64 manifest payload. Everything else follows from it:
 *
 * - A declared digest is replaced only where it equals the digest of the bytes
 *   as they were, so a fixture whose whole point is a mismatched digest keeps
 *   its mismatch.
 * - A payload whose base64 does not round-trip is noncanonical on purpose and
 *   is left untouched, because re-encoding it would erase the defect it exists
 *   to encode.
 * - Byte counts are asserted, never rewritten. Two version strings of different
 *   lengths would move them, and that is a change a person should look at.
 *
 * It also restamps the `runtimeVersion` recorded in the frozen binding, gateway
 * handshake, and operation-record fixtures. Those model a host running *this*
 * release, so a gateway built from them must accept a manifest this release
 * compiled.
 *
 * Usage: node scripts/refreeze-protocol-fixtures.mjs [--check]
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const ROOT = "test/fixtures/orchestrator/protocol";

/**
 * Fixtures that record the DeployKit release installed on the host. Listed one
 * by one rather than matched by pattern, so this can never sweep a version
 * somewhere that a test is deliberately holding at an older value.
 */
const RUNTIME_VERSION_FIXTURES = [
  "test/fixtures/orchestrator/binding/valid/binding.json",
  "test/fixtures/orchestrator/protocol/valid/output-handshake.jsonl",
  "test/fixtures/orchestrator/state/valid/operation-record.json",
  "test/fixtures/orchestrator/state/invalid/operation-record-with-secret.json",
  "test/fixtures/orchestrator/state/invalid/operation-record-unknown-status.json",
];
const CHECK_ONLY = process.argv.includes("--check");
const REQUIRED_VERSION = /("requiredVersion":\s*")([^"]*)(")/u;

const versionSource = await readFile("src/version.ts", "utf8");
const versionMatch = /export const VERSION = "([^"]+)"/u.exec(versionSource);
if (versionMatch === null) throw new Error("src/version.ts does not declare VERSION");
const VERSION = versionMatch[1];

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    // A deliberately malformed line is part of the fixture.
    return undefined;
  }
};

/** Replaces `value` wherever a digest object carries one of the old digests. */
function restamp(frame, replacements) {
  let next = frame;
  for (const key of ["digest", "manifestDigest"]) {
    const digest = next[key];
    const replacement = typeof digest?.value === "string" ? replacements.get(digest.value) : undefined;
    if (replacement !== undefined) next = { ...next, [key]: { ...digest, value: replacement } };
  }
  return next;
}

let inspected = 0;
let changed = 0;

for (const kind of ["valid", "invalid"]) {
  const directory = join(ROOT, kind);
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(directory, name);
    const original = await readFile(path, "utf8");
    const lines = original.split("\n");

    // Pass one: rewrite the manifest payloads and learn how each digest moved.
    const replacements = new Map();
    const rewritten = lines.map((line) => {
      if (line.trim() === "") return line;
      const frame = parse(line);
      if (frame?.frame !== "manifest" || typeof frame.payload !== "string") return line;

      const decoded = Buffer.from(frame.payload, "base64");
      if (decoded.toString("base64") !== frame.payload) return line;

      const text = decoded.toString("utf8");
      const match = REQUIRED_VERSION.exec(text);
      if (match === null || match[2] === VERSION) return line;
      inspected += 1;

      const updated = Buffer.from(text.replace(REQUIRED_VERSION, `$1${VERSION}$3`), "utf8");
      if (updated.byteLength !== decoded.byteLength) {
        throw new Error(
          `${path}: ${match[2]} -> ${VERSION} changes the manifest byte length; ` +
            "the frozen frame counts must be reviewed by hand",
        );
      }
      replacements.set(sha256Hex(decoded), sha256Hex(updated));
      return JSON.stringify(restamp({ ...frame, payload: updated.toString("base64") }, replacements));
    });

    if (replacements.size === 0) continue;

    // Pass two: every other frame that repeats one of those digests.
    const finished = rewritten.map((line) => {
      if (line.trim() === "") return line;
      const frame = parse(line);
      if (frame === undefined) return line;
      const next = restamp(frame, replacements);
      return next === frame ? line : JSON.stringify(next);
    });

    const output = finished.join("\n");
    if (output === original) continue;
    changed += 1;
    if (CHECK_ONLY) {
      process.stderr.write(`${path} is not frozen on ${VERSION}\n`);
      continue;
    }
    await writeFile(path, output);
    process.stdout.write(`refroze ${path}\n`);
  }
}

const RUNTIME_VERSION = /("runtimeVersion":\s*")([^"]*)(")/gu;

for (const path of RUNTIME_VERSION_FIXTURES) {
  const original = await readFile(path, "utf8");
  const output = original.replace(RUNTIME_VERSION, `$1${VERSION}$3`);
  if (output === original) continue;
  changed += 1;
  if (CHECK_ONLY) {
    process.stderr.write(`${path} is not frozen on ${VERSION}\n`);
    continue;
  }
  await writeFile(path, output);
  process.stdout.write(`refroze ${path}\n`);
}

process.stdout.write(
  `${inspected} manifest frame(s) restamped on ${VERSION}; ` +
    `${changed} fixture(s) ${CHECK_ONLY ? "stale" : "rewritten"}\n`,
);
if (CHECK_ONLY && changed > 0) process.exit(1);
