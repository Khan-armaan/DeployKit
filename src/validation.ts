import type { ZodIssue } from "zod";

import {
  type DeployKitManifest,
  type DeployService,
  deployKitManifestSchema,
} from "./manifest.js";
import { isValidVersionRequirement } from "./version.js";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  path: ReadonlyArray<string | number>;
  message: string;
  remediation?: string;
}

export interface ValidationResult<T = DeployKitManifest> {
  valid: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  value?: T;
  /** Alias retained for callers that prefer a domain-specific property. */
  manifest?: T;
}

const secretLikeNamePattern = /(?:^|_)(?:API_?)?KEY(?:_|$)|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|DATABASE_URL|CONNECTION_STRING/iu;

function issue(
  code: string,
  path: ReadonlyArray<string | number>,
  message: string,
  remediation?: string,
  severity: ValidationSeverity = "error",
): ValidationIssue {
  return { code, severity, path, message, ...(remediation ? { remediation } : {}) };
}

function compareIssues(left: ValidationIssue, right: ValidationIssue): number {
  const severity = left.severity.localeCompare(right.severity);
  if (severity !== 0) {
    return severity;
  }

  const path = formatValidationPath(left.path).localeCompare(formatValidationPath(right.path));
  if (path !== 0) {
    return path;
  }

  return left.code.localeCompare(right.code) || left.message.localeCompare(right.message);
}

function resultFromIssues<T>(issues: ValidationIssue[], value?: T): ValidationResult<T> {
  const sorted = [...issues].sort(compareIssues);
  const errors = sorted.filter((entry) => entry.severity === "error");
  const warnings = sorted.filter((entry) => entry.severity === "warning");

  return {
    valid: errors.length === 0,
    issues: sorted,
    errors,
    warnings,
    ...(value === undefined ? {} : { value, manifest: value }),
  };
}

function pathFromZodIssue(zodIssue: ZodIssue): Array<string | number> {
  return zodIssue.path.map((part) => (typeof part === "symbol" ? part.description ?? part.toString() : part));
}

function collectDuplicateIssues(
  values: readonly string[],
  path: ReadonlyArray<string | number>,
  code: string,
  label: string,
): ValidationIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      duplicates.add(value);
    }
    seen.add(normalized);
  }

  return [...duplicates]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => issue(code, path, `${label} contains duplicate value '${value}'`));
}

function isRoutable(service: DeployService): boolean {
  return service.type === "compose" || service.role !== "worker";
}

function serviceHasHostRouteForTarget(
  manifest: DeployKitManifest,
  serviceName: string,
  targetName: string,
): boolean {
  if (manifest.frontend?.type === "service" && manifest.frontend.service === serviceName) return true;
  const target = manifest.targets[targetName];
  if (target === undefined) return false;
  const domains = new Set([target.primaryDomain, ...target.aliases]);
  return manifest.routes.some(
    (route) => route.target === serviceName &&
      (route.hostname === "@primary" || domains.has(route.hostname)),
  );
}

