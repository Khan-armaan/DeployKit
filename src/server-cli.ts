import { Command, CommanderError, InvalidArgumentError } from "commander";

import { renderCliError } from "./cli-errors.js";
import { DeployKitError } from "./errors.js";
import { Reporter } from "./output.js";
import { runServerApply } from "./server-runtime.js";
import { readServerTargetLogs, inspectServerTarget } from "./server-inspect.js";
import { SecretsStore, serverPaths } from "./server/index.js";
import { VERSION } from "./version.js";

interface GlobalOptions {
  manifest: string;
  json?: boolean;
  verbose?: boolean;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function reporter(command: Command): Reporter {
  const options = globalOptions(command);
  return new Reporter(options.json ? "json" : "human", options.verbose);
}

function parseList(value: string): string[] {
  if (value === "none" || value.trim() === "") return [];
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
    throw new DeployKitError("DK_USAGE", "Secret names must use uppercase environment-variable syntax");
  }
  return [...new Set(names)];
}

function validateCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new DeployKitError("DK_USAGE", "--commit must be a lowercase 40-character Git commit SHA");
  }
}

function integerOption(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10_000) {
    throw new InvalidArgumentError("tail must be an integer between 1 and 10000");
  }
  return number;
}

export function configureServerProgram(): Command {
  const program = new Command()
    .name("deploykit")
    .description("DeployKit deterministic VPS runtime")
    .version(VERSION)
    .option("--manifest <path>", "manifest path", "deploykit.yaml")
    .option("--json", "emit machine-readable JSON")
    .option("--verbose", "show diagnostic details");
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined });

  const server = program.command("server").description("execute the enrolled VPS runtime");
  server.command("apply")
    .requiredOption("--target <name>")
    .requiredOption("--commit <sha>")
    .option("--source <directory>", "checked-out source", process.cwd())
    .option("--resume")
    .option("--dry-run")
    .action(async (options: { target: string; commit: string; source: string; resume?: boolean; dryRun?: boolean }, command: Command) => {
      validateCommitSha(options.commit);
      reporter(command).result("DK_SERVER_APPLY", await runServerApply({
        manifestPath: globalOptions(command).manifest,
        target: options.target,
        commit: options.commit,
        source: options.source,
        resume: Boolean(options.resume),
        dryRun: Boolean(options.dryRun),
      }));
    });

  server.command("secrets-write")
    .requiredOption("--target-id <id>")
    .requiredOption("--required <names>")
    .requiredOption("--generated <names>")
    .action(async (options: { targetId: string; required: string; generated: string }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const paths = serverPaths(options.targetId);
      const store = new SecretsStore({ file: paths.secretsFile, requirements: { required: parseList(options.required), generated: parseList(options.generated) } });
      process.stdout.write(`${JSON.stringify(await store.writeFromStdin(Buffer.concat(chunks).toString("utf8"), true))}\n`);
    });

  server.command("secrets-check")
    .requiredOption("--target-id <id>")
    .requiredOption("--required <names>")
    .requiredOption("--generated <names>")
    .action(async (options: { targetId: string; required: string; generated: string }) => {
      const paths = serverPaths(options.targetId);
      const store = new SecretsStore({ file: paths.secretsFile, requirements: { required: parseList(options.required), generated: parseList(options.generated) } });
      process.stdout.write(`${JSON.stringify(await store.check())}\n`);
    });

  server.command("target-status").requiredOption("--target-id <id>").action(async (options: { targetId: string }) => {
    process.stdout.write(`${JSON.stringify(await inspectServerTarget(options.targetId))}\n`);
  });
  server.command("target-logs")
    .requiredOption("--target-id <id>")
    .option("--tail <lines>", "line count", integerOption, 200)
    .action(async (options: { targetId: string; tail: number }) => {
      const paths = serverPaths(options.targetId);
      const redactor = await new SecretsStore({ file: paths.secretsFile, requirements: { required: [], generated: [] } }).redactor();
      process.stdout.write(`${JSON.stringify(redactor.redact(await readServerTargetLogs(options.targetId, options.tail)))}\n`);
    });

  return program;
}

export async function runServerCli(argv = process.argv, stderr: NodeJS.WritableStream = process.stderr): Promise<number> {
  const program = configureServerProgram();
  try {
    if (argv.length <= 2) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    const normalized = error instanceof CommanderError && error.exitCode !== 0
      ? new DeployKitError("DK_USAGE", error.message.replace(/^error:\s*/u, ""), { cause: error })
      : error;
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const flags = argv.slice(2);
    const rendered = renderCliError(normalized, { json: flags.includes("--json"), verbose: flags.includes("--verbose") });
    stderr.write(rendered.output);
    return rendered.exitCode;
  }
}
