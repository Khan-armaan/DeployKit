import { z } from "zod";

import type { DeployKitError } from "../errors.js";

import {
  commandSchema,
  domainSchema,
  environmentNameSchema,
  identifierSchema,
  relativePathSchema,
} from "../manifest.js";
import { orchestratorError } from "./failures.js";
import { createExactValueRedactor, type ExactValueRedactor } from "./redaction.js";
import { OPERATOR_CONFIG_API_VERSION, type DeployKitOperatorConfig } from "./contracts.js";

/**
 * Phase 2 owns the `config-schema` boundary: it turns the untrusted, hand-edited
 * `deploykit.config.yaml` into the frozen `DeployKitOperatorConfig` shape, or
 * refuses it with `DK_CONFIG_PLACEHOLDER` / `DK_CONFIG_INVALID`.
 *
 * Nothing here reads the filesystem, touches the network, or applies runtime
 * defaults. Defaults belong to the Phase 3 compiler so the parsed config stays a
 * faithful record of what the operator actually wrote.
 */

// ------------------------------------------------------------- primitives --

const EXACT_NODE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const PACKAGE_SCRIPT_PATTERN = /^[A-Za-z0-9:_-]+$/u;
const UPLOAD_LIMIT_PATTERN = /^[1-9]\d*(?:[kKmMgG])?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SSH_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const GITHUB_ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,254}$/u;
const GIT_REF_CHARACTER_PATTERN = /^[A-Za-z0-9._\-/]+$/u;
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;
const IPV6_PATTERN = /^[0-9A-Fa-f:]{2,45}$/u;
const DATABASE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const VOLUME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const CONNECTION_TEMPLATE_PLACEHOLDER = /\{([a-z]+)\}/gu;
const CONNECTION_TEMPLATE_FIELDS: ReadonlySet<string> = new Set([
  "username",
  "password",
  "host",
  "port",
  "database",
]);

/** Names that would embed a credential into publicly served build output. */
export const PUBLIC_SECRET_LIKE_PATTERN =
  /(^|_)(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|API_KEY|ACCESS_KEY)(_|$)/u;

/** Reserved for values DeployKit itself injects into the runtime environment. */
export const RESERVED_ENVIRONMENT_PREFIX = "DEPLOYKIT_" as const;

/**
 * Literal fragments shipped in `assets/deploykit.config.example.yaml`. They are
 * matched case-insensitively against every scalar in the parsed document before
 * schema validation, so a freshly scaffolded file always reports
 * `DK_CONFIG_PLACEHOLDER` instead of a confusing field-level type error.
 */
export const CONFIG_PLACEHOLDER_TOKENS: readonly string[] = Object.freeze([
  "your-org",
  "your-repo",
  "example.com",
  "example-app",
  "/home/you/",
  "/absolute/path/to",
  "replace-with",
  "replace_with",
  "replace-me",
  "changeme",
  "change-me",
]);

function isSafeGitRef(value: string): boolean {
  if (!GIT_REF_CHARACTER_PATTERN.test(value)) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (value.startsWith("-") || value.endsWith(".")) return false;
  return !value
    .split("/")
    .some((segment) => segment === "" || segment.startsWith(".") || segment.endsWith(".lock"));
}

function isAbsoluteFilePath(value: string): boolean {
  if (!value.startsWith("/") || /[\0\n\r]/u.test(value)) return false;
  return !value.split("/").some((segment) => segment === "..");
}

function isConnectionHost(value: string): boolean {
  return domainSchema.safeParse(value).success ||
    IPV4_PATTERN.test(value) ||
    (value.includes(":") && IPV6_PATTERN.test(value));
}

const positiveSecondsSchema = z.number().int().positive().max(86_400);
const portNumberSchema = z.number().int().min(1).max(65_535);

const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeGitRef, "must be a safe Git ref without '..', empty, or dot-leading segments");

const repositorySchema = z
  .string()
  .min(3)
  .max(140)
  .regex(REPOSITORY_PATTERN, "must be a GitHub repository as owner/name");

const sshHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isConnectionHost, "must be a fully-qualified domain name or an IP address");

