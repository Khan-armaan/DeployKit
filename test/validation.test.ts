import { describe, expect, it } from "vitest";

import { parseManifest, type DeployKitManifestInput } from "../src/manifest.js";
import {
  ManifestValidationError,
  assertValidManifest,
  formatValidationIssue,
  validateComposeConfiguration,
  validateManifest,
} from "../src/validation.js";

function validManifest(): DeployKitManifestInput {
  return {
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: "sample", requiredVersion: "^0.1.0" },
    compose: { files: ["compose.yaml"] },
    services: {
      api: {
        type: "compose",
        service: "api",
        internalPort: 3000,
        healthCheck: { type: "http", path: "/health" },
      },
      worker: {
        type: "pm2",
        role: "worker",
        workingDirectory: "worker",
        nodeVersion: "22.14.0",
        packageManager: "npm",
        startScript: "start",
        healthCheck: { type: "process" },
      },
    },
    frontend: {
      type: "static",
      workingDirectory: "frontend",
      nodeVersion: "22.14.0",
      packageManager: "npm",
      outputDirectory: "dist",
      publicEnvironment: { VITE_API_BASE: "/api" },
    },
    routes: [
      {
        path: "/api/",
        target: "api",
        websocket: true,
      },
    ],
    database: {
      type: "compose",
      service: "postgres",
      internalPort: 5432,
      consumers: ["api", "worker"],
      volume: "postgres-data",
      credentials: {
        username: "app",
        database: "app",
        passwordSecret: "DB_PASSWORD",
        connectionStringSecret: "DATABASE_URL",
        connectionStringTemplate:
          "postgresql://{username}:{password}@{host}:{port}/{database}",
      },
      migrations: { service: "api", command: ["npm", "run", "migrate"] },
    },
    secrets: {
      required: ["CERTBOT_EMAIL", "OPENAI_API_KEY"],
      generated: ["DATABASE_URL", "DB_PASSWORD"],
    },
    targets: {
      production: {
        runnerLabel: "prod-vps",
        primaryDomain: "example.com",
        aliases: ["www.example.com"],
        publicOverrides: { VITE_API_BASE: "/api" },
        runtimeOverrides: { LOG_LEVEL: "info" },
      },
    },
  };
}

describe("validateManifest", () => {
  it("accepts a complete normalized manifest", () => {
    const result = validateManifest(validManifest());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.routes[0]?.buffering).toBe(false);
  });

  it("requires Compose files for any Compose workload", () => {
    const input = validManifest();
    delete input.compose;

    const result = validateManifest(input);
    expect(result.valid).toBe(false);
    expect(result.errors.map((entry) => entry.code)).toContain("COMPOSE_FILES_REQUIRED");
  });

  it("reports service, route, PM2, domain, and secret reference errors together", () => {
    const input = validManifest();
    input.services = {
      ...input.services,
      worker: {
        type: "pm2",
        role: "worker",
        workingDirectory: "worker",
        nodeVersion: "20.11.1",
        packageManager: "npm",
        startScript: "start",
        portEnvironmentVariable: "PORT",
        healthCheck: { type: "http", path: "/health" },
      },
    };
    input.routes = [{ path: "/missing/", target: "missing" }];
    input.database = {
      type: "external",
      connectionStringSecret: "EXTERNAL_DATABASE_URL",
      tlsCaSecret: "DATABASE_CA",
    };
    input.secrets = { required: ["SHARED", "SHARED"], generated: ["SHARED"] };
    input.targets = {
      production: {
        runnerLabel: "one",
        primaryDomain: "example.com",
        runtimeOverrides: { SHARED: "plaintext" },
      },
      staging: {
        runnerLabel: "two",
        primaryDomain: "example.com",
      },
    };

    const codes = new Set(validateManifest(input).errors.map((entry) => entry.code));
    expect(codes).toEqual(expect.objectContaining(new Set([
      "PM2_WORKER_PORT_FORBIDDEN",
      "PM2_WORKER_HEALTH_INVALID",
      "ROUTE_TARGET_UNKNOWN",
      "DOMAIN_TARGET_COLLISION",
      "SECRET_REQUIRED_DUPLICATE",
      "SECRET_KIND_CONFLICT",
      "SECRET_VALUE_IN_RUNTIME_OVERRIDE",
      "EXTERNAL_DATABASE_SECRET_REQUIRED",
    ])));
  });

  it("rejects ambiguous prefix routes and explicit buffering on streams", () => {
    const input = validManifest();
    input.routes = [{
      path: "/socket",
      target: "api",
      websocket: true,
      buffering: true,
    }];

    const codes = validateManifest(input).errors.map((entry) => entry.code);
    expect(codes).toContain("ROUTE_PREFIX_AMBIGUOUS");
    expect(codes).toContain("ROUTE_STREAM_BUFFERING_ENABLED");
  });

  it("keeps schema failures in the same structured result", () => {
    const result = validateManifest({ apiVersion: "wrong" });
    expect(result.valid).toBe(false);
    expect(result.manifest).toBeUndefined();
    expect(result.errors.every((entry) => entry.code === "MANIFEST_SCHEMA_INVALID")).toBe(true);
    expect(formatValidationIssue(result.errors[0]!)).toContain("[MANIFEST_SCHEMA_INVALID]");
  });

  it("throws one structured error from assertValidManifest", () => {
    const input = validManifest();
    delete input.compose;
    expect(() => assertValidManifest(input)).toThrow(ManifestValidationError);
  });
});

describe("validateComposeConfiguration", () => {
  it("rejects fixed container names and every unmanaged published port", () => {
    const manifest = parseManifest(validManifest());
    const result = validateComposeConfiguration(
      {
        services: {
          api: {
            container_name: "fixed-api",
            ports: [{ host_ip: "0.0.0.0", published: "3000", target: 3000 }],
          },
          postgres: {},
        },
        volumes: { "postgres-data": {} },
      },
      manifest,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "COMPOSE_CONTAINER_NAME_UNSAFE",
      "COMPOSE_PUBLISHED_PORT_UNMANAGED",
    ]));
  });

  it("checks manifest service and volume references against effective Compose output", () => {
    const manifest = parseManifest(validManifest());
    const result = validateComposeConfiguration({ services: {} }, manifest);
    const codes = result.errors.map((entry) => entry.code);

    expect(codes).toContain("COMPOSE_SERVICE_NOT_FOUND");
    expect(codes).toContain("COMPOSE_DATABASE_SERVICE_NOT_FOUND");
  });

  it("rejects host networking, scaling, and a declared-but-unmounted database volume", () => {
    const manifest = parseManifest(validManifest());
    const result = validateComposeConfiguration({
      services: {
        api: { network_mode: "host", deploy: { replicas: 2 } },
        postgres: { volumes: [] },
      },
      volumes: { "postgres-data": {} },
    }, manifest);
    expect(result.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "COMPOSE_NETWORK_MODE_UNSAFE",
      "COMPOSE_REPLICAS_UNSUPPORTED",
      "COMPOSE_DATABASE_VOLUME_NOT_MOUNTED",
    ]));
  });
});