function semanticIssues(manifest: DeployKitManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const serviceEntries = Object.entries(manifest.services);
  const hasComposeWorkload =
    serviceEntries.some(([, service]) => service.type === "compose") ||
    manifest.database?.type === "compose";

  if (!isValidVersionRequirement(manifest.metadata.requiredVersion)) {
    issues.push(
      issue(
        "DEPLOYKIT_VERSION_REQUIREMENT_INVALID",
        ["metadata", "requiredVersion"],
        `'${manifest.metadata.requiredVersion}' is not a valid semantic-version requirement`,
        "Use an exact version such as 0.1.0 or a standard semver range such as ^0.1.0.",
      ),
    );
  }

  if (serviceEntries.length === 0 && manifest.frontend === undefined) {
    issues.push(
      issue(
        "WORKLOAD_REQUIRED",
        ["services"],
        "The manifest must define at least one service or a frontend",
      ),
    );
  }

  if (hasComposeWorkload && manifest.compose === undefined) {
    issues.push(
      issue(
        "COMPOSE_FILES_REQUIRED",
        ["compose"],
        "Compose files are required when a Compose service or database is configured",
        "Add compose.files with the existing project-relative Compose file path(s).",
      ),
    );
  }

  if (!hasComposeWorkload && manifest.compose !== undefined) {
    issues.push(
      issue(
        "COMPOSE_FILES_UNUSED",
        ["compose", "files"],
        "Compose files are configured but no Compose workload uses them",
        undefined,
        "warning",
      ),
    );
  }

  if (manifest.compose !== undefined) {
    issues.push(
      ...collectDuplicateIssues(
        manifest.compose.files,
        ["compose", "files"],
        "COMPOSE_FILE_DUPLICATE",
        "compose.files",
      ),
    );
  }

  const composeNames = new Map<string, string>();
  const explicitHostPorts = new Map<number, string>();

  for (const [name, service] of serviceEntries) {
    const servicePath: Array<string | number> = ["services", name];

    if (service.type === "compose") {
      const previous = composeNames.get(service.service);
      if (previous !== undefined) {
        issues.push(
          issue(
            "COMPOSE_SERVICE_DUPLICATE",
            [...servicePath, "service"],
            `Compose service '${service.service}' is already represented by logical service '${previous}'`,
          ),
        );
      } else {
        composeNames.set(service.service, name);
      }

      if (service.healthCheck.type === "process") {
        issues.push(
          issue(
            "COMPOSE_PROCESS_HEALTH_UNSUPPORTED",
            [...servicePath, "healthCheck", "type"],
            "Process health checks are only valid for PM2 workloads",
            "Use an HTTP, TCP, or command health check for this Compose service.",
          ),
        );
      }

      if (
        (service.healthCheck.type === "http" || service.healthCheck.type === "tcp") &&
        service.hostPort === undefined
      ) {
        for (const targetName of Object.keys(manifest.targets)) {
          if (serviceHasHostRouteForTarget(manifest, name, targetName)) continue;
          issues.push(
            issue(
              "COMPOSE_HOST_HEALTH_UNREACHABLE",
              [...servicePath, "healthCheck"],
              `Compose service '${name}' has a host-side ${service.healthCheck.type.toUpperCase()} health check but no loopback binding for target '${targetName}'`,
              "Use a command health check for a private Compose service, route the service on every target, or declare an explicit loopback hostPort.",
            ),
          );
        }
      }

      if (service.hostPort !== undefined) {
        const previousPortOwner = explicitHostPorts.get(service.hostPort);
        if (previousPortOwner !== undefined) {
          issues.push(
            issue(
              "HOST_PORT_DUPLICATE",
              [...servicePath, "hostPort"],
              `Host port ${service.hostPort} is also requested by service '${previousPortOwner}'`,
              "Remove explicit host ports to let DeployKit allocate stable loopback ports.",
            ),
          );
        } else {
          explicitHostPorts.set(service.hostPort, name);
        }
      }

      continue;
    }

    const isWorker = service.role === "worker";
    if (!isWorker && service.portEnvironmentVariable === undefined) {
      issues.push(
        issue(
          "PM2_PORT_ENV_REQUIRED",
          [...servicePath, "portEnvironmentVariable"],
          `PM2 ${service.role} service '${name}' must declare the environment variable used for its allocated port`,
          "Set portEnvironmentVariable (commonly PORT).",
        ),
      );
    }

    if (isWorker && service.portEnvironmentVariable !== undefined) {
      issues.push(
        issue(
          "PM2_WORKER_PORT_FORBIDDEN",
          [...servicePath, "portEnvironmentVariable"],
          `PM2 worker '${name}' cannot request a public upstream port`,
          "Remove portEnvironmentVariable or change the role to api/ssr.",
        ),
      );
    }

    if (isWorker && !["process", "command"].includes(service.healthCheck.type)) {
      issues.push(
        issue(
          "PM2_WORKER_HEALTH_INVALID",
          [...servicePath, "healthCheck", "type"],
          `PM2 worker '${name}' must use a process or command health check`,
        ),
      );
    }

    if (!isWorker && service.healthCheck.type === "process") {
      issues.push(
        issue(
          "PM2_UPSTREAM_HEALTH_INVALID",
          [...servicePath, "healthCheck", "type"],
          `PM2 ${service.role} service '${name}' must use an HTTP, TCP, or command health check`,
        ),
      );
    }

    if (
      service.installCommand !== undefined &&
      service.installCommand[0] !== service.packageManager &&
      service.installCommand[0] !== "corepack"
    ) {
      issues.push(
        issue(
          "PACKAGE_MANAGER_COMMAND_MISMATCH",
          [...servicePath, "installCommand", 0],
          `Install command starts with '${service.installCommand[0]}' but packageManager is '${service.packageManager}'`,
          undefined,
          "warning",
        ),
      );
    }
  }

  const labels = new Map<string, string[]>();
  for (const [targetName, target] of Object.entries(manifest.targets)) {
    labels.set(target.runnerLabel, [...(labels.get(target.runnerLabel) ?? []), targetName]);
  }
  if (explicitHostPorts.size > 0) {
    for (const [runnerLabel, targetNames] of labels) {
      if (targetNames.length < 2) continue;
      issues.push(
        issue(
          "HOST_PORT_SHARED_RUNNER_COLLISION",
          ["targets"],
          `Targets ${targetNames.join(", ")} share runner '${runnerLabel}' while services request fixed host ports`,
          "Use dynamic host ports or place the targets on different runner labels.",
        ),
      );
    }
  }

  if (manifest.frontend?.type === "service") {
    const frontendService = manifest.services[manifest.frontend.service];
    if (frontendService === undefined) {
      issues.push(
        issue(
          "FRONTEND_SERVICE_UNKNOWN",
          ["frontend", "service"],
          `Frontend references unknown service '${manifest.frontend.service}'`,
        ),
      );
    } else if (!isRoutable(frontendService)) {
      issues.push(
        issue(
          "FRONTEND_SERVICE_NOT_HTTP",
          ["frontend", "service"],
          `Frontend cannot target worker service '${manifest.frontend.service}'`,
        ),
      );
    }
  }

  if (manifest.frontend?.type === "static") {
    for (const variable of Object.keys(manifest.frontend.publicEnvironment)) {
      if (secretLikeNamePattern.test(variable)) {
        issues.push(
          issue(
            "PUBLIC_ENV_SECRET_LIKE",
            ["frontend", "publicEnvironment", variable],
            `Public build variable '${variable}' looks like a secret and would be embedded in frontend assets`,
            "Move sensitive values to secrets.required and consume them only in a server-side service.",
          ),
        );
      }
    }
  }

  const knownDomains = new Set<string>();
  const domainOwner = new Map<string, string>();
  for (const [targetName, target] of Object.entries(manifest.targets)) {
    const targetDomains = [target.primaryDomain, ...target.aliases];
    issues.push(
      ...collectDuplicateIssues(
        targetDomains,
        ["targets", targetName],
        "TARGET_DOMAIN_DUPLICATE",
        `target '${targetName}' domains`,
      ),
    );

    for (const domain of targetDomains) {
      const normalized = domain.toLowerCase();
      const previousOwner = domainOwner.get(normalized);
      if (previousOwner !== undefined && previousOwner !== targetName) {
        issues.push(
          issue(
            "DOMAIN_TARGET_COLLISION",
            ["targets", targetName],
            `Domain '${domain}' is already assigned to target '${previousOwner}'`,
          ),
        );
      } else {
        domainOwner.set(normalized, targetName);
      }
      knownDomains.add(normalized);
    }

    if (manifest.frontend?.type === "static") {
      const declaredPublicVariables = new Set(Object.keys(manifest.frontend.publicEnvironment));
      for (const variable of Object.keys(target.publicOverrides)) {
        if (!declaredPublicVariables.has(variable)) {
          issues.push(
            issue(
              "PUBLIC_OVERRIDE_UNDECLARED",
              ["targets", targetName, "publicOverrides", variable],
              `Public override '${variable}' is not declared by frontend.publicEnvironment`,
            ),
          );
        }
      }
    } else if (Object.keys(target.publicOverrides).length > 0) {
      issues.push(
        issue(
          "PUBLIC_OVERRIDES_WITHOUT_STATIC_FRONTEND",
          ["targets", targetName, "publicOverrides"],
          "Public build overrides require a static frontend",
        ),
      );
    }
  }

  const routeKeys = new Map<string, number>();
  for (const [index, route] of manifest.routes.entries()) {
    const routePath: Array<string | number> = ["routes", index];
    const target = manifest.services[route.target];
    if (target === undefined) {
      issues.push(
        issue(
          "ROUTE_TARGET_UNKNOWN",
          [...routePath, "target"],
          `Route references unknown service '${route.target}'`,
        ),
      );
    } else if (!isRoutable(target)) {
      issues.push(
        issue(
          "ROUTE_TARGET_NOT_HTTP",
          [...routePath, "target"],
          `Route cannot target worker service '${route.target}'`,
        ),
      );
    }

    if (route.hostname !== "@primary" && !knownDomains.has(route.hostname.toLowerCase())) {
      issues.push(
        issue(
          "ROUTE_HOSTNAME_UNKNOWN",
          [...routePath, "hostname"],
          `Route hostname '${route.hostname}' is not declared by any target`,
        ),
      );
    }

    if (route.websocket && route.sse) {
      issues.push(
        issue(
          "ROUTE_STREAM_MODE_CONFLICT",
          routePath,
          "A route cannot enable both WebSocket upgrades and server-sent events",
        ),
      );
    }

    if (route.match === "prefix" && route.path !== "/" && !route.path.endsWith("/")) {
      issues.push(
        issue(
          "ROUTE_PREFIX_AMBIGUOUS",
          [...routePath, "path"],
          `Prefix route '${route.path}' must end with '/'`,
          `Use '${route.path}/' or set match: exact.`,
        ),
      );
    }

    if ((route.websocket || route.sse) && route.buffering) {
      issues.push(
        issue(
          "ROUTE_STREAM_BUFFERING_ENABLED",
          [...routePath, "buffering"],
          "Streaming routes must disable proxy buffering",
          "Set buffering: false.",
        ),
      );
    }

    const routeKey = `${route.hostname}\u0000${route.match}\u0000${route.path}`;
    const previousIndex = routeKeys.get(routeKey);
    if (previousIndex !== undefined) {
      issues.push(
        issue(
          "ROUTE_DUPLICATE",
          routePath,
          `Route duplicates routes[${previousIndex}] for ${route.hostname} ${route.match} ${route.path}`,
        ),
      );
    } else {
      routeKeys.set(routeKey, index);
    }
  }

  const requiredSecrets = manifest.secrets.required;
  const generatedSecrets = manifest.secrets.generated;
  issues.push(
    ...collectDuplicateIssues(
      requiredSecrets,
      ["secrets", "required"],
      "SECRET_REQUIRED_DUPLICATE",
      "secrets.required",
    ),
    ...collectDuplicateIssues(
      generatedSecrets,
      ["secrets", "generated"],
      "SECRET_GENERATED_DUPLICATE",
      "secrets.generated",
    ),
  );

  const requiredSecretSet = new Set(requiredSecrets);
  const generatedSecretSet = new Set(generatedSecrets);
  if (!requiredSecretSet.has("CERTBOT_EMAIL")) {
    issues.push(
      issue(
        "CERTBOT_EMAIL_SECRET_REQUIRED",
        ["secrets", "required"],
        "TLS issuance requires CERTBOT_EMAIL to be declared as a required server secret",
        "Add CERTBOT_EMAIL to secrets.required and set it with `deploykit secrets set`.",
      ),
    );
  }
  for (const name of [...requiredSecretSet].sort()) {
    if (generatedSecretSet.has(name)) {
      issues.push(
        issue(
          "SECRET_KIND_CONFLICT",
          ["secrets"],
          `Secret '${name}' cannot be both required and generated`,
        ),
      );
    }
  }

  const declaredSecretSet = new Set([...requiredSecrets, ...generatedSecrets]);
  for (const [targetName, target] of Object.entries(manifest.targets)) {
    for (const variable of Object.keys(target.runtimeOverrides)) {
      if (declaredSecretSet.has(variable) || secretLikeNamePattern.test(variable)) {
        issues.push(
          issue(
            "SECRET_VALUE_IN_RUNTIME_OVERRIDE",
            ["targets", targetName, "runtimeOverrides", variable],
            `Secret-like variable '${variable}' must not be stored as a plaintext target override`,
            "Set it with `deploykit secrets set` instead.",
          ),
        );
      }
    }
    for (const variable of Object.keys(target.publicOverrides)) {
      if (declaredSecretSet.has(variable) || secretLikeNamePattern.test(variable)) {
        issues.push(
          issue(
            "SECRET_VALUE_IN_PUBLIC_OVERRIDE",
            ["targets", targetName, "publicOverrides", variable],
            `Secret-like variable '${variable}' must not be exposed to frontend assets`,
          ),
        );
      }
    }
  }

  if (manifest.database?.type === "external") {
    const secretReferences = [
      ["connectionStringSecret", manifest.database.connectionStringSecret],
      ...(manifest.database.tlsCaSecret === undefined
        ? []
        : [["tlsCaSecret", manifest.database.tlsCaSecret]]),
    ] as const;

    for (const [field, secret] of secretReferences) {
      if (!requiredSecretSet.has(secret)) {
        issues.push(
          issue(
            "EXTERNAL_DATABASE_SECRET_REQUIRED",
            ["database", field],
            `External database secret '${secret}' must be listed in secrets.required`,
          ),
        );
      }
    }
  }

  if (manifest.database?.type === "compose") {
    issues.push(
      ...collectDuplicateIssues(
        manifest.database.consumers,
        ["database", "consumers"],
        "DATABASE_CONSUMER_DUPLICATE",
        "database.consumers",
      ),
    );

    for (const [index, consumer] of manifest.database.consumers.entries()) {
      if (manifest.services[consumer] === undefined) {
        issues.push(
          issue(
            "DATABASE_CONSUMER_UNKNOWN",
            ["database", "consumers", index],
            `Database consumer '${consumer}' is not a declared service`,
          ),
        );
      }
    }

    const hasPm2Consumer = manifest.database.consumers.some(
      (consumer) => manifest.services[consumer]?.type === "pm2",
    );
    if (hasPm2Consumer && manifest.database.internalPort === undefined) {
      issues.push(
        issue(
          "COMPOSE_DATABASE_INTERNAL_PORT_REQUIRED",
          ["database", "internalPort"],
          "A Compose database consumed by PM2 must declare its container port",
          "Set database.internalPort so DeployKit can create a loopback-only host binding.",
        ),
      );
    }

    const connectionSecret = manifest.database.credentials.connectionStringSecret;
    const connectionTemplate = manifest.database.credentials.connectionStringTemplate;
    if ((connectionSecret === undefined) !== (connectionTemplate === undefined)) {
      issues.push(
        issue(
          "COMPOSE_DATABASE_CONNECTION_PAIR_REQUIRED",
          ["database", "credentials"],
          "connectionStringSecret and connectionStringTemplate must be configured together",
        ),
      );
    }
    if (connectionTemplate !== undefined) {
      const allowed = new Set(["username", "password", "host", "port", "database"]);
      const placeholders = [...connectionTemplate.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]!);
      const unexpected = placeholders.filter((name) => !allowed.has(name));
      const missing = [...allowed].filter((name) => !placeholders.includes(name));
      if (unexpected.length > 0 || missing.length > 0) {
        issues.push(
          issue(
            "COMPOSE_DATABASE_CONNECTION_TEMPLATE_INVALID",
            ["database", "credentials", "connectionStringTemplate"],
            `Connection template must contain exactly the supported placeholders; missing: ${missing.join(", ") || "none"}; unsupported: ${unexpected.join(", ") || "none"}`,
            "Use {username}, {password}, {host}, {port}, and {database}; write the scheme and other syntax literally.",
          ),
        );
      }
    }

    const generatedReferences = [
      ["passwordSecret", manifest.database.credentials.passwordSecret],
      ...(manifest.database.credentials.connectionStringSecret === undefined
        ? []
        : [["connectionStringSecret", manifest.database.credentials.connectionStringSecret]]),
    ] as const;

    for (const [field, secret] of generatedReferences) {
      if (!generatedSecretSet.has(secret)) {
        issues.push(
          issue(
            "COMPOSE_DATABASE_SECRET_GENERATED",
            ["database", "credentials", field],
            `Compose database secret '${secret}' must be listed in secrets.generated`,
          ),
        );
      }
    }

    for (const hookName of ["migrations", "seed"] as const) {
      const hook = manifest.database[hookName];
      if (hook !== undefined && manifest.services[hook.service] === undefined) {
        issues.push(
          issue(
            "DATABASE_HOOK_SERVICE_UNKNOWN",
            ["database", hookName, "service"],
            `${hookName === "migrations" ? "Migration" : "Seed"} hook references unknown service '${hook.service}'`,
          ),
        );
      }
    }
  }

  return issues;
}

