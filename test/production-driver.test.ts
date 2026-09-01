import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseManifest, type ProjectManifest } from "../src/manifest.js";
import { planDeployment, type ApplyContext } from "../src/server/apply.js";
import { ProcessCommandRunner, RecordingCommandRunner, type CommandSpec } from "../src/server/command.js";
import type { ServerRoots } from "../src/server/paths.js";
import {
  ProductionDeploymentDriver,
  deploymentUnixUser,
} from "../src/server/production-driver.js";
import type { ReservedResources } from "../src/server/registry.js";
import {
  NodeToolchainManager,
  checksumForNodeArchive,
  type NodePackageManager,
  type NodeToolchain,
  type NodeToolchainProvider,
} from "../src/server/toolchains.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function fixtureManifest(): ProjectManifest {
  return parseManifest({
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: "driver-app", requiredVersion: "0.1.0" },
    compose: { files: ["compose.yaml"] },
    services: {
      api: {
        type: "compose",
        service: "api",
        internalPort: 3_000,
        healthCheck: { type: "http", path: "/health", retries: 2, intervalSeconds: 1 },
      },
      events: {
        type: "pm2",
        role: "api",
        workingDirectory: "events",
        nodeVersion: "22.14.0",
        packageManager: "npm",
        buildScript: "build",
        startScript: "start",
        portEnvironmentVariable: "PORT",
        healthCheck: { type: "http", path: "/ready", retries: 2, intervalSeconds: 1 },
      },
    },
    frontend: {
      type: "static",
      workingDirectory: "frontend",
      nodeVersion: "22.14.0",
      packageManager: "npm",
      buildScript: "build",
      outputDirectory: "dist",
      publicEnvironment: { VITE_API_BASE: "/api" },
    },
    routes: [{ path: "/api/", target: "api" }, { path: "/events/", target: "events", sse: true }],
    database: {
      type: "compose",
      service: "postgres",
      internalPort: 5_432,
      consumers: ["api", "events"],
      volume: "postgres-data",
      credentials: {
        username: "app",
        database: "driver",
        passwordSecret: "POSTGRES_PASSWORD",
        connectionStringSecret: "DATABASE_URL",
        connectionStringTemplate: "postgresql://{username}:{password}@{host}:{port}/{database}",
      },
      migrations: { service: "api", command: ["npm", "run", "migrate"] },
      seed: { service: "api", command: ["npm", "run", "seed"] },
    },
    secrets: {
      required: ["CERTBOT_EMAIL"],
      generated: ["POSTGRES_PASSWORD", "DATABASE_URL"],
    },
    targets: {
      production: {
        runnerLabel: "vps-one",
        primaryDomain: "driver.example.com",
        runtimeOverrides: { LOG_LEVEL: "info" },
        publicOverrides: { VITE_API_BASE: "/api" },
      },
    },
  });
}

function roots(directory: string): ServerRoots {
  return {
    config: join(directory, "etc"),
    state: join(directory, "state"),
    data: join(directory, "srv"),
    nginxAvailable: join(directory, "nginx-available"),
    nginxEnabled: join(directory, "nginx-enabled"),
    letsEncryptWebroot: join(directory, "acme"),
  };
}

function resourcesFor(contextPlan: ReturnType<typeof planDeployment>): ReservedResources {
  let nextPort = 34_000;
  const ports = contextPlan.portRequests.map((request) => ({
    serviceKey: request.serviceKey,
    targetId: request.targetId,
    service: request.service,
    address: "127.0.0.1" as const,
    port: nextPort++,
  }));
  return {
    domains: contextPlan.domains.map((domain) => ({ domain, targetId: contextPlan.targetId })),
    ports,
    portsByService: Object.fromEntries(ports.map((reservation) => [reservation.service, reservation.port])),
  };
}

async function deploymentContext(directory: string): Promise<ApplyContext> {
  const source = join(directory, "source");
  await mkdir(join(source, "events"), { recursive: true });
  await mkdir(join(source, "frontend", "dist"), { recursive: true });
  await writeFile(join(source, "compose.yaml"), "services:\n  api: { image: node:22 }\n  postgres: { image: postgres:16 }\n");
  await writeFile(join(source, "events", "package.json"), "{}\n");
  await writeFile(join(source, "frontend", "package.json"), "{}\n");
  await writeFile(join(source, "frontend", "dist", "index.html"), "hello\n");
  const manifest = fixtureManifest();
  const plan = planDeployment(manifest, "production", "a".repeat(40), roots(directory));
  return {
    manifest,
    plan,
    sourceDirectory: source,
    resources: resourcesFor(plan),
    dns: [],
  };
}

class FixtureToolchains implements NodeToolchainProvider {
  readonly installRoot: string;

  constructor(directory: string) {
    this.installRoot = join(directory, "node");
  }

  async ensure(version: string): Promise<NodeToolchain> {
    const directory = join(this.installRoot, version);
    return {
      version,
      directory,
      binDirectory: join(directory, "bin"),
      nodeExecutable: join(directory, "bin", "node"),
    };
  }

