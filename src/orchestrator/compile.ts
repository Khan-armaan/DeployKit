import { createHash } from "node:crypto";

import { VERSION } from "../version.js";
import { canonicalRuntimeManifestBytes, compareCodePoints, computeManifestDigest } from "./canonical.js";
import {
  RUNTIME_MANIFEST_API_VERSION,
  type CompiledRuntimeManifest,
  type DeployKitOperatorConfig,
  type HealthCheckInput,
  type ManifestDigest,
  type OperatorDatabase,
  type OperatorFrontend,
  type OperatorRoute,
  type OperatorService,
  type RuntimeDatabase,
  type RuntimeFrontend,
  type RuntimeHealthCheck,
  type RuntimeRoute,
  type RuntimeService,
} from "./contracts.js";
import type { ConfigIssue, ParsedOperatorConfig } from "./config-schema.js";
import { orchestratorError } from "./failures.js";

/**
 * Phase 3 turns the hand-edited operator config into the one secret-free input
 * the deterministic deployment engine accepts.
 *
 * Two properties make a resume safe and are asserted by the phase tests:
 *
 * - equivalent configs compile to byte-identical manifests, so the digest is a
 *   function of intent rather than of YAML formatting or key order;
 * - a backend secret *value* never reaches the manifest, so rotating one leaves
 *   the digest — and therefore the deployment identity — unchanged.
 *
 * Nothing here reads the filesystem, resolves a commit, or contacts GitHub or a
 * VPS. `hostPort: auto` compiles to *no* requested port so allocation stays
 * server-owned under the existing global registry lock.
 */

// ------------------------------------------------------------- normalization --

/**
 * Runtime defaults for values the operator may omit. They are part of the
 * canonical bytes, so changing one changes every manifest digest.
 */
export const RUNTIME_HEALTH_DEFAULTS = Object.freeze({
  intervalSeconds: 10,
  timeoutSeconds: 5,
  retries: 5,
  startPeriodSeconds: 20,
});

export const RUNTIME_ROUTE_TIMEOUT_DEFAULTS = Object.freeze({
  connect: 5,
  send: 60,
  read: 60,
});

export const RUNTIME_HTTP_EXPECTED_STATUSES: readonly number[] = Object.freeze([200]);
export const RUNTIME_DEFAULT_WORKING_DIRECTORY = "." as const;
export const RUNTIME_DEFAULT_BUILD_SCRIPT = "build" as const;

function sortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function sortedRecord(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareCodePoints(left, right)),
  );
}

/**
 * A stable 128-bit identity for one repository/target pair. It is independent of
 * the manifest so a config edit never moves a deployment's server state, ports,
 * Nginx file, or release directory.
 */
