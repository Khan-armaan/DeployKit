import {
  type DeployKitManifest,
  type DeployService,
  type HealthCheck,
  type Route,
} from "./manifest.js";
import { assertValidManifest, ManifestValidationError } from "./validation.js";
import { makeTargetId } from "./server/ids.js";
import { serverPaths, type ServerPaths } from "./server/paths.js";
import { BOOTSTRAP_NODE_VERSION, PM2_VERSION } from "./version.js";

export const DEPLOYMENT_PLAN_API_VERSION = "deploykit/plan/v1alpha1" as const;

export interface DeploymentPlanOptions {
  portRange?: {
    start: number;
    end: number;
  };
  commitSha?: string;
  sourceRef?: string;
  certbotStaging?: boolean;
  serverAddresses?: readonly string[];
}

export interface PlannedFile {
  path: string;
  purpose: string;
  mode?: string;
  kind: "directory" | "file" | "symlink";
}

export interface PlannedPort {
  id: string;
  service: string;
  purpose: "upstream" | "pm2" | "database";
  bindAddress: "127.0.0.1";
  allocation: "dynamic" | "explicit";
  requestedPort?: number;
  internalPort?: number;
  range: {
    start: number;
    end: number;
  };
}

export interface PlannedComposeProcess {
  id: string;
  type: "compose";
  service: string;
  logicalService: string;
  healthCheck: HealthCheck;
  portId?: string;
}

export interface PlannedPm2Process {
  id: string;
  type: "pm2";
  role: "api" | "ssr" | "worker";
  workingDirectory: string;
  nodeVersion: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  installCommand: readonly string[];
  buildScript?: string;
  startScript: string;
  portEnvironmentVariable?: string;
  portId?: string;
  healthCheck: HealthCheck;
}

export interface PlannedStaticBuild {
  id: "frontend";
  type: "static-build";
  workingDirectory: string;
  nodeVersion: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  installCommand: readonly string[];
  buildScript: string;
  outputDirectory: string;
  destination: string;
  publicEnvironment: Readonly<Record<string, string>>;
}

export interface PlannedHook {
  id: "database:migrations" | "database:seed";
  type: "hook";
  phase: "migrations" | "seed";
  service: string;
  command: readonly string[];
  fatal: true;
}

export type PlannedProcess =
  | PlannedComposeProcess
  | PlannedPm2Process
  | PlannedStaticBuild
  | PlannedHook;

export interface PlannedNginxRoute {
  hostname: string;
  path: string;
  match: "exact" | "prefix";
  target: string;
  upstreamPortId: string;
  preservePrefix: boolean;
  websocket: boolean;
  sse: boolean;
  buffering: boolean;
  requestBuffering: boolean;
  uploadLimit?: string;
  timeouts: {
    connectSeconds: number;
    sendSeconds: number;
    readSeconds: number;
  };
}

export interface PlannedNginxSite {
  name: string;
  serverNames: string[];
  availablePath: string;
  enabledPath: string;
  static?: {
    root: string;
    spaFallback: boolean;
  };
  frontendUpstreamPortId?: string;
  routes: PlannedNginxRoute[];
  usesConnectionUpgradeMap: boolean;
  activation: "atomic-test-and-reload";
}

export interface PlannedDnsCheck {
  domain: string;
  recordTypes: readonly ["A", "AAAA"];
  expectedAddresses: readonly string[] | "server-addresses";
  directRecordsOnly: true;
  beforeMutation: true;
}

export interface PlannedCertificate {
  provider: "certbot";
  challenge: "webroot";
  domains: string[];
  webroot: string;
  staging: boolean;
  managesNginxConfiguration: false;
  renewalReloadHook: "nginx-test-and-reload";
}

export interface DeploymentPhase {
  code:
    | "PREFLIGHT"
    | "DNS"
    | "LOCK"
    | "ALLOCATE"
    | "CHECKOUT"
    | "CONFIGURE"
    | "BUILD"
    | "MIGRATE"
    | "START"
    | "HEALTH"
    | "NGINX"
    | "TLS"
    | "COMPLETE";
  description: string;
  mutatesServer: boolean;
}

