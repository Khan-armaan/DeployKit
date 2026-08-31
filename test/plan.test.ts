import { describe, expect, it } from "vitest";

import { parseManifest, type DeployKitManifestInput } from "../src/manifest.js";
import {
  DeploymentPlanError,
  createDeploymentPlan,
  generateDeploymentPlan,
} from "../src/plan.js";
import { makeTargetId } from "../src/server/ids.js";

function plannedManifest(): DeployKitManifestInput {
  return {
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: "commerce", requiredVersion: "^0.1.0" },
    compose: { files: ["compose.yaml"] },
    services: {
      api: {
        type: "compose",
        service: "backend",
        internalPort: 3000,
        healthCheck: { type: "http", path: "/health" },
      },
      admin: {
        type: "pm2",
        role: "api",
        workingDirectory: "admin",
        nodeVersion: "20.18.1",
        packageManager: "pnpm",
        buildScript: "build",
        startScript: "start",
        portEnvironmentVariable: "ADMIN_PORT",
        healthCheck: { type: "tcp" },
      },
      worker: {
        type: "pm2",
        role: "worker",
        workingDirectory: "worker",
        nodeVersion: "22.14.0",
        packageManager: "npm",
        startScript: "work",
        healthCheck: { type: "process" },
      },
      "staging-api": {
        type: "compose",
        service: "staging-backend",
        internalPort: 3100,
        healthCheck: { type: "command", command: ["true"] },
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
      { path: "/api/", match: "prefix", target: "api", websocket: true },
      { path: "/api/upload", match: "exact", target: "api", uploadLimit: "25m", requestBuffering: false },
      { hostname: "preview.shop.example.com", path: "/preview/", target: "staging-api" },
    ],
    database: {
      type: "compose",
      service: "postgres",
      internalPort: 5432,
      consumers: ["api", "worker"],
      volume: "postgres-data",
      credentials: {
        username: "commerce",
        database: "commerce",
        passwordSecret: "DB_PASSWORD",
      },
      migrations: { service: "api", command: ["npm", "run", "migrate"] },
      seed: { service: "api", command: ["npm", "run", "seed"] },
    },
    secrets: { required: ["CERTBOT_EMAIL", "PAYMENT_API_TOKEN"], generated: ["DB_PASSWORD"] },
    targets: {
      production: {
        runnerLabel: "vps-one",
        primaryDomain: "shop.example.com",
        aliases: ["www.shop.example.com"],
        environment: "production-approval",
        publicOverrides: { VITE_API_BASE: "/api" },
        runtimeOverrides: { LOG_LEVEL: "info" },
      },
      preview: {
        runnerLabel: "vps-two",
        primaryDomain: "preview.shop.example.com",
      },
    },
  };
}

describe("createDeploymentPlan", () => {
  it("produces a deterministic, target-specific first-deployment plan", () => {
    const manifest = parseManifest(plannedManifest());
    const options = {
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      sourceRef: "main",
      serverAddresses: ["2001:db8::1", "203.0.113.10", "203.0.113.10"],
      certbotStaging: true,
    } as const;

    const first = createDeploymentPlan(manifest, "production", options);
    const second = generateDeploymentPlan(manifest, "production", options);
    const targetId = makeTargetId("commerce", "production");

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      apiVersion: "deploykit/plan/v1alpha1",
      deploymentId: targetId,
      runnerLabel: "vps-one",
      githubEnvironment: "production-approval",
      source: {
        ref: "main",
        commitSha: options.commitSha,
        releaseDirectory: `/srv/deploykit/${targetId}/releases/${options.commitSha}`,
      },
      failurePolicy: {
        retryFailedOnly: true,
        refuseCompletedDeployment: true,
      },
    });
    expect(first.domains).toEqual(["shop.example.com", "www.shop.example.com"]);
    expect(first.server.nodeVersions).toEqual(["20.18.1", "22.14.0", "22.18.0"]);
    expect(first.server.globalNodePackages).toEqual(["pm2@6.0.8"]);
  });

  it("allocates only loopback ports and exposes Compose databases only to PM2 consumers", () => {
    const plan = createDeploymentPlan(parseManifest(plannedManifest()), "production");

    expect(plan.ports.map((port) => port.id)).toEqual([
      "database:compose",
      "service:admin",
      "service:api",
    ]);
    expect(plan.ports.every((port) => port.bindAddress === "127.0.0.1")).toBe(true);
    expect(plan.ports.find((port) => port.id === "service:api")).toMatchObject({
      internalPort: 3000,
      allocation: "dynamic",
    });
    expect(plan.ports.some((port) => port.service === "worker")).toBe(false);
  });

  it("orders exact and longer Nginx routes before prefixes and plans WebSocket support", () => {
    const plan = createDeploymentPlan(parseManifest(plannedManifest()), "production");

    expect(plan.nginx.routes.map((route) => `${route.match}:${route.path}`)).toEqual([
      "exact:/api/upload",
      "prefix:/api/",
    ]);
    expect(plan.nginx.routes[1]).toMatchObject({
      websocket: true,
      buffering: false,
      upstreamPortId: "service:api",
    });
    expect(plan.nginx.usesConnectionUpgradeMap).toBe(true);
    expect(plan.nginx.static?.root).toContain("/static");
    expect(plan.nginx.activation).toBe("atomic-test-and-reload");
  });

  it("describes fatal hooks, protected secret storage, DNS, TLS, and managed files", () => {
    const plan = createDeploymentPlan(parseManifest(plannedManifest()), "production");

    const hooks = plan.processes.filter((process) => process.type === "hook");
    expect(hooks).toEqual([
      expect.objectContaining({ phase: "migrations", fatal: true }),
      expect.objectContaining({ phase: "seed", fatal: true }),
    ]);
    expect(plan.secrets).toMatchObject({ mode: "0600", required: ["CERTBOT_EMAIL", "PAYMENT_API_TOKEN"] });
    expect(plan.dnsChecks.every((check) => check.beforeMutation && check.directRecordsOnly)).toBe(true);
    expect(plan.certificate).toMatchObject({
      challenge: "webroot",
      managesNginxConfiguration: false,
      renewalReloadHook: "nginx-test-and-reload",
    });
    expect(plan.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      `/etc/nginx/sites-available/deploykit-${plan.deploymentId}.conf`,
      `/etc/deploykit/targets/${plan.deploymentId}/secrets.env`,
    ]));
  });

  it("rejects unknown targets and unsafe planning options", () => {
    const manifest = parseManifest(plannedManifest());
    expect(() => createDeploymentPlan(manifest, "staging")).toThrow(DeploymentPlanError);
    expect(() =>
      createDeploymentPlan(manifest, "production", { portRange: { start: 80, end: 90 } }),
    ).toThrowError(expect.objectContaining({ code: "PLAN_OPTIONS_INVALID" }));
    expect(() =>
      createDeploymentPlan(manifest, "production", { commitSha: "main" }),
    ).toThrowError(expect.objectContaining({ code: "PLAN_OPTIONS_INVALID" }));
  });
});
