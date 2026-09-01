import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  canonicalYaml,
  compareCodePoints,
  manifestDigestMatches,
  CanonicalizationError,
} from "../src/orchestrator/canonical.js";
import {
  compileRuntimeManifest,
  makeOrchestratorTargetId,
  RUNTIME_HEALTH_DEFAULTS,
  RUNTIME_ROUTE_TIMEOUT_DEFAULTS,
} from "../src/orchestrator/compile.js";
import { parseOperatorConfig } from "../src/orchestrator/config-schema.js";
import {
  createCompiledDeploymentPlan,
  toProjectManifest,
  validateCompiledProject,
} from "../src/orchestrator/project.js";
import {
  generateComposeOverride,
  generateNginxConfig,
  generatePm2Ecosystem,
} from "../src/generators/index.js";
import { CONTRACT_KEY_ORDER, RUNTIME_MANIFEST_CANONICALIZATION } from "../src/orchestrator/contracts.js";
import { DeployKitError } from "../src/errors.js";
import { VERSION } from "../src/version.js";

const TOPOLOGIES = ["static-compose", "pm2-compose-db", "container-external"] as const;
type Topology = (typeof TOPOLOGIES)[number];

function fixtureDirectory(name: Topology): string {
  return resolve("test", "fixtures", name);
}

async function fixtureSource(name: Topology): Promise<string> {
  return readFile(join(fixtureDirectory(name), "deploykit.config.fixture.yaml"), "utf8");
}

async function compileFixture(name: Topology) {
  return compileRuntimeManifest(parseOperatorConfig(parseYaml(await fixtureSource(name))));
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  }
  return value;
}

/** Every regular file under `directory`, mapped to its SHA-256 and mode. */
async function treeFingerprint(directory: string): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const [contents, info] = await Promise.all([readFile(path), stat(path)]);
      fingerprint.set(
        path,
        `${createHash("sha256").update(contents).digest("hex")}:${(info.mode & 0o7777).toString(8)}:${info.mtimeMs}`,
      );
    }
  };
  await walk(directory);
  return fingerprint;
}

// ------------------------------------------------------------- canonical --