export interface DeploymentPlan {
  apiVersion: typeof DEPLOYMENT_PLAN_API_VERSION;
  deploymentId: string;
  project: string;
  target: string;
  runnerLabel: string;
  githubEnvironment: string;
  source: {
    ref: string;
    commitSha: string | null;
    releaseDirectory: string;
  };
  server: {
    supportedOperatingSystems: readonly ["ubuntu-22.04", "ubuntu-24.04"];
    aptPackages: string[];
    nodeVersions: string[];
    globalNodePackages: string[];
  };
  domains: string[];
  dnsChecks: PlannedDnsCheck[];
  ports: PlannedPort[];
  files: PlannedFile[];
  processes: PlannedProcess[];
  nginx: PlannedNginxSite;
  certificate: PlannedCertificate;
  phases: DeploymentPhase[];
  secrets: {
    required: string[];
    generated: string[];
    destination: string;
    mode: "0600";
  };
  failurePolicy: {
    checkpointEachPhase: true;
    disableNewNginxSite: true;
    retainArtifacts: readonly ["source", "logs", "ports", "secrets", "process-state", "database-volumes"];
    retryFailedOnly: true;
    refuseCompletedDeployment: true;
  };
}

const defaultPortRange = { start: 20_000, end: 39_999 } as const;
const commitShaPattern = /^[0-9a-f]{40}$/u;

const serverPackages = [
  "ca-certificates",
  "certbot",
  "containerd.io",
  "curl",
  "dnsutils",
  "docker-buildx-plugin",
  "docker-ce",
  "docker-ce-cli",
  "docker-compose-plugin",
  "git",
  "gnupg",
  "jq",
  "nginx",
  "openssl",
  "ufw",
  "util-linux",
  "xz-utils",
] as const;

const phases: DeploymentPhase[] = [
  { code: "PREFLIGHT", description: "Validate manifest, server compatibility, secrets, and first-deploy state", mutatesServer: false },
  { code: "DNS", description: "Resolve direct A/AAAA records and compare them with the server addresses", mutatesServer: false },
  { code: "LOCK", description: "Acquire the server-wide DeployKit deployment lock", mutatesServer: true },
  { code: "ALLOCATE", description: "Reserve domains and stable loopback ports atomically", mutatesServer: true },
  { code: "CHECKOUT", description: "Resolve the requested ref and check out its immutable commit SHA", mutatesServer: true },
  { code: "CONFIGURE", description: "Generate release-local Compose overrides, PM2 definitions, and runtime environment", mutatesServer: true },
  { code: "BUILD", description: "Build Compose images, PM2 applications, and static frontend assets", mutatesServer: true },
  { code: "MIGRATE", description: "Run fatal database migration and seed hooks in order", mutatesServer: true },
  { code: "START", description: "Start declared Compose and PM2 workloads", mutatesServer: true },
  { code: "HEALTH", description: "Wait for every declared workload health policy", mutatesServer: false },
  { code: "NGINX", description: "Stage the Nginx site, validate the complete configuration, and reload atomically", mutatesServer: true },
  { code: "TLS", description: "Issue a webroot certificate and install the validated renewal reload hook", mutatesServer: true },
  { code: "COMPLETE", description: "Persist the successful immutable deployment state", mutatesServer: true },
];

export class DeploymentPlanError extends Error {
  readonly code: "PLAN_TARGET_NOT_FOUND" | "PLAN_OPTIONS_INVALID" | "PLAN_MANIFEST_INVALID";
  override readonly cause?: unknown;

  constructor(
    code: "PLAN_TARGET_NOT_FOUND" | "PLAN_OPTIONS_INVALID" | "PLAN_MANIFEST_INVALID",
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "DeploymentPlanError";
    this.code = code;
    this.cause = options.cause;
  }
}

function defaultInstallCommand(packageManager: "npm" | "pnpm" | "yarn" | "bun"): readonly string[] {
  switch (packageManager) {
    case "npm":
      return ["npm", "ci"];
    case "pnpm":
      return ["pnpm", "install", "--frozen-lockfile"];
    case "yarn":
      return ["yarn", "install", "--immutable"];
    case "bun":
      return ["bun", "install", "--frozen-lockfile"];
  }
}

