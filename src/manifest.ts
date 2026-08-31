import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const DEPLOYKIT_API_VERSION = "deploykit/v1alpha1" as const;
export const DEFAULT_MANIFEST_FILE = "deploykit.yaml";

const identifierPattern = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/;
const exactNodeVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const packageScriptPattern = /^[A-Za-z0-9:_-]+$/;
const uploadLimitPattern = /^[1-9]\d*(?:[kKmMgG])?$/;
const runnerLabelPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;

function isSafeRelativePath(value: string): boolean {
  if (value === ".") {
    return true;
  }

  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }

  return !value.split(/[\\/]/u).some((segment) => segment === ".." || segment === "");
}

function isDomainName(value: string): boolean {
  if (value.length > 253 || value !== value.toLowerCase() || value.endsWith(".")) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length < 2) {
    return false;
  }

  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

export const identifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(identifierPattern, "must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_'");

export const environmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(environmentNamePattern, "must be a valid environment-variable name");

export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isDomainName, "must be a lowercase fully-qualified domain name");

export const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafeRelativePath, "must be a safe project-relative path without '..'");

export const commandSchema = z
  .array(z.string().min(1).max(4_096))
  .min(1)
  .max(128)
  .readonly();

const positiveSecondsSchema = z.number().int().positive().max(86_400);

const healthTimingFields = {
  intervalSeconds: positiveSecondsSchema.default(10),
  timeoutSeconds: positiveSecondsSchema.default(5),
  retries: z.number().int().positive().max(1_000).default(12),
  startPeriodSeconds: z.number().int().nonnegative().max(86_400).default(0),
};

export const httpHealthCheckSchema = z
  .strictObject({
    type: z.literal("http"),
    path: z.string().startsWith("/").max(2_048),
    port: z.number().int().min(1).max(65_535).optional(),
    expectedStatuses: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .default([200]),
    ...healthTimingFields,
  });

export const tcpHealthCheckSchema = z.strictObject({
  type: z.literal("tcp"),
  port: z.number().int().min(1).max(65_535).optional(),
  ...healthTimingFields,
});

export const commandHealthCheckSchema = z.strictObject({
  type: z.literal("command"),
  command: commandSchema,
  ...healthTimingFields,
});

export const processHealthCheckSchema = z.strictObject({
  type: z.literal("process"),
  ...healthTimingFields,
});

export const healthCheckSchema = z.discriminatedUnion("type", [
  httpHealthCheckSchema,
  tcpHealthCheckSchema,
  commandHealthCheckSchema,
  processHealthCheckSchema,
]);

export const composeServiceSchema = z.strictObject({
  type: z.literal("compose"),
  service: identifierSchema,
  internalPort: z.number().int().min(1).max(65_535),
  hostPort: z.number().int().min(1).max(65_535).optional(),
  healthCheck: healthCheckSchema,
});

export const pm2ServiceSchema = z.strictObject({
  type: z.literal("pm2"),
  role: z.enum(["api", "ssr", "worker"]),
  workingDirectory: relativePathSchema.default("."),
  nodeVersion: z
    .string()
    .regex(exactNodeVersionPattern, "must be an exact Node.js version such as 22.14.0"),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
  installCommand: commandSchema.optional(),
  buildScript: z.string().regex(packageScriptPattern, "must be a package script name").optional(),
  startScript: z.string().regex(packageScriptPattern, "must be a package script name"),
  portEnvironmentVariable: environmentNameSchema.optional(),
  healthCheck: healthCheckSchema,
});

export const serviceSchema = z.discriminatedUnion("type", [
  composeServiceSchema,
  pm2ServiceSchema,
]);

export const staticFrontendSchema = z.strictObject({
  type: z.literal("static"),
  workingDirectory: relativePathSchema.default("."),
  nodeVersion: z
    .string()
    .regex(exactNodeVersionPattern, "must be an exact Node.js version such as 22.14.0"),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
  installCommand: commandSchema.optional(),
  buildScript: z
    .string()
    .regex(packageScriptPattern, "must be a package script name")
    .default("build"),
  outputDirectory: relativePathSchema,
  spaFallback: z.boolean().default(true),
  apiBasePath: z.string().startsWith("/").default("/api"),
  publicEnvironment: z.record(environmentNameSchema, z.string()).default({}),
});

export const serviceFrontendSchema = z.strictObject({
  type: z.literal("service"),
  service: identifierSchema,
});

export const frontendSchema = z.discriminatedUnion("type", [
  staticFrontendSchema,
  serviceFrontendSchema,
]);

export const routeTimeoutsSchema = z.strictObject({
  connect: positiveSecondsSchema.default(60),
  send: positiveSecondsSchema.default(60),
  read: positiveSecondsSchema.default(60),
});

const routeInputSchema = z.strictObject({
  hostname: z.union([z.literal("@primary"), domainSchema]).default("@primary"),
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
      "must not contain whitespace or control characters",
    ),
  match: z.enum(["exact", "prefix"]).default("prefix"),
  target: identifierSchema,
  preservePrefix: z.boolean().default(true),
  websocket: z.boolean().default(false),
  sse: z.boolean().default(false),
  buffering: z.boolean().optional(),
  requestBuffering: z.boolean().default(true),
  uploadLimit: z
    .string()
    .regex(uploadLimitPattern, "must be an Nginx size such as 25m")
    .optional(),
  timeouts: routeTimeoutsSchema.default({ connect: 60, send: 60, read: 60 }),
});

export const routeSchema = routeInputSchema.transform((route) => ({
  ...route,
  buffering: route.buffering ?? !(route.websocket || route.sse),
}));

