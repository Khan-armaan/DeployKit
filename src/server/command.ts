import { spawn } from "node:child_process";

import { ServerError } from "./errors.js";
import type { SecretRedactor } from "./secrets.js";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly allowFailure?: boolean;
}

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly dryRun: boolean;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

function recordedSpec(spec: CommandSpec): CommandSpec {
  return {
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    env: spec.env === undefined
      ? undefined
      : Object.fromEntries(Object.keys(spec.env).map((key) => [key, spec.env?.[key] === undefined ? undefined : "[SET]"])),
    timeoutMs: spec.timeoutMs,
    allowFailure: spec.allowFailure,
  };
}

function validateSpec(spec: CommandSpec): void {
  if (spec.command.trim() === "" || spec.command.includes("\0")) {
    throw new ServerError("SERVER_COMMAND_FAILED", "command executable is empty or contains NUL");
  }
  for (const argument of spec.args) {
    if (argument.includes("\0")) {
      throw new ServerError("SERVER_COMMAND_FAILED", "command argument contains NUL");
    }
  }
}

export function formatArgv(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((value) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
      ? value
      : `'${value.replace(/'/g, `'\\''`)}'`)
    .join(" ");
}

export interface ProcessCommandRunnerOptions {
  readonly dryRun?: boolean;
  readonly redactor?: SecretRedactor;
  readonly maxOutputBytes?: number;
}

/** Executes an executable with an argv array. It never invokes a shell. */
export class ProcessCommandRunner implements CommandRunner {
  readonly invocations: CommandSpec[] = [];
  private readonly dryRun: boolean;
  private readonly redactor?: SecretRedactor;
  private readonly maxOutputBytes: number;

  constructor(options: ProcessCommandRunnerOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.redactor = options.redactor;
    this.maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    validateSpec(spec);
    this.invocations.push(recordedSpec(spec));
    if (this.dryRun) {
      return { command: spec.command, args: [...spec.args], exitCode: 0, stdout: "", stderr: "", dryRun: true };
    }

    return await new Promise<CommandResult>((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const [key, value] of Object.entries(spec.env ?? {})) {
        if (value === undefined) delete environment[key];
        else environment[key] = value;
      }
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      };
      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes) {
          child.kill("SIGKILL");
          fail(new ServerError(
            "SERVER_COMMAND_FAILED",
            `${spec.command} exceeded the ${this.maxOutputBytes}-byte output limit`,
          ));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        fail(new ServerError(
          "SERVER_COMMAND_FAILED",
          `could not start ${spec.command}`,
          { command: spec.command },
          { cause: error },
        ));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        const rawStdout = Buffer.concat(stdout).toString("utf8");
        const rawStderr = Buffer.concat(stderr).toString("utf8");
        const redact = (value: string): string => this.redactor?.redactText(value) ?? value;
        const result: CommandResult = {
          command: spec.command,
          args: [...spec.args],
          exitCode: exitCode ?? 128,
          stdout: redact(rawStdout),
          stderr: redact(rawStderr),
          dryRun: false,
        };
        if (result.exitCode !== 0 && !(spec.allowFailure ?? false)) {
          fail(new ServerError(
            "SERVER_COMMAND_FAILED",
            `${formatArgv(spec.command, spec.args)} exited with code ${result.exitCode}${signal === null ? "" : ` (${signal})`}`,
            { ...result },
          ));
          return;
        }
        settled = true;
        resolve(result);
      });

      if (spec.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          fail(new ServerError(
            "SERVER_COMMAND_FAILED",
            `${spec.command} timed out after ${spec.timeoutMs}ms`,
            { timeoutMs: spec.timeoutMs },
          ));
        }, spec.timeoutMs);
      }
      if (spec.stdin === undefined) child.stdin.end();
      else child.stdin.end(spec.stdin);
    });
  }
}

export class RecordingCommandRunner implements CommandRunner {
  readonly invocations: CommandSpec[] = [];
  private readonly handler?: (spec: CommandSpec) => Promise<Partial<CommandResult>> | Partial<CommandResult>;

  constructor(
    handler?: (spec: CommandSpec) => Promise<Partial<CommandResult>> | Partial<CommandResult>,
  ) {
    this.handler = handler;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    validateSpec(spec);
    this.invocations.push(recordedSpec(spec));
    const override = await this.handler?.(spec);
    return {
      command: spec.command,
      args: [...spec.args],
      exitCode: 0,
      stdout: "",
      stderr: "",
      dryRun: true,
      ...override,
    };
  }
}
