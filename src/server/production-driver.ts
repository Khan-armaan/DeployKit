import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  generateComposeOverride,
  generateNginxConfig,
  generatePm2Ecosystem,
} from "../generators/index.js";
import type {
  ComposeDatabase,
  HealthCheck,
  Pm2Service,
  ProjectManifest,
  StaticFrontend,
} from "../manifest.js";
import { parsePackageManagerDeclaration } from "../package-manager.js";
import { PM2_VERSION } from "../version.js";
import type { ApplyContext, DeploymentDriver } from "./apply.js";
import { atomicWriteFile } from "./atomic.js";
import type { CommandResult, CommandRunner, CommandSpec } from "./command.js";
import { ServerError } from "./errors.js";
import type { HealthClient } from "./health.js";
import { FetchHealthClient } from "./health.js";
import { ReleaseManager } from "./release.js";
import {
  SecretsStore,
  secretRequirementsFromManifest,
  serializeSecretsEnv,
  type SecretValues,
} from "./secrets.js";
import {
  NodeToolchainManager,
  defaultInstallArgv,
  packageScriptArgv,
  withToolchainExecutable,
  type NodePackageManager,
  type NodeToolchain,
  type NodeToolchainProvider,
} from "./toolchains.js";

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CERTBOT_EMAIL_SECRET = "CERTBOT_EMAIL";
const COMPOSE_DATABASE_URL_ENV = "DEPLOYKIT_COMPOSE_DATABASE_URL";
export const DEFAULT_PM2_RUNTIME_EXECUTABLE = `/opt/deploykit/pm2/${PM2_VERSION}/node_modules/.bin/pm2-runtime`;

type SupportedPackageManager = NodePackageManager;
type Sleep = (milliseconds: number) => Promise<void>;

interface DatabaseRuntime {
  readonly internalPort?: number;
  readonly composeOverrideEnvironment: Readonly<Record<string, string>>;
  readonly composeProcessEnvironment: Readonly<Record<string, string>>;
  readonly pm2Environment: Readonly<Record<string, string>>;
  readonly pm2SecretEnvironment: Readonly<Record<string, string>>;
}

interface PreparedNodeWorkload {
  readonly service: Pm2Service | StaticFrontend;
  readonly toolchain: NodeToolchain;
  readonly packageManagerExecutable: string;
}

export interface ProductionDeploymentDriverOptions {
  readonly runner: CommandRunner;
  /** Optional resolved snapshot supplied by the server CLI. Values still persist only in secrets.env. */
  readonly secrets?: SecretValues;
  readonly toolchains?: NodeToolchainProvider;
  readonly healthClient?: HealthClient;
  readonly sleep?: Sleep;
  readonly dryRun?: boolean;
  readonly pm2RuntimeExecutable?: string;
  readonly systemdUnitDirectory?: string;
  readonly certbotEmailSecret?: string;
  readonly certbotStaging?: boolean;
  /** Compatibility escape hatch for manifests created before database.internalPort existed. */
  readonly databaseInternalPort?: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function safeRelativeWorkingDirectory(release: string, workingDirectory: string): string {
  const directory = resolve(release, workingDirectory);
  const prefix = release.endsWith("/") ? release : `${release}/`;
  if (directory !== release && !directory.startsWith(prefix)) {
    throw new ServerError("SERVER_STATE_INVALID", "workload directory escapes the staged release", {
      release,
      workingDirectory,
    });
  }
  return directory;
}

export function deploymentUnixUser(targetId: string): string {
  const digest = createHash("sha256").update(targetId).digest("hex").slice(0, 8);
  const readable = targetId.replace(/[^a-z0-9-]/g, "-").slice(0, 20).replace(/-+$/g, "") || "app";
  return `dk-${readable}-${digest}`;
}

function portsByService(context: ApplyContext): Record<string, number> {
  const result: Record<string, number> = {};
  for (const reservation of context.resources.ports) result[reservation.service] = reservation.port;
  return result;
}

function composePrefix(context: ApplyContext): string[] {
  const files = context.manifest.compose?.files;
  if (files === undefined) {
    throw new ServerError("SERVER_STATE_INVALID", "Compose files are required for this operation");
  }
  return [
    "compose",
    ...files.flatMap((file) => ["--file", file]),
    "--file", ".deploykit/compose.override.yaml",
    "--project-name", context.plan.targetId,
  ];
}

function cleanEnvironment(values: Readonly<Record<string, string>>): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) environment[name] = undefined;
  return { ...environment, ...values };
}

function userEnvironment(
  user: string,
  home: string,
  path: string,
  values: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return cleanEnvironment({
    HOME: home,
    USER: user,
    LOGNAME: user,
    PATH: path,
    NODE_ENV: "production",
    CI: "true",
    ...values,
  });
}

function databaseConsumers(
  manifest: ProjectManifest,
  database: ComposeDatabase,
): { readonly compose: string[]; readonly pm2: string[] } {
  const compose: string[] = [];
  const pm2: string[] = [];
  for (const consumer of database.consumers) {
    const service = manifest.services[consumer];
    if (service?.type === "compose") compose.push(consumer);
    if (service?.type === "pm2") pm2.push(consumer);
  }
  return { compose, pm2 };
}

