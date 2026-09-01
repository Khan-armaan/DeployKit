import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ProjectManifest } from "../manifest.js";
import type {
  DeploymentStateIdentity,
  HealthResult,
  ManifestDigest,
} from "../orchestrator/contracts.js";
import { ServerError, isServerError } from "./errors.js";
import { DeploymentEventLogger } from "./events.js";
import { assertCommitSha, assertSafeId, makeServiceKey, makeTargetId } from "./ids.js";
import { makeDeploymentIdentity } from "./identity.js";
import { buildInspection, type ServerInspectionResult } from "./inspect.js";
import type { LockProvider } from "./lock.js";
import { DEFAULT_SERVER_ROOTS, serverPaths, type ServerPaths, type ServerRoots } from "./paths.js";
import { allocatedPortResults, type PortRequest, type RegistryStore, type ReservedResources } from "./registry.js";
import type { SecretRedactor } from "./secrets.js";
import { DEPLOYMENT_PHASES, DeploymentStateStore, type ServerDeploymentPhase, type DeploymentState } from "./state.js";
import { verifyDirectDns, type DnsResolver, type DnsVerificationResult } from "./dns.js";

export interface DeploymentAction {
  readonly phase: ServerDeploymentPhase;
  readonly kind: "check" | "directory" | "file" | "command" | "service" | "certificate" | "activation";
  readonly description: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly path?: string;
}

export interface ServerDeploymentPlan {
  readonly targetId: string;
  readonly targetName: string;
  readonly commitSha: string;
  readonly domains: readonly string[];
  readonly portRequests: readonly PortRequest[];
  readonly paths: ServerPaths;
  readonly actions: readonly DeploymentAction[];
}

function installArgv(packageManager: "npm" | "pnpm" | "yarn" | "bun", explicit?: readonly string[]): readonly string[] {
  if (explicit !== undefined) return explicit;
  switch (packageManager) {
    case "npm": return ["npm", "ci"];
    case "pnpm": return ["pnpm", "install", "--frozen-lockfile"];
    case "yarn": return ["yarn", "install", "--immutable"];
    case "bun": return ["bun", "install", "--frozen-lockfile"];
  }
}

function scriptArgv(packageManager: "npm" | "pnpm" | "yarn" | "bun", script: string): readonly string[] {
  return packageManager === "npm" ? ["npm", "run", script] : [packageManager, "run", script];
}

function commandAction(
  phase: ServerDeploymentPhase,
  description: string,
  argv: readonly string[],
): DeploymentAction {
  const [command, ...args] = argv;
  if (command === undefined) throw new ServerError("SERVER_STATE_INVALID", `${description} has an empty command`);
  return { phase, kind: "command", description, command, args };
}

export interface PlanDeploymentOptions {
  /**
   * Identity supplied by the root-owned gateway binding. The runtime never lets
   * caller input choose it; when it is absent the legacy manifest-derived
   * identifier is used instead.
   */
  readonly targetId?: string;
}