function portIdForService(name: string): string {
  return `service:${name}`;
}

function routeComparator(left: Route, right: Route): number {
  const hostname = left.hostname.localeCompare(right.hostname);
  if (hostname !== 0) {
    return hostname;
  }

  if (left.match !== right.match) {
    return left.match === "exact" ? -1 : 1;
  }

  return right.path.length - left.path.length || left.path.localeCompare(right.path) || left.target.localeCompare(right.target);
}

function getRoutedServiceNames(
  manifest: DeployKitManifest,
  targetDomains: ReadonlySet<string>,
): Set<string> {
  const names = new Set(
    manifest.routes
      .filter((route) => routeAppliesToTarget(route, targetDomains))
      .map((route) => route.target),
  );
  if (manifest.frontend?.type === "service") {
    names.add(manifest.frontend.service);
  }
  return names;
}

function composeDatabaseNeedsHostPort(manifest: DeployKitManifest): boolean {
  if (manifest.database?.type !== "compose") {
    return false;
  }

  return manifest.database.consumers.some(
    (consumer) => manifest.services[consumer]?.type === "pm2",
  );
}

function plannedPorts(
  manifest: DeployKitManifest,
  range: { start: number; end: number },
  targetDomains: ReadonlySet<string>,
): PlannedPort[] {
  const ports: PlannedPort[] = [];
  const routedNames = getRoutedServiceNames(manifest, targetDomains);

  for (const [name, service] of Object.entries(manifest.services).sort(([a], [b]) => a.localeCompare(b))) {
    if (service.type === "pm2") {
      if (service.role !== "worker") {
        ports.push({
          id: portIdForService(name),
          service: name,
          purpose: "pm2",
          bindAddress: "127.0.0.1",
          allocation: "dynamic",
          range: { ...range },
        });
      }
      continue;
    }

    if (routedNames.has(name) || service.hostPort !== undefined) {
      ports.push({
        id: portIdForService(name),
        service: name,
        purpose: "upstream",
        bindAddress: "127.0.0.1",
        allocation: service.hostPort === undefined ? "dynamic" : "explicit",
        ...(service.hostPort === undefined ? {} : { requestedPort: service.hostPort }),
        internalPort: service.internalPort,
        range: { ...range },
      });
    }
  }

  if (manifest.database?.type === "compose" && composeDatabaseNeedsHostPort(manifest)) {
    ports.push({
      id: "database:compose",
      service: manifest.database.service,
      purpose: "database",
      bindAddress: "127.0.0.1",
      allocation: "dynamic",
      range: { ...range },
    });
  }

  return ports.sort((left, right) => left.id.localeCompare(right.id));
}

function plannedProcesses(
  manifest: DeployKitManifest,
  releaseDirectory: string,
  publicOverrides: Readonly<Record<string, string>>,
  portIds: ReadonlySet<string>,
): PlannedProcess[] {
  const processes: PlannedProcess[] = [];

  for (const [name, service] of Object.entries(manifest.services).sort(([a], [b]) => a.localeCompare(b))) {
    const id = portIdForService(name);
    if (service.type === "compose") {
      processes.push({
        id: name,
        type: "compose",
        service: service.service,
        logicalService: name,
        healthCheck: service.healthCheck,
        ...(portIds.has(id) ? { portId: id } : {}),
      });
      continue;
    }

    processes.push({
      id: name,
      type: "pm2",
      role: service.role,
      workingDirectory: service.workingDirectory,
      nodeVersion: service.nodeVersion,
      packageManager: service.packageManager,
      installCommand: service.installCommand ?? defaultInstallCommand(service.packageManager),
      ...(service.buildScript === undefined ? {} : { buildScript: service.buildScript }),
      startScript: service.startScript,
      ...(service.portEnvironmentVariable === undefined
        ? {}
        : { portEnvironmentVariable: service.portEnvironmentVariable }),
      ...(portIds.has(id) ? { portId: id } : {}),
      healthCheck: service.healthCheck,
    });
  }

  if (manifest.frontend?.type === "static") {
    processes.push({
      id: "frontend",
      type: "static-build",
      workingDirectory: manifest.frontend.workingDirectory,
      nodeVersion: manifest.frontend.nodeVersion,
      packageManager: manifest.frontend.packageManager,
      installCommand:
        manifest.frontend.installCommand ?? defaultInstallCommand(manifest.frontend.packageManager),
      buildScript: manifest.frontend.buildScript,
      outputDirectory: manifest.frontend.outputDirectory,
      destination: `${releaseDirectory}/static`,
      publicEnvironment: {
        ...manifest.frontend.publicEnvironment,
        ...publicOverrides,
      },
    });
  }

  if (manifest.database?.type === "compose") {
    if (manifest.database.migrations !== undefined) {
      processes.push({
        id: "database:migrations",
        type: "hook",
        phase: "migrations",
        service: manifest.database.migrations.service,
        command: manifest.database.migrations.command,
        fatal: true,
      });
    }
    if (manifest.database.seed !== undefined) {
      processes.push({
        id: "database:seed",
        type: "hook",
        phase: "seed",
        service: manifest.database.seed.service,
        command: manifest.database.seed.command,
        fatal: true,
      });
    }
  }

  return processes;
}