function defaultConnectionStringTemplate(port: number): string | undefined {
  switch (port) {
    case 5432: return "postgresql://{username}:{password}@{host}:{port}/{database}";
    case 3306: return "mysql://{username}:{password}@{host}:{port}/{database}";
    case 27017: return "mongodb://{username}:{password}@{host}:{port}/{database}";
    default: return undefined;
  }
}

function renderConnectionString(
  template: string,
  values: Readonly<Record<"username" | "password" | "host" | "port" | "database", string>>,
): string {
  const required = ["username", "password", "host", "port", "database"] as const;
  for (const placeholder of required) {
    if (!template.includes(`{${placeholder}}`)) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        `database connectionStringTemplate must contain {${placeholder}}`,
      );
    }
  }
  const rendered = required.reduce(
    (output, key) => output.split(`{${key}}`).join(encodeURIComponent(values[key])),
    template,
  );
  if (/\{[A-Za-z0-9_]+\}/.test(rendered)) {
    throw new ServerError("SERVER_STATE_INVALID", "database connectionStringTemplate has an unknown placeholder");
  }
  return rendered;
}

async function tcpReady(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ready);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function isOwnedEnabledLink(target: string, available: string): boolean {
  return resolve(dirname(target), available) === resolve(available);
}

function managedNginxMarker(targetId: string): string {
  return `# deploykit-target: ${targetId}`;
}