export function planDeployment(
  manifest: ProjectManifest,
  targetName: string,
  commitSha: string,
  roots: ServerRoots = DEFAULT_SERVER_ROOTS,
  options: PlanDeploymentOptions = {},
): ServerDeploymentPlan {
  const target = manifest.targets[targetName];
  if (target === undefined) {
    throw new ServerError("SERVER_STATE_INVALID", `manifest does not define target ${targetName}`, {
      targetName,
      availableTargets: Object.keys(manifest.targets),
    });
  }
  const sha = assertCommitSha(commitSha);
  const targetId = options.targetId === undefined
    ? makeTargetId(manifest.metadata.name, targetName)
    : assertSafeId(options.targetId, "target id");
  const paths = serverPaths(targetId, roots);
  const targetDomains = new Set([target.primaryDomain, ...target.aliases]);
  const applicableRoutes = manifest.routes.filter(
    (route) => route.hostname === "@primary" || targetDomains.has(route.hostname),
  );
  const routeTargets = new Set(applicableRoutes.map((route) => route.target));
  if (manifest.frontend?.type === "service") routeTargets.add(manifest.frontend.service);
  const domains = [target.primaryDomain, ...target.aliases];
  const uniqueDomains = [...new Set(domains)];
  const portRequests: PortRequest[] = [];
  for (const [name, service] of Object.entries(manifest.services)) {
    const needsLoopback = routeTargets.has(name) ||
      (service.type === "compose" && service.hostPort !== undefined) ||
      (service.type === "pm2" && service.role !== "worker");
    if (!needsLoopback) continue;
    portRequests.push({
      targetId,
      service: name,
      serviceKey: makeServiceKey(targetId, name),
      requestedPort: service.type === "compose" ? service.hostPort : undefined,
    });
  }
  const composeDatabaseNeedsLoopback = manifest.database?.type === "compose" &&
    manifest.database.consumers.some((consumer) => manifest.services[consumer]?.type === "pm2");
  if (manifest.database?.type === "compose" && composeDatabaseNeedsLoopback) {
    const service = "database:compose";
    portRequests.push({
      targetId,
      service,
      serviceKey: makeServiceKey(targetId, service),
    });
  }

  const actions: DeploymentAction[] = [
    { phase: "manifest-validated", kind: "check", description: "Validate the versioned manifest and effective Compose contract" },
    ...uniqueDomains.map<DeploymentAction>((domain) => ({
      phase: "dns-verified",
      kind: "check",
      description: `Verify direct A/AAAA records for ${domain}`,
    })),
    {
      phase: "resources-reserved",
      kind: "file",
      description: "Reserve domains and stable loopback ports under the server-wide lock",
      path: paths.registryFile,
    },
    {
      phase: "source-staged",
      kind: "directory",
      description: `Atomically stage immutable release ${sha}`,
      path: paths.releaseDirectory(sha),
    },
  ];

  if (manifest.compose !== undefined) {
    actions.push(
      {
        phase: "workloads-ready",
        kind: "file",
        description: "Generate a DeployKit-owned Compose override with loopback-only published ports",
        path: `${paths.releaseDirectory(sha)}/.deploykit/compose.override.yaml`,
      },
      commandAction(
        "workloads-ready",
        "Build and start Compose workloads",
        [
          "docker", "compose",
          ...manifest.compose.files.flatMap((file) => ["--file", file]),
          "--file", ".deploykit/compose.override.yaml",
          "--project-name", targetId,
          "up", "--detach", "--build",
        ],
      ),
    );
  }

  for (const [name, service] of Object.entries(manifest.services)) {
    if (service.type !== "pm2") continue;
    actions.push({
      phase: "workloads-ready",
      kind: "service",
      description: `Run PM2 workload ${name} as the per-application Unix user using Node ${service.nodeVersion}`,
    });
    actions.push(commandAction("workloads-ready", `Install dependencies for ${name}`, installArgv(service.packageManager, service.installCommand)));
    if (service.buildScript !== undefined) {
      actions.push(commandAction("workloads-ready", `Build ${name}`, scriptArgv(service.packageManager, service.buildScript)));
    }
    actions.push(commandAction("workloads-ready", `Start ${name}`, scriptArgv(service.packageManager, service.startScript)));
  }

  if (manifest.frontend?.type === "static") {
    actions.push(
      commandAction(
        "workloads-ready",
        "Install static frontend dependencies",
        installArgv(manifest.frontend.packageManager, manifest.frontend.installCommand),
      ),
      commandAction(
        "workloads-ready",
        "Build static frontend",
        scriptArgv(manifest.frontend.packageManager, manifest.frontend.buildScript),
      ),
    );
  }

  if (manifest.database?.type === "compose" && manifest.database.migrations !== undefined) {
    actions.push(commandAction("migrations-complete", "Run database migrations", manifest.database.migrations.command));
  }
  if (manifest.database?.type === "compose" && manifest.database.seed !== undefined) {
    actions.push(commandAction("migrations-complete", "Run database seed hook", manifest.database.seed.command));
  }
  for (const [name, service] of Object.entries(manifest.services)) {
    actions.push({
      phase: "health-verified",
      kind: "check",
      description: `Wait for ${name} ${service.healthCheck.type} health check`,
    });
  }
  actions.push(
    {
      phase: "proxy-staged",
      kind: "file",
      description: "Atomically stage managed Nginx configuration and validate with nginx -t",
      path: paths.nginxAvailableFile,
    },
    commandAction("proxy-staged", "Validate Nginx configuration", ["nginx", "-t"]),
    {
      phase: "tls-issued",
      kind: "certificate",
      description: "Issue certificates with Certbot webroot without allowing Certbot to edit Nginx",
    } as DeploymentAction,
    commandAction("tls-issued", "Issue or reconcile the TLS certificate", [
      "certbot", "--config", "/dev/stdin", "certonly", "--webroot", "--webroot-path", paths.acmeWebroot,
      "--non-interactive", "--agree-tos", "--keep-until-expiring",
      "--cert-name", target.primaryDomain,
      ...uniqueDomains.flatMap((domain) => ["--domain", domain]),
    ]),
    {
      phase: "activated",
      kind: "activation",
      description: "Activate the release and reload Nginx after successful validation",
      path: paths.currentReleaseLink,
    },
    commandAction("activated", "Reload Nginx", ["systemctl", "reload", "nginx"]),
  );

  return { targetId, targetName, commitSha: sha, domains: uniqueDomains, portRequests, paths, actions };
}

