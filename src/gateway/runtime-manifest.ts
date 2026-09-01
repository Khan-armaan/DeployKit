import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  commandSchema,
  domainSchema,
  environmentNameSchema,
  identifierSchema,
  relativePathSchema,
} from "../manifest.js";
import { canonicalRuntimeManifestBytes } from "../orchestrator/canonical.js";
import {
  GATEWAY_PROTOCOL_LIMITS,
  RUNTIME_MANIFEST_API_VERSION,
  type CompiledRuntimeManifest,
} from "../orchestrator/contracts.js";
import { protocolError } from "./failures.js";

/**
 * The gateway receives the compiled runtime manifest as bytes, not as a value.
 * Two independent properties must hold before it may be used:
 *
 * 1. it parses into exactly the frozen `deploykit/runtime/v1alpha1` shape, with
 *    no unknown keys and no unresolved defaults, and
 * 2. re-serializing that value under `deploykit/runtime-yaml-canonical/v1`
 *    reproduces the received bytes exactly.
 *
 * The second check is what makes the digest meaningful. The digest is taken
 * over bytes, so without it a caller could ship a semantically identical but
 * differently encoded document, and two hosts could disagree about which
 * manifest a deployment identity refers to. It also rejects YAML anchors,
 * aliases, tags, comments, and flow style for free, because none of them
 * survive canonical re-serialization.
 *
 * The manifest is secret-free by contract: it carries public values and secret
 * *names* only, so nothing parsed here needs redaction.
 */

const targetIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, "must be a 32-character lower-case target id");

const targetNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u,
    "must contain only letters, digits, dots, underscores, and interior hyphens",
  );

const packageManagerSchema = z.enum(["npm", "pnpm", "yarn", "bun"]);
const portSchema = z.number().int().min(1).max(65_535);
const nodeVersionSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u,
    "must be an exact Node.js version",
  );
const packageScriptSchema = z.string().regex(/^[A-Za-z0-9:_-]+$/u, "must be a package script name");

/**
 * Runtime timings are always resolved. The compiler applies every default
 * before digesting, so a manifest that omits one is not the compiled form the
 * digest was taken over.
 */
const healthTiming = {
  intervalSeconds: z.number().int().positive().max(86_400),
  timeoutSeconds: z.number().int().positive().max(86_400),
  retries: z.number().int().positive().max(1_000),
  startPeriodSeconds: z.number().int().nonnegative().max(86_400),
};

const healthCheckSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("http"),
    path: z.string().startsWith("/").max(2_048),
    port: portSchema.optional(),
    expectedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(32),
    ...healthTiming,
  }),
  z.strictObject({ type: z.literal("tcp"), port: portSchema.optional(), ...healthTiming }),
  z.strictObject({ type: z.literal("command"), command: commandSchema, ...healthTiming }),
  z.strictObject({ type: z.literal("process"), ...healthTiming }),
]);

const serviceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("compose"),
    service: identifierSchema,
    internalPort: portSchema,
    hostPort: portSchema.optional(),
    healthCheck: healthCheckSchema,
  }),
  z.strictObject({
    type: z.literal("pm2"),
    role: z.enum(["api", "ssr", "worker"]),
    workingDirectory: relativePathSchema,
    nodeVersion: nodeVersionSchema,
    packageManager: packageManagerSchema,
    installCommand: commandSchema.optional(),
    buildScript: packageScriptSchema.optional(),
    startScript: packageScriptSchema,
    portEnvironmentVariable: environmentNameSchema.optional(),
    hostPort: portSchema.optional(),
    healthCheck: healthCheckSchema,
  }),
]);

const frontendSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("static"),
    workingDirectory: relativePathSchema,
    nodeVersion: nodeVersionSchema,
    packageManager: packageManagerSchema,
    installCommand: commandSchema.optional(),
    buildScript: packageScriptSchema,
    outputDirectory: relativePathSchema,
    spaFallback: z.boolean(),
    publicEnvironment: z.record(environmentNameSchema, z.string().max(8_192)),
  }),
  z.strictObject({
    type: z.literal("service"),
    service: identifierSchema,
    publicEnvironment: z.record(environmentNameSchema, z.string().max(8_192)),
  }),
]);

const routeSchema = z.strictObject({
  hostname: z.union([z.literal("@primary"), domainSchema]),
  path: z.string().startsWith("/").max(2_048),
  match: z.enum(["exact", "prefix"]),
  target: identifierSchema,
  preservePrefix: z.boolean(),
  websocket: z.boolean(),
  sse: z.boolean(),
  buffering: z.boolean(),
  requestBuffering: z.boolean(),
  uploadLimit: z.string().regex(/^[1-9]\d*(?:[kKmMgG])?$/u, "must be an Nginx size such as 25m").optional(),
  timeouts: z.strictObject({
    connect: z.number().int().positive().max(86_400),
    send: z.number().int().positive().max(86_400),
    read: z.number().int().positive().max(86_400),
  }),
});

const deploymentHookSchema = z.strictObject({ service: identifierSchema, command: commandSchema });

const databaseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("compose"),
    service: identifierSchema,
    internalPort: portSchema.optional(),
    consumers: z.array(identifierSchema).min(1).max(64),
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
  }),
  z.strictObject({
    type: z.literal("external"),
    connectionStringSecret: environmentNameSchema,
    tlsCaSecret: environmentNameSchema.optional(),
    requireTls: z.boolean(),
  }),
]);

export const runtimeManifestSchema = z.strictObject({
  apiVersion: z.literal(RUNTIME_MANIFEST_API_VERSION),
  metadata: z.strictObject({
    name: identifierSchema,
    requiredVersion: z.string().min(1).max(128),
  }),
  target: z.strictObject({
    name: targetNameSchema,
    targetId: targetIdSchema,
    githubEnvironment: z.string().min(1).max(255),
    primaryDomain: domainSchema,
    aliases: z.array(domainSchema).max(64),
  }),
  compose: z.strictObject({ files: z.array(relativePathSchema).min(1).max(32) }).optional(),
  services: z.record(identifierSchema, serviceSchema),
  frontend: frontendSchema.optional(),
  routes: z.array(routeSchema).max(256),
  database: databaseSchema.optional(),
  secrets: z.strictObject({
    required: z.array(environmentNameSchema).max(GATEWAY_PROTOCOL_LIMITS.maxSecretFrames),
    generated: z.array(environmentNameSchema).max(GATEWAY_PROTOCOL_LIMITS.maxSecretFrames),
  }),
});

/**
 * Decodes and validates the canonical manifest bytes the gateway received.
 * Every refusal is a protocol failure: the bytes are part of the request, and
 * a request that cannot be understood is never partially applied.
 */
export function parseCanonicalRuntimeManifest(bytes: Buffer): CompiledRuntimeManifest {
  if (bytes.includes(0)) throw protocolError("the runtime manifest contains a NUL byte");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw protocolError("the runtime manifest is not valid UTF-8");
  }

  let document: unknown;
  try {
    document = parseYaml(text, { merge: false });
  } catch (error) {
    throw protocolError("the runtime manifest is not parsable YAML", { cause: String(error) });
  }

  const parsed = runtimeManifestSchema.safeParse(document);
  if (!parsed.success) {
    throw protocolError("the runtime manifest does not match the frozen runtime contract", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)),
        message: issue.message,
      })),
    });
  }

  const manifest = parsed.data as unknown as CompiledRuntimeManifest;
  if (!canonicalRuntimeManifestBytes(manifest).equals(bytes)) {
    throw protocolError(
      "the runtime manifest is not canonical under deploykit/runtime-yaml-canonical/v1",
    );
  }
  return manifest;
}
