import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ServerError } from "./errors.js";

export interface AtomicWriteOptions {
  readonly mode?: number;
}

export async function atomicWriteFile(
  file: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", options.mode ?? 0o644);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);

    // fsync the directory so the rename survives a sudden power loss.
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }

  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new ServerError(
      "SERVER_STATE_INVALID",
      `cannot parse JSON state file ${file}`,
      { file },
      { cause: error },
    );
  }
}

export async function atomicWriteJson(
  file: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