const absoluteFilePathSchema = z
  .string()
  .min(2)
  .max(4_096)
  .refine(isAbsoluteFilePath, "must be an absolute path without '..' or control characters");

const hostPortSchema = z.union([z.literal("auto"), portNumberSchema]);

const packageManagerSchema = z.enum(["npm", "pnpm", "yarn", "bun"]);

const nodeVersionSchema = z
  .string()
  .regex(EXACT_NODE_VERSION_PATTERN, "must be an exact Node.js version such as 22.18.0");

const packageScriptSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(PACKAGE_SCRIPT_PATTERN, "must be a package script name");

// ---------------------------------------------------------- health checks --

const healthTimingFields = {
  intervalSeconds: positiveSecondsSchema.optional(),
  timeoutSeconds: positiveSecondsSchema.optional(),
  retries: z.number().int().positive().max(1_000).optional(),
  startPeriodSeconds: z.number().int().nonnegative().max(86_400).optional(),
};

export const operatorHttpHealthCheckSchema = z.strictObject({
  type: z.literal("http"),
  path: z.string().startsWith("/").max(2_048),
  port: portNumberSchema.optional(),
  expectedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(16).optional(),
  ...healthTimingFields,
});

export const operatorTcpHealthCheckSchema = z.strictObject({
  type: z.literal("tcp"),
  port: portNumberSchema.optional(),
  ...healthTimingFields,
});

export const operatorCommandHealthCheckSchema = z.strictObject({
  type: z.literal("command"),
  command: commandSchema,
  ...healthTimingFields,
});

export const operatorProcessHealthCheckSchema = z.strictObject({
  type: z.literal("process"),
  ...healthTimingFields,
});

export const operatorHealthCheckSchema = z.discriminatedUnion("type", [
  operatorHttpHealthCheckSchema,
  operatorTcpHealthCheckSchema,
  operatorCommandHealthCheckSchema,
  operatorProcessHealthCheckSchema,
]);

// --------------------------------------------------------------- services --

export const operatorComposeServiceSchema = z.strictObject({
  type: z.literal("compose"),
  service: identifierSchema,
  internalPort: portNumberSchema,
  hostPort: hostPortSchema.optional(),
  healthCheck: operatorHealthCheckSchema,
});

const pm2ServiceFields = {
  type: z.literal("pm2"),
  workingDirectory: relativePathSchema.optional(),
  nodeVersion: nodeVersionSchema,
  packageManager: packageManagerSchema,
  installCommand: commandSchema.optional(),
  buildScript: packageScriptSchema.optional(),
  startScript: packageScriptSchema,
  healthCheck: operatorHealthCheckSchema,
};

export const operatorPm2NetworkServiceSchema = z.strictObject({
  ...pm2ServiceFields,
  role: z.enum(["api", "ssr"]),
  portEnvironmentVariable: environmentNameSchema,
  hostPort: hostPortSchema.optional(),
});

export const operatorPm2WorkerServiceSchema = z.strictObject({
  ...pm2ServiceFields,
  role: z.literal("worker"),
});

export const operatorPm2ServiceSchema = z.discriminatedUnion("role", [
  operatorPm2NetworkServiceSchema,
  operatorPm2WorkerServiceSchema,
]);

export const operatorServiceSchema = z.union([
  operatorComposeServiceSchema,
  operatorPm2ServiceSchema,
]);

// --------------------------------------------------------------- frontend --

export const operatorStaticFrontendSchema = z.strictObject({
  type: z.literal("static"),
  workingDirectory: relativePathSchema.optional(),
  nodeVersion: nodeVersionSchema,
  packageManager: packageManagerSchema,
  installCommand: commandSchema.optional(),
  buildScript: packageScriptSchema.optional(),
  outputDirectory: relativePathSchema,
  spaFallback: z.boolean().optional(),
});

export const operatorServiceFrontendSchema = z.strictObject({
  type: z.literal("service"),
  service: identifierSchema,
});

export const operatorFrontendSchema = z.discriminatedUnion("type", [
  operatorStaticFrontendSchema,
  operatorServiceFrontendSchema,
]);