export interface ApplyContext {
  readonly manifest: ProjectManifest;
  readonly plan: ServerDeploymentPlan;
  readonly sourceDirectory: string;
  readonly resources: ReservedResources;
  readonly dns: readonly DnsVerificationResult[];
}

/** Every mutating phase is explicit so a production driver cannot silently skip one. */
export interface DeploymentDriver {
  stageSource(context: ApplyContext): Promise<void>;
  startWorkloads(context: ApplyContext): Promise<void>;
  runMigrations(context: ApplyContext): Promise<void>;
  verifyHealth(context: ApplyContext): Promise<void>;
  stageProxy(context: ApplyContext): Promise<void>;
  issueTls(context: ApplyContext): Promise<void>;
  activate(context: ApplyContext): Promise<void>;
  disableNewProxyAfterFailure(context: ApplyContext): Promise<void>;
}

export interface DeploymentApplierOptions {
  readonly manifest: ProjectManifest;
  readonly targetName: string;
  readonly commitSha: string;
  /** Digest of the compiled secret-free runtime manifest this apply deploys. */
  readonly manifestDigest: ManifestDigest | string;
  /** Identity from the root-owned gateway binding, when there is one. */
  readonly targetId?: string;
  /**
   * Absolute root of the already-retrieved application source. It is validated
   * before any phase runs and is never allowed to be a runtime-owned path.
   */
  readonly sourceDirectory: string;
  readonly serverAddresses: readonly string[];
  readonly roots?: ServerRoots;
  readonly lock: LockProvider;
  readonly registry: RegistryStore;
  readonly dnsResolver: DnsResolver;
  readonly driver: DeploymentDriver;
  readonly redactor: SecretRedactor;
  readonly now?: () => Date;
}