function routeAppliesToTarget(route: Route, targetDomains: ReadonlySet<string>): boolean {
  return route.hostname === "@primary" || targetDomains.has(route.hostname);
}

function upstreamPortId(route: Route, service: DeployService): string {
  if (service.type === "pm2" && service.role === "worker") {
    throw new DeploymentPlanError(
      "PLAN_MANIFEST_INVALID",
      `Route '${route.path}' targets PM2 worker '${route.target}'`,
    );
  }
  return portIdForService(route.target);
}

function plannedNginxSite(
  manifest: DeployKitManifest,
  targetName: string,
  releaseDirectory: string,
): PlannedNginxSite {
  const target = manifest.targets[targetName];
  if (target === undefined) {
    throw new DeploymentPlanError("PLAN_TARGET_NOT_FOUND", `Unknown deployment target '${targetName}'`);
  }

  const deploymentId = makeTargetId(manifest.metadata.name, targetName);
  const serverNames = [target.primaryDomain, ...target.aliases].sort((left, right) => {
    if (left === target.primaryDomain) return -1;
    if (right === target.primaryDomain) return 1;
    return left.localeCompare(right);
  });
  const targetDomains = new Set(serverNames);
  const routes = [...manifest.routes]
    .filter((route) => routeAppliesToTarget(route, targetDomains))
    .sort(routeComparator)
    .map<PlannedNginxRoute>((route) => ({
      hostname: route.hostname === "@primary" ? target.primaryDomain : route.hostname,
      path: route.path,
      match: route.match,
      target: route.target,
      upstreamPortId: upstreamPortId(route, manifest.services[route.target]!),
      preservePrefix: route.preservePrefix,
      websocket: route.websocket,
      sse: route.sse,
      buffering: route.buffering,
      requestBuffering: route.requestBuffering,
      ...(route.uploadLimit === undefined ? {} : { uploadLimit: route.uploadLimit }),
      timeouts: {
        connectSeconds: route.timeouts.connect,
        sendSeconds: route.timeouts.send,
        readSeconds: route.timeouts.read,
      },
    }));

  return {
    name: deploymentId,
    serverNames,
    availablePath: `/etc/nginx/sites-available/deploykit-${deploymentId}.conf`,
    enabledPath: `/etc/nginx/sites-enabled/deploykit-${deploymentId}.conf`,
    ...(manifest.frontend?.type === "static"
      ? {
          static: {
            root: `${releaseDirectory}/static`,
            spaFallback: manifest.frontend.spaFallback,
          },
        }
      : {}),
    ...(manifest.frontend?.type === "service"
      ? { frontendUpstreamPortId: portIdForService(manifest.frontend.service) }
      : {}),
    routes,
    usesConnectionUpgradeMap: routes.some((route) => route.websocket),
    activation: "atomic-test-and-reload",
  };
}