// ----------------------------------------------------------------- routes --

export const operatorRouteSchema = z.strictObject({
  hostname: z.union([z.literal("@primary"), domainSchema]).optional(),
  path: z
    .string()
    .startsWith("/")
    .max(2_048)
    .refine(
      (path) =>
        !/[\s{};$#"'\\]/u.test(path) &&
        ![...path].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint < 32 || codePoint === 127;
        }),
      "must not contain whitespace, control, or Nginx metacharacters",
    ),
  match: z.enum(["exact", "prefix"]).optional(),
  target: identifierSchema,
  preservePrefix: z.boolean().optional(),
  websocket: z.boolean().optional(),
  sse: z.boolean().optional(),
  buffering: z.boolean().optional(),
  requestBuffering: z.boolean().optional(),
  uploadLimit: z.string().regex(UPLOAD_LIMIT_PATTERN, "must be an Nginx size such as 25m").optional(),
  timeouts: z
    .strictObject({
      connect: positiveSecondsSchema.optional(),
      send: positiveSecondsSchema.optional(),
      read: positiveSecondsSchema.optional(),
    })
    .optional(),
});

// --------------------------------------------------------------- database --

export const operatorDeploymentHookSchema = z.strictObject({
  service: identifierSchema,
  command: commandSchema,
});

export const operatorComposeDatabaseSchema = z.strictObject({
  type: z.literal("compose"),
  service: identifierSchema,
  internalPort: portNumberSchema.optional(),
  consumers: z.array(identifierSchema).min(1).max(64),
  volume: z.string().regex(VOLUME_PATTERN, "must be a Compose volume name"),
  credentials: z.strictObject({
    username: z.string().regex(DATABASE_IDENTIFIER_PATTERN, "must be a database role name"),
    database: z.string().regex(DATABASE_IDENTIFIER_PATTERN, "must be a database name"),
    passwordSecret: environmentNameSchema,
    connectionStringSecret: environmentNameSchema.optional(),
    connectionStringTemplate: z
      .string()
      .min(1)
      .max(2_048)
      .refine((template) => {
        const fields = [...template.matchAll(CONNECTION_TEMPLATE_PLACEHOLDER)].map((match) => match[1] ?? "");
        return fields.length > 0 && fields.every((field) => CONNECTION_TEMPLATE_FIELDS.has(field));
      }, "may only interpolate {username}, {password}, {host}, {port}, and {database}")
      .optional(),
  }),
  migrations: operatorDeploymentHookSchema.optional(),
  seed: operatorDeploymentHookSchema.optional(),
});

export const operatorExternalDatabaseSchema = z.strictObject({
  type: z.literal("external"),
  connectionStringSecret: environmentNameSchema,
  tlsCaSecret: environmentNameSchema.optional(),
  requireTls: z.boolean().optional(),
});

export const operatorDatabaseSchema = z.discriminatedUnion("type", [
  operatorComposeDatabaseSchema,
  operatorExternalDatabaseSchema,
]);

// ------------------------------------------------------------- whole file --

export const operatorConfigSchema = z.strictObject({
  apiVersion: z.literal(OPERATOR_CONFIG_API_VERSION),
  kind: z.literal("Deployment"),
  project: z.strictObject({
    name: identifierSchema,
    repository: repositorySchema,
    ref: gitRefSchema,
  }),
  target: z.strictObject({
    name: identifierSchema,
    githubEnvironment: z
      .string()
      .regex(GITHUB_ENVIRONMENT_PATTERN, "must be a GitHub Environment name"),
    primaryDomain: domainSchema,
    aliases: z.array(domainSchema).max(64).optional(),
  }),
  server: z.strictObject({
    host: sshHostSchema,
    user: z.string().regex(SSH_USER_PATTERN, "must be a Linux account name"),
    port: portNumberSchema,
    identityFile: absoluteFilePathSchema,
    hostKeyFingerprint: z
      .string()
      .regex(HOST_KEY_FINGERPRINT_PATTERN, "must be an OpenSSH SHA256 host-key fingerprint"),
    configureFirewall: z.boolean().optional(),
  }),
  compose: z
    .strictObject({
      files: z.array(relativePathSchema).min(1).max(16),
    })
    .optional(),
  services: z.record(identifierSchema, operatorServiceSchema),
  frontend: operatorFrontendSchema.optional(),
  routes: z.array(operatorRouteSchema).max(128).optional(),
  database: operatorDatabaseSchema.optional(),
  environment: z.strictObject({
    frontend: z.record(environmentNameSchema, z.string().max(32_768)).default({}),
    backend: z.record(environmentNameSchema, z.string().max(262_144)).default({}),
    generated: z.array(environmentNameSchema).max(256).default([]),
  }),
});

