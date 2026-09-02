import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeployKitError } from "./errors.js";

/**
 * Where the installed package actually is, found rather than assumed.
 *
 * A module in this package is loaded from three different depths: from
 * `src/<area>/` under test, from `dist/` when the CLI is bundled to one file,
 * and from `dist/chunks/` when esbuild splits it. A hard-coded `../..` is
 * correct for exactly one of those, which is why a packaged install can fail
 * while every source-tree test passes — the layout the tests exercise is not
 * the layout that ships.
 *
 * So the root is located by walking up until the files that only the package
 * root has are actually present. `markers` are all required: a lone
 * `package.json` would also match a scope directory or a nested workspace, and
 * matching the wrong directory is precisely the failure this replaces.
 */

/** Enough to reach the package root from `dist/chunks/` and from `src/<area>/`. */
const PACKAGE_ROOT_SEARCH_DEPTH = 4;

export interface PackageRootRequest {
  /** `import.meta.url` of the calling module; absent in the CommonJS bundle. */
  readonly moduleUrl: string | undefined;
  /** Package-relative paths that must all exist at the root. */
  readonly markers: readonly string[];
  /** What the caller wanted, for the failure message. */
  readonly subject: string;
}

export function resolvePackageRoot(request: PackageRootRequest): string {
  if (!request.moduleUrl) {
    // The standalone VPS bundle is CommonJS and ships no package around it.
    throw new DeployKitError(
      "DK_UNSUPPORTED",
      `The ${request.subject} is unavailable in the standalone VPS runtime`,
    );
  }
  let directory = dirname(fileURLToPath(request.moduleUrl));
  for (let depth = 0; depth <= PACKAGE_ROOT_SEARCH_DEPTH; depth += 1) {
    if (request.markers.every((marker) => existsSync(resolve(directory, marker)))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new DeployKitError(
    "DK_UNSUPPORTED",
    `The ${request.subject} is not installed beside the DeployKit CLI`,
    { details: { markers: request.markers } },
  );
}
