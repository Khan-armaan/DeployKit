import { DEPLOYKIT_API_VERSION, type DeployKitManifest } from "../manifest.js";
import { createDeploymentPlan, type DeploymentPlan, type DeploymentPlanOptions } from "../plan.js";
import { validateProject, type ProjectValidationResult } from "../project-validation.js";
import type {
  CompiledRuntimeManifest,
  RuntimeDatabase,
  RuntimeFrontend,
  RuntimeHealthCheck,
  RuntimeService,
} from "./contracts.js";
import type { CompiledDeployment } from "./compile.js";

/**
 * Phase 3 deliberately keeps one validation engine. The compiled runtime
 * manifest is projected onto the manifest shape `validateManifest`,
 * `validateProject`, `createDeploymentPlan`, and the deterministic generators
 * already understand, so the config-driven path inherits every existing schema,
 * semantic, filesystem, package-script, package-manager, effective-Compose,
 * route, and plan check instead of growing a parallel one.
 *
 * The projection is lossless and read-only: it copies values, resolves nothing
 * from the filesystem, and never writes to the application tree.
 */

type ProjectedHealthCheck = DeployKitManifest["services"][string]["healthCheck"];

/** The runtime contract is deeply readonly; the manifest schema is not. */
function projectHealthCheck(check: RuntimeHealthCheck): ProjectedHealthCheck {
  if (check.type === "http") return { ...check, expectedStatuses: [...check.expectedStatuses] };
  if (check.type === "command") return { ...check, command: [...check.command] };
  return { ...check };
}

function projectService(service: RuntimeService): DeployKitManifest["services"][string] {
  if (service.type === "compose") {
    return {
      type: "compose",
      service: service.service,
      internalPort: service.internalPort,
      ...(service.hostPort === undefined ? {} : { hostPort: service.hostPort }),
      healthCheck: projectHealthCheck(service.healthCheck),
    };
  }

  return {
    type: "pm2",
    role: service.role,
    workingDirectory: service.workingDirectory,
    nodeVersion: service.nodeVersion,
    packageManager: service.packageManager,
    ...(service.installCommand === undefined ? {} : { installCommand: [...service.installCommand] }),
    ...(service.buildScript === undefined ? {} : { buildScript: service.buildScript }),
    startScript: service.startScript,
    ...(service.role === "worker"
      ? {}
      : {
          portEnvironmentVariable: service.portEnvironmentVariable,
          ...(service.hostPort === undefined ? {} : { hostPort: service.hostPort }),
        }),
    healthCheck: projectHealthCheck(service.healthCheck),
  };
}

function projectFrontend(frontend: RuntimeFrontend): DeployKitManifest["frontend"] {
  if (frontend.type === "service") {
    return {
      type: "service",
      service: frontend.service,
      publicEnvironment: { ...frontend.publicEnvironment },
    };
  }
  return {
    type: "static",
    workingDirectory: frontend.workingDirectory,
    nodeVersion: frontend.nodeVersion,
    packageManager: frontend.packageManager,
    ...(frontend.installCommand === undefined ? {} : { installCommand: [...frontend.installCommand] }),
    buildScript: frontend.buildScript,
    outputDirectory: frontend.outputDirectory,
    spaFallback: frontend.spaFallback,
    // The compiled config has no separate API base path; the schema default is
    // the same "/api" the example config documents.
    apiBasePath: "/api",
    publicEnvironment: { ...frontend.publicEnvironment },
  };
}

/**
 * Projects the compiled manifest onto the existing manifest shape.
 *
 * Two mappings are worth stating explicitly:
 *
 * - `secrets.required` in the runtime manifest names *every* secret the runtime
 *   needs. The existing schema splits that set, so operator-supplied names are
 *   projected as required and server-generated names as generated.
 * - public values reach a static frontend as build environment and a service
 *   frontend as target runtime overrides, which is what the Compose and PM2
 *   generators already inject into a workload's environment.
 */
