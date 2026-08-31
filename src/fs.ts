import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(path: string, contents: string | Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split("/").at(-1)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonFile(path: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function writeIfAbsent(path: string, contents: string, mode = 0o644): Promise<"created" | "unchanged"> {
  if (await pathExists(path)) {
    const existing = await readFile(path, "utf8");
    if (existing === contents) return "unchanged";
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }
  await atomicWriteFile(path, contents, mode);
  return "created";
}

export { readFile, writeFile, mkdir };