export const deploymentHookSchema = z.strictObject({
  service: identifierSchema,
  command: commandSchema,
});

export const composeDatabaseSchema = z.strictObject({
  type: z.literal("compose"),
  service: identifierSchema,
  internalPort: z.number().int().min(1).max(65_535).optional(),
  consumers: z.array(identifierSchema).min(1),
  volume: z.string().min(1).max(255),
  credentials: z.strictObject({
    username: z.string().min(1).max(128),
    database: z.string().min(1).max(128),
    passwordSecret: environmentNameSchema,
    connectionStringSecret: environmentNameSchema.optional(),
    connectionStringTemplate: z.string().min(1).max(2_048).optional(),
  }),
  migrations: deploymentHookSchema.optional(),
  seed: deploymentHookSchema.optional(),
});

export const externalDatabaseSchema = z.strictObject({
  type: z.literal("external"),
  connectionStringSecret: environmentNameSchema,
  tlsCaSecret: environmentNameSchema.optional(),
  requireTls: z.boolean().default(true),
});

export const databaseSchema = z.discriminatedUnion("type", [
  composeDatabaseSchema,
  externalDatabaseSchema,
]);

export const secretsSchema = z.strictObject({
  required: z.array(environmentNameSchema).default([]),
  generated: z.array(environmentNameSchema).default([]),
});

export const targetSchema = z.strictObject({
  runnerLabel: z.string().regex(runnerLabelPattern, "must match an enrolled lowercase server label"),
  primaryDomain: domainSchema,
  aliases: z.array(domainSchema).default([]),
  environment: z.string().min(1).max(255).default("production"),
  publicOverrides: z.record(environmentNameSchema, z.string()).default({}),
  runtimeOverrides: z.record(environmentNameSchema, z.string()).default({}),
});

export const deployKitManifestSchema = z.strictObject({
  apiVersion: z.literal(DEPLOYKIT_API_VERSION),
  metadata: z.strictObject({
    name: identifierSchema,
    requiredVersion: z.string().min(1).max(128),
  }),
  compose: z
    .strictObject({
      files: z.array(relativePathSchema).min(1),
    })
    .optional(),
  services: z.record(identifierSchema, serviceSchema).default({}),
  frontend: frontendSchema.optional(),
  routes: z.array(routeSchema).default([]),
  database: databaseSchema.optional(),
  secrets: secretsSchema.default({ required: [], generated: [] }),
  targets: z.record(identifierSchema, targetSchema).refine(
    (targets) => Object.keys(targets).length > 0,
    "must define at least one deployment target",
  ),
});

/** Backwards-friendly schema alias for library consumers. */
export const manifestSchema = deployKitManifestSchema;

export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type ComposeService = z.infer<typeof composeServiceSchema>;
export type Pm2Service = z.infer<typeof pm2ServiceSchema>;
export type DeployService = z.infer<typeof serviceSchema>;
export type StaticFrontend = z.infer<typeof staticFrontendSchema>;
export type ServiceFrontend = z.infer<typeof serviceFrontendSchema>;
export type Frontend = z.infer<typeof frontendSchema>;
export type Route = z.infer<typeof routeSchema>;
export type DeploymentHook = z.infer<typeof deploymentHookSchema>;
export type ComposeDatabase = z.infer<typeof composeDatabaseSchema>;
export type ExternalDatabase = z.infer<typeof externalDatabaseSchema>;
export type Database = z.infer<typeof databaseSchema>;
export type DeployTarget = z.infer<typeof targetSchema>;
export type DeployKitManifest = z.infer<typeof deployKitManifestSchema>;
export type ProjectManifest = DeployKitManifest;
export type DeployKitManifestInput = z.input<typeof deployKitManifestSchema>;

export class ManifestFileError extends Error {
  readonly code: "MANIFEST_READ_FAILED" | "MANIFEST_YAML_INVALID";
  readonly filePath?: string;
  override readonly cause?: unknown;

  constructor(
    code: "MANIFEST_READ_FAILED" | "MANIFEST_YAML_INVALID",
    message: string,
    options: { cause?: unknown; filePath?: string } = {},
  ) {
    super(message);
    this.name = "ManifestFileError";
    this.code = code;
    this.filePath = options.filePath;
    this.cause = options.cause;
  }
}

export function parseManifest(input: unknown): DeployKitManifest {
  return deployKitManifestSchema.parse(input);
}

export function safeParseManifest(input: unknown): ReturnType<typeof deployKitManifestSchema.safeParse> {
  return deployKitManifestSchema.safeParse(input);
}

export function parseManifestYaml(source: string, filePath?: string): DeployKitManifest {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new ManifestFileError(
      "MANIFEST_YAML_INVALID",
      `Unable to parse${filePath ? ` ${filePath}` : " manifest YAML"}`,
      { cause: error, filePath },
    );
  }

  return parseManifest(document);
}

export async function loadManifest(filePath = DEFAULT_MANIFEST_FILE): Promise<DeployKitManifest> {
  const absolutePath = resolve(filePath);
  let source: string;

  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new ManifestFileError("MANIFEST_READ_FAILED", `Unable to read manifest at ${absolutePath}`, {
      cause: error,
      filePath: absolutePath,
    });
  }

  return parseManifestYaml(source, absolutePath);
}

export function stringifyManifest(input: DeployKitManifestInput | DeployKitManifest): string {
  const manifest = parseManifest(input);
  return stringifyYaml(manifest, { indent: 2, lineWidth: 0 });
}