  async ensurePackageManager(toolchain: NodeToolchain, packageManager: NodePackageManager): Promise<string> {
    return join(toolchain.binDirectory, packageManager);
  }
}

function successfulRunner(): RecordingCommandRunner {
  return new RecordingCommandRunner((spec) => {
    if (spec.command === "id") return { exitCode: 1, dryRun: false };
    if (spec.command === "nginx" && spec.args[0] === "-T") {
      return { stdout: "", stderr: "", dryRun: false };
    }
    return { exitCode: 0, dryRun: false };
  });
}

describe("NodeToolchainManager", () => {
  it("downloads an exact archive, checks the official digest, and verifies node -v", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-node-"));
    temporaryDirectories.push(directory);
    const checksum = "a".repeat(64);
    const observed: CommandSpec[] = [];
    const runner = new RecordingCommandRunner((spec) => {
      observed.push(spec);
      if (spec.command.endsWith("/bin/node") && !spec.command.includes("staging")) {
        return { exitCode: 1, dryRun: false };
      }
      if (spec.command.endsWith("/bin/node")) return { stdout: "v22.14.0\n", dryRun: false };
      if (spec.command === "curl" && spec.args.at(-1)?.endsWith("SHASUMS256.txt")) {
        return {
          stdout: `${checksum}  node-v22.14.0-linux-x64.tar.xz\n`,
          dryRun: false,
        };
      }
      return { exitCode: 0, dryRun: false };
    });
    const manager = new NodeToolchainManager({
      runner,
      installRoot: join(directory, "node"),
      architecture: "x64",
    });

    const result = await manager.ensure("22.14.0");

    expect(result.nodeExecutable).toBe(join(directory, "node", "22.14.0", "bin", "node"));
    const digest = observed.find((entry) => entry.command === "sha256sum");
    expect(digest?.args).toEqual(["--check", "--strict"]);
    expect(String(digest?.stdin)).toContain(checksum);
    expect(runner.invocations.some((entry) =>
      entry.command === "tar" && entry.args.includes("--no-same-owner"),
    )).toBe(true);
    expect(runner.invocations.every((entry) => !["sh", "bash", "zsh"].includes(entry.command))).toBe(true);
  });

  it("does not accept a checksum belonging to a similarly named archive", () => {
    expect(() => checksumForNodeArchive(
      `${"b".repeat(64)}  prefix-node-v22.14.0-linux-x64.tar.xz\n`,
      "node-v22.14.0-linux-x64.tar.xz",
    )).toThrow("did not contain exactly one entry");
  });

  it("records the complete install without executing it in process dry-run mode", async () => {
    const runner = new ProcessCommandRunner({ dryRun: true });
    const manager = new NodeToolchainManager({
      runner,
      installRoot: "/tmp/deploykit-dry-node",
      architecture: "x64",
    });

    await manager.ensure("22.14.0");

    expect(runner.invocations.some((entry) => entry.command === "curl")).toBe(true);
    expect(runner.invocations.some((entry) => entry.command === "sha256sum")).toBe(true);
    expect(runner.invocations.some((entry) => entry.command === "tar")).toBe(true);
  });
});

