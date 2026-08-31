import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DeployKitError } from "./errors.js";
import { loadManifest } from "./manifest.js";
import { validateProject } from "./project-validation.js";
import {
  DeploymentApplier,
  DeploymentStateStore,
  DigDnsResolver,
  FlockLockProvider,
  ProcessCommandRunner,
  ProductionDeploymentDriver,
  RegistryStore,
  SecretsStore,
  makeTargetId,
  planDeployment,
  secretRequirementsFromManifest,
  serverPaths,
} from "./server/index.js";
import { VERSION, versionSatisfiesRequirement } from "./version.js";

interface ServerConfig {
  version: 1;
  label: string;
  repository: string;
  publicAddresses: string[];
  portRange?: { start: number; end: number };
}

async function loadServerConfig(label: string): Promise<ServerConfig> {
  const path = `/etc/deploykit/server-${label}.json`;
  const parsed = JSON.parse(await readFile(path, "utf8")) as ServerConfig;
  if (parsed.version !== 1 || parsed.label !== label || !Array.isArray(parsed.publicAddresses)) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", `Invalid server configuration at ${path}`);
  }
  return parsed;
}

export interface ServerApplyOptions {
  manifestPath: string;
  target: string;
  commit: string;
  source: string;
  resume: boolean;
  dryRun: boolean;
}

export async function runServerApply(options: ServerApplyOptions): Promise<unknown> {
  process.env.DEPLOYKIT_SERVER_RUNTIME = "1";
  const manifest = await loadManifest(options.manifestPath);
  const validation = await validateProject(manifest, { manifestPath: options.manifestPath, inspectComposeConfig: true });
  if (!validation.valid) throw new DeployKitError("DK_VALIDATION_FAILED", "Server-side project validation failed", { details: validation.issues });
  const target = manifest.targets[options.target];
  if (!target) throw new DeployKitError("DK_USAGE", `Unknown target '${options.target}'`);
  if (!versionSatisfiesRequirement(manifest.metadata.requiredVersion, VERSION)) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", `Manifest requires DeployKit ${manifest.metadata.requiredVersion}, but server has ${VERSION}`);
  }
  const serverConfig = await loadServerConfig(target.runnerLabel);
  const plan = planDeployment(manifest, options.target, options.commit);
  if (options.dryRun) return plan;
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", "deploykit server apply must run as root");
  }

  const lock = new FlockLockProvider();
  const paths = serverPaths(makeTargetId(manifest.metadata.name, options.target));
  const stateStore = new DeploymentStateStore({
    file: paths.deploymentStateFile,
    lockFile: paths.deploymentStateLockFile,
    targetId: paths.targetId,
    lock,
  });
  const existing = await stateStore.read();
  if (existing?.status === "failed" && !options.resume) {
    throw new DeployKitError("DK_DEPLOYMENT_FAILED", "A failed deployment exists. Re-run through deploykit retry/--resume.");
  }
  if (!existing && options.resume) throw new DeployKitError("DK_USAGE", "--resume was requested, but no failed deployment exists");

  const secretsStore = new SecretsStore({ file: paths.secretsFile, requirements: secretRequirementsFromManifest(manifest) });
  const secretCheck = await secretsStore.check();
  if (!secretCheck.valid) throw new DeployKitError("DK_SECRET_MISSING", `Missing required secrets: ${secretCheck.missing.join(", ")}`);
  const secretValues = await secretsStore.read();
  const redactor = await secretsStore.redactor();
  const runner = new ProcessCommandRunner({ redactor });
  const registry = new RegistryStore({
    file: paths.registryFile,
    lockFile: paths.registryLockFile,
    lock,
    portRange: serverConfig.portRange ?? { start: 20_000, end: 39_999 },
  });
  const driver = new ProductionDeploymentDriver({ runner, secrets: secretValues });
  const applier = new DeploymentApplier({
    manifest,
    targetName: options.target,
    commitSha: options.commit,
    sourceDirectory: resolve(options.source),
    serverAddresses: serverConfig.publicAddresses,
    lock,
    registry,
    dnsResolver: new DigDnsResolver(runner),
    driver,
    redactor,
  });
  return applier.apply();
}
