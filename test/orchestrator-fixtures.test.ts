import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

type FixtureRecord = Record<string, unknown>;

const fixtures = [
  {
    name: "static-compose",
    digest: "72b9804b7effa83c884108b26cce7844edca5bd305e50e15a3a9a82d97d7bd81",
    services: {
      api: { type: "compose", service: "api", internalPort: 3000, hostPort: "auto", health: "http" },
    },
    frontend: { type: "static", workingDirectory: "frontend" },
    routes: ["exact:/api/upload:api", "prefix:/api/:api"],
    database: "compose",
    frontendEnvironment: ["VITE_API_BASE_URL"],
    backendEnvironment: ["CERTBOT_EMAIL"],
    generatedEnvironment: ["DATABASE_URL", "POSTGRES_PASSWORD"],
  },
  {
    name: "pm2-compose-db",
    digest: "2334d68ade3ecd49ce09d79c03483b036fdea075c01d5fd789035eb3c6845f8a",
    services: {
      api: { type: "pm2", role: "api", workingDirectory: "api", hostPort: "auto", health: "http" },
      ssr: { type: "pm2", role: "ssr", workingDirectory: "web", hostPort: "auto", health: "http" },
      worker: { type: "pm2", role: "worker", workingDirectory: "worker", hostPort: undefined, health: "command" },
    },
    frontend: { type: "service", service: "ssr" },
    routes: ["prefix:/api/:api"],
    database: "compose",
    frontendEnvironment: ["PUBLIC_API_BASE_URL"],
    backendEnvironment: ["CERTBOT_EMAIL", "LOG_LEVEL"],
    generatedEnvironment: ["DATABASE_URL", "POSTGRES_PASSWORD"],
  },
  {
    name: "container-external",
    digest: "534e6e7eb74ccdbe7820e82e47b152fe3680b03b54bb4accef5cb976f0d456b4",
    services: {
      api: { type: "compose", service: "api", internalPort: 4000, hostPort: "auto", health: "http" },
      web: { type: "compose", service: "web", internalPort: 8080, hostPort: "auto", health: "http" },
    },
    frontend: { type: "service", service: "web" },
    routes: ["prefix:/api/:api"],
    database: "external",
    frontendEnvironment: ["PUBLIC_API_BASE_URL"],
    backendEnvironment: ["CERTBOT_EMAIL", "DATABASE_CA", "DATABASE_URL"],
    generatedEnvironment: [],
  },
] as const;

function record(value: unknown, label: string): FixtureRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as FixtureRecord;
}

function records(value: unknown, label: string): FixtureRecord[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value as string[];
}

function requiredString(value: FixtureRecord, key: string, label: string): string {
  const entry = value[key];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return entry;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as FixtureRecord)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as FixtureRecord)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]),
    );
  }
  return value;
}

function canonicalBytes(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function environmentRecord(environment: FixtureRecord, partition: "frontend" | "backend"): Record<string, string> {
  const result = record(environment[partition], `environment.${partition}`);
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "string") throw new TypeError(`environment.${partition}.${key} must be a string`);
  }
  return result as Record<string, string>;
}

function serviceSummary(services: FixtureRecord): FixtureRecord {
  return Object.fromEntries(Object.entries(services).map(([name, input]) => {
    const service = record(input, `services.${name}`);
    const health = record(service.healthCheck, `services.${name}.healthCheck`);
    if (service.type === "compose") {
      return [name, {
        type: service.type,
        service: service.service,
        internalPort: service.internalPort,
        hostPort: service.hostPort,
        health: health.type,
      }];
    }
    return [name, {
      type: service.type,
      role: service.role,
      workingDirectory: service.workingDirectory,
      hostPort: service.hostPort,
      health: health.type,
    }];
  }));
}