export function validateManifest(input: unknown): ValidationResult {
  const parsed = deployKitManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((zodIssue) =>
      issue(
        "MANIFEST_SCHEMA_INVALID",
        pathFromZodIssue(zodIssue),
        zodIssue.message,
        "Correct the value to match deploykit/v1alpha1.",
      ),
    );
    return resultFromIssues(issues);
  }

  return resultFromIssues(semanticIssues(parsed.data), parsed.data);
}

export function validateManifestSemantics(manifest: DeployKitManifest): ValidationResult {
  return resultFromIssues(semanticIssues(manifest), manifest);
}

export class ManifestValidationError extends Error {
  readonly code = "MANIFEST_VALIDATION_FAILED" as const;
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const errors = issues.filter((entry) => entry.severity === "error");
    super(`Manifest validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}`);
    this.name = "ManifestValidationError";
    this.issues = [...issues];
  }
}

export function assertValidManifest(input: unknown): DeployKitManifest {
  const validation = validateManifest(input);
  if (!validation.valid || validation.manifest === undefined) {
    throw new ManifestValidationError(validation.issues);
  }
  return validation.manifest;
}

export function formatValidationPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((formatted, part) => {
    if (typeof part === "number") {
      return `${formatted}[${part}]`;
    }
    return `${formatted}.${part}`;
  }, "$");
}