export interface DeploymentApplyResult {
  readonly plan: ServerDeploymentPlan;
  readonly identity: DeploymentStateIdentity;
  readonly state: DeploymentState;
  readonly resumed: boolean;
  readonly resources: ReservedResources;
  readonly dns: readonly DnsVerificationResult[];
  readonly inspection: ServerInspectionResult;
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Resolves a path that may not exist yet through its closest existing ancestor,
 * so a runtime-owned directory is compared against the incoming root on the
 * same footing. Without it a host whose temporary or state root is itself a
 * symlink would compare a resolved path against an unresolved one and miss an
 * overlap.
 */
async function resolveExistingAncestor(path: string): Promise<string> {
  const absolute = resolve(path);
  const segments: string[] = [];
  let candidate = absolute;
  for (;;) {
    try {
      return resolve(await realpath(candidate), ...segments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = resolve(candidate, "..");
    if (parent === candidate) return absolute;
    segments.unshift(candidate.slice(parent.length + 1));
    candidate = parent;
  }
}

/**
 * Validates the incoming project root the caller retrieved. The deployment
 * engine accepts an explicit root so source retrieval can own where the tree
 * lives, but it refuses any root that overlaps runtime-owned state: the
 * immutable releases, the activated release link, and the target's
 * configuration and state directories all belong to DeployKit alone.
 */
export async function assertIncomingSourceRoot(
  sourceDirectory: string,
  paths: ServerPaths,
): Promise<string> {
  if (!isAbsolute(sourceDirectory) || sourceDirectory.includes("\0")) {
    throw new ServerError(
      "SERVER_SOURCE_ROOT_INVALID",
      "the incoming project root must be an absolute path without NUL bytes",
    );
  }
  let root: string;
  try {
    root = await realpath(sourceDirectory);
  } catch (error) {
    throw new ServerError(
      "SERVER_SOURCE_ROOT_INVALID",
      `the incoming project root ${sourceDirectory} does not exist`,
      { sourceDirectory },
      { cause: error },
    );
  }
  if (!(await lstat(root)).isDirectory()) {
    throw new ServerError("SERVER_SOURCE_ROOT_INVALID", `the incoming project root ${root} is not a directory`, {
      sourceDirectory: root,
    });
  }
  const reserved = await Promise.all([
    paths.releasesDirectory,
    paths.currentReleaseLink,
    paths.targetConfigDirectory,
    resolve(paths.deploymentStateFile, ".."),
  ].map((path) => resolveExistingAncestor(path)));
  for (const path of reserved) {
    if (contains(path, root) || contains(root, path)) {
      throw new ServerError(
        "SERVER_SOURCE_ROOT_INVALID",
        "the incoming project root overlaps a DeployKit-owned runtime path",
        { sourceDirectory: root, reservedPath: path },
      );
    }
  }
  return root;
}

/**
 * Health is derived from the manifest once `verifyHealth` returns, because that
 * phase throws unless every declared check passed. Persisting it keeps
 * inspection answerable from state alone, without the manifest the deployment
 * was applied from.
 */
function healthResults(manifest: ProjectManifest): readonly HealthResult[] {
  return Object.entries(manifest.services)
    .map(([service, definition]) => ({
      service,
      healthy: true,
      check: definition.healthCheck.type,
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

export class DeploymentApplier {
  constructor(private readonly options: DeploymentApplierOptions) {}

  async apply(): Promise<DeploymentApplyResult> {
    const plan = planDeployment(
      this.options.manifest,
      this.options.targetName,
      this.options.commitSha,
      this.options.roots,
      { targetId: this.options.targetId },
    );
    const identity = makeDeploymentIdentity(
      plan.targetId,
      plan.commitSha,
      this.options.manifestDigest,
    );
    const sourceDirectory = await assertIncomingSourceRoot(this.options.sourceDirectory, plan.paths);
    const stateStore = new DeploymentStateStore({
      file: plan.paths.deploymentStateFile,
      lockFile: plan.paths.deploymentStateLockFile,
      targetId: plan.targetId,
      targetName: plan.targetName,
      lock: this.options.lock,
      now: this.options.now,
    });
    const events = new DeploymentEventLogger(
      plan.paths.deploymentLogFile,
      plan.targetId,
      this.options.redactor,
      this.options.now,
    );
    const releaseDirectory = plan.paths.releaseDirectory(plan.commitSha);

    return await this.options.lock.withLock(plan.paths.deploymentLockFile, async () => {
      // Holding the server-wide deployment lock is what makes a `running`
      // record provably interrupted rather than live.
      const begun = await stateStore.begin(identity, { serverDeploymentLockHeld: true });
      const releaseExistedBeforeApply = await pathExists(releaseDirectory);
      await events.write("info", "SERVER_DEPLOYMENT_STARTED", "starting", begun.resumed
        ? `Resuming deployment attempt ${begun.state.attempt}`
        : "Starting first deployment");
      let currentPhase: ServerDeploymentPhase | "starting" = "starting";
      let context: ApplyContext | undefined;
      try {
        currentPhase = "manifest-validated";
        await events.write("info", "SERVER_PHASE_STARTED", currentPhase, "Validating deployment manifest");
        await stateStore.checkpoint(currentPhase);
        await events.write("info", "SERVER_PHASE_COMPLETED", currentPhase, "Manifest validation checkpoint complete");

        currentPhase = "dns-verified";
        await events.write("info", "SERVER_PHASE_STARTED", currentPhase, "Verifying direct DNS records");
        const dns = await verifyDirectDns(plan.domains, this.options.serverAddresses, this.options.dnsResolver);
        await stateStore.checkpoint(currentPhase);
        await events.write("info", "SERVER_PHASE_COMPLETED", currentPhase, "DNS verification checkpoint complete");

        currentPhase = "resources-reserved";
        await events.write("info", "SERVER_PHASE_STARTED", currentPhase, "Reserving shared domains and loopback ports");
        const resources = await this.options.registry.reserve({
          targetId: plan.targetId,
          domains: plan.domains,
          ports: plan.portRequests,
        });
        await stateStore.recordResources({
          domains: resources.domains.map((reservation) => reservation.domain),
          ports: allocatedPortResults(resources.ports),
        });
        await stateStore.checkpoint(currentPhase);
        await events.write("info", "SERVER_PHASE_COMPLETED", currentPhase, "Resource reservation checkpoint complete");
        context = {
          manifest: this.options.manifest,
          plan,
          sourceDirectory,
          resources,
          dns,
        };

        // Only stageSource may create the immutable release. A release that
        // appeared during an earlier phase of this run is a conflict, while one
        // left by an interrupted attempt is still verified by ReleaseManager.
        if (!releaseExistedBeforeApply && await pathExists(releaseDirectory)) {
          throw new ServerError(
            "SERVER_RELEASE_CONFLICT",
            `release ${plan.commitSha} was created before the source-staged phase`,
            { releaseDirectory },
          );
        }

        const phases: readonly [ServerDeploymentPhase, (value: ApplyContext) => Promise<void>][] = [
          ["source-staged", (value) => this.options.driver.stageSource(value)],
          ["workloads-ready", (value) => this.options.driver.startWorkloads(value)],
          ["migrations-complete", (value) => this.options.driver.runMigrations(value)],
          ["health-verified", (value) => this.options.driver.verifyHealth(value)],
          ["proxy-staged", (value) => this.options.driver.stageProxy(value)],
          ["tls-issued", (value) => this.options.driver.issueTls(value)],
          ["activated", (value) => this.options.driver.activate(value)],
        ];
        const completed = new Set(begun.state.checkpoints.map((checkpoint) => checkpoint.phase));
        for (const [phase, operation] of phases) {
          currentPhase = phase;
          if (completed.has(phase)) {
            await events.write("info", "SERVER_PHASE_SKIPPED", phase, "Using durable checkpoint from an earlier attempt");
          } else {
            await events.write("info", "SERVER_PHASE_STARTED", phase, `Starting ${phase}`);
            await operation(context);
          }
          if (phase === "health-verified") {
            await stateStore.recordHealth(healthResults(this.options.manifest));
          }
          await stateStore.checkpoint(phase);
          await events.write("info", "SERVER_PHASE_COMPLETED", phase, `Completed ${phase}`);
        }
        const state = await stateStore.succeed();
        await events.write("info", "SERVER_DEPLOYMENT_SUCCEEDED", "complete", "First deployment completed successfully");
        return {
          plan,
          identity,
          state,
          resumed: begun.resumed,
          resources,
          dns,
          inspection: this.options.redactor.redact(
            buildInspection(
              { kind: "current", state },
              { targetId: plan.targetId, targetName: plan.targetName },
            ),
          ),
        };
      } catch (error) {
        if (context !== undefined) {
          await this.options.driver.disableNewProxyAfterFailure(context).catch(() => undefined);
        }
        const code = isServerError(error) ? error.code : "SERVER_APPLY_FAILED";
        const unredacted = error instanceof Error ? error.message : String(error);
        const message = this.options.redactor.redactText(unredacted);
        await stateStore.fail(currentPhase, code, message).catch(() => undefined);
        await events.write("error", "SERVER_DEPLOYMENT_FAILED", currentPhase, message, { errorCode: code }).catch(() => undefined);
        if (isServerError(error)) {
          throw new ServerError(error.code, message, this.options.redactor.redact(error.details));
        }
        throw new ServerError("SERVER_APPLY_FAILED", message);
      }
    });
  }
}

export function phasesAfter(state: DeploymentState): readonly ServerDeploymentPhase[] {
  return DEPLOYMENT_PHASES.slice(state.checkpoints.length);
}
