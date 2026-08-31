import { basename, join } from "node:path";
import { pathExists } from "./fs.js";
import { run } from "./process.js";
import { DeployKitError } from "./errors.js";

export const COMPOSE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml"
] as const;

export interface EffectiveComposeService {
  name: string;
  containerName?: string;
  ports: Array<{ target?: number; published?: string | number; hostIp?: string; protocol?: string }>;
  exposedPorts: number[];
  hasHealthcheck: boolean;
  image?: string;
  build?: unknown;
  environmentNames: string[];
  networkMode?: string;
  replicas?: number;
  namedVolumes: string[];
}

export interface ComposeInspection {
  files: string[];
  services: EffectiveComposeService[];
  volumes: string[];
  networks: string[];
  environmentReferences: ComposeEnvironmentReference[];
  warnings: string[];
}

export interface ComposeEnvironmentReference {
  name: string;
  required: boolean;
  locations: string[];
}

export async function discoverComposeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const candidate of COMPOSE_CANDIDATES) {
    if (await pathExists(join(directory, candidate))) files.push(candidate);
  }
  return files.slice(0, 1);
}

function environmentNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).split("=", 1)[0] ?? "").filter(Boolean).sort();
  }
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).sort();
  return [];
}

function namedVolumeSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.flatMap((entry) => {
    if (typeof entry === "string") {
      const source = entry.split(":", 1)[0] ?? "";
      return source !== "" && !source.startsWith("/") && !source.startsWith(".") && !source.startsWith("~")
        ? [source]
        : [];
    }
    if (entry && typeof entry === "object") {
      const volume = entry as { type?: unknown; source?: unknown };
      return (volume.type === undefined || volume.type === "volume") && typeof volume.source === "string"
        ? [volume.source]
        : [];
    }
    return [];
  });
  return [...new Set(names)].sort();
}

export async function inspectCompose(directory: string, files: string[]): Promise<ComposeInspection> {
  if (files.length === 0) return { files: [], services: [], volumes: [], networks: [], environmentReferences: [], warnings: [] };
  const args = ["compose"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json", "--no-interpolate");
  let output: string;
  try {
    output = (await run("docker", args, { cwd: directory })).stdout;
  } catch (error) {
    throw new DeployKitError(
      "DK_VALIDATION_FAILED",
      `Unable to resolve ${files.map((file) => basename(file)).join(", ")} with docker compose config`,
      { cause: error }
    );
  }
  const parsed = JSON.parse(output) as {
    services?: Record<string, {
      container_name?: string;
      ports?: Array<Record<string, unknown>>;
      expose?: Array<string | number>;
      healthcheck?: unknown;
      image?: string;
      build?: unknown;
      environment?: unknown;
      network_mode?: unknown;
      deploy?: { replicas?: unknown };
      volumes?: unknown;
    }>;
    volumes?: Record<string, unknown>;
    networks?: Record<string, unknown>;
  };
  const services = Object.entries(parsed.services ?? {}).map(([name, service]) => ({
    name,
    containerName: service.container_name,
    ports: (service.ports ?? []).map((port) => ({
      target: typeof port.target === "number" ? port.target : undefined,
      published: typeof port.published === "string" || typeof port.published === "number" ? port.published : undefined,
      hostIp: typeof port.host_ip === "string" ? port.host_ip : undefined,
      protocol: typeof port.protocol === "string" ? port.protocol : undefined
    })),
    exposedPorts: (service.expose ?? [])
      .map((port) => Number(String(port).split("/")[0]))
      .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535),
    hasHealthcheck: Boolean(service.healthcheck),
    image: service.image,
    build: service.build,
    environmentNames: environmentNames(service.environment),
    networkMode: typeof service.network_mode === "string" ? service.network_mode : undefined,
    replicas: typeof service.deploy?.replicas === "number" && Number.isInteger(service.deploy.replicas)
      ? service.deploy.replicas
      : undefined,
    namedVolumes: namedVolumeSources(service.volumes),
  }));
  const warnings: string[] = [];
  for (const service of services) {
    if (service.containerName) warnings.push(`Service '${service.name}' fixes container_name; remove it so Compose can namespace each target.`);
    if (service.ports.length > 0) warnings.push(`Service '${service.name}' publishes host ports; DeployKit must own host bindings through its generated override.`);
  }
  return {
    files,
    services,
    volumes: Object.keys(parsed.volumes ?? {}).sort(),
    networks: Object.keys(parsed.networks ?? {}).sort(),
    environmentReferences: collectComposeEnvironmentReferences(parsed),
    warnings
  };
}

/** Find Compose interpolation and pass-through environment requirements. */
export function collectComposeEnvironmentReferences(configuration: unknown): ComposeEnvironmentReference[] {
  const references = new Map<string, { required: boolean; locations: Set<string> }>();
  const add = (name: string, required: boolean, location: string): void => {
    const existing = references.get(name) ?? { required: false, locations: new Set<string>() };
    existing.required ||= required;
    existing.locations.add(location);
    references.set(name, existing);
  };
  const interpolation = /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  const visit = (value: unknown, location: string): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(interpolation)) {
        const name = match[1] ?? match[3];
        if (!name) continue;
        const operator = match[2];
        add(name, operator === undefined || operator.endsWith("?"), location);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, location ? `${location}.${key}` : key);
      }
    }
  };
  visit(configuration, "");

  const services = configuration && typeof configuration === "object"
    ? (configuration as { services?: Record<string, { environment?: unknown }> }).services
    : undefined;
  for (const [service, details] of Object.entries(services ?? {})) {
    if (Array.isArray(details.environment)) {
      details.environment.forEach((entry, index) => {
        if (typeof entry === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) {
          add(entry, true, `services.${service}.environment[${index}]`);
        }
      });
    } else if (details.environment && typeof details.environment === "object") {
      for (const [name, value] of Object.entries(details.environment as Record<string, unknown>)) {
        if (value === null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          add(name, true, `services.${service}.environment.${name}`);
        }
      }
    }
  }

  return [...references.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      required: value.required,
      locations: [...value.locations].sort(),
    }));
}

export function assertComposeSafe(inspection: ComposeInspection): void {
  if (inspection.warnings.length > 0) {
    throw new DeployKitError("DK_VALIDATION_FAILED", "Compose configuration is incompatible with managed multi-project deployment", {
      details: { remediation: inspection.warnings }
    });
  }
}
