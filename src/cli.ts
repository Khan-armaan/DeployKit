#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import prompts from "prompts";

import { OpenAIAdvisorProvider, AnthropicAdvisorProvider, loadApprovedAdvisorFiles, requestManifestAdvice } from "./advisor/index.js";
import { bootstrapServer, readSshFingerprint } from "./bootstrap.js";
import { renderCliError } from "./cli-errors.js";
import { loadOperatorConfig } from "./orchestrator/config.js";
import { DeployKitError } from "./errors.js";
import { atomicWriteFile, writeIfAbsent } from "./fs.js";
import { dispatchDeployment, inferGitHubRepository, validateApplicationRef } from "./github.js";
import { collectInitAnswers, createStarterManifest, type InitAnswers } from "./init.js";
import { loadManifest, parseManifest, stringifyManifest, type ProjectManifest } from "./manifest.js";
import { Reporter } from "./output.js";
import { createDeploymentPlan } from "./plan.js";
import { validateProject } from "./project-validation.js";
import { assertValidManifest } from "./validation.js";
import { requireServer } from "./local-config.js";
import { runRemoteDeployKit } from "./remote.js";
import { checkRemoteSecrets, setRemoteSecrets } from "./secrets-client.js";
import { inspectServerTarget, readServerTargetLogs } from "./server-inspect.js";
import {
  SecretsStore,
  makeTargetId,
  secretRequirementsFromManifest,
  serverPaths
} from "./server/index.js";
import { runServerApply } from "./server-runtime.js";
import { generateGitHubWorkflow } from "./generators/index.js";
import { VERSION } from "./version.js";

export { normalizeCliError, renderCliError } from "./cli-errors.js";

interface GlobalOptions {
  manifest: string;
  json?: boolean;
  verbose?: boolean;
}

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function reporter(command: Command): Reporter {
  const options = globals(command);
  return new Reporter(options.json ? "json" : "human", options.verbose);
}

async function manifestFor(command: Command): Promise<ProjectManifest> {
  return loadManifest(globals(command).manifest);
}

function requireTarget(manifest: ProjectManifest, targetName: string): ProjectManifest["targets"][string] {
  const target = manifest.targets[targetName];
  if (!target) throw new DeployKitError("DK_USAGE", `Unknown target '${targetName}'. Available: ${Object.keys(manifest.targets).join(", ")}`);
  return target;
}

function parseList(value: string): string[] {
  if (value === "none" || value.trim() === "") return [];
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))) throw new DeployKitError("DK_USAGE", "Secret names must use uppercase environment-variable syntax");
  return [...new Set(names)];
}

export function localAdvisorSecretValues(
  manifest: ProjectManifest,
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const requirements = secretRequirementsFromManifest(manifest);
  const names = new Set([
    ...requirements.required,
    ...(requirements.generated ?? []),
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY"
  ]);
  return [...new Set([...names].flatMap((name) => {
    const value = environment[name];
    return value ? [value] : [];
  }))];
}

export function validateAdvisorCandidate(value: unknown): ProjectManifest {
  return assertValidManifest(value);
}

function integerOption(label: string, minimum: number, maximum: number): (value: string) => number {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new InvalidArgumentError(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
}

function validateCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new DeployKitError("DK_USAGE", "--commit must be a lowercase 40-character Git commit SHA");
  }
}

function formatIssues(result: Awaited<ReturnType<typeof validateProject>>): string {
  return result.issues.map((entry) => {
    const path = entry.path.length > 0 ? entry.path.join(".") : "manifest";
    return `${entry.severity.toUpperCase()} ${entry.code} ${path}: ${entry.message}${entry.remediation ? `\n  ${entry.remediation}` : ""}`;
  }).join("\n");
}

async function confirm(message: string, initial = false): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const response = await prompts({ type: "confirm", name: "yes", message, initial });
  return Boolean(response.yes);
}

/**
 * Scaffolds, securely reads, and validates the one-file deployment config.
 * Interactive sessions wait at the prompt so the same command can continue once
 * the operator has filled the file in.
 */