function plannedFiles(
  paths: ServerPaths,
  releaseDirectory: string,
  hasCompose: boolean,
  hasPm2: boolean,
  runnerLabel: string,
): PlannedFile[] {
  const files: PlannedFile[] = [
    { path: releaseDirectory, purpose: "Immutable checked-out source and build output", kind: "directory" },
    { path: paths.targetConfigDirectory, purpose: "Per-application configuration", mode: "0700", kind: "directory" },
    { path: paths.secretsFile, purpose: "Required and generated runtime secrets", mode: "0600", kind: "file" },
    { path: paths.deploymentStateFile, purpose: "Phase checkpoints and immutable deployment state", mode: "0600", kind: "file" },
    { path: paths.deploymentLogFile, purpose: "Structured redacted phase and failure log", mode: "0600", kind: "file" },
    { path: paths.deploymentStateLockFile, purpose: "Per-target deployment state lock", mode: "0600", kind: "file" },
    { path: paths.deploymentLockFile, purpose: "Server-wide deployment transaction lock", mode: "0600", kind: "file" },
    { path: paths.registryFile, purpose: "Shared domain and loopback-port registry", mode: "0600", kind: "file" },
    { path: paths.registryLockFile, purpose: "Shared registry lock", mode: "0600", kind: "file" },
    { path: paths.logsDirectory, purpose: "Per-application and deployment logs", mode: "0750", kind: "directory" },
    { path: paths.acmeWebroot, purpose: "Shared Certbot webroot", mode: "0755", kind: "directory" },
    { path: `/etc/deploykit/server-${runnerLabel}.json`, purpose: "Enrolled runner and public-address configuration", mode: "0600", kind: "file" },
    { path: "/etc/nginx/conf.d/deploykit-websocket-map.conf", purpose: "Shared WebSocket connection-upgrade map", mode: "0644", kind: "file" },
    { path: "/etc/letsencrypt/renewal-hooks/deploy/deploykit-nginx-reload", purpose: "Validated certificate renewal reload hook", mode: "0755", kind: "file" },
    { path: paths.nginxAvailableFile, purpose: "DeployKit-managed Nginx virtual host", mode: "0644", kind: "file" },
    { path: paths.nginxEnabledLink, purpose: "Enabled Nginx virtual host", kind: "symlink" },
    { path: paths.currentReleaseLink, purpose: "Atomically activated release", kind: "symlink" },
  ];

  if (hasCompose) {
    files.push({
      path: `${releaseDirectory}/.deploykit/compose.override.yaml`,
      purpose: "Generated loopback-only Compose overrides",
      mode: "0644",
      kind: "file",
    });
  }

  if (hasPm2) {
    files.push({
      path: `${releaseDirectory}/.deploykit/ecosystem.cjs`,
      purpose: "Generated PM2 ecosystem definition",
      mode: "0644",
      kind: "file",
    });
    files.push({
      path: `/etc/systemd/system/deploykit-${paths.targetId}.service`,
      purpose: "Per-application PM2 runtime service",
      mode: "0644",
      kind: "file",
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validateOptions(options: DeploymentPlanOptions): {
  range: { start: number; end: number };
  commitSha: string | null;
  sourceRef: string;
  serverAddresses: string[] | "server-addresses";
} {
  const range = options.portRange ?? defaultPortRange;
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1_024 ||
    range.end > 65_535 ||
    range.start > range.end
  ) {
    throw new DeploymentPlanError(
      "PLAN_OPTIONS_INVALID",
      "Port range must use integer ports between 1024 and 65535 with start <= end",
    );
  }

  if (options.commitSha !== undefined && !commitShaPattern.test(options.commitSha)) {
    throw new DeploymentPlanError(
      "PLAN_OPTIONS_INVALID",
      "commitSha must be a lowercase 40-character Git commit SHA",
    );
  }

  if (options.sourceRef !== undefined && options.sourceRef.trim().length === 0) {
    throw new DeploymentPlanError("PLAN_OPTIONS_INVALID", "sourceRef must not be empty");
  }

  return {
    range: { ...range },
    commitSha: options.commitSha ?? null,
    sourceRef: options.sourceRef ?? "<workflow-ref>",
    serverAddresses:
      options.serverAddresses === undefined
        ? "server-addresses"
        : [...new Set(options.serverAddresses)].sort((left, right) => left.localeCompare(right)),
  };
}

export function createDeploymentPlan(
  input: DeployKitManifest,
  targetName: string,
  options: DeploymentPlanOptions = {},
): DeploymentPlan {
  let manifest: DeployKitManifest;
  try {
    manifest = assertValidManifest(input);
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw new DeploymentPlanError(
        "PLAN_MANIFEST_INVALID",
        "Cannot create a deployment plan from an invalid manifest",
        { cause: error },
      );
    }
    throw error;
  }

  const target = manifest.targets[targetName];
  if (target === undefined) {
    throw new DeploymentPlanError("PLAN_TARGET_NOT_FOUND", `Unknown deployment target '${targetName}'`);
  }

  const normalizedOptions = validateOptions(options);
  const deploymentId = makeTargetId(manifest.metadata.name, targetName);
  const paths = serverPaths(deploymentId);
  const releaseDirectory = normalizedOptions.commitSha === null
    ? `${paths.releasesDirectory}/<resolved-commit-sha>`
    : paths.releaseDirectory(normalizedOptions.commitSha);
  const targetDomains = new Set([target.primaryDomain, ...target.aliases]);
  const ports = plannedPorts(manifest, normalizedOptions.range, targetDomains);
  const portIds = new Set(ports.map((port) => port.id));
  const domains = [target.primaryDomain, ...target.aliases].sort((left, right) => {
    if (left === target.primaryDomain) return -1;
    if (right === target.primaryDomain) return 1;
    return left.localeCompare(right);
  });
  const nodeVersions = new Set<string>();
  for (const service of Object.values(manifest.services)) {
    if (service.type === "pm2") nodeVersions.add(service.nodeVersion);
  }
  if (manifest.frontend?.type === "static") nodeVersions.add(manifest.frontend.nodeVersion);
  nodeVersions.add(BOOTSTRAP_NODE_VERSION);

  return {
    apiVersion: DEPLOYMENT_PLAN_API_VERSION,
    deploymentId,
    project: manifest.metadata.name,
    target: targetName,
    runnerLabel: target.runnerLabel,
    githubEnvironment: target.environment,
    source: {
      ref: normalizedOptions.sourceRef,
      commitSha: normalizedOptions.commitSha,
      releaseDirectory,
    },
    server: {
      supportedOperatingSystems: ["ubuntu-22.04", "ubuntu-24.04"],
      aptPackages: [...serverPackages],
      nodeVersions: [...nodeVersions].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
      globalNodePackages: [`pm2@${PM2_VERSION}`],
    },
    domains,
    dnsChecks: domains.map((domain) => ({
      domain,
      recordTypes: ["A", "AAAA"],
      expectedAddresses: normalizedOptions.serverAddresses,
      directRecordsOnly: true,
      beforeMutation: true,
    })),
    ports,
    files: plannedFiles(
      paths,
      releaseDirectory,
      manifest.compose !== undefined,
      Object.values(manifest.services).some((service) => service.type === "pm2"),
      target.runnerLabel,
    ),
    processes: plannedProcesses(
      manifest,
      releaseDirectory,
      target.publicOverrides,
      portIds,
    ),
    nginx: plannedNginxSite(manifest, targetName, releaseDirectory),
    certificate: {
      provider: "certbot",
      challenge: "webroot",
      domains: [...domains],
      webroot: paths.acmeWebroot,
      staging: options.certbotStaging ?? false,
      managesNginxConfiguration: false,
      renewalReloadHook: "nginx-test-and-reload",
    },
    phases: phases.map((phase) => ({ ...phase })),
    secrets: {
      required: [...manifest.secrets.required].sort(),
      generated: [...manifest.secrets.generated].sort(),
      destination: paths.secretsFile,
      mode: "0600",
    },
    failurePolicy: {
      checkpointEachPhase: true,
      disableNewNginxSite: true,
      retainArtifacts: ["source", "logs", "ports", "secrets", "process-state", "database-volumes"],
      retryFailedOnly: true,
      refuseCompletedDeployment: true,
    },
  };
}

export const generateDeploymentPlan = createDeploymentPlan;
