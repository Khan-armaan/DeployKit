import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DEPLOYKIT_API_VERSION,
  ManifestFileError,
  deployKitManifestSchema,
  loadManifest,
  parseManifest,
  parseManifestYaml,
  stringifyManifest,
  type DeployKitManifestInput,
} from "../src/manifest.js";

function minimalManifest(): DeployKitManifestInput {
  return {
    apiVersion: DEPLOYKIT_API_VERSION,
    metadata: { name: "example-app", requiredVersion: "^0.1.0" },
    services: {
      api: {
        type: "pm2",
        role: "api",
        workingDirectory: "server",
        nodeVersion: "22.14.0",
        packageManager: "npm",
        startScript: "start",
        portEnvironmentVariable: "PORT",
        healthCheck: { type: "http", path: "/health" },
      },
    },
    routes: [{ path: "/api/", target: "api" }],
    targets: {
      production: {
        runnerLabel: "vps-production",
        primaryDomain: "example.com",
      },
    },
  };
}

describe("deployKitManifestSchema", () => {
  it("parses v1alpha1 manifests and materializes deterministic defaults", () => {
    const manifest = parseManifest(minimalManifest());

    expect(manifest.apiVersion).toBe("deploykit/v1alpha1");
    expect(manifest.routes[0]).toMatchObject({
      hostname: "@primary",
      match: "prefix",
      preservePrefix: true,
      buffering: true,
      timeouts: { connect: 60, send: 60, read: 60 },
    });
    expect(manifest.targets.production).toMatchObject({
      aliases: [],
      environment: "production",
      publicOverrides: {},
      runtimeOverrides: {},
    });
    expect(manifest.secrets).toEqual({ required: [], generated: [] });
  });

  it("uses streaming-safe buffering defaults", () => {
    const input = minimalManifest();
    input.routes = [
      { path: "/socket/", target: "api", websocket: true },
      { path: "/events/", target: "api", sse: true },
    ];

    const manifest = parseManifest(input);
    expect(manifest.routes.map((route) => route.buffering)).toEqual([false, false]);
  });

  it("supports Compose services, both frontends, and both database modes", () => {
    const compose = parseManifest({
      ...minimalManifest(),
      compose: { files: ["compose.yaml"] },
      services: {
        api: {
          type: "compose",
          service: "backend",
          internalPort: 3000,
          healthCheck: { type: "tcp" },
        },
      },
      frontend: {
        type: "static",
        workingDirectory: "frontend",
        nodeVersion: "20.18.1",
        packageManager: "pnpm",
        outputDirectory: "dist",
      },
      database: {
        type: "compose",
        service: "postgres",
        consumers: ["api"],
        volume: "postgres-data",
        credentials: {
          username: "app",
          database: "app",
          passwordSecret: "DB_PASSWORD",
        },
      },
    });
    expect(compose.services.api?.type).toBe("compose");
    expect(compose.frontend).toMatchObject({ type: "static", buildScript: "build", apiBasePath: "/api" });
    expect(compose.database?.type).toBe("compose");

    const external = parseManifest({
      ...minimalManifest(),
      frontend: { type: "service", service: "api" },
      database: {
        type: "external",
        connectionStringSecret: "DATABASE_URL",
      },
    });
    expect(external.frontend).toEqual({ type: "service", service: "api", publicEnvironment: {} });
    expect(external.database).toMatchObject({ type: "external", requireTls: true });
  });

  it("rejects unsafe paths, non-exact Node versions, and unknown keys", () => {
    const unsafePath = minimalManifest();
    unsafePath.services = {
      api: {
        type: "pm2",
        role: "api",
        workingDirectory: "../server",
        nodeVersion: "^22.0.0",
        packageManager: "npm",
        startScript: "start",
        portEnvironmentVariable: "PORT",
        healthCheck: { type: "http", path: "/health" },
      },
    };
    expect(() => parseManifest(unsafePath)).toThrow(z.ZodError);

    expect(() =>
      parseManifest({
        ...minimalManifest(),
        unexpected: true,
      }),
    ).toThrow(z.ZodError);
  });
});

describe("manifest YAML I/O", () => {
  it("round-trips normalized YAML", () => {
    const original = parseManifest(minimalManifest());
    const yaml = stringifyManifest(original);
    const reparsed = parseManifestYaml(yaml);

    expect(yaml).toContain("apiVersion: deploykit/v1alpha1");
    expect(reparsed).toEqual(original);
  });

  it("loads deploykit YAML from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-manifest-"));
    const file = join(directory, "deploykit.yaml");
    await writeFile(file, stringifyManifest(minimalManifest()), "utf8");

    await expect(loadManifest(file)).resolves.toMatchObject({
      metadata: { name: "example-app" },
    });
  });

  it("uses a stable error for malformed YAML", () => {
    try {
      parseManifestYaml("apiVersion: [", "broken.yaml");
      throw new Error("expected malformed YAML to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestFileError);
      expect((error as ManifestFileError).code).toBe("MANIFEST_YAML_INVALID");
      expect((error as ManifestFileError).filePath).toBe("broken.yaml");
    }
  });

  it("exposes the schema for integrations", () => {
    expect(deployKitManifestSchema.safeParse(minimalManifest()).success).toBe(true);
  });
});