export function makeOrchestratorTargetId(repository: string, targetName: string): string {
  const raw = `${repository}${String.fromCharCode(0)}${targetName}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

function compileHealthCheck(check: HealthCheckInput): RuntimeHealthCheck {
  const timing = {
    intervalSeconds: check.intervalSeconds ?? RUNTIME_HEALTH_DEFAULTS.intervalSeconds,
    timeoutSeconds: check.timeoutSeconds ?? RUNTIME_HEALTH_DEFAULTS.timeoutSeconds,
    retries: check.retries ?? RUNTIME_HEALTH_DEFAULTS.retries,
    startPeriodSeconds: check.startPeriodSeconds ?? RUNTIME_HEALTH_DEFAULTS.startPeriodSeconds,
  };

  switch (check.type) {
    case "http":
      return {
        type: "http",
        path: check.path,
        ...(check.port === undefined ? {} : { port: check.port }),
        expectedStatuses: [...(check.expectedStatuses ?? RUNTIME_HTTP_EXPECTED_STATUSES)],
        ...timing,
      };
    case "tcp":
      return { type: "tcp", ...(check.port === undefined ? {} : { port: check.port }), ...timing };
    case "command":
      return { type: "command", command: [...check.command], ...timing };
    case "process":
      return { type: "process", ...timing };
  }
}

/** `auto` means "no caller-requested port"; the server allocates it. */
function requestedHostPort(hostPort: "auto" | number | undefined): number | undefined {
  return typeof hostPort === "number" ? hostPort : undefined;
}

function compileService(service: OperatorService): RuntimeService {
  if (service.type === "compose") {
    const hostPort = requestedHostPort(service.hostPort);
    return {
      type: "compose",
      service: service.service,
      internalPort: service.internalPort,
      ...(hostPort === undefined ? {} : { hostPort }),
      healthCheck: compileHealthCheck(service.healthCheck),
    };
  }

  const base = {
    type: "pm2" as const,
    workingDirectory: service.workingDirectory ?? RUNTIME_DEFAULT_WORKING_DIRECTORY,
    nodeVersion: service.nodeVersion,
    packageManager: service.packageManager,
    ...(service.installCommand === undefined ? {} : { installCommand: [...service.installCommand] }),
    ...(service.buildScript === undefined ? {} : { buildScript: service.buildScript }),
    startScript: service.startScript,
    healthCheck: compileHealthCheck(service.healthCheck),
  };

  if (service.role === "worker") return { ...base, role: "worker" };

  const hostPort = requestedHostPort(service.hostPort);
  return {
    ...base,
    role: service.role,
    portEnvironmentVariable: service.portEnvironmentVariable,
    ...(hostPort === undefined ? {} : { hostPort }),
  };
}

function compileFrontend(
  frontend: OperatorFrontend,
  publicEnvironment: Readonly<Record<string, string>>,
): RuntimeFrontend {
  if (frontend.type === "service") {
    return { type: "service", service: frontend.service, publicEnvironment };
  }
  return {
    type: "static",
    workingDirectory: frontend.workingDirectory ?? RUNTIME_DEFAULT_WORKING_DIRECTORY,
    nodeVersion: frontend.nodeVersion,
    packageManager: frontend.packageManager,
    ...(frontend.installCommand === undefined ? {} : { installCommand: [...frontend.installCommand] }),
    buildScript: frontend.buildScript ?? RUNTIME_DEFAULT_BUILD_SCRIPT,
    outputDirectory: frontend.outputDirectory,
    spaFallback: frontend.spaFallback ?? true,
    publicEnvironment,
  };
}

function compileRoute(route: OperatorRoute): RuntimeRoute {
  return {
    hostname: route.hostname ?? "@primary",
    path: route.path,
    match: route.match ?? "prefix",
    target: route.target,
    preservePrefix: route.preservePrefix ?? true,
    websocket: route.websocket ?? false,
    sse: route.sse ?? false,
    // Server-sent events cannot stream through a buffering proxy. A WebSocket
    // leaves proxy buffering behind when it upgrades, so it keeps the default.
    buffering: route.buffering ?? !(route.sse ?? false),
    requestBuffering: route.requestBuffering ?? true,
    ...(route.uploadLimit === undefined ? {} : { uploadLimit: route.uploadLimit }),
    timeouts: {
      connect: route.timeouts?.connect ?? RUNTIME_ROUTE_TIMEOUT_DEFAULTS.connect,
      send: route.timeouts?.send ?? RUNTIME_ROUTE_TIMEOUT_DEFAULTS.send,
      read: route.timeouts?.read ?? RUNTIME_ROUTE_TIMEOUT_DEFAULTS.read,
    },
  };
}

/**
 * The order generated Nginx locations are emitted in: most specific first. It is
 * total and independent of the order the operator happened to type, so two
 * equivalent configs cannot produce different manifest bytes.
 */
export function compareRuntimeRoutes(left: RuntimeRoute, right: RuntimeRoute): number {
  const hostname = compareCodePoints(left.hostname, right.hostname);
  if (hostname !== 0) return hostname;
  if (left.match !== right.match) return left.match === "exact" ? -1 : 1;
  if (left.path.length !== right.path.length) return right.path.length - left.path.length;
  return compareCodePoints(left.path, right.path) || compareCodePoints(left.target, right.target);
}

function compileDatabase(database: OperatorDatabase): RuntimeDatabase {
  if (database.type === "external") {
    return {
      type: "external",
      connectionStringSecret: database.connectionStringSecret,
      ...(database.tlsCaSecret === undefined ? {} : { tlsCaSecret: database.tlsCaSecret }),
      requireTls: database.requireTls ?? true,
    };
  }

  const credentials = database.credentials;
  return {
    type: "compose",
    service: database.service,
    ...(database.internalPort === undefined ? {} : { internalPort: database.internalPort }),
    consumers: sortedStrings(database.consumers),
    volume: database.volume,
    credentials: {
      username: credentials.username,
      database: credentials.database,
      passwordSecret: credentials.passwordSecret,
      ...(credentials.connectionStringSecret === undefined
        ? {}
        : { connectionStringSecret: credentials.connectionStringSecret }),
      ...(credentials.connectionStringTemplate === undefined
        ? {}
        : { connectionStringTemplate: credentials.connectionStringTemplate }),
    },
    ...(database.migrations === undefined
      ? {}
      : { migrations: { service: database.migrations.service, command: [...database.migrations.command] } }),
    ...(database.seed === undefined
      ? {}
      : { seed: { service: database.seed.service, command: [...database.seed.command] } }),
  };
}

// -------------------------------------------------------- compile semantics --

/**
 * Cross-field rules that only become checkable once defaults are applied. They
 * report field paths and names, never values.
 */
function compileIssues(
  config: DeployKitOperatorConfig,
  publicEnvironment: Readonly<Record<string, string>>,
): readonly ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const publicNames = Object.keys(publicEnvironment);

  if (publicNames.length > 0 && config.frontend === undefined) {
    issues.push({
      path: ["environment", "frontend"],
      code: "PUBLIC_ENVIRONMENT_WITHOUT_FRONTEND",
      message: `declares ${publicNames.length} public value(s) but the config has no frontend to build them into`,
    });
  }

  // Two logical services may not claim one Compose service; the server would
  // otherwise start, health-check, and route the same container twice.
  const composeOwners = new Map<string, string>();
  for (const [name, service] of Object.entries(config.services)) {
    if (service.type !== "compose") continue;
    const previous = composeOwners.get(service.service);
    if (previous !== undefined) {
      issues.push({
        path: ["services", name, "service"],
        code: "COMPOSE_SERVICE_DUPLICATE",
        message: `Compose service '${service.service}' is already represented by '${previous}'`,
      });
    } else {
      composeOwners.set(service.service, name);
    }
  }
  if (config.database?.type === "compose") {
    const owner = composeOwners.get(config.database.service);
    if (owner !== undefined) {
      issues.push({
        path: ["database", "service"],
        code: "DATABASE_SERVICE_IS_WORKLOAD",
        message: `Compose service '${config.database.service}' is already declared as workload '${owner}'`,
      });
    }
  }

  return issues;
}

// ------------------------------------------------------------------ compile --

export interface CompileOptions {
  /**
   * DeployKit version the compiled manifest requires on the VPS. It is part of
   * the canonical bytes, so a runtime upgrade produces a new digest.
   */
  readonly requiredVersion?: string;
}

export interface CompiledDeployment {
  readonly manifest: CompiledRuntimeManifest;
  /** The exact bytes the digest is taken over and the gateway receives. */
  readonly canonicalBytes: Buffer;
  readonly digest: ManifestDigest;
  readonly targetId: string;
  readonly repository: string;
  readonly applicationRef: string;
  readonly targetName: string;
}

export function compileRuntimeManifest(
  parsed: ParsedOperatorConfig,
  options: CompileOptions = {},
): CompiledDeployment {
  const { config, environment } = parsed;
  const publicEnvironment = sortedRecord(environment.publicValues);

  const issues = compileIssues(config, publicEnvironment);
  if (issues.length > 0) {
    throw orchestratorError(
      "DK_CONFIG_INVALID",
      `deploykit.config.yaml cannot be compiled into a runtime manifest (${issues.length} issue(s)): ${issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      { details: { issues } },
    );
  }

  const targetId = makeOrchestratorTargetId(config.project.repository, config.target.name);
  const services = Object.fromEntries(
    Object.entries(config.services)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([name, service]) => [name, compileService(service)]),
  );
  const routes = (config.routes ?? []).map(compileRoute).sort(compareRuntimeRoutes);

  const manifest: CompiledRuntimeManifest = {
    apiVersion: RUNTIME_MANIFEST_API_VERSION,
    metadata: {
      name: config.project.name,
      requiredVersion: options.requiredVersion ?? VERSION,
    },
    target: {
      name: config.target.name,
      targetId,
      githubEnvironment: config.target.githubEnvironment,
      primaryDomain: config.target.primaryDomain,
      aliases: sortedStrings(config.target.aliases ?? []),
    },
    ...(config.compose === undefined ? {} : { compose: { files: [...config.compose.files] } }),
    services,
    ...(config.frontend === undefined
      ? {}
      : { frontend: compileFrontend(config.frontend, publicEnvironment) }),
    routes,
    ...(config.database === undefined ? {} : { database: compileDatabase(config.database) }),
    secrets: {
      required: [...environment.declaredSecretNames].sort(compareCodePoints),
      generated: [...environment.generatedNames].sort(compareCodePoints),
    },
  };

  const canonicalBytes = canonicalRuntimeManifestBytes(manifest);

  return {
    manifest,
    canonicalBytes,
    digest: computeManifestDigest(canonicalBytes),
    targetId,
    repository: config.project.repository,
    applicationRef: config.project.ref,
    targetName: config.target.name,
  };
}