export function formatValidationIssue(entry: ValidationIssue): string {
  return `[${entry.code}] ${formatValidationPath(entry.path)}: ${entry.message}`;
}

type ComposeConfigService = {
  container_name?: unknown;
  ports?: unknown;
  network_mode?: unknown;
  deploy?: unknown;
  volumes?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the normalized output of `docker compose config`. DeployKit generates
 * its own loopback-only override, so any pre-existing published port is unsafe.
 */
export function validateComposeConfiguration(
  configuration: unknown,
  manifest?: DeployKitManifest,
): ValidationResult<Record<string, unknown>> {
  if (!isObject(configuration)) {
    return resultFromIssues([
      issue("COMPOSE_CONFIG_INVALID", ["compose"], "Docker Compose configuration must be an object"),
    ]);
  }

  const issues: ValidationIssue[] = [];
  const rawServices = configuration.services;
  if (!isObject(rawServices)) {
    return resultFromIssues([
      issue("COMPOSE_SERVICES_MISSING", ["compose", "services"], "Docker Compose config has no services object"),
    ]);
  }

  for (const [serviceName, rawService] of Object.entries(rawServices).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isObject(rawService)) {
      issues.push(
        issue(
          "COMPOSE_SERVICE_INVALID",
          ["compose", "services", serviceName],
          `Compose service '${serviceName}' must be an object`,
        ),
      );
      continue;
    }

    const service = rawService as ComposeConfigService;
    if (typeof service.container_name === "string" && service.container_name.length > 0) {
      issues.push(
        issue(
          "COMPOSE_CONTAINER_NAME_UNSAFE",
          ["compose", "services", serviceName, "container_name"],
          `Compose service '${serviceName}' fixes container_name to '${service.container_name}'`,
          "Remove container_name so Compose can namespace containers per deployment.",
        ),
      );
    }

    if (Array.isArray(service.ports) && service.ports.length > 0) {
      service.ports.forEach((_port, index) => {
        issues.push(
          issue(
            "COMPOSE_PUBLISHED_PORT_UNMANAGED",
            ["compose", "services", serviceName, "ports", index],
            `Compose service '${serviceName}' publishes a port outside DeployKit's allocator`,
            "Remove the ports entry; keep the container port exposed internally and declare internalPort in deploykit.yaml.",
          ),
        );
      });
    }
    if (typeof service.network_mode === "string" && service.network_mode.length > 0) {
      issues.push(
        issue(
          "COMPOSE_NETWORK_MODE_UNSAFE",
          ["compose", "services", serviceName, "network_mode"],
          `Compose service '${serviceName}' sets network_mode to '${service.network_mode}'`,
          "Remove network_mode and use Compose networks managed under the deployment project name.",
        ),
      );
    }
    if (isObject(service.deploy)) {
      const replicas = service.deploy.replicas;
      if (typeof replicas === "number" && Number.isInteger(replicas) && replicas !== 1) {
        issues.push(
          issue(
            "COMPOSE_REPLICAS_UNSUPPORTED",
            ["compose", "services", serviceName, "deploy", "replicas"],
            `Compose service '${serviceName}' requests ${replicas} replicas`,
            "Use one replica in DeployKit v0.1.",
          ),
        );
      }
    }
  }

  if (manifest !== undefined) {
    for (const [logicalName, service] of Object.entries(manifest.services)) {
      if (service.type === "compose" && rawServices[service.service] === undefined) {
        issues.push(
          issue(
            "COMPOSE_SERVICE_NOT_FOUND",
            ["services", logicalName, "service"],
            `Compose config does not contain service '${service.service}'`,
          ),
        );
      }
    }

    if (manifest.database?.type === "compose") {
      const composeDatabase = manifest.database;
      if (rawServices[composeDatabase.service] === undefined) {
        issues.push(
          issue(
            "COMPOSE_DATABASE_SERVICE_NOT_FOUND",
            ["database", "service"],
            `Compose config does not contain database service '${composeDatabase.service}'`,
          ),
        );
      }

      if (isObject(configuration.volumes) && configuration.volumes[composeDatabase.volume] === undefined) {
        issues.push(
          issue(
            "COMPOSE_DATABASE_VOLUME_NOT_FOUND",
            ["database", "volume"],
            `Compose config does not declare volume '${composeDatabase.volume}'`,
          ),
        );
      }
      const databaseService = rawServices[composeDatabase.service];
      if (isObject(databaseService) && Array.isArray(databaseService.volumes)) {
        const mounted = databaseService.volumes.some((entry) => {
          if (typeof entry === "string") return entry.split(":", 1)[0] === composeDatabase.volume;
          return isObject(entry) && entry.source === composeDatabase.volume && (entry.type === undefined || entry.type === "volume");
        });
        if (!mounted) {
          issues.push(
            issue(
              "COMPOSE_DATABASE_VOLUME_NOT_MOUNTED",
              ["database", "volume"],
              `Compose database service '${composeDatabase.service}' does not mount '${composeDatabase.volume}'`,
            ),
          );
        }
      }
    }
  }

  return resultFromIssues(issues, configuration);
}
