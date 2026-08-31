import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { ServerError } from "./errors.js";

export interface LockOptions {
  readonly timeoutMs?: number;
}

export interface LockProvider {
  withLock<T>(
    file: string,
    operation: () => Promise<T>,
    options?: LockOptions,
  ): Promise<T>;
}

/** A deterministic lock implementation for unit tests and single-process use. */
export class InProcessLockProvider implements LockProvider {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(
    file: string,
    operation: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const predecessor = this.tails.get(file) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => held);
    this.tails.set(file, tail);

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutMs = options.timeoutMs ?? 30_000;
      await Promise.race([
        predecessor.catch(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ServerError("SERVER_LOCK_TIMEOUT", `timed out locking ${file}`, { file, timeoutMs })),
            timeoutMs,
          );
        }),
      ]);
      return await operation();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unlock();
      if (this.tails.get(file) === tail) this.tails.delete(file);
    }
  }
}

export interface FlockLockProviderOptions {
  readonly binary?: string;
}

/**
 * Holds an OS-level advisory lock while JavaScript executes. The child prints a
 * NUL byte only after `flock(2)` succeeds, then remains alive by reading stdin.
 * No caller-controlled value is interpreted by a shell.
 */
export class FlockLockProvider implements LockProvider {
  private readonly binary: string;

  constructor(options: FlockLockProviderOptions = {}) {
    this.binary = options.binary ?? "flock";
  }

  async withLock<T>(
    file: string,
    operation: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    if (!isAbsolute(file) || file.includes("\0")) {
      throw new ServerError("SERVER_LOCK_FAILED", "flock path must be absolute and cannot contain NUL", { file });
    }
    await mkdir(dirname(file), { recursive: true });
    const lockHandle = await open(file, "a", 0o600);
    await lockHandle.close();
    await chmod(file, 0o600);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const seconds = Math.max(0.001, timeoutMs / 1000).toFixed(3);
    const child = spawn(
      this.binary,
      ["--exclusive", "--wait", seconds, file, "sh", "-c", "printf '\\0'; cat >/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", (error) => reject(
        new ServerError("SERVER_LOCK_FAILED", `failed to run flock for ${file}`, { file }, { cause: error }),
      ));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => {
        if (!chunk.includes(0)) {
          reject(new ServerError("SERVER_LOCK_FAILED", `flock handshake failed for ${file}`, { file }));
          return;
        }
        resolve();
      });
    });
    await Promise.race([
      ready,
      exited.then(({ code }) => {
        const errorCode = code === 1 ? "SERVER_LOCK_TIMEOUT" : "SERVER_LOCK_FAILED";
        throw new ServerError(errorCode, `could not acquire lock ${file}`, { file, exitCode: code, stderr });
      }),
    ]);

    let operationResult: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      operationResult = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    child.stdin.end();
    const { code, signal } = await exited;
    if (operationFailed) throw operationError;
    if (code !== 0) {
      throw new ServerError(
        "SERVER_LOCK_FAILED",
        `flock holder exited with code ${code ?? `signal ${signal ?? "unknown"}`}`,
        { file, stderr },
      );
    }
    return operationResult as T;
  }
}