export type OperatorConfigInput = z.input<typeof operatorConfigSchema>;

// ------------------------------------------------------------ diagnostics --

export interface ConfigIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export function formatConfigPath(path: readonly (string | number)[]): string {
  return path.length === 0
    ? "deploykit.config.yaml"
    : path.reduce<string>(
        (rendered, segment) =>
          typeof segment === "number" ? `${rendered}[${segment}]` : rendered === "" ? segment : `${rendered}.${segment}`,
        "",
      );
}

function configInvalid(issues: readonly ConfigIssue[]): DeployKitError {
  const summary = issues
    .slice(0, 5)
    .map((issue) => `${formatConfigPath(issue.path)}: ${issue.message}`)
    .join("; ");
  return orchestratorError(
    "DK_CONFIG_INVALID",
    `deploykit.config.yaml is not a valid ${OPERATOR_CONFIG_API_VERSION} deployment (${issues.length} issue(s)): ${summary}`,
    { details: { issues } },
  );
}

// ------------------------------------------------------------ placeholders --

/**
 * Walks scalars only. Values are never included in the result: a placeholder is
 * reported by its field path and the matched example token, so the report stays
 * safe even when the offending scalar sits under `environment.backend`.
 */
export function findConfigPlaceholders(document: unknown): readonly ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (typeof value === "string") {
      const lowered = value.toLowerCase();
      const token = CONFIG_PLACEHOLDER_TOKENS.find((candidate) => lowered.includes(candidate));
      if (token !== undefined) {
        issues.push({
          path,
          code: "CONFIG_PLACEHOLDER",
          message: `still contains the bundled example placeholder '${token}'`,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => { visit(entry, [...path, index]); });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, [...path, key]);
      }
    }
  };

  visit(document, []);
  return issues;
}

// --------------------------------------------------------------- semantics --

function collectServicePorts(config: DeployKitOperatorConfig): Map<number, string[]> {
  const ports = new Map<number, string[]>();
  for (const [name, service] of Object.entries(config.services)) {
    const hostPort = "hostPort" in service ? service.hostPort : undefined;
    if (typeof hostPort !== "number") continue;
    ports.set(hostPort, [...(ports.get(hostPort) ?? []), name]);
  }
  return ports;
}

function routableServiceNames(config: DeployKitOperatorConfig): Set<string> {
  return new Set(
    Object.entries(config.services)
      .filter(([, service]) => service.type === "compose" || service.role !== "worker")
      .map(([name]) => name),
  );
}

/**
 * Cross-field rules the Zod schema cannot express. Every rule reports a field
 * path and a name; no rule ever reports a value.
 */