describe("ProductionDeploymentDriver", () => {
  it("executes every production phase with argv commands and keeps derived secrets out of generated files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-driver-"));
    temporaryDirectories.push(directory);
    const context = await deploymentContext(directory);
    const observed: CommandSpec[] = [];
    const baseRunner = successfulRunner();
    const runner = new RecordingCommandRunner(async (spec) => {
      observed.push(spec);
      return await baseRunner.run(spec);
    });
    const password = "s/ecret value";
    const driver = new ProductionDeploymentDriver({
      runner,
      toolchains: new FixtureToolchains(directory),
      secrets: {
        CERTBOT_EMAIL: "ops@example.com",
        POSTGRES_PASSWORD: password,
        DATABASE_URL: "replace-this-random-placeholder",
      },
      healthClient: { get: async () => ({ status: 200 }) },
      sleep: async () => undefined,
      systemdUnitDirectory: join(directory, "systemd"),
      certbotStaging: true,
    });

    await driver.stageSource(context);
    await driver.startWorkloads(context);
    await driver.runMigrations(context);
    await driver.verifyHealth(context);
    await driver.stageProxy(context);

    const acme = await readFile(context.plan.paths.nginxAvailableFile, "utf8");
    expect(acme).toContain("Temporary ACME-only configuration");
    expect(acme).toContain("return 503");
    expect(acme).not.toContain("proxy_pass");

    await driver.disableNewProxyAfterFailure(context);
    await expect(lstat(context.plan.paths.nginxEnabledLink)).rejects.toMatchObject({ code: "ENOENT" });

    // TLS retry must restore the disabled ACME site because stageProxy is checkpointed.
    await driver.issueTls(context);
    expect(await readlink(context.plan.paths.nginxEnabledLink)).toBe(context.plan.paths.nginxAvailableFile);
    await driver.activate(context);

    const release = context.plan.paths.releaseDirectory(context.plan.commitSha);
    const composeOverride = await readFile(join(release, ".deploykit", "compose.override.yaml"), "utf8");
    const ecosystem = await readFile(join(release, ".deploykit", "ecosystem.cjs"), "utf8");
    const nginx = await readFile(context.plan.paths.nginxAvailableFile, "utf8");
    const secrets = await readFile(context.plan.paths.secretsFile, "utf8");

    expect(composeOverride).toContain("127.0.0.1:");
    expect(composeOverride).toContain("${DEPLOYKIT_COMPOSE_DATABASE_URL}");
    expect(composeOverride).not.toContain(password);
    expect(ecosystem).not.toContain(password);
    expect(ecosystem).not.toContain("postgresql://");
    expect(nginx).toContain("listen 443 ssl http2");
    expect(nginx).not.toContain(password);
    expect(secrets).toContain("postgresql://app:s%2Fecret%20value@127.0.0.1:");

    const composeUp = runner.invocations.find((entry) =>
      entry.command === "docker" && entry.args.includes("up"),
    );
    expect(composeUp?.args).toContain("--wait");
    const observedComposeUp = observed.find((entry) =>
      entry.command === "docker" && entry.args.includes("up"),
    );
    expect(observedComposeUp?.env?.[COMPOSE_DATABASE_ENV]).toContain("@postgres:5432/driver");
    expect(observedComposeUp?.env?.POSTGRES_PASSWORD).toBe(password);
    const unitFile = join(directory, "systemd", `deploykit-${context.plan.targetId}.service`);
    const unit = await readFile(unitFile, "utf8");
    expect(unit).toContain(`EnvironmentFile=${context.plan.paths.secretsFile}`);
    expect(unit).toContain("pm2-runtime start");
    expect(unit).not.toContain(password);
    expect(runner.invocations.some((entry) =>
      entry.command === "systemctl" && entry.args.includes(`deploykit-${context.plan.targetId}.service`),
    )).toBe(true);
    const certbot = runner.invocations.find((entry) => entry.command === "certbot");
    expect(certbot?.args).toContain("--staging");
    expect(certbot?.args).not.toContain("ops@example.com");
    expect(runner.invocations.every((entry) => !["sh", "bash", "zsh"].includes(entry.command))).toBe(true);

    const migration = runner.invocations.findIndex((entry) => entry.args.includes("migrate"));
    const seed = runner.invocations.findIndex((entry) => entry.args.includes("seed"));
    expect(migration).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(migration);
    expect(deploymentUnixUser(context.plan.targetId).length).toBeLessThanOrEqual(32);
  });

  it("refuses an unmanaged Nginx server_name collision before writing the site", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-nginx-"));
    temporaryDirectories.push(directory);
    const context = await deploymentContext(directory);
    const runner = new RecordingCommandRunner((spec: CommandSpec) => spec.command === "nginx" && spec.args[0] === "-T"
      ? {
          stdout: "# configuration file /etc/nginx/sites-enabled/manual.conf:\nserver { server_name driver.example.com; }\n",
          dryRun: false,
        }
      : { dryRun: false });
    const driver = new ProductionDeploymentDriver({
      runner,
      toolchains: new FixtureToolchains(directory),
      secrets: {},
    });

    await expect(driver.stageProxy(context)).rejects.toMatchObject({ code: "SERVER_DOMAIN_COLLISION" });
    await expect(lstat(context.plan.paths.nginxAvailableFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove an expected-path symlink before this driver activated it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-cleanup-"));
    temporaryDirectories.push(directory);
    const context = await deploymentContext(directory);
    await mkdir(join(directory, "manual"), { recursive: true });
    const manual = join(directory, "manual", "site.conf");
    await writeFile(manual, "server {}\n");
    await mkdir(join(directory, "nginx-enabled"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(manual, context.plan.paths.nginxEnabledLink);
    const driver = new ProductionDeploymentDriver({
      runner: successfulRunner(),
      toolchains: new FixtureToolchains(directory),
      secrets: {},
    });

    await driver.disableNewProxyAfterFailure(context);
    expect(await readlink(context.plan.paths.nginxEnabledLink)).toBe(manual);
  });

  it("refuses to overwrite an unmarked file at the managed available path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-unmarked-"));
    temporaryDirectories.push(directory);
    const context = await deploymentContext(directory);
    await mkdir(join(directory, "nginx-available"), { recursive: true });
    await writeFile(context.plan.paths.nginxAvailableFile, "# maintained by an operator\nserver {}\n");
    const driver = new ProductionDeploymentDriver({
      runner: successfulRunner(),
      toolchains: new FixtureToolchains(directory),
      secrets: {},
    });

    await expect(driver.stageProxy(context)).rejects.toMatchObject({ code: "SERVER_DOMAIN_COLLISION" });
    expect(await readFile(context.plan.paths.nginxAvailableFile, "utf8")).toContain("maintained by an operator");
  });
});

const COMPOSE_DATABASE_ENV = "DEPLOYKIT_COMPOSE_DATABASE_URL";
