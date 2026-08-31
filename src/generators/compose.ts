import { Document, isSeq } from "yaml";

import type { ProjectManifest } from "../manifest.js";
import {
  asRecord,
  assertPort,
  assertSafeName,
  manifestRecord,
  namedEntries,
  optionalNumber,
  optionalString,
  requiredString,
  stringArray,
  type ManifestRecord,
} from "./model.js";

export interface ComposeOverrideOptions {
  target: string;
  /** Stable loopback ports keyed by manifest service name. */
  ports: Readonly<Record<string, number>>;
  envFile?: string;
  /** Additional non-secret runtime values. */
  environment?: Readonly<Record<string, string>>;
  /** Required when a Compose database must be reached by a PM2 consumer. */
  databaseInternalPort?: number;
}

interface ComposeServiceOverride {
  restart: "unless-stopped";
  env_file: string[];
  environment?: Record<string, string>;
  ports?: string[];
}

function safeAbsolutePath(value: string, label: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`${label} must be a safe absolute path`);
  }
  return value;
}

function runtimeEnvironment(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string") {
      throw new Error(`${label} contains an invalid runtime environment value`);
    }
    result[key] = entry;
  }
  return result;
}

function publiclyReachableServices(root: ManifestRecord, target: ManifestRecord): Set<string> {
  const result = new Set<string>();
  const primaryDomain = requiredString(target, "primaryDomain", "target");
  const domains = new Set([
    primaryDomain,
    ...(target.aliases === undefined ? [] : stringArray(target.aliases, "target.aliases")),
  ]);
  if (!Array.isArray(root.routes)) throw new Error("routes must be an array");
  for (let index = 0; index < root.routes.length; index += 1) {
    const route = asRecord(root.routes[index], `routes[${index}]`);
    const hostname = optionalString(route, "hostname") ?? "@primary";
    if (hostname !== "@primary" && !domains.has(hostname)) continue;
    result.add(requiredString(route, "target", `routes[${index}]`));
  }
  if (root.frontend !== undefined) {
    const frontend = asRecord(root.frontend, "frontend");
    if (frontend.type === "service") {
      result.add(requiredString(frontend, "service", "frontend"));
    }
  }
  return result;
}

function databaseNeedsLoopbackPort(
  root: ManifestRecord,
  services: Map<string, ManifestRecord>,
): string | undefined {
  if (root.database === undefined) return undefined;
  const database = asRecord(root.database, "database");
  if (database.type !== "compose") return undefined;
  const consumers = stringArray(database.consumers, "database.consumers");
  const hasPm2Consumer = consumers.some((consumer) => services.get(consumer)?.type === "pm2");
  return hasPm2Consumer ? requiredString(database, "service", "database") : undefined;
}

function servicePort(
  logicalName: string,
  service: ManifestRecord,
  options: ComposeOverrideOptions,
): number {
  const allocated = options.ports[logicalName];
  const explicit = optionalNumber(service, "hostPort");
  if (allocated === undefined && explicit === undefined) {
    throw new Error(`No loopback port was provided for Compose service '${logicalName}'`);
  }
  if (allocated !== undefined && explicit !== undefined && allocated !== explicit) {
    throw new Error(
      `Allocated port ${allocated} conflicts with explicit hostPort ${explicit} for '${logicalName}'`,
    );
  }
  return assertPort(allocated ?? explicit ?? 0, `Host port for service '${logicalName}'`);
}

/**
 * Generate a Compose override without mutating the application's Compose files.
 * `!override` ensures an application port list cannot accidentally remain public.
 */
export function generateComposeOverride(
  manifest: ProjectManifest,
  options: ComposeOverrideOptions,
): string {
  const root = manifestRecord(manifest);
  const metadata = asRecord(root.metadata, "metadata");
  const projectName = assertSafeName(
    requiredString(metadata, "name", "metadata"),
    "metadata.name",
  );
  const target = namedEntries(root.targets, "targets").find(
    (entry) => entry.name === options.target,
  );
  if (!target) throw new Error(`Unknown target '${options.target}'`);

  const allServices = namedEntries(root.services, "services");
  const serviceMap = new Map(allServices.map((entry) => [entry.name, entry.value]));
  const publicServices = publiclyReachableServices(root, target.value);
  const databaseService = databaseNeedsLoopbackPort(root, serviceMap);

  const envFile = safeAbsolutePath(
    options.envFile ?? `/etc/deploykit/apps/${projectName}/${options.target}.env`,
    "envFile",
  );
  const environment = {
    ...runtimeEnvironment(
      target.value.runtimeOverrides,
      `targets.${options.target}.runtimeOverrides`,
    ),
    ...runtimeEnvironment(options.environment, "environment"),
  };
  const services: Record<string, ComposeServiceOverride> = {};
  const portBearingComposeServices: string[] = [];

  for (const { name, value } of allServices) {
    if (value.type !== "compose") continue;
    const composeServiceName = assertSafeName(
      requiredString(value, "service", `services.${name}`),
      `services.${name}.service`,
    );
    if (services[composeServiceName] !== undefined) {
      throw new Error(`Multiple manifest services reference Compose service '${composeServiceName}'`);
    }
    const override: ComposeServiceOverride = {
      restart: "unless-stopped",
      env_file: [envFile],
    };
    if (Object.keys(environment).length > 0) override.environment = { ...environment };
    if (publicServices.has(name)) {
      const hostPort = servicePort(name, value, options);
      const internalPort = assertPort(
        optionalNumber(value, "internalPort") ?? 0,
        `services.${name}.internalPort`,
      );
      override.ports = [`127.0.0.1:${hostPort}:${internalPort}`];
      portBearingComposeServices.push(composeServiceName);
    }
    services[composeServiceName] = override;
  }

  if (root.database !== undefined) {
    const database = asRecord(root.database, "database");
    if (database.type === "compose") {
      const composeServiceName = assertSafeName(
        requiredString(database, "service", "database"),
        "database.service",
      );
      const override =
        services[composeServiceName] ??
        ({
          restart: "unless-stopped",
          env_file: [envFile],
          ...(Object.keys(environment).length > 0 ? { environment: { ...environment } } : {}),
        } satisfies ComposeServiceOverride);
      if (databaseService) {
        const hostPort =
          options.ports["database:compose"] ?? options.ports[composeServiceName];
        if (hostPort === undefined) {
          throw new Error("No loopback port was provided for the Compose database");
        }
        if (options.databaseInternalPort === undefined) {
          throw new Error(
            "databaseInternalPort is required when a PM2 service consumes the Compose database",
          );
        }
        override.ports = [
          `127.0.0.1:${assertPort(hostPort, "Database host port")}:${assertPort(
            options.databaseInternalPort,
            "Database internal port",
          )}`,
        ];
        portBearingComposeServices.push(composeServiceName);
      }
      services[composeServiceName] = override;
    }
  }

  const document = new Document(
    {
      name: `deploykit-${projectName}-${assertSafeName(options.target, "target")}`,
      services,
    },
    {
      customTags: [
        {
          tag: "!override",
          collection: "seq",
          resolve: (value) => value,
        },
      ],
    },
  );
  document.commentBefore = "Generated by DeployKit. Do not edit.";
  for (const serviceName of portBearingComposeServices) {
    const ports = document.getIn(["services", serviceName, "ports"], true);
    if (isSeq(ports)) ports.tag = "!override";
  }
  return document.toString({ lineWidth: 0 });
}
