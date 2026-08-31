import { execa, type Options } from "execa";
import { DeployKitError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  reject?: boolean;
  timeoutMs?: number;
  stdio?: "pipe" | "inherit" | "stream";
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<RunResult> {
  try {
    const result = await execa(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      reject: options.reject ?? true,
      timeout: options.timeoutMs,
      stdio: options.stdio === "stream" ? ["pipe", "inherit", "inherit"] : options.stdio ?? "pipe",
      stripFinalNewline: true
    } as Options);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? 0
    };
  } catch (error) {
    const candidate = error as { shortMessage?: string; stderr?: string; exitCode?: number };
    throw new DeployKitError("DK_COMMAND_FAILED", candidate.shortMessage ?? `Command failed: ${command}`, {
      cause: error,
      details: { command, args, stderr: candidate.stderr, exitCode: candidate.exitCode }
    });
  }
}