async function loadOperatorDeployment(out: Reporter): Promise<Awaited<ReturnType<typeof loadOperatorConfig>>> {
  return loadOperatorConfig({
    confirm: (message) => confirm(message, true),
    onScaffold: (location) => {
      out.info(
        "DK_CONFIG_SCAFFOLDED",
        `Created ${location.configPath} with mode 0600 and excluded it through ${location.excludePath}`,
      );
    },
  });
}

export function configureProgram(): Command {
  const program = new Command()
    .name("deploykit")
    .description("Manifest-driven first deployments to Ubuntu VPS hosts")
    .version(VERSION)
    .option("--manifest <path>", "manifest path", "deploykit.yaml")
    .option("--json", "emit machine-readable JSON")
    .option("--verbose", "show diagnostic details");
  // Set these before creating subcommands so they inherit non-exiting behavior.
  program.exitOverride();
  program.configureOutput({
    // Commander's prose errors are replaced by DeployKit's stable error envelope.
    writeErr: () => undefined
  });

  program.command("init")
    .description("inspect the repository and create deploykit.yaml plus the pinned workflow")
    .option("--yes", "use provided/default answers without prompts")
    .option("--project-name <name>")
    .option("--target <name>", "target name", "production")
    .option("--runner-label <label>")
    .option("--domain <fqdn>")
    .option("--api-service <service>")
    .option("--api-port <port>", "API container port", integerOption("API port", 1, 65_535))
    .addOption(new Option("--frontend-mode <mode>", "frontend delivery mode").choices(["static", "service", "none"]))
    .action(async (options: Record<string, unknown>, command: Command) => {
      const out = reporter(command);
      const defaults: Partial<InitAnswers> = {
        projectName: options.projectName as string | undefined,
        targetName: options.target as string | undefined,
        runnerLabel: options.runnerLabel as string | undefined,
        primaryDomain: options.domain as string | undefined,
        apiService: options.apiService as string | undefined,
        apiPort: options.apiPort as number | undefined,
        frontendMode: options.frontendMode as InitAnswers["frontendMode"] | undefined
      };
      const answers = await collectInitAnswers(process.cwd(), defaults, Boolean(options.yes));
      const manifestInput = await createStarterManifest(process.cwd(), answers);
      const manifest = parseManifest(manifestInput);
      const validation = await validateProject(manifest, { manifestPath: globals(command).manifest });
      const manifestContents = stringifyManifest(manifest);
      const workflow = generateGitHubWorkflow(manifest, { manifestPath: globals(command).manifest });
      if (!options.yes && !(await confirm("Write deploykit.yaml and .github/workflows/deploykit.yml?", true))) {
        throw new DeployKitError("DK_USAGE", "Initialization cancelled");
      }
      const manifestResult = await writeIfAbsent(resolve(globals(command).manifest), manifestContents, 0o644);
      const workflowResult = await writeIfAbsent(resolve(".github/workflows/deploykit.yml"), workflow, 0o644);
      if (!validation.valid) {
        out.warn(
          "DK_INIT_REMEDIATION_REQUIRED",
          `Configuration was generated, but ${validation.errors.length} project issue(s) must be fixed before deployment`,
          validation.issues,
        );
      }
      out.result("DK_INIT_COMPLETE", {
        manifest: manifestResult,
        workflow: workflowResult,
        targets: Object.keys(manifest.targets),
        valid: validation.valid,
        issues: validation.issues,
      });
    });

  program.command("validate")
    .description("validate schema, repository files, and effective Compose configuration")
    .option("--skip-compose", "skip docker compose config inspection")
    .action(async (options: { skipCompose?: boolean }, command: Command) => {
      const out = reporter(command);
      const manifest = await manifestFor(command);
      const result = await validateProject(manifest, { manifestPath: globals(command).manifest, inspectComposeConfig: !options.skipCompose });
      if (!result.valid) {
        if (!globals(command).json) out.result("DK_VALIDATION_RESULT", formatIssues(result));
        throw new DeployKitError("DK_VALIDATION_FAILED", "Project validation failed", { details: result.issues });
      }
      out.result("DK_VALIDATION_OK", globals(command).json ? result : `Valid deploykit/v1alpha1 manifest (${result.warnings.length} warning(s))`);
    });

  program.command("plan")
    .description("print a deterministic, non-mutating deployment plan")
    .requiredOption("--target <name>")
    .option("--ref <ref>", "application ref", "main")
    .option("--commit <sha>")
    .option("--certbot-staging")
    .action(async (options: { target: string; ref: string; commit?: string; certbotStaging?: boolean }, command: Command) => {
      const manifest = await manifestFor(command);
      const validation = await validateProject(manifest, { manifestPath: globals(command).manifest });
      if (!validation.valid) throw new DeployKitError("DK_VALIDATION_FAILED", "Cannot plan an invalid project", { details: validation.issues });
      requireTarget(manifest, options.target);
      validateApplicationRef(options.ref);
      if (options.commit) validateCommitSha(options.commit);
      reporter(command).result("DK_PLAN", createDeploymentPlan(manifest, options.target, {
        sourceRef: options.ref,
        commitSha: options.commit,
        certbotStaging: options.certbotStaging
      }));
    });

  program.command("advise")
    .description("request a local-only, validated manifest proposal")
    .addOption(new Option("--provider <provider>", "advisor provider").choices(["openai", "anthropic"]).makeOptionMandatory())
    .requiredOption("--model <model>")
    .requiredOption("--file <paths...>", "explicitly approved repository files")
    .option("--write", "write the validated candidate after confirmation")
    .option("--yes", "confirm --write non-interactively")
    .action(async (options: { provider: string; model: string; file: string[]; write?: boolean; yes?: boolean }, command: Command) => {
      const manifest = await manifestFor(command);
      const secretValues = localAdvisorSecretValues(manifest);
      const files = await loadApprovedAdvisorFiles({
        cwd: process.cwd(),
        requestedPaths: options.file,
        approvedPaths: options.file,
        secretValues
      });
      const provider = options.provider === "openai"
        ? new OpenAIAdvisorProvider({ apiKey: process.env.OPENAI_API_KEY, model: options.model })
        : options.provider === "anthropic"
          ? new AnthropicAdvisorProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: options.model })
          : undefined;
      if (!provider) throw new DeployKitError("DK_USAGE", "--provider must be openai or anthropic");
      const result = await requestManifestAdvice({
        manifest,
        files,
        approvedPaths: options.file,
        provider,
        validate: validateAdvisorCandidate,
        secretValues
      });
      const out = reporter(command);
      out.result("DK_ADVISOR_PROPOSAL", globals(command).json ? result : `${result.diff}\n\nRationale: ${result.proposal.rationale}${result.proposal.warnings.length ? `\nWarnings: ${result.proposal.warnings.join("; ")}` : ""}`);
      if (options.write) {
        const accepted = options.yes || await confirm("Write this validated manifest proposal?", false);
        if (!accepted) throw new DeployKitError("DK_USAGE", "Advisor proposal was not written");
        await atomicWriteFile(resolve(globals(command).manifest), stringifyManifest(result.candidate), 0o644);
        out.info("DK_ADVISOR_WRITTEN", `Updated ${globals(command).manifest}`);
      }
    });

  const server = program.command("server").description("manage or execute the deterministic server runtime");
  server.command("bootstrap")
    .description("idempotently enroll an Ubuntu VPS over SSH")
    .requiredOption("--host <ssh-target>")
    .requiredOption("--repo <owner/name>")
    .requiredOption("--label <server-label>")
    .option("--configure-firewall")
    .option("--accept-root-runner-risk")
    .option("--accept-host-key")
    .option("--dry-run")
    .action(async (options: { host: string; repo: string; label: string; configureFirewall?: boolean; acceptRootRunnerRisk?: boolean; acceptHostKey?: boolean; dryRun?: boolean }, command: Command) => {
      let acceptHostKey = Boolean(options.acceptHostKey);
      if (!options.dryRun && !acceptHostKey && process.stdin.isTTY) {
        const fingerprint = await readSshFingerprint(options.host);
        acceptHostKey = await confirm(`Trust SSH host key ${fingerprint}?`, false);
      }
      const result = await bootstrapServer({
        host: options.host,
        repository: options.repo,
        label: options.label,
        configureFirewall: options.configureFirewall,
        acceptRootRunnerRisk: Boolean(options.acceptRootRunnerRisk),
        acceptHostKey,
        dryRun: options.dryRun
      });
      reporter(command).result("DK_BOOTSTRAP", result);
    });

  server.command("apply")
    .description("internal: apply a deployment on the enrolled runner")
    .requiredOption("--target <name>")
    .requiredOption("--commit <sha>")
    .option("--source <directory>", "checked-out source", process.cwd())
    .option("--resume")
    .option("--dry-run")
    .action(async (options: { target: string; commit: string; source: string; resume?: boolean; dryRun?: boolean }, command: Command) => {
      validateCommitSha(options.commit);
      const result = await runServerApply({
        manifestPath: globals(command).manifest,
        target: options.target,
        commit: options.commit,
        source: options.source,
        resume: Boolean(options.resume),
        dryRun: Boolean(options.dryRun)
      });
      reporter(command).result("DK_SERVER_APPLY", result);
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
      const result = await store.writeFromStdin(Buffer.concat(chunks).toString("utf8"), true);
      process.stdout.write(`${JSON.stringify(result)}\n`);
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
  server.command("target-logs").requiredOption("--target-id <id>").option("--tail <lines>", "line count", integerOption("tail", 1, 10_000), 200).action(async (options: { targetId: string; tail: number }) => {
    const paths = serverPaths(options.targetId);
    const secretRedactor = await new SecretsStore({ file: paths.secretsFile, requirements: { required: [], generated: [] } }).redactor();
    const logs = await readServerTargetLogs(options.targetId, options.tail);
    process.stdout.write(`${JSON.stringify(secretRedactor.redact(logs))}\n`);
  });

  const secrets = program.command("secrets").description("manage per-target server secrets");
  secrets.command("set").description("transfer target secrets over SSH stdin").requiredOption("--target <name>").option("--file <path>").action(async (options: { target: string; file?: string }, command: Command) => {
    reporter(command).result("DK_SECRETS_SET", await setRemoteSecrets(await manifestFor(command), options.target, { file: options.file }));
  });
  secrets.command("check").description("check that all target secrets are present").requiredOption("--target <name>").action(async (options: { target: string }, command: Command) => {
    const result = await checkRemoteSecrets(await manifestFor(command), options.target) as { valid?: boolean };
    if (!result.valid) throw new DeployKitError("DK_SECRET_MISSING", "Target secrets are incomplete", { details: result });
    reporter(command).result("DK_SECRETS_OK", result);
  });

  const dispatchLegacy = async (
    options: { target: string; ref: string; repo?: string; dryRun?: boolean },
    command: Command,
    resume: boolean,
  ): Promise<void> => {
    const manifest = await manifestFor(command);
    requireTarget(manifest, options.target);
    const validation = await validateProject(manifest, { manifestPath: globals(command).manifest });
    if (!validation.valid) {
      throw new DeployKitError("DK_VALIDATION_FAILED", "Cannot dispatch an invalid project", { details: validation.issues });
    }
    validateApplicationRef(options.ref);
    const repository = options.repo ?? await inferGitHubRepository();
    const result = await dispatchDeployment({ repository, target: options.target, applicationRef: options.ref, resume, dryRun: options.dryRun });
    reporter(command).result(resume ? "DK_RETRY_DISPATCHED" : "DK_DEPLOY_DISPATCHED", result);
  };

  program.command("deploy")
    .description("deploy from deploykit.config.yaml")
    .option("--target <name>", "legacy deploykit.yaml target")
    .option("--ref <branch>", "legacy application branch")
    .option("--repo <owner/name>", "legacy GitHub repository")
    .option("--dry-run", "legacy workflow dry run")
    .action(async (options: { target?: string; ref?: string; repo?: string; dryRun?: boolean }, command: Command) => {
      const legacyRequested = options.target !== undefined || options.ref !== undefined ||
        options.repo !== undefined || options.dryRun === true;
      if (!legacyRequested) {
        const out = reporter(command);
        const loaded = await loadOperatorDeployment(out);
        // Phases 3-13 own compilation, GitHub setup, the gateway, and dispatch.
        // Until they land, a valid config is reported and nothing is mutated.
        out.info("DK_CONFIG_OK", `Validated ${loaded.location.configPath} for target '${loaded.config.target.name}'`, {
          project: loaded.config.project.name,
          repository: loaded.config.project.repository,
          ref: loaded.config.project.ref,
          target: loaded.config.target.name,
          primaryDomain: loaded.config.target.primaryDomain,
          services: Object.keys(loaded.config.services).sort(),
          declaredSecretNames: loaded.environment.declaredSecretNames,
        });
        throw new DeployKitError(
          "DK_UNSUPPORTED",
          "This build validates deploykit.config.yaml, but the one-command deployment orchestrator is not implemented yet. The legacy --target/--ref path remains available only for already initialized v0.1 projects.",
        );
      }
      if (options.target === undefined || options.ref === undefined) {
        throw new DeployKitError(
          "DK_USAGE",
          "Legacy deployment requires both --target <name> and --ref <branch>",
        );
      }
      await dispatchLegacy({ ...options, target: options.target, ref: options.ref }, command, false);
    });

  program.command("retry")
    .description("resume a failed legacy first deployment")
    .requiredOption("--target <name>")
    .requiredOption("--ref <branch>")
    .option("--repo <owner/name>")
    .option("--dry-run")
    .action(async (options: { target: string; ref: string; repo?: string; dryRun?: boolean }, command: Command) => {
      await dispatchLegacy(options, command, true);
    });

  const inspectRemote = async (kind: "status" | "logs", targetName: string, manifest: ProjectManifest, tail?: number): Promise<unknown> => {
    const target = requireTarget(manifest, targetName);
    const enrolled = await requireServer(target.runnerLabel);
    const targetId = makeTargetId(manifest.metadata.name, targetName);
    const result = await runRemoteDeployKit(enrolled.host, ["server", kind === "status" ? "target-status" : "target-logs", "--target-id", targetId, ...(kind === "logs" ? ["--tail", String(tail ?? 200)] : [])], { hostKey: enrolled.hostKey });
    return JSON.parse(result.stdout) as unknown;
  };
  program.command("status").description("inspect deployment state on the target server").requiredOption("--target <name>").action(async (options: { target: string }, command: Command) => {
    reporter(command).result("DK_STATUS", await inspectRemote("status", options.target, await manifestFor(command)));
  });
  program.command("logs").description("read redacted deployment logs from the target server").requiredOption("--target <name>").option("--tail <lines>", "line count", integerOption("tail", 1, 10_000), 200).action(async (options: { target: string; tail: number }, command: Command) => {
    reporter(command).result("DK_LOGS", await inspectRemote("logs", options.target, await manifestFor(command), options.tail));
  });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = configureProgram();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return;
      throw new DeployKitError("DK_USAGE", error.message.replace(/^error:\s*/u, ""), {
        cause: error,
        details: { commanderCode: error.code }
      });
    }
    throw error;
  }
}

export async function runCli(argv = process.argv, stderr: NodeJS.WritableStream = process.stderr): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (error) {
    const flags = argv.slice(2);
    const rendered = renderCliError(error, {
      json: flags.includes("--json"),
      verbose: flags.includes("--verbose")
    });
    stderr.write(rendered.output);
    return rendered.exitCode;
  }
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const moduleUrl: string | undefined = import.meta.url;
  // The standalone VPS bundle is CommonJS and invokes runCli explicitly.
  if (!moduleUrl) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return resolve(entry) === resolve(fileURLToPath(moduleUrl));
  }
}

if (isDirectInvocation()) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
