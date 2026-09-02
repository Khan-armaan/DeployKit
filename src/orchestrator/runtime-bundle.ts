import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { resolvePackageRoot } from "../package-root.js";
import { SHA256_HEX_PATTERN, type Sha256Hex } from "./contracts.js";
import { orchestratorError } from "./failures.js";
import type { RuntimeBundleReference } from "./planner.js";
import { run } from "../process.js";

/**
 * The checksum-verified standalone bundle the VPS installs.
 *
 * Phase 4 injected {@link RuntimeBundleReference} rather than inventing one so
 * no placeholder would ship; this module is the production source of that
 * value. It packs the local package with `npm pack`, digests the exact bytes
 * that will be uploaded, and refuses a tarball that does not carry the two
 * files the installer needs — the standalone server runtime and the pinned
 * GitHub host keys.
 *
 * The package *name* travels with the reference and is passed to the installer,
 * which compares it against the name inside the tarball. The published package
 * and the installer therefore cannot drift apart the way they did while the
 * installer hard-coded a name of its own.
 */

/** Files the installer reads out of the packed tarball, as `tar` reports them. */
export const REQUIRED_BUNDLE_ENTRIES: readonly string[] = Object.freeze([
  "package/package.json",
  "package/dist/server-cli.cjs",
  "package/assets/github-known-hosts",
  "package/assets/bootstrap.sh",
  "package/assets/gateway-binding.sh",
  "package/assets/gateway-keys.sh",
  "package/assets/gateway-source-probe.sh",
]);

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[+-][A-Za-z0-9.-]+)?$/u;

export interface ResolvedRuntimeBundle extends RuntimeBundleReference {
  readonly packageName: string;
}

export interface ResolveRuntimeBundleOptions {
  /** Directory holding the `package.json` to pack. Defaults to the installed package. */
  readonly packageRoot?: string;
  /** Directory `npm pack` writes the tarball into. */
  readonly destination: string;
}

function bootstrapFailure(message: string, details: Record<string, unknown> = {}): Error {
  return orchestratorError("DK_GATEWAY_BOOTSTRAP_FAILED", message, { details });
}

/**
 * The root of the installed npm package, *found* rather than assumed. This
 * module is loaded from `src/orchestrator/` under test and from `dist/` or
 * `dist/chunks/` once the CLI is bundled, so a fixed depth is right for only
 * one of them — see {@link resolvePackageRoot}. Both markers are required
 * because every caller here needs the manifest *and* the installer assets.
 */
export function localPackageRoot(): string {
  return resolvePackageRoot({
    moduleUrl: import.meta.url,
    markers: ["package.json", "assets/bootstrap.sh"],
    subject: "DeployKit package",
  });
}

export async function readPackageIdentity(
  packageRoot: string,
): Promise<{ readonly name: string; readonly version: string }> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    throw bootstrapFailure(`${packageRoot} does not contain a readable package.json`, {
      cause: String(error),
    });
  }
  const record = document as { name?: unknown; version?: unknown };
  if (typeof record.name !== "string" || !PACKAGE_NAME_PATTERN.test(record.name)) {
    throw bootstrapFailure(`${packageRoot} does not declare a usable npm package name`);
  }
  if (typeof record.version !== "string" || !PACKAGE_VERSION_PATTERN.test(record.version)) {
    throw bootstrapFailure(`${packageRoot} does not declare a usable npm package version`);
  }
  return { name: record.name, version: record.version };
}

/** Refuses a tarball the installer would reject only after uploading it. */
export async function assertBundleContents(packageFile: string): Promise<readonly string[]> {
  const listing = await run("tar", ["-tzf", packageFile], { reject: false });
  if (listing.exitCode !== 0) {
    throw bootstrapFailure(`${basename(packageFile)} is not a readable gzip tarball`);
  }
  const entries = listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const missing = REQUIRED_BUNDLE_ENTRIES.filter((required) => !entries.includes(required));
  if (missing.length > 0) {
    throw bootstrapFailure(`${basename(packageFile)} does not contain the standalone gateway runtime`, {
      missing,
    });
  }
  return entries;
}

export function sha256File(contents: Uint8Array): Sha256Hex {
  const digest = createHash("sha256").update(contents).digest("hex");
  if (!SHA256_HEX_PATTERN.test(digest)) throw bootstrapFailure("the runtime bundle digest is malformed");
  return digest;
}

/**
 * Packs the local package and returns the reference the gateway binding and the
 * installer are both bound to. The digest covers the exact bytes uploaded, so a
 * tarball rebuilt with different contents can never satisfy an existing
 * binding's `runtimeBundleSha256`.
 */
export async function resolveRuntimeBundle(
  options: ResolveRuntimeBundleOptions,
): Promise<ResolvedRuntimeBundle> {
  const packageRoot = options.packageRoot ?? localPackageRoot();
  const identity = await readPackageIdentity(packageRoot);

  const packed = await run("npm", ["pack", packageRoot, "--json", "--pack-destination", options.destination]);
  let entries: Array<{ filename?: unknown }>;
  try {
    entries = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
  } catch (error) {
    throw bootstrapFailure("npm pack returned malformed JSON", { cause: String(error) });
  }
  const filename = entries[0]?.filename;
  if (typeof filename !== "string" || filename === "" || basename(filename) !== filename) {
    throw bootstrapFailure("npm pack did not report a safe output filename");
  }
  const packageFile = join(options.destination, filename);
  await assertBundleContents(packageFile);

  return {
    version: identity.version,
    packageName: identity.name,
    packageFile,
    packageSha256: sha256File(await readFile(packageFile)),
  };
}