export function validateOperatorConfigSemantics(config: DeployKitOperatorConfig): readonly ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (path: readonly (string | number)[], code: string, message: string): void => {
    issues.push({ path, code, message });
  };

  const serviceNames = new Set(Object.keys(config.services));
  const routable = routableServiceNames(config);
  if (serviceNames.size === 0) push(["services"], "NO_SERVICE", "must declare at least one workload");

  // Compose files are required by every Compose-backed workload and database.
  const usesCompose = Object.values(config.services).some((service) => service.type === "compose") ||
    config.database?.type === "compose";
  if (usesCompose && config.compose === undefined) {
    push(["compose"], "COMPOSE_FILES_MISSING", "must list the application Compose files used by compose workloads");
  }
  if (!usesCompose && config.compose !== undefined) {
    push(["compose"], "COMPOSE_FILES_UNUSED", "declares Compose files but no workload or database uses Compose");
  }
  if (config.compose !== undefined) {
    const seen = new Set<string>();
    config.compose.files.forEach((file, index) => {
      if (seen.has(file)) push(["compose", "files", index], "COMPOSE_FILE_DUPLICATE", `duplicates '${file}'`);
      seen.add(file);
    });
  }

  // Domains.
  const domains = new Set<string>([config.target.primaryDomain]);
  (config.target.aliases ?? []).forEach((alias, index) => {
    if (domains.has(alias)) {
      push(["target", "aliases", index], "DOMAIN_DUPLICATE", `duplicates the domain '${alias}'`);
    }
    domains.add(alias);
  });

  // Explicit host ports must not collide with each other.
  for (const [port, names] of collectServicePorts(config)) {
    if (names.length > 1) {
      push(["services"], "HOST_PORT_COLLISION", `services ${names.join(", ")} all request host port ${port}`);
    }
  }

  // Frontend.
  if (config.frontend?.type === "service" && !serviceNames.has(config.frontend.service)) {
    push(["frontend", "service"], "UNRESOLVED_FRONTEND", `'${config.frontend.service}' is not a declared service`);
  }
  if (config.frontend?.type === "service" && !routable.has(config.frontend.service)) {
    push(["frontend", "service"], "UNROUTABLE_FRONTEND", `'${config.frontend.service}' is a worker and cannot serve HTTP`);
  }

  // Routes.
  const seenRoutes = new Map<string, number>();
  (config.routes ?? []).forEach((route, index) => {
    const hostname = route.hostname ?? "@primary";
    const match = route.match ?? "prefix";
    const key = `${hostname}\u0000${match}\u0000${route.path}`;
    const previous = seenRoutes.get(key);
    if (previous !== undefined) {
      push(["routes", index], "ROUTE_AMBIGUOUS", `duplicates routes[${previous}] for ${hostname} ${match} ${route.path}`);
    }
    seenRoutes.set(key, index);
    if (hostname !== "@primary" && !domains.has(hostname)) {
      push(["routes", index, "hostname"], "ROUTE_HOSTNAME_UNKNOWN", `'${hostname}' is not a declared target domain`);
    }
    if (!serviceNames.has(route.target)) {
      push(["routes", index, "target"], "ROUTE_TARGET_UNKNOWN", `'${route.target}' is not a declared service`);
    } else if (!routable.has(route.target)) {
      push(["routes", index, "target"], "ROUTE_TARGET_UNROUTABLE", `'${route.target}' is a worker and has no port`);
    }
  });

  // Environment partitions.
  const publicNames = Object.keys(config.environment.frontend);
  const backendNames = Object.keys(config.environment.backend);
  const generatedNames = config.environment.generated;
  const partitions: readonly (readonly [string, readonly string[]])[] = [
    ["frontend", publicNames],
    ["backend", backendNames],
    ["generated", generatedNames],
  ];
  const owner = new Map<string, string>();
  for (const [partition, names] of partitions) {
    names.forEach((name, index) => {
      const path = partition === "generated"
        ? ["environment", "generated", index] as const
        : ["environment", partition, name] as const;
      if (name.startsWith(RESERVED_ENVIRONMENT_PREFIX)) {
        push(path, "ENVIRONMENT_NAME_RESERVED", `'${name}' uses the reserved ${RESERVED_ENVIRONMENT_PREFIX} prefix`);
      }
      const previous = owner.get(name);
      if (previous !== undefined) {
        push(path, "ENVIRONMENT_NAME_DUPLICATE", `'${name}' is already declared under environment.${previous}`);
      } else {
        owner.set(name, partition);
      }
    });
  }
  for (const name of publicNames) {
    if (PUBLIC_SECRET_LIKE_PATTERN.test(name)) {
      push(
        ["environment", "frontend", name],
        "PUBLIC_NAME_SECRET_LIKE",
        `'${name}' is named like a secret but frontend values are embedded in public build output`,
      );
    }
  }

  // Declared secret names must exist in a private partition.
  const privateNames = new Set([...backendNames, ...generatedNames]);
  const requireSecret = (name: string, path: readonly (string | number)[]): void => {
    if (!privateNames.has(name)) {
      push(path, "SECRET_NOT_DECLARED", `'${name}' is not declared under environment.backend or environment.generated`);
    }
  };

  if (config.database?.type === "compose") {
    const database = config.database;
    requireSecret(database.credentials.passwordSecret, ["database", "credentials", "passwordSecret"]);
    if (database.credentials.connectionStringSecret !== undefined) {
      requireSecret(database.credentials.connectionStringSecret, ["database", "credentials", "connectionStringSecret"]);
    }
    database.consumers.forEach((consumer, index) => {
      if (!serviceNames.has(consumer)) {
        push(["database", "consumers", index], "DATABASE_CONSUMER_UNKNOWN", `'${consumer}' is not a declared service`);
      }
    });
    for (const [hook, key] of [[database.migrations, "migrations"], [database.seed, "seed"]] as const) {
      if (hook !== undefined && !serviceNames.has(hook.service)) {
        push(["database", key, "service"], "DATABASE_HOOK_UNKNOWN", `'${hook.service}' is not a declared service`);
      }
    }
  }
  if (config.database?.type === "external") {
    requireSecret(config.database.connectionStringSecret, ["database", "connectionStringSecret"]);
    if (config.database.tlsCaSecret !== undefined) {
      requireSecret(config.database.tlsCaSecret, ["database", "tlsCaSecret"]);
    }
  }

  return issues;
}