function acmeOnlyNginxConfig(targetId: string, domains: readonly string[], webroot: string): string {
  return [
    managedNginxMarker(targetId),
    "# Managed by DeployKit. Temporary ACME-only configuration.",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${domains.join(" ")};`,
    "",
    "    location ^~ /.well-known/acme-challenge/ {",
    `        root ${webroot};`,
    "        default_type text/plain;",
    "    }",
    "",
    "    location / { return 503; }",
    "}",
    "",
  ].join("\n");
}

/** Concrete, deterministic implementation of every DeploymentApplier phase. */
export class ProductionDeploymentDriver implements DeploymentDriver {
  private readonly runner: CommandRunner;
  private readonly toolchains: NodeToolchainProvider;
  private readonly healthClient: HealthClient;
  private readonly sleep: Sleep;
  private readonly dryRun: boolean;
  private readonly pm2RuntimeExecutable: string;
  private readonly systemdUnitDirectory: string;
  private readonly certbotEmailSecret: string;
  private readonly certbotStaging: boolean;
  private readonly databaseInternalPort?: number;
  private readonly providedSecrets: SecretValues;
  private readonly activatedProxyTargets = new Set<string>();

  constructor(options: ProductionDeploymentDriverOptions) {
    this.runner = options.runner;
    this.toolchains = options.toolchains ?? new NodeToolchainManager({ runner: options.runner });
    this.healthClient = options.healthClient ?? new FetchHealthClient();
    this.sleep = options.sleep ?? defaultSleep;
    this.dryRun = options.dryRun ?? false;
    this.pm2RuntimeExecutable = options.pm2RuntimeExecutable ?? DEFAULT_PM2_RUNTIME_EXECUTABLE;
    this.systemdUnitDirectory = (options.systemdUnitDirectory ?? "/etc/systemd/system").replace(/\/$/, "");
    if (
      !/^\/[A-Za-z0-9._/-]+$/.test(this.pm2RuntimeExecutable) ||
      !/^\/[A-Za-z0-9._/-]+$/.test(this.systemdUnitDirectory) ||
      this.pm2RuntimeExecutable.includes("..") ||
      this.systemdUnitDirectory.includes("..")
    ) {
      throw new ServerError("SERVER_STATE_INVALID", "PM2/systemd paths must be safe absolute paths");
    }
    this.certbotEmailSecret = options.certbotEmailSecret ?? CERTBOT_EMAIL_SECRET;
    this.certbotStaging = options.certbotStaging ?? false;
    this.databaseInternalPort = options.databaseInternalPort;
    this.providedSecrets = options.secrets ?? {};
  }

  async stageSource(context: ApplyContext): Promise<void> {
    const user = deploymentUnixUser(context.plan.targetId);
    const home = this.applicationHome(context);
    const exists = await this.runner.run({ command: "id", args: ["--user", user], allowFailure: true });
    if (exists.dryRun || exists.exitCode !== 0) {
      await this.runner.run({
        command: "useradd",
        args: [
          "--system", "--user-group", "--create-home",
          "--home-dir", home,
          "--shell", "/usr/sbin/nologin",
          user,
        ],
      });
    }
    await this.runner.run({
      command: "install",
      args: ["--directory", "--owner", user, "--group", user, "--mode", "0750", home, context.plan.paths.logsDirectory],
    });
    if (!this.dryRun) {
      const staged = await new ReleaseManager(context.plan.paths).stage(
        context.sourceDirectory,
        context.plan.commitSha,
      );
      if (staged.directory !== this.releaseDirectory(context)) {
        throw new ServerError("SERVER_STATE_INVALID", "release manager returned an unexpected path");
      }
    }
    await this.runner.run({
      command: "chown",
      args: ["--recursive", `${user}:${user}`, this.releaseDirectory(context)],
    });
    await this.runner.run({ command: "chmod", args: ["0755", this.releaseDirectory(context)] });
  }

  async startWorkloads(context: ApplyContext): Promise<void> {
    const release = this.releaseDirectory(context);
    const generatedDirectory = join(release, ".deploykit");
    if (!this.dryRun) await mkdir(generatedDirectory, { recursive: true, mode: 0o755 });
    const secrets = await this.ensureSecrets(context);
    const database = await this.prepareDatabaseRuntime(context, secrets);
    const resolvedSecrets = {
      ...secrets,
      ...await this.readSecrets(context),
      ...database.pm2SecretEnvironment,
    };
    const prepared = new Map<string, PreparedNodeWorkload>();

    for (const [name, service] of Object.entries(context.manifest.services)) {
      if (service.type === "pm2") prepared.set(name, await this.prepareNodeWorkload(context, service));
    }
    if (context.manifest.frontend?.type === "static") {
      prepared.set("frontend:static", await this.prepareNodeWorkload(context, context.manifest.frontend));
    }

    for (const [name, service] of Object.entries(context.manifest.services)) {
      if (service.type !== "pm2") continue;
      const node = prepared.get(name);
      if (node === undefined) throw new ServerError("SERVER_STATE_INVALID", `Node.js toolchain missing for ${name}`);
      await this.installAndBuildNodeWorkload(context, service, node);
    }

    if (context.manifest.frontend?.type === "static") {
      const frontend = context.manifest.frontend;
      const node = prepared.get("frontend:static");
      if (node === undefined) throw new ServerError("SERVER_STATE_INVALID", "static frontend toolchain is missing");
      await this.installAndBuildNodeWorkload(context, frontend, node, {
        ...frontend.publicEnvironment,
        ...context.manifest.targets[context.plan.targetName]?.publicOverrides,
      });
      await this.copyStaticBuild(context, frontend);
    }

    const ports = portsByService(context);
    if (context.manifest.compose !== undefined) {
      const override = generateComposeOverride(context.manifest, {
        target: context.plan.targetName,
        ports,
        envFile: context.plan.paths.secretsFile,
        environment: database.composeOverrideEnvironment,
        databaseInternalPort: database.internalPort,
      });
      if (!this.dryRun) {
        await atomicWriteFile(join(generatedDirectory, "compose.override.yaml"), override, { mode: 0o644 });
      }
      await this.runCompose(
        context,
        ["up", "--detach", "--build", "--wait", "--wait-timeout", "120"],
        { ...resolvedSecrets, ...database.composeProcessEnvironment },
      );
    }

    const pm2Entries = [...prepared.entries()].filter(([name]) => name !== "frontend:static");
    if (pm2Entries.length > 0) {
      const ecosystem = generatePm2Ecosystem(context.manifest, {
        target: context.plan.targetName,
        releaseDirectory: release,
        ports,
        logDirectory: context.plan.paths.logsDirectory,
        environment: database.pm2Environment,
        nodeInstallRoot: this.toolchains.installRoot,
      });
      const ecosystemFile = join(generatedDirectory, "ecosystem.cjs");
      if (!this.dryRun) await atomicWriteFile(ecosystemFile, ecosystem, { mode: 0o644 });
      const primary = pm2Entries[0]?.[1].toolchain;
      if (primary === undefined) throw new ServerError("SERVER_STATE_INVALID", "PM2 has no Node.js toolchain");
      const unit = this.pm2SystemdUnit(context, ecosystemFile, primary);
      const unitFile = this.pm2SystemdUnitFile(context);
      if (!this.dryRun) await atomicWriteFile(unitFile, unit, { mode: 0o644 });
      await this.runner.run({ command: "systemctl", args: ["daemon-reload"] });
      await this.runner.run({
        command: "systemctl",
        args: ["enable", "--now", this.pm2SystemdUnitName(context)],
        timeoutMs: 180_000,
      });
    }
  }

  async runMigrations(context: ApplyContext): Promise<void> {
    if (context.manifest.database?.type !== "compose") return;
    const secrets = await this.readSecrets(context);
    const database = await this.prepareDatabaseRuntime(context, secrets);
    const resolvedSecrets = {
      ...secrets,
      ...await this.readSecrets(context),
      ...database.pm2SecretEnvironment,
    };
    for (const hook of [context.manifest.database.migrations, context.manifest.database.seed]) {
      if (hook === undefined) continue;
      const service = context.manifest.services[hook.service];
      if (service?.type === "pm2") {
        const prepared = await this.prepareNodeWorkload(context, service);
        const cwd = safeRelativeWorkingDirectory(this.releaseDirectory(context), service.workingDirectory);
        const resolved = this.resolveNodeArgv(hook.command, service.packageManager, prepared);
        await this.runAsApplication(context, {
          ...resolved,
          cwd,
          env: {
            ...resolvedSecrets,
            ...database.pm2Environment,
            ...database.pm2SecretEnvironment,
            COREPACK_HOME: `${prepared.toolchain.directory}/corepack`,
            PATH: `${cwd}/node_modules/.bin:${prepared.toolchain.binDirectory}:${SYSTEM_PATH}`,
          },
          timeoutMs: 900_000,
        });
      } else {
        const composeService = service?.type === "compose"
          ? service.service
          : hook.service === context.manifest.database.service
            ? hook.service
            : undefined;
        if (composeService === undefined) {
          throw new ServerError("SERVER_STATE_INVALID", `database hook references unknown service ${hook.service}`);
        }
        await this.runCompose(
          context,
          ["exec", "--no-TTY", composeService, ...hook.command],
          { ...resolvedSecrets, ...database.composeProcessEnvironment },
          900_000,
        );
      }
    }
  }

  async verifyHealth(context: ApplyContext): Promise<void> {
    const secrets = await this.readSecrets(context);
    const database = await this.prepareDatabaseRuntime(context, secrets);
    const resolvedSecrets = {
      ...secrets,
      ...await this.readSecrets(context),
      ...database.pm2SecretEnvironment,
    };
    for (const [name, service] of Object.entries(context.manifest.services)) {
      const health = service.healthCheck;
      if (health.startPeriodSeconds > 0 && !this.dryRun) {
        await this.sleep(health.startPeriodSeconds * 1_000);
      }
      if (health.type === "http") {
        if (this.dryRun) continue;
        const port = this.healthPort(context, name, health.port);
        await this.pollCheck(name, health, async () => {
          try {
            const response = await this.healthClient.get(
              `http://127.0.0.1:${port}${health.path}`,
              health.timeoutSeconds * 1_000,
            );
            return health.expectedStatuses.includes(response.status);
          } catch {
            return false;
          }
        });
      } else if (health.type === "tcp") {
        if (this.dryRun) continue;
        const port = this.healthPort(context, name, health.port);
        await this.pollCheck(name, health, () => tcpReady("127.0.0.1", port, health.timeoutSeconds * 1_000));
      } else if (health.type === "command") {
        await this.pollCheck(name, health, async () => {
          let result: CommandResult;
          if (service.type === "compose") {
            result = await this.runCompose(
              context,
              ["exec", "--no-TTY", service.service, ...health.command],
              { ...resolvedSecrets, ...database.composeProcessEnvironment },
              health.timeoutSeconds * 1_000,
              true,
            );
          } else {
            const prepared = await this.prepareNodeWorkload(context, service);
            const cwd = safeRelativeWorkingDirectory(this.releaseDirectory(context), service.workingDirectory);
            const resolved = this.resolveNodeArgv(health.command, service.packageManager, prepared);
            result = await this.runAsApplication(context, {
              ...resolved,
              cwd,
              env: {
                ...resolvedSecrets,
                ...database.pm2Environment,
                ...database.pm2SecretEnvironment,
                COREPACK_HOME: `${prepared.toolchain.directory}/corepack`,
                PATH: `${cwd}/node_modules/.bin:${prepared.toolchain.binDirectory}:${SYSTEM_PATH}`,
              },
              timeoutMs: health.timeoutSeconds * 1_000,
              allowFailure: true,
            });
          }
          return result.exitCode === 0;
        });
      } else {
        if (service.type !== "pm2") {
          throw new ServerError("SERVER_STATE_INVALID", `process health is invalid for Compose service ${name}`);
        }
        await this.pollCheck(name, health, async () => {
          const result = await this.runner.run({
            command: "systemctl",
            args: ["is-active", "--quiet", this.pm2SystemdUnitName(context)],
            timeoutMs: health.timeoutSeconds * 1_000,
            allowFailure: true,
          });
          return result.exitCode === 0;
        });
      }
    }
  }

  async stageProxy(context: ApplyContext): Promise<void> {
    await this.ensureAcmeSite(context);
  }

  async issueTls(context: ApplyContext): Promise<void> {
    // A failed TLS attempt disables the link while proxy-staged remains a durable
    // checkpoint. Reconcile it here so retry always has a reachable webroot.
    await this.ensureAcmeSite(context);
    const secrets = await this.readSecrets(context);
    const email = secrets[this.certbotEmailSecret];
    if (email === undefined || email.trim() === "") {
      throw new ServerError(
        "SERVER_SECRET_MISSING",
        `TLS issuance requires ${this.certbotEmailSecret} in ${context.plan.paths.secretsFile}`,
        { missing: [this.certbotEmailSecret] },
      );
    }
    const target = context.manifest.targets[context.plan.targetName];
    if (target === undefined) throw new ServerError("SERVER_STATE_INVALID", "deployment target disappeared");
    await this.runner.run({
      command: "certbot",
      args: [
        "--config", "/dev/stdin",
        "certonly", "--webroot", "--webroot-path", context.plan.paths.acmeWebroot,
        "--non-interactive", "--agree-tos", "--keep-until-expiring",
        "--cert-name", target.primaryDomain,
        ...(this.certbotStaging ? ["--staging"] : []),
        ...context.plan.domains.flatMap((domain) => ["--domain", domain]),
      ],
      env: cleanEnvironment({ PATH: SYSTEM_PATH, HOME: "/root" }),
      stdin: `email = ${email}\n`,
      timeoutMs: 600_000,
    });
    const renewalDropIn = join(this.systemdUnitDirectory, "certbot.service.d", "deploykit-nginx.conf");
    if (!this.dryRun) {
      await atomicWriteFile(renewalDropIn, [
        "# Generated by DeployKit. Validate before certificate reload.",
        "[Service]",
        "ExecStartPost=/usr/sbin/nginx -t",
        "ExecStartPost=/usr/bin/systemctl reload nginx",
        "",
      ].join("\n"), { mode: 0o644 });
    }
    await this.runner.run({ command: "systemctl", args: ["daemon-reload"] });
    await this.runner.run({ command: "systemctl", args: ["enable", "--now", "certbot.timer"] });
  }

  async activate(context: ApplyContext): Promise<void> {
    if (!this.dryRun) await new ReleaseManager(context.plan.paths).activate(context.plan.commitSha);
    const config = `${managedNginxMarker(context.plan.targetId)}\n${generateNginxConfig(context.manifest, {
      target: context.plan.targetName,
      ports: portsByService(context),
      staticRoot: context.manifest.frontend?.type === "static"
        ? join(context.plan.paths.currentReleaseLink, "static")
        : undefined,
      acmeWebroot: context.plan.paths.acmeWebroot,
      tls: {},
    })}`;
    if (!this.dryRun) {
      await this.assertManagedAvailableFile(context);
      await this.assertNoNginxCollision(context);
      await atomicWriteFile(context.plan.paths.nginxAvailableFile, config, { mode: 0o644 });
      await this.activateManagedNginxLink(context);
    }
    await this.runner.run({ command: "nginx", args: ["-t"] });
    await this.runner.run({ command: "systemctl", args: ["reload", "nginx"] });
  }

  async disableNewProxyAfterFailure(context: ApplyContext): Promise<void> {
    if (this.dryRun) return;
    if (!this.activatedProxyTargets.has(context.plan.targetId)) return;
    let owned = false;
    try {
      const stats = await lstat(context.plan.paths.nginxEnabledLink);
      if (!stats.isSymbolicLink()) return;
      const target = await readlink(context.plan.paths.nginxEnabledLink);
      owned = isOwnedEnabledLink(target, context.plan.paths.nginxAvailableFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!owned) return;
    await rm(context.plan.paths.nginxEnabledLink, { force: true });
    this.activatedProxyTargets.delete(context.plan.targetId);
    await this.runner.run({ command: "nginx", args: ["-t"] });
    await this.runner.run({ command: "systemctl", args: ["reload", "nginx"] });
  }

  private releaseDirectory(context: ApplyContext): string {
    return context.plan.paths.releaseDirectory(context.plan.commitSha);
  }

  private applicationHome(context: ApplyContext): string {
    return join(dirname(context.plan.paths.deploymentStateFile), "home");
  }

  private async ensureSecrets(context: ApplyContext): Promise<Record<string, string>> {
    const store = new SecretsStore({
      file: context.plan.paths.secretsFile,
      requirements: secretRequirementsFromManifest(context.manifest),
    });
    if (this.dryRun) {
      const values = { ...await store.read(), ...this.providedSecrets };
      const requirements = secretRequirementsFromManifest(context.manifest);
      const missing = [...requirements.required, ...(requirements.generated ?? [])]
        .filter((name) => values[name] === undefined || values[name] === "");
      if (missing.length > 0) {
        throw new ServerError("SERVER_SECRET_MISSING", `missing required secrets: ${missing.join(", ")}`);
      }
      return values;
    }
    await store.writeFromStdin(serializeSecretsEnv(this.providedSecrets), true);
    return await store.read();
  }

  private async readSecrets(context: ApplyContext): Promise<Record<string, string>> {
    const stored = await new SecretsStore({
      file: context.plan.paths.secretsFile,
      requirements: secretRequirementsFromManifest(context.manifest),
    }).read();
    return { ...this.providedSecrets, ...stored };
  }

  private async prepareNodeWorkload(
    context: ApplyContext,
    service: Pm2Service | StaticFrontend,
  ): Promise<PreparedNodeWorkload> {
    const toolchain = await this.toolchains.ensure(service.nodeVersion);
    const working = safeRelativeWorkingDirectory(this.releaseDirectory(context), service.workingDirectory);
    let packageManagerVersion: string | undefined;
    try {
      const packageJson = JSON.parse(await readFile(join(working, "package.json"), "utf8")) as { packageManager?: unknown };
      const declaration = parsePackageManagerDeclaration(packageJson.packageManager);
      if (packageJson.packageManager !== undefined && declaration === undefined) {
        throw new ServerError("SERVER_STATE_INVALID", `${service.workingDirectory}/package.json has an invalid packageManager declaration`);
      }
      if (declaration !== undefined && declaration.name !== service.packageManager) {
        throw new ServerError(
          "SERVER_STATE_INVALID",
          `${service.workingDirectory}/package.json pins ${declaration.name}, but the manifest selects ${service.packageManager}`,
        );
      }
      packageManagerVersion = declaration?.version;
    } catch (error) {
      if (error instanceof ServerError) throw error;
      throw new ServerError(
        "SERVER_STATE_INVALID",
        `Unable to read ${service.workingDirectory}/package.json for package-manager verification`,
        undefined,
        { cause: error },
      );
    }
    if (service.packageManager !== "npm" && packageManagerVersion === undefined) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        `${service.packageManager} requires an exact packageManager declaration in ${service.workingDirectory}/package.json`,
      );
    }
    const packageManagerExecutable = await this.toolchains.ensurePackageManager(
      toolchain,
      service.packageManager as SupportedPackageManager,
      packageManagerVersion,
    );
    return { service, toolchain, packageManagerExecutable };
  }

  private resolveNodeArgv(
    argv: readonly string[],
    packageManager: NodePackageManager,
    prepared: PreparedNodeWorkload,
  ): Pick<CommandSpec, "command" | "args"> {
    const resolved = withToolchainExecutable(
      argv,
      packageManager,
      prepared.packageManagerExecutable,
      prepared.toolchain,
    );
    return { command: resolved.command, args: resolved.args };
  }

  private async installAndBuildNodeWorkload(
    context: ApplyContext,
    service: Pm2Service | StaticFrontend,
    prepared: PreparedNodeWorkload,
    environment: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    const cwd = safeRelativeWorkingDirectory(this.releaseDirectory(context), service.workingDirectory);
    const install = service.installCommand ?? defaultInstallArgv(service.packageManager);
    const installSpec = this.resolveNodeArgv(install, service.packageManager, prepared);
    await this.runAsApplication(context, {
      ...installSpec,
      cwd,
      env: {
        ...environment,
        COREPACK_HOME: `${prepared.toolchain.directory}/corepack`,
        PATH: `${cwd}/node_modules/.bin:${prepared.toolchain.binDirectory}:${SYSTEM_PATH}`,
      },
      timeoutMs: 900_000,
    });
    const buildScript = service.type === "static" ? service.buildScript : service.buildScript;
    if (buildScript !== undefined) {
      const build = this.resolveNodeArgv(
        packageScriptArgv(service.packageManager, buildScript),
        service.packageManager,
        prepared,
      );
      await this.runAsApplication(context, {
        ...build,
        cwd,
        env: {
          ...environment,
          COREPACK_HOME: `${prepared.toolchain.directory}/corepack`,
          PATH: `${cwd}/node_modules/.bin:${prepared.toolchain.binDirectory}:${SYSTEM_PATH}`,
        },
        timeoutMs: 900_000,
      });
    }
  }

  private async copyStaticBuild(context: ApplyContext, frontend: StaticFrontend): Promise<void> {
    const release = this.releaseDirectory(context);
    const working = safeRelativeWorkingDirectory(release, frontend.workingDirectory);
    const source = safeRelativeWorkingDirectory(working, frontend.outputDirectory);
    const destination = join(release, "static");
    const staging = `${destination}.staging-${randomBytes(8).toString("hex")}`;
    try {
      await this.runner.run({ command: "mkdir", args: ["--parents", staging] });
      await this.runner.run({ command: "cp", args: ["--archive", `${source}/.`, staging] });
      await this.runner.run({ command: "rm", args: ["--recursive", "--force", "--one-file-system", destination] });
      await this.runner.run({ command: "mv", args: ["--no-target-directory", staging, destination] });
    } finally {
      await this.runner.run({
        command: "rm",
        args: ["--recursive", "--force", "--one-file-system", staging],
        allowFailure: true,
      }).catch(() => undefined);
    }
  }

  private async runAsApplication(context: ApplyContext, spec: CommandSpec): Promise<CommandResult> {
    const user = deploymentUnixUser(context.plan.targetId);
    const home = this.applicationHome(context);
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      if (value !== undefined) values[name] = value;
    }
    const path = values.PATH ?? SYSTEM_PATH;
    return await this.runner.run({
      command: "runuser",
      args: ["--user", user, "--group", user, "--preserve-environment", "--", spec.command, ...spec.args],
      cwd: spec.cwd,
      env: userEnvironment(user, home, path, values),
      stdin: spec.stdin,
      timeoutMs: spec.timeoutMs,
      allowFailure: spec.allowFailure,
    });
  }

  private async runCompose(
    context: ApplyContext,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
    timeoutMs = 600_000,
    allowFailure = false,
  ): Promise<CommandResult> {
    return await this.runner.run({
      command: "docker",
      args: [...composePrefix(context), ...args],
      cwd: this.releaseDirectory(context),
      env: cleanEnvironment({ PATH: SYSTEM_PATH, HOME: "/root", ...environment }),
      timeoutMs,
      allowFailure,
    });
  }

  private async prepareDatabaseRuntime(
    context: ApplyContext,
    secrets: SecretValues,
  ): Promise<DatabaseRuntime> {
    if (context.manifest.database?.type !== "compose") {
      return {
        composeOverrideEnvironment: {},
        composeProcessEnvironment: {},
        pm2Environment: {},
        pm2SecretEnvironment: {},
      };
    }
    const database = context.manifest.database;
    const consumers = databaseConsumers(context.manifest, database);
    const needsPm2Port = consumers.pm2.length > 0;
    const internalPort = database.internalPort ?? this.databaseInternalPort ?? await this.inferDatabaseInternalPort(context, database);
    if (needsPm2Port && internalPort === undefined) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        "a Compose database consumed by PM2 requires database.internalPort",
      );
    }
    const hostPort = portsByService(context)["database:compose"];
    if (needsPm2Port && hostPort === undefined) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        "the deployment planner did not reserve database:compose for the PM2 database consumer",
      );
    }
    const pm2Environment: Record<string, string> = internalPort === undefined ? {} : {
      DEPLOYKIT_DATABASE_HOST: needsPm2Port ? "127.0.0.1" : database.service,
      DEPLOYKIT_DATABASE_PORT: String(needsPm2Port ? hostPort : internalPort),
      DEPLOYKIT_DATABASE_USER: database.credentials.username,
      DEPLOYKIT_DATABASE_NAME: database.credentials.database,
    };

    const connectionSecret = database.credentials.connectionStringSecret;
    if (connectionSecret === undefined) {
      return {
        internalPort,
        composeOverrideEnvironment: {},
        composeProcessEnvironment: {},
        pm2Environment,
        pm2SecretEnvironment: {},
      };
    }
    const password = secrets[database.credentials.passwordSecret];
    if (password === undefined || password === "") {
      throw new ServerError("SERVER_SECRET_MISSING", `missing ${database.credentials.passwordSecret}`);
    }
    if (internalPort === undefined) {
      throw new ServerError("SERVER_STATE_INVALID", "database.internalPort is required to derive a connection string");
    }
    const template = database.credentials.connectionStringTemplate ?? defaultConnectionStringTemplate(internalPort);
    if (template === undefined) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        "database.connectionStringTemplate is required for this database port",
      );
    }
    const connection = (host: string, port: number): string => renderConnectionString(template, {
      username: database.credentials.username,
      password,
      host,
      port: String(port),
      database: database.credentials.database,
    });
    const composeUrl = connection(database.service, internalPort);
    const pm2Url = needsPm2Port ? connection("127.0.0.1", hostPort ?? 0) : composeUrl;
    if (!this.dryRun && secrets[connectionSecret] !== pm2Url) {
      const next = { ...secrets, [connectionSecret]: pm2Url };
      await atomicWriteFile(context.plan.paths.secretsFile, serializeSecretsEnv(next), { mode: 0o600 });
    }
    const mixed = needsPm2Port && consumers.compose.length > 0;
    return {
      internalPort,
      composeOverrideEnvironment: mixed
        ? { [connectionSecret]: `\${${COMPOSE_DATABASE_URL_ENV}}` }
        : {},
      composeProcessEnvironment: mixed ? { [COMPOSE_DATABASE_URL_ENV]: composeUrl } : {},
      pm2Environment,
      pm2SecretEnvironment: { [connectionSecret]: pm2Url },
    };
  }

  private async inferDatabaseInternalPort(
    context: ApplyContext,
    database: ComposeDatabase,
  ): Promise<number | undefined> {
    const declared = Object.values(context.manifest.services).find(
      (service) => service.type === "compose" && service.service === database.service,
    );
    if (declared?.type === "compose") return declared.internalPort;
    if (context.manifest.compose === undefined) return undefined;
    const files = context.manifest.compose.files.flatMap((file) => ["--file", file]);
    const result = await this.runner.run({
      command: "docker",
      args: ["compose", ...files, "config", "--format", "json", "--no-interpolate"],
      cwd: this.releaseDirectory(context),
      env: cleanEnvironment({ PATH: SYSTEM_PATH, HOME: "/root" }),
      timeoutMs: 120_000,
    });
    if (result.dryRun || result.stdout.trim() === "") return undefined;
    let config: { services?: Record<string, { expose?: Array<string | number>; ports?: Array<{ target?: number }> }> };
    try {
      config = JSON.parse(result.stdout) as typeof config;
    } catch (error) {
      throw new ServerError("SERVER_STATE_INVALID", "docker compose config returned invalid JSON", undefined, { cause: error });
    }
    const service = config.services?.[database.service];
    const candidates = new Set<number>();
    for (const value of service?.expose ?? []) {
      const port = Number(String(value).split("/")[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) candidates.add(port);
    }
    for (const value of service?.ports ?? []) {
      if (Number.isInteger(value.target) && (value.target ?? 0) > 0) candidates.add(value.target ?? 0);
    }
    return candidates.size === 1 ? [...candidates][0] : undefined;
  }

  private healthPort(context: ApplyContext, service: string, explicit?: number): number {
    const reserved = portsByService(context)[service];
    const port = reserved ?? explicit;
    if (port === undefined) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        `health check for ${service} is not reachable from the host; expose it through a reserved loopback port`,
      );
    }
    return port;
  }

  private async pollCheck(
    service: string,
    health: HealthCheck,
    attempt: () => Promise<boolean>,
  ): Promise<void> {
    for (let index = 0; index < health.retries; index += 1) {
      if (await attempt()) return;
      if (index + 1 < health.retries && !this.dryRun) await this.sleep(health.intervalSeconds * 1_000);
    }
    throw new ServerError(
      "SERVER_HEALTH_TIMEOUT",
      `health check for ${service} failed after ${health.retries} attempts`,
      { service, attempts: health.retries, type: health.type },
    );
  }

  private async assertNoNginxCollision(context: ApplyContext): Promise<void> {
    const result = await this.runner.run({ command: "nginx", args: ["-T"], timeoutMs: 60_000 });
    if (result.dryRun) return;
    const domains = new Set(context.plan.domains);
    const ownedFiles = new Set([
      resolve(context.plan.paths.nginxAvailableFile),
      resolve(context.plan.paths.nginxEnabledLink),
    ]);
    let currentFile = "";
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
      const header = /^# configuration file (.+):$/.exec(line.trim());
      if (header?.[1] !== undefined) {
        currentFile = resolve(header[1]);
        continue;
      }
      const serverName = /\bserver_name\s+([^;]+);/.exec(line);
      if (serverName?.[1] === undefined) continue;
      const collision = serverName[1].trim().split(/\s+/).find((name) => domains.has(name.toLowerCase()));
      if (collision !== undefined && !ownedFiles.has(currentFile)) {
        throw new ServerError(
          "SERVER_DOMAIN_COLLISION",
          `${collision} already appears in unmanaged Nginx configuration ${currentFile || "(unknown file)"}`,
          { domain: collision, file: currentFile },
        );
      }
    }
  }

  private async ensureAcmeSite(context: ApplyContext): Promise<void> {
    if (!this.dryRun) {
      await mkdir(context.plan.paths.acmeWebroot, { recursive: true, mode: 0o755 });
      await this.assertManagedAvailableFile(context);
      await this.assertNoNginxCollision(context);
      await atomicWriteFile(
        context.plan.paths.nginxAvailableFile,
        acmeOnlyNginxConfig(context.plan.targetId, context.plan.domains, context.plan.paths.acmeWebroot),
        { mode: 0o644 },
      );
      await this.activateManagedNginxLink(context);
    }
    await this.runner.run({ command: "nginx", args: ["-t"] });
    await this.runner.run({ command: "systemctl", args: ["reload", "nginx"] });
  }

  private async activateManagedNginxLink(context: ApplyContext): Promise<void> {
    const enabled = context.plan.paths.nginxEnabledLink;
    try {
      const stats = await lstat(enabled);
      if (!stats.isSymbolicLink()) {
        throw new ServerError("SERVER_DOMAIN_COLLISION", `${enabled} exists and is not a managed symlink`);
      }
      const target = await readlink(enabled);
      if (!isOwnedEnabledLink(target, context.plan.paths.nginxAvailableFile)) {
        throw new ServerError("SERVER_DOMAIN_COLLISION", `${enabled} points to an unmanaged Nginx file`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(enabled), { recursive: true });
    const temporary = `${enabled}.staging-${randomBytes(8).toString("hex")}`;
    try {
      await symlink(context.plan.paths.nginxAvailableFile, temporary);
      await rename(temporary, enabled);
      this.activatedProxyTargets.add(context.plan.targetId);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private pm2SystemdUnitName(context: ApplyContext): string {
    return `deploykit-${context.plan.targetId}.service`;
  }

  private pm2SystemdUnitFile(context: ApplyContext): string {
    return join(this.systemdUnitDirectory, this.pm2SystemdUnitName(context));
  }

  private pm2SystemdUnit(
    context: ApplyContext,
    ecosystemFile: string,
    toolchain: NodeToolchain,
  ): string {
    const values = [
      this.pm2RuntimeExecutable,
      ecosystemFile,
      context.plan.paths.secretsFile,
      this.applicationHome(context),
      context.plan.paths.logsDirectory,
      this.releaseDirectory(context),
    ];
    if (values.some((value) => !/^\/[A-Za-z0-9._/-]+$/.test(value))) {
      throw new ServerError("SERVER_STATE_INVALID", "systemd paths contain unsupported characters");
    }
    const user = deploymentUnixUser(context.plan.targetId);
    const runtimeArgs = this.pm2RuntimeExecutable === "/usr/bin/env"
      ? `pm2-runtime start ${ecosystemFile}`
      : `start ${ecosystemFile}`;
    return [
      "# Generated by DeployKit. No secret values are stored in this unit.",
      "[Unit]",
      `Description=DeployKit PM2 workloads for ${context.plan.targetId}`,
      "After=network-online.target docker.service",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `User=${user}`,
      `Group=${user}`,
      `WorkingDirectory=${this.releaseDirectory(context)}`,
      `Environment=PATH=${toolchain.binDirectory}:${SYSTEM_PATH}`,
      `Environment=PM2_HOME=${join(this.applicationHome(context), ".pm2")}`,
      `EnvironmentFile=${context.plan.paths.secretsFile}`,
      `ExecStart=${this.pm2RuntimeExecutable} ${runtimeArgs}`,
      "Restart=on-failure",
      "RestartSec=3s",
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "ProtectSystem=strict",
      `ReadWritePaths=${this.applicationHome(context)} ${context.plan.paths.logsDirectory} ${this.releaseDirectory(context)}`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
  }

  private async assertManagedAvailableFile(context: ApplyContext): Promise<void> {
    try {
      const stats = await lstat(context.plan.paths.nginxAvailableFile);
      if (!stats.isFile()) {
        throw new ServerError(
          "SERVER_DOMAIN_COLLISION",
          `${context.plan.paths.nginxAvailableFile} exists and is not a regular managed file`,
        );
      }
      const contents = await readFile(context.plan.paths.nginxAvailableFile, "utf8");
      if (!contents.startsWith(`${managedNginxMarker(context.plan.targetId)}\n`)) {
        throw new ServerError(
          "SERVER_DOMAIN_COLLISION",
          `${context.plan.paths.nginxAvailableFile} exists without this target's DeployKit marker`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
