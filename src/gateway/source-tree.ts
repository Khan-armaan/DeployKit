import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { gatewayError } from "./failures.js";

/**
 * The safety check that stands between a repository someone else controls and
 * a root-owned deployment. Git already refuses to write outside a work tree,
 * but the *contents* of a tree are attacker-chosen: a symlink can point at
 * `/etc/shadow`, a gitlink can leave an empty directory where a service is
 * expected, and a `.git` directory smuggled into a release would make the
 * deployed tree a repository of its own.
 *
 * So the materialized tree is walked before it is ever promoted, and anything
 * that is not a plain file, directory, or inward-pointing symlink is refused
 * as `DK_SOURCE_UNSAFE`. Nothing here follows a symlink.
 */

/** A tree far larger than this is a mistake, not an application. */
export const MAX_SOURCE_ENTRIES = 200_000;
export const MAX_SOURCE_DEPTH = 64;

export interface SourceTreeReport {
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
}

export interface SourceTreeOptions {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

function unsafe(message: string, details: Record<string, unknown> = {}): Error {
  return gatewayError("DK_SOURCE_UNSAFE", message, { details });
}

/** True when `child` is `parent` itself or lies underneath it. */
function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

/**
 * Validates one symlink without following it. The target is resolved lexically
 * against the link's own directory, because the file it names may not exist yet
 * and `realpath` would refuse it, and because a dangling escape is still an
 * escape once the deployment creates the missing file.
 */
export function assertSymlinkStaysInside(root: string, linkPath: string, target: string): void {
  const relativePath = relative(root, linkPath);
  if (target.includes("\0")) throw unsafe("a source symlink target contains a NUL byte", { path: relativePath });
  if (isAbsolute(target)) {
    throw unsafe("a source symlink points outside the retrieved tree", { path: relativePath });
  }
  const resolved = resolve(join(linkPath, ".."), target);
  if (!contains(root, resolved)) {
    throw unsafe("a source symlink points outside the retrieved tree", { path: relativePath });
  }
}

/**
 * Walks the retrieved tree and refuses anything that must never reach a
 * release. `.git` is rejected wherever it appears: the materialized tree is a
 * plain directory of files, never a repository.
 */
export async function assertSafeSourceTree(
  root: string,
  options: SourceTreeOptions = {},
): Promise<SourceTreeReport> {
  const maxEntries = options.maxEntries ?? MAX_SOURCE_ENTRIES;
  const maxDepth = options.maxDepth ?? MAX_SOURCE_DEPTH;
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  let entries = 0;

  const rootStats = await lstat(root);
  if (!rootStats.isDirectory()) {
    throw unsafe("the retrieved source root is not a directory", { root });
  }

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      throw unsafe(`the retrieved source is nested deeper than ${String(maxDepth)} directories`, {
        path: relative(root, directory),
      });
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > maxEntries) {
        throw unsafe(`the retrieved source contains more than ${String(maxEntries)} entries`);
      }
      const full = join(directory, entry.name);
      const relativePath = relative(root, full);
      if (entry.name === ".git") {
        throw unsafe("the retrieved source contains a .git path", { path: relativePath });
      }
      if (entry.name === ".gitmodules") {
        throw unsafe("the retrieved source declares submodules DeployKit does not fetch", {
          path: relativePath,
        });
      }
      if (!contains(root, full)) {
        throw unsafe("a source entry resolves outside the retrieved tree", { path: relativePath });
      }
      if (entry.isSymbolicLink()) {
        symlinks += 1;
        assertSymlinkStaysInside(root, full, await readlink(full));
        continue;
      }
      if (entry.isDirectory()) {
        directories += 1;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw unsafe("the retrieved source contains a device, socket, or FIFO", { path: relativePath });
      }
      files += 1;
    }
  };

  await walk(root, 1);
  return { files, directories, symlinks };
}