// -------------------------------------------------------------- partitions --

export interface EnvironmentPartition {
  /** Build-time values that legitimately appear in public artifacts. */
  readonly publicValues: Readonly<Record<string, string>>;
  /** Operator-supplied secret values. Never persist or serialize these. */
  readonly backendValues: Readonly<Record<string, string>>;
  /** Secret names the VPS generates and preserves; no local value exists. */
  readonly generatedNames: readonly string[];
  /** Every private secret name, sorted, for the secret-free runtime manifest. */
  readonly declaredSecretNames: readonly string[];
}

function sortedEntries(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function partitionEnvironment(config: DeployKitOperatorConfig): EnvironmentPartition {
  const backendValues = sortedEntries(config.environment.backend);
  const generatedNames = [...config.environment.generated].sort();
  return {
    publicValues: sortedEntries(config.environment.frontend),
    backendValues,
    generatedNames,
    declaredSecretNames: [...new Set([...Object.keys(backendValues), ...generatedNames])].sort(),
  };
}

export interface ParsedOperatorConfig {
  readonly config: DeployKitOperatorConfig;
  readonly environment: EnvironmentPartition;
  /** Initialized from the backend values before any further processing. */
  readonly redactor: ExactValueRedactor;
}

// ------------------------------------------------------------------ parse --

/**
 * Order matters. Placeholders are detected on the raw document first so a
 * freshly scaffolded file reports `DK_CONFIG_PLACEHOLDER` rather than the
 * schema error its example values happen to trigger.
 */
export function parseOperatorConfig(document: unknown): ParsedOperatorConfig {
  const placeholders = findConfigPlaceholders(document);
  if (placeholders.length > 0) {
    throw orchestratorError(
      "DK_CONFIG_PLACEHOLDER",
      `deploykit.config.yaml still holds ${placeholders.length} bundled example placeholder value(s): ${placeholders
        .slice(0, 5)
        .map((issue) => formatConfigPath(issue.path))
        .join(", ")}`,
      { details: { issues: placeholders } },
    );
  }

  const parsed = operatorConfigSchema.safeParse(document);
  if (!parsed.success) {
    throw configInvalid(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  const config = parsed.data as DeployKitOperatorConfig;
  const environment = partitionEnvironment(config);
  const redactor = createExactValueRedactor(Object.values(environment.backendValues));

  const semantic = validateOperatorConfigSemantics(config);
  if (semantic.length > 0) throw configInvalid(semantic);

  return { config, environment, redactor };
}