describe("canonical runtime-manifest bytes", () => {
  it("emits contract order first, then remaining keys by code point", () => {
    const yaml = canonicalYaml(
      { services: {}, metadata: { requiredVersion: "1", name: "n" }, apiVersion: "v" },
      CONTRACT_KEY_ORDER.runtimeManifest,
    );

    expect(yaml).toBe(
      [
        '"apiVersion": "v"',
        '"metadata":',
        '  "name": "n"',
        '  "requiredVersion": "1"',
        '"services": {}',
        "",
      ].join("\n"),
    );
  });

  it("renders sequences of mappings under a bare dash and empty collections inline", () => {
    expect(canonicalYaml({ routes: [{ b: 2, a: [1, "x"] }], aliases: [], env: {} })).toBe(
      [
        '"aliases": []',
        '"env": {}',
        '"routes":',
        "  -",
        '    "a":',
        '      - 1',
        '      - "x"',
        '    "b": 2',
        "",
      ].join("\n"),
    );
  });

  it("orders keys by Unicode code point rather than UTF-16 code unit", () => {
    // U+1F600 is above U+FF5E as a code point but below it as a surrogate pair.
    expect(compareCodePoints("\u{1F600}", "～")).toBeGreaterThan(0);
    expect(canonicalYaml({ "\u{1F600}": 1, "～": 2 })).toBe(
      `${JSON.stringify("～")}: 2\n${JSON.stringify("\u{1F600}")}: 1\n`,
    );
  });

  it("fails closed on values with no canonical encoding", () => {
    expect(() => canonicalYaml({ a: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalYaml({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
    expect(() => canonicalYaml({ a: [undefined] as never })).toThrow(CanonicalizationError);
    expect(() => canonicalYaml([] as never)).toThrow(CanonicalizationError);
    expect(() => canonicalYaml({})).toThrow(CanonicalizationError);
  });

  it("round-trips through a YAML 1.2 parser without aliases, tags, or comments", async () => {
    const compiled = await compileFixture("static-compose");
    const text = compiled.canonicalBytes.toString("utf8");

    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toMatch(/[\t\r]/u);
    expect(text).not.toMatch(/(^|\n)\s*#/u);
    expect(text).not.toMatch(/[&*!]/u);
    expect(parseYaml(text)).toEqual(JSON.parse(JSON.stringify(compiled.manifest)));
  });

  it("binds the digest to the algorithm, encoding, and canonicalization", async () => {
    const compiled = await compileFixture("static-compose");

    expect(compiled.digest).toEqual({
      apiVersion: "deploykit/digest/v1alpha1",
      algorithm: "sha256",
      encoding: "hex",
      canonicalization: RUNTIME_MANIFEST_CANONICALIZATION,
      value: createHash("sha256").update(compiled.canonicalBytes).digest("hex"),
    });
    expect(manifestDigestMatches(compiled.canonicalBytes, compiled.digest)).toBe(true);
    expect(manifestDigestMatches(Buffer.from("other"), compiled.digest)).toBe(false);
    expect(
      manifestDigestMatches(compiled.canonicalBytes, {
        ...compiled.digest,
        canonicalization: "deploykit/runtime-yaml-canonical/v0" as never,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- compile --

describe("deterministic compilation", () => {
  it("reproduces the frozen Phase 1 gateway manifest frame byte for byte", async () => {
    const compiled = await compileFixture("static-compose");
    const lines = (await readFile(
      resolve("test", "fixtures", "orchestrator", "protocol", "valid", "apply.jsonl"),
      "utf8",
    )).trim().split("\n");
    const frame = JSON.parse(lines[1]!) as {
      byteLength: number;
      digest: { value: string };
      payload: string;
    };

    expect(compiled.canonicalBytes.toString("base64")).toBe(frame.payload);
    expect(compiled.canonicalBytes.byteLength).toBe(frame.byteLength);
    expect(compiled.digest.value).toBe(frame.digest.value);
    // The runtime version is part of the canonical bytes; regenerate the
    // protocol fixtures deliberately when it changes.
    expect(compiled.manifest.metadata.requiredVersion).toBe(VERSION);
  });

  it.each(TOPOLOGIES)("compiles %s identically regardless of YAML shape", async (name) => {
    const document = parseYaml(await fixtureSource(name)) as unknown;
    const baseline = compileRuntimeManifest(parseOperatorConfig(document));

    const reordered = compileRuntimeManifest(parseOperatorConfig(reverseKeys(document)));
    const reserialized = compileRuntimeManifest(
      parseOperatorConfig(parseYaml(stringifyYaml(document, { indent: 4, lineWidth: 0 }))),
    );

    for (const other of [reordered, reserialized]) {
      expect(other.canonicalBytes.toString("utf8")).toBe(baseline.canonicalBytes.toString("utf8"));
      expect(other.digest.value).toBe(baseline.digest.value);
      expect(other.targetId).toBe(baseline.targetId);
    }
  });

  it.each(TOPOLOGIES)("keeps %s manifest bytes independent of backend secret values", async (name) => {
    const document = parseYaml(await fixtureSource(name)) as {
      environment: { backend: Record<string, string> };
    };
    const baseline = compileRuntimeManifest(parseOperatorConfig(document));

    const environment = document.environment;
    const rotated = {
      ...document,
      environment: {
        ...environment,
        backend: Object.fromEntries(
          Object.entries(environment.backend).map(([key], index) => [key, `DK_CANARY_ROTATED_${index}`]),
        ),
      },
    };
    const compiled = compileRuntimeManifest(parseOperatorConfig(rotated));

    expect(Object.keys(environment.backend).length).toBeGreaterThan(0);
    expect(compiled.canonicalBytes.toString("utf8")).toBe(baseline.canonicalBytes.toString("utf8"));
    expect(compiled.digest.value).toBe(baseline.digest.value);
  });

  it("derives a target id from the repository and target name only", async () => {
    const compiled = await compileFixture("static-compose");

    expect(compiled.targetId).toMatch(/^[0-9a-f]{32}$/u);
    expect(compiled.targetId).toBe(
      makeOrchestratorTargetId("deploykit-fixtures/static-compose", "production"),
    );
    expect(compiled.manifest.target.targetId).toBe(compiled.targetId);
    expect(makeOrchestratorTargetId("deploykit-fixtures/static-compose", "staging")).not.toBe(
      compiled.targetId,
    );
    expect(makeOrchestratorTargetId("other/static-compose", "production")).not.toBe(compiled.targetId);
  });

  it("maps hostPort auto to no caller-requested port and keeps an explicit one", async () => {
    const document = parseYaml(await fixtureSource("static-compose")) as Record<string, unknown>;
    const services = document.services as Record<string, Record<string, unknown>>;

    const auto = compileRuntimeManifest(parseOperatorConfig(document));
    expect(services.api!.hostPort).toBe("auto");
    expect(auto.manifest.services.api).not.toHaveProperty("hostPort");
    expect(auto.canonicalBytes.toString("utf8")).not.toContain("hostPort");

    const pinned = compileRuntimeManifest(
      parseOperatorConfig({ ...document, services: { api: { ...services.api, hostPort: 31_337 } } }),
    );
    expect(pinned.manifest.services.api).toMatchObject({ hostPort: 31_337 });
    expect(pinned.digest.value).not.toBe(auto.digest.value);
  });

  it("applies runtime defaults and orders routes most specific first", async () => {
    const compiled = await compileFixture("static-compose");

    expect(compiled.manifest.services.api!.healthCheck).toMatchObject(RUNTIME_HEALTH_DEFAULTS);
    expect(compiled.manifest.routes.map((route) => `${route.match}:${route.path}`)).toEqual([
      "exact:/api/upload",
      "prefix:/api/",
    ]);
    expect(compiled.manifest.routes[1]!.timeouts).toEqual(RUNTIME_ROUTE_TIMEOUT_DEFAULTS);
    expect(compiled.manifest.routes[1]).toMatchObject({ preservePrefix: true, buffering: true, sse: false });
  });

  it("sorts every map, domain, workload, consumer, and secret name", async () => {
    const compiled = await compileFixture("pm2-compose-db");
    const sorted = (values: readonly string[]): string[] => [...values].sort(compareCodePoints);

    expect(Object.keys(compiled.manifest.services)).toEqual(sorted(Object.keys(compiled.manifest.services)));
    expect(compiled.manifest.secrets.required).toEqual([
      "CERTBOT_EMAIL",
      "DATABASE_URL",
      "LOG_LEVEL",
      "POSTGRES_PASSWORD",
    ]);
    expect(compiled.manifest.secrets.generated).toEqual(["DATABASE_URL", "POSTGRES_PASSWORD"]);
    expect(compiled.manifest.database).toMatchObject({ consumers: ["api", "ssr", "worker"] });
    // Compose file order is application-significant and is never sorted.
    expect(compiled.manifest.compose?.files).toEqual(["compose.yaml"]);
  });

  it("carries public values to both frontend kinds and refuses them without a frontend", async () => {
    const staticFrontend = await compileFixture("static-compose");
    const serviceFrontend = await compileFixture("container-external");

    expect(staticFrontend.manifest.frontend).toMatchObject({
      type: "static",
      publicEnvironment: { VITE_API_BASE_URL: "/api" },
    });
    expect(serviceFrontend.manifest.frontend).toMatchObject({
      type: "service",
      publicEnvironment: { PUBLIC_API_BASE_URL: "/api" },
    });

    const document = parseYaml(await fixtureSource("container-external")) as Record<string, unknown>;
    delete document.frontend;
    expect(() => compileRuntimeManifest(parseOperatorConfig(document))).toThrow(
      expect.objectContaining({ code: "DK_CONFIG_INVALID" }) as unknown as Error,
    );
  });

  it("refuses two workloads that claim one Compose service", async () => {
    const document = parseYaml(await fixtureSource("container-external")) as Record<string, unknown>;
    const services = document.services as Record<string, unknown>;

    expect(() =>
      compileRuntimeManifest(
        parseOperatorConfig({ ...document, services: { ...services, mirror: services.api } }),
      ),
    ).toThrow(expect.objectContaining({ code: "DK_CONFIG_INVALID" }) as unknown as Error);
  });

  it("refuses a Compose database service that is also a declared workload", async () => {
    const document = parseYaml(await fixtureSource("static-compose")) as Record<string, unknown>;
    const services = document.services as Record<string, Record<string, unknown>>;

    expect(() =>
      compileRuntimeManifest(
        parseOperatorConfig({
          ...document,
          services: { ...services, store: { ...services.api, service: "postgres" } },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "DK_CONFIG_INVALID" }) as unknown as Error);
  });

  it("keeps a WebSocket route buffered and forces an SSE route unbuffered", async () => {
    const websocket = await compileFixture("static-compose");
    const sse = await compileFixture("pm2-compose-db");

    expect(websocket.manifest.routes[1]).toMatchObject({ websocket: true, buffering: true });
    expect(sse.manifest.routes[0]).toMatchObject({ sse: true, buffering: false });
  });
});

// ------------------------------------------------- projection and planning --

describe("compiled project validation and planning", () => {
  it.each(TOPOLOGIES)("validates, plans, and generates %s from the compiled form", async (name) => {
    const directory = fixtureDirectory(name);
    const before = await treeFingerprint(directory);
    const compiled = await compileFixture(name);

    const validation = await validateCompiledProject(compiled, { sourceRoot: directory });
    expect(
      validation.errors,
      validation.errors.map((entry) => `${entry.code} ${entry.path.join(".")}: ${entry.message}`).join("\n"),
    ).toEqual([]);

    const plan = createCompiledDeploymentPlan(compiled, { commitSha: "a".repeat(40) });
    expect(plan.deploymentId).toBe(compiled.targetId);
    expect(plan.runnerLabel).toBeNull();
    expect(plan.execution).toBe("gateway");
    expect(plan.source.manifestDigest).toBe(compiled.digest.value);
    expect(plan.source.ref).toBe(compiled.applicationRef);
    expect(plan.githubEnvironment).toBe(compiled.manifest.target.githubEnvironment);
    expect(plan.files.some((file) => file.path.startsWith("/etc/deploykit/server-"))).toBe(false);
    expect(plan.ports.every((port) => port.bindAddress === "127.0.0.1")).toBe(true);
    expect(plan.ports.every((port) => port.allocation === "dynamic")).toBe(true);

    const projected = toProjectManifest(compiled.manifest);
    const ports = Object.fromEntries(plan.ports.map((port, index) => [port.service, 30_000 + index]));
    const nginx = generateNginxConfig(projected, {
      target: compiled.targetName,
      ports,
      staticRoot: projected.frontend?.type === "static" ? "/srv/deploykit/fixture/current/static" : undefined,
      tls: {},
    });
    expect(nginx).toContain("listen 443 ssl http2;");
    expect(nginx).toContain(compiled.manifest.target.primaryDomain);

    if (projected.compose !== undefined) {
      expect(
        generateComposeOverride(projected, {
          target: compiled.targetName,
          ports,
          envFile: "/etc/deploykit/targets/fixture/secrets.env",
          databaseInternalPort:
            projected.database?.type === "compose" ? projected.database.internalPort : undefined,
        }),
      ).toContain("services:");
    }
    if (Object.values(projected.services).some((service) => service.type === "pm2")) {
      expect(
        generatePm2Ecosystem(projected, {
          target: compiled.targetName,
          ports,
          releaseDirectory: `/srv/deploykit/fixture/releases/${"a".repeat(40)}`,
        }),
      ).toContain("COREPACK_HOME");
    }

    expect(await treeFingerprint(directory)).toEqual(before);
  });

  it("projects the runtime secret set back onto operator and generated names", async () => {
    const projected = toProjectManifest((await compileFixture("static-compose")).manifest);

    expect(projected.secrets).toEqual({
      required: ["CERTBOT_EMAIL"],
      generated: ["DATABASE_URL", "POSTGRES_PASSWORD"],
    });
    expect(projected.targets.production).toMatchObject({
      primaryDomain: "static.example.test",
      aliases: ["www.static.example.test"],
      environment: "fixture-static-production",
    });
    expect(projected.targets.production?.runnerLabel).toBeUndefined();
  });

  it("injects service-frontend public values as target runtime overrides", async () => {
    const projected = toProjectManifest((await compileFixture("pm2-compose-db")).manifest);

    expect(projected.targets.production?.runtimeOverrides).toEqual({ PUBLIC_API_BASE_URL: "/api" });
    expect(projected.targets.production?.publicOverrides).toEqual({});
    expect(
      generatePm2Ecosystem(projected, {
        target: "production",
        ports: { api: 30_001, ssr: 30_002 },
        releaseDirectory: `/srv/deploykit/fixture/releases/${"a".repeat(40)}`,
      }),
    ).toContain("PUBLIC_API_BASE_URL");
  });

  it("plans an explicit PM2 host port as an explicit reservation", async () => {
    const document = parseYaml(await fixtureSource("pm2-compose-db")) as Record<string, unknown>;
    const services = document.services as Record<string, Record<string, unknown>>;
    const compiled = compileRuntimeManifest(
      parseOperatorConfig({ ...document, services: { ...services, api: { ...services.api, hostPort: 31_100 } } }),
    );

    const plan = createCompiledDeploymentPlan(compiled);
    expect(plan.ports.find((port) => port.service === "api")).toMatchObject({
      purpose: "pm2",
      allocation: "explicit",
      requestedPort: 31_100,
      bindAddress: "127.0.0.1",
    });
    expect(plan.ports.find((port) => port.service === "ssr")).toMatchObject({ allocation: "dynamic" });
  });

  it("rejects a plan identity that is not a digest or a safe server id", async () => {
    const compiled = await compileFixture("static-compose");
    const projected = toProjectManifest(compiled.manifest);
    const { createDeploymentPlan } = await import("../src/plan.js");

    expect(() => createDeploymentPlan(projected, "production", { manifestDigest: "nope" })).toThrow(
      /manifestDigest/u,
    );
    expect(() => createDeploymentPlan(projected, "production", { targetId: "Bad Id" })).toThrow(/targetId/u);
  });
});

// ------------------------------------------------------------------- leaks --

describe("secret containment", () => {
  it.each(TOPOLOGIES)("keeps %s backend secret values out of every compiled artifact", async (name) => {
    const directory = fixtureDirectory(name);
    const document = parseYaml(await fixtureSource(name)) as {
      environment: { backend: Record<string, string> };
    };

    // Substituting distinctive canaries first keeps the scan honest: a short
    // fixture value such as "fixture" occurs innocently in public fields.
    const parsed = parseOperatorConfig({
      ...document,
      environment: {
        ...document.environment,
        backend: Object.fromEntries(
          Object.keys(document.environment.backend).map((key) => [key, `DK_CANARY_LEAK_${key}_VALUE`]),
        ),
      },
    });
    const compiled = compileRuntimeManifest(parsed);
    const values = Object.values(parsed.environment.backendValues);
    expect(values.length).toBeGreaterThan(0);

    const plan = createCompiledDeploymentPlan(compiled, { commitSha: "b".repeat(40) });
    const validation = await validateCompiledProject(compiled, { sourceRoot: directory });
    const artifacts = [
      compiled.canonicalBytes.toString("utf8"),
      JSON.stringify(compiled.manifest),
      JSON.stringify(compiled.digest),
      JSON.stringify(toProjectManifest(compiled.manifest)),
      JSON.stringify(plan),
      JSON.stringify(validation.issues),
    ].join("\n");

    for (const value of values) {
      expect(artifacts).not.toContain(value);
    }
    // Names are public; only the values are withheld.
    for (const secretName of compiled.manifest.secrets.required) {
      expect(compiled.canonicalBytes.toString("utf8")).toContain(secretName);
    }
  });

  it("reports a compile failure without echoing the offending value", async () => {
    const document = parseYaml(await fixtureSource("container-external")) as Record<string, unknown>;
    delete document.frontend;

    try {
      compileRuntimeManifest(parseOperatorConfig(document));
      expect.unreachable("compilation should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(DeployKitError);
      const serialized = JSON.stringify({
        message: (error as DeployKitError).message,
        details: (error as DeployKitError).details,
      });
      expect(serialized).toContain("PUBLIC_ENVIRONMENT_WITHOUT_FRONTEND");
      expect(serialized).not.toContain("not-a-real-password");
      expect(serialized).not.toContain("fixture-only-ca-certificate-material");
    }
  });
});