async function assertPackageScripts(directory: string, scriptNames: readonly string[]): Promise<void> {
  const packageJson = record(JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")), "package.json");
  const scripts = record(packageJson.scripts, "package.json.scripts");
  for (const script of scriptNames) expect(scripts[script], `missing package script '${script}' in ${directory}`).toBeTypeOf("string");
}

async function assertProjectReferences(directory: string, config: FixtureRecord): Promise<void> {
  const compose = record(config.compose, "compose");
  const composeFiles = strings(compose.files, "compose.files");
  const composeServices = new Set<string>();
  const buildDirectories = new Map<string, string>();

  for (const file of composeFiles) {
    const composePath = resolve(directory, file);
    await expect(access(composePath)).resolves.toBeUndefined();
    const document = record(parseYaml(await readFile(composePath, "utf8")), file);
    for (const [name, input] of Object.entries(record(document.services, `${file}.services`))) {
      composeServices.add(name);
      const service = record(input, `${file}.services.${name}`);
      if (typeof service.build === "string") buildDirectories.set(name, service.build);
    }
  }

  const services = record(config.services, "services");
  for (const [name, input] of Object.entries(services)) {
    const service = record(input, `services.${name}`);
    if (service.type === "compose") {
      const composeName = requiredString(service, "service", `services.${name}`);
      expect(composeServices.has(composeName), `missing Compose service '${composeName}'`).toBe(true);
      const buildDirectory = buildDirectories.get(composeName);
      if (buildDirectory !== undefined) expect((await stat(resolve(directory, buildDirectory))).isDirectory()).toBe(true);
      continue;
    }

    const workingDirectory = resolve(directory, requiredString(service, "workingDirectory", `services.${name}`));
    const scriptNames = [requiredString(service, "startScript", `services.${name}`)];
    if (typeof service.buildScript === "string") scriptNames.push(service.buildScript);
    const health = record(service.healthCheck, `services.${name}.healthCheck`);
    if (health.type === "command") {
      const command = strings(health.command, `services.${name}.healthCheck.command`);
      if (command[1] === "run" && command[2] !== undefined) scriptNames.push(command[2]);
    }
    await assertPackageScripts(workingDirectory, scriptNames);
  }

  const frontend = record(config.frontend, "frontend");
  if (frontend.type === "static") {
    const workingDirectory = resolve(directory, requiredString(frontend, "workingDirectory", "frontend"));
    await assertPackageScripts(workingDirectory, [requiredString(frontend, "buildScript", "frontend")]);
  } else {
    expect(Object.hasOwn(services, requiredString(frontend, "service", "frontend"))).toBe(true);
  }

  const database = record(config.database, "database");
  if (database.type === "compose") {
    expect(composeServices.has(requiredString(database, "service", "database"))).toBe(true);
    for (const consumer of strings(database.consumers, "database.consumers")) {
      expect(Object.hasOwn(services, consumer), `unknown database consumer '${consumer}'`).toBe(true);
    }
  }

  for (const route of records(config.routes, "routes")) {
    expect(Object.hasOwn(services, requiredString(route, "target", "route"))).toBe(true);
  }
}

describe.each(fixtures)("orchestrator acceptance fixture $name", (fixture) => {
  it("provides a complete config-driven topology with test-only trust inputs", async () => {
    const directory = resolve("test", "fixtures", fixture.name);
    const source = await readFile(resolve(directory, "deploykit.config.fixture.yaml"), "utf8");
    const config = record(parseYaml(source), "config");

    expect(config.apiVersion).toBe("deploykit/config/v1alpha1");
    expect(config.kind).toBe("Deployment");
    expect(config).not.toHaveProperty("secrets");
    expect(config).not.toHaveProperty("targets");

    const project = record(config.project, "project");
    expect(project).toMatchObject({ name: fixture.name, ref: "main" });
    expect(requiredString(project, "repository", "project")).toBe(`deploykit-fixtures/${fixture.name}`);

    const target = record(config.target, "target");
    expect(target.name).toBe("production");
    expect(requiredString(target, "githubEnvironment", "target")).toMatch(/^fixture-/u);
    expect(requiredString(target, "primaryDomain", "target")).toMatch(/\.example\.test$/u);
    expect(strings(target.aliases, "target.aliases").every((domain) => domain.endsWith(".example.test"))).toBe(true);

    const server = record(config.server, "server");
    expect(requiredString(server, "host", "server")).toMatch(/\.example\.test$/u);
    expect(server).toMatchObject({ user: "ubuntu", port: 22, configureFirewall: false });
    expect(requiredString(server, "identityFile", "server")).toMatch(/^\/home\/deploykit-fixture\/\.ssh\//u);
    expect(requiredString(server, "hostKeyFingerprint", "server")).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);

    const services = record(config.services, "services");
    expect(serviceSummary(services)).toEqual(fixture.services);
    expect(record(config.frontend, "frontend")).toMatchObject(fixture.frontend);
    expect(records(config.routes, "routes").map((route) =>
      `${String(route.match)}:${String(route.path)}:${String(route.target)}`,
    )).toEqual(fixture.routes);
    expect(record(config.database, "database").type).toBe(fixture.database);

    const environment = record(config.environment, "environment");
    const frontendEnvironment = environmentRecord(environment, "frontend");
    const backendEnvironment = environmentRecord(environment, "backend");
    const generatedEnvironment = strings(environment.generated, "environment.generated");
    expect(Object.keys(frontendEnvironment).sort(compareKeys)).toEqual(fixture.frontendEnvironment);
    expect(Object.keys(backendEnvironment).sort(compareKeys)).toEqual(fixture.backendEnvironment);
    expect([...generatedEnvironment].sort(compareKeys)).toEqual(fixture.generatedEnvironment);
    expect(backendEnvironment.CERTBOT_EMAIL).toContain("fixture-ops@");

    const environmentNames = [
      ...Object.keys(frontendEnvironment),
      ...Object.keys(backendEnvironment),
      ...generatedEnvironment,
    ];
    expect(new Set(environmentNames).size).toBe(environmentNames.length);
    expect(environmentNames.every((name) => /^[A-Z_][A-Z0-9_]*$/u.test(name))).toBe(true);

    const database = record(config.database, "database");
    const databaseSecretNames = database.type === "external"
      ? [database.connectionStringSecret, database.tlsCaSecret].filter((value): value is string => typeof value === "string")
      : Object.entries(record(database.credentials, "database.credentials"))
          .filter(([key, value]) => key.endsWith("Secret") && typeof value === "string")
          .map(([, value]) => value as string);
    const privateNames = new Set([...Object.keys(backendEnvironment), ...generatedEnvironment]);
    expect(databaseSecretNames.every((name) => privateNames.has(name))).toBe(true);

    await assertProjectReferences(directory, config);
  });

  it("has stable canonical contract bytes independent of YAML object-key order", async () => {
    const source = await readFile(
      resolve("test", "fixtures", fixture.name, "deploykit.config.fixture.yaml"),
      "utf8",
    );
    const parsed = parseYaml(source) as unknown;
    const first = canonicalBytes(parsed);
    const second = canonicalBytes(parseYaml(source));
    const reordered = canonicalBytes(reverseObjectKeyOrder(parsed));

    expect(second).toBe(first);
    expect(reordered).toBe(first);
    expect(createHash("sha256").update(first).digest("hex")).toBe(fixture.digest);
  });
});