function projectDatabase(database: RuntimeDatabase): NonNullable<DeployKitManifest["database"]> {
  if (database.type === "external") {
    return {
      type: "external",
      connectionStringSecret: database.connectionStringSecret,
      ...(database.tlsCaSecret === undefined ? {} : { tlsCaSecret: database.tlsCaSecret }),
      requireTls: database.requireTls,
    };
  }
  return {
    type: "compose",
    service: database.service,
    ...(database.internalPort === undefined ? {} : { internalPort: database.internalPort }),
    consumers: [...database.consumers],
    volume: database.volume,
    credentials: { ...database.credentials },
    ...(database.migrations === undefined
      ? {}
      : { migrations: { service: database.migrations.service, command: [...database.migrations.command] } }),
    ...(database.seed === undefined
      ? {}
      : { seed: { service: database.seed.service, command: [...database.seed.command] } }),
  };
}

export function toProjectManifest(manifest: CompiledRuntimeManifest): DeployKitManifest {
  const generated = [...manifest.secrets.generated].sort();
  const generatedNames = new Set(generated);
  const required = manifest.secrets.required.filter((name) => !generatedNames.has(name)).sort();
  const publicEnvironment = manifest.frontend === undefined ? {} : { ...manifest.frontend.publicEnvironment };

  return {
    apiVersion: DEPLOYKIT_API_VERSION,
    metadata: {
      name: manifest.metadata.name,
      requiredVersion: manifest.metadata.requiredVersion,
    },
    ...(manifest.compose === undefined ? {} : { compose: { files: [...manifest.compose.files] } }),
    services: Object.fromEntries(
      Object.entries(manifest.services).map(([name, service]) => [name, projectService(service)]),
    ),
    ...(manifest.frontend === undefined ? {} : { frontend: projectFrontend(manifest.frontend) }),
    routes: manifest.routes.map((route) => ({
      hostname: route.hostname,
      path: route.path,
      match: route.match,
      target: route.target,
      preservePrefix: route.preservePrefix,
      websocket: route.websocket,
      sse: route.sse,
      buffering: route.buffering,
      requestBuffering: route.requestBuffering,
      ...(route.uploadLimit === undefined ? {} : { uploadLimit: route.uploadLimit }),
      timeouts: { ...route.timeouts },
    })),
    ...(manifest.database === undefined ? {} : { database: projectDatabase(manifest.database) }),
    secrets: { required, generated },
    targets: {
      [manifest.target.name]: {
        primaryDomain: manifest.target.primaryDomain,
        aliases: [...manifest.target.aliases],
        environment: manifest.target.githubEnvironment,
        publicOverrides: {},
        runtimeOverrides: manifest.frontend?.type === "service" ? publicEnvironment : {},
      },
    },
  };
}

export interface CompiledProjectValidationOptions {
  /**
   * Absolute root of the application source tree to validate. It is
   * independent of where the compiled manifest came from: locally it is the
   * repository working tree, and on the VPS it is the immutable checked-out
   * commit.
   */
  readonly sourceRoot: string;
  /** Runs `docker compose config`; off by default so validation stays local. */
  readonly inspectComposeConfig?: boolean;
}

/**
 * Runs every existing project check against the compiled form. Reads only; it
 * never writes to the application's Dockerfiles, Compose files, sources, or
 * `package.json`.
 */
export async function validateCompiledProject(
  compiled: CompiledDeployment,
  options: CompiledProjectValidationOptions,
): Promise<ProjectValidationResult> {
  return validateProject(toProjectManifest(compiled.manifest), {
    sourceRoot: options.sourceRoot,
    inspectComposeConfig: options.inspectComposeConfig ?? false,
  });
}

/** The secret-free public plan for a compiled deployment. */
export function createCompiledDeploymentPlan(
  compiled: CompiledDeployment,
  options: Omit<DeploymentPlanOptions, "manifestDigest" | "targetId"> = {},
): DeploymentPlan {
  return createDeploymentPlan(toProjectManifest(compiled.manifest), compiled.targetName, {
    ...options,
    sourceRef: options.sourceRef ?? compiled.applicationRef,
    manifestDigest: compiled.digest.value,
    targetId: compiled.targetId,
  });
}
