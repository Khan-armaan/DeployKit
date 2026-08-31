import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

import { atomicWriteJson } from "./atomic.js";
import { ServerError } from "./errors.js";
import { assertCommitSha, assertSafeId } from "./ids.js";
import type { ServerPaths } from "./paths.js";

interface ReleaseMarker {
  readonly version: 1;
  readonly targetId: string;
  readonly commitSha: string;
}

export interface StagedRelease {
  readonly directory: string;
  readonly reused: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validateExistingRelease(
  directory: string,
  targetId: string,
  commitSha: string,
): Promise<void> {
  let marker: ReleaseMarker;
  try {
    marker = JSON.parse(await readFile(`${directory}/.deploykit-release.json`, "utf8")) as ReleaseMarker;
  } catch (error) {
    throw new ServerError(
      "SERVER_STATE_INVALID",
      `existing release ${directory} does not have a valid DeployKit marker`,
      { directory },
      { cause: error },
    );
  }
  if (marker.version !== 1 || marker.targetId !== targetId || marker.commitSha !== commitSha) {
    throw new ServerError("SERVER_STATE_INVALID", `existing release marker does not match ${targetId}@${commitSha}`, {
      marker,
    });
  }
}

export class ReleaseManager {
  constructor(private readonly paths: ServerPaths) {}

  async stage(sourceDirectory: string, commitSha: string): Promise<StagedRelease> {
    assertSafeId(this.paths.targetId, "target id");
    const sha = assertCommitSha(commitSha);
    const source = await realpath(sourceDirectory);
    const sourceStats = await lstat(source);
    if (!sourceStats.isDirectory()) {
      throw new ServerError("SERVER_STATE_INVALID", `release source is not a directory: ${source}`);
    }
    await mkdir(this.paths.releasesDirectory, { recursive: true, mode: 0o755 });
    const releases = await realpath(this.paths.releasesDirectory);
    const destinationInsideSource = relative(source, releases);
    const sourceInsideDestination = relative(releases, source);
    if (
      destinationInsideSource === "" ||
      (!destinationInsideSource.startsWith("..") && !isAbsolute(destinationInsideSource)) ||
      (!sourceInsideDestination.startsWith("..") && !isAbsolute(sourceInsideDestination))
    ) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        "release destination cannot be inside the source directory",
        { source, releases },
      );
    }
    const destination = this.paths.releaseDirectory(sha);
    if (await pathExists(destination)) {
      await validateExistingRelease(destination, this.paths.targetId, sha);
      return { directory: destination, reused: true };
    }

    const staging = `${destination}.staging-${randomBytes(10).toString("hex")}`;
    try {
      await cp(source, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
      await atomicWriteJson(`${staging}/.deploykit-release.json`, {
        version: 1,
        targetId: this.paths.targetId,
        commitSha: sha,
      } satisfies ReleaseMarker, { mode: 0o644 });
      try {
        await rename(staging, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
          throw error;
        }
        await validateExistingRelease(destination, this.paths.targetId, sha);
      }
      return { directory: destination, reused: false };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async activate(commitSha: string): Promise<string> {
    const sha = assertCommitSha(commitSha);
    const destination = this.paths.releaseDirectory(sha);
    await validateExistingRelease(destination, this.paths.targetId, sha);
    await mkdir(dirname(this.paths.currentReleaseLink), { recursive: true });
    const temporary = `${this.paths.currentReleaseLink}.staging-${randomBytes(10).toString("hex")}`;
    try {
      await symlink(destination, temporary);
      await rename(temporary, this.paths.currentReleaseLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EISDIR" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        throw error;
      }
      throw new ServerError(
        "SERVER_STATE_INVALID",
        `${this.paths.currentReleaseLink} exists and is not a replaceable symlink`,
        { path: this.paths.currentReleaseLink },
        { cause: error },
      );
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return destination;
  }

  async current(): Promise<string | undefined> {
    try {
      return await readlink(this.paths.currentReleaseLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
