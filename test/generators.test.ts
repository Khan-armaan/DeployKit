import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import {
  CHECKOUT_ACTION_SHA,
  generateComposeOverride,
  generateGitHubWorkflow,
  generateNginxConfig,
  generatePm2Ecosystem,
} from "../src/generators/index.js";
import { parseManifest, type ProjectManifest } from "../src/manifest.js";

function manifest(): ProjectManifest {
  return parseManifest({
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: "sample-app", requiredVersion: "0.1.0" },
    compose: { files: ["compose.yaml"] },
    services: {
      api: {
        type: "compose",
        service: "api",
        internalPort: 3_000,
        healthCheck: { type: "http", path: "/health" },
      },
      events: {
        type: "pm2",
        role: "api",
        workingDirectory: "events",
        nodeVersion: "22.14.0",
        packageManager: "pnpm",
        buildScript: "build",
        startScript: "start",
        portEnvironmentVariable: "PORT",
        healthCheck: { type: "http", path: "/health" },
      },
      worker: {
        type: "pm2",
        role: "worker",
        workingDirectory: "worker",
        nodeVersion: "20.19.1",
        packageManager: "npm",
        startScript: "start:prod",
        healthCheck: { type: "process" },
      },
    },
    frontend: {
      type: "static",
      workingDirectory: "frontend",
      nodeVersion: "22.14.0",
      packageManager: "npm",
      buildScript: "build",
      outputDirectory: "dist",
      spaFallback: true,
      apiBasePath: "/api",
      publicEnvironment: {},
    },
    routes: [
      {
        hostname: "@primary",
        path: "/api/v1/upload",
        match: "exact",
        target: "api",
        preservePrefix: true,
        uploadLimit: "25m",
        requestBuffering: false,
        timeouts: { connect: 60, send: 90, read: 90 },
      },
      {
        hostname: "@primary",
        path: "/api/",
        match: "prefix",
        target: "api",
        preservePrefix: false,
        websocket: false,
        timeouts: { connect: 60, send: 60, read: 60 },
      },
      {
        hostname: "@primary",
        path: "/events/",
        match: "prefix",
        target: "events",
        sse: true,
        timeouts: { connect: 30, send: 120, read: 120 },
      },
      {
        hostname: "@primary",
        path: "/socket/",
        match: "prefix",
        target: "api",
        websocket: true,
        timeouts: { connect: 30, send: 300, read: 300 },
      },
    ],
    database: {
      type: "compose",
      service: "postgres",
      internalPort: 5_432,
      consumers: ["api", "events"],
      volume: "postgres-data",
      credentials: {
        username: "app",
        database: "app",
        passwordSecret: "POSTGRES_PASSWORD",
        connectionStringSecret: "DATABASE_URL",
        connectionStringTemplate:
          "postgresql://{username}:{password}@{host}:{port}/{database}",
      },
    },
    secrets: {
      required: [],
      generated: ["POSTGRES_PASSWORD", "DATABASE_URL"],
    },
    targets: {
      production: {
        runnerLabel: "vps-one",
        primaryDomain: "app.example.com",
        aliases: ["www.app.example.com"],
        environment: "production",
        publicOverrides: {},
        runtimeOverrides: { LOG_LEVEL: "info" },
      },
      staging: {
        runnerLabel: "vps-two",
        primaryDomain: "staging.example.com",
        aliases: [],
        environment: "staging-approval",
        publicOverrides: {},
        runtimeOverrides: {},
      },
    },
  });
}

describe("GitHub workflow generator", () => {
  it("is deterministic, pinned, protected, and target-specific", () => {
    const first = generateGitHubWorkflow(manifest());
    const second = generateGitHubWorkflow(manifest());
    expect(first).toBe(second);
    expect(first).toContain(`actions/checkout@${CHECKOUT_ACTION_SHA}`);
    expect(first).not.toMatch(/actions\/checkout@v\d/);
    expect(first).toContain("DeployKit workflows must run from the protected default branch");
    expect(first).toContain("deploykit-${{ inputs.target }}");

    const workflow = parseYaml(first) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      jobs: Record<string, { "runs-on": string[]; environment: string }>;
    };
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      "target",
      "ref",
      "dry_run",
      "resume",
    ]);
    expect(workflow.jobs.deploy_production?.["runs-on"]).toEqual([
      "self-hosted",
      "deploykit",
      "vps-one",
    ]);
    expect(workflow.jobs.deploy_staging?.environment).toBe("staging-approval");
  });
});

describe("Nginx generator", () => {
  it("renders static, exact, prefix, WebSocket and SSE behavior safely", () => {
    const output = generateNginxConfig(manifest(), {
      target: "production",
      ports: { api: 20_001, events: 20_002 },
      staticRoot: "/srv/deploykit/sample-app/production/current/static",
    });
    expect(output).toContain("proxy_set_header Connection $connection_upgrade;");
    expect(output).not.toContain("map $http_upgrade $connection_upgrade");
    expect(output).toContain("location = /api/v1/upload");
    expect(output).toContain("client_max_body_size 25m;");
    expect(output).toContain("proxy_request_buffering off;");
    expect(output).toContain("location ^~ /api/");
    expect(output).toContain("proxy_pass http://127.0.0.1:20001/;");
    expect(output).toContain("root /srv/deploykit/sample-app/production/current/static;");
    expect(output).toContain("try_files $uri $uri/ /index.html;");
    expect(output).toContain("proxy_read_timeout 120s;");
    expect(output).toContain("proxy_cache off;");
    expect(output).toContain("proxy_set_header Connection $connection_upgrade;");
    expect(output.match(/proxy_set_header Upgrade/g)).toHaveLength(1);
    expect(output.indexOf("location = /api/v1/upload")).toBeLessThan(
      output.indexOf("location ^~ /api/"),
    );
  });

  it("renders webroot redirects and explicit TLS without Certbot mutation", () => {
    const output = generateNginxConfig(manifest(), {
      target: "staging",
      ports: { api: 20_011, events: 20_012 },
      staticRoot: "/srv/deploykit/sample-app/staging/current/static",
      tls: {},
      includeConnectionUpgradeMap: true,
    });
    expect(output).toContain("location ^~ /.well-known/acme-challenge/");
    expect(output).toContain("map $http_upgrade $connection_upgrade");
    expect(output).toContain("return 301 https://$host$request_uri;");
    expect(output).toContain(
      "ssl_certificate /etc/letsencrypt/live/staging.example.com/fullchain.pem;",
    );
    expect(output).not.toContain("certbot --nginx");
  });

  it("ignores explicit routes owned by another deployment target", () => {
    const project = manifest();
    project.routes.push({
      hostname: "staging.example.com",
      path: "/staging-only/",
      match: "prefix",
      target: "api",
      preservePrefix: true,
      websocket: false,
      sse: false,
      buffering: true,
      requestBuffering: true,
      timeouts: { connect: 60, send: 60, read: 60 },
    });

    const output = generateNginxConfig(project, {
      target: "production",
      ports: { api: 20_001, events: 20_002 },
      staticRoot: "/srv/deploykit/sample-app/production/current/static",
    });
    expect(output).not.toContain("staging.example.com");
    expect(output).not.toContain("/staging-only/");
  });
});

describe("PM2 ecosystem generator", () => {
  it("uses exact Node toolchains, stable names and loopback port environment", () => {
    const output = generatePm2Ecosystem(manifest(), {
      target: "production",
      releaseDirectory: "/srv/deploykit/sample-app/production/releases/abc123",
      ports: { events: 20_002 },
    });
    const json = output.slice(output.indexOf("{") , output.lastIndexOf(";") );
    const ecosystem = JSON.parse(json) as { apps: Array<Record<string, unknown>> };
    expect(ecosystem.apps).toHaveLength(2);
    expect(ecosystem.apps[0]).toMatchObject({
      name: "sample-app-production-events",
      cwd: "/srv/deploykit/sample-app/production/releases/abc123/events",
      script: "/opt/deploykit/node/22.14.0/bin/pnpm",
      args: ["run", "start"],
      interpreter: "none",
      env: expect.objectContaining({
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        PORT: "20002",
        HOST: "127.0.0.1",
      }),
    });
    expect(ecosystem.apps[1]).toMatchObject({ name: "sample-app-production-worker" });
    expect(output).not.toContain("POSTGRES_PASSWORD");
  });
});

describe("Compose override generator", () => {
  it("publishes only routed and PM2-consumed services on loopback", () => {
    const output = generateComposeOverride(manifest(), {
      target: "production",
      ports: { api: 20_001, "database:compose": 25_432 },
      databaseInternalPort: 5_432,
    });
    expect(output).toContain("name: deploykit-sample-app-production");
    expect(output).toContain("ports: !override");
    expect(output).toContain("127.0.0.1:20001:3000");
    expect(output).toContain("127.0.0.1:25432:5432");
    expect(output).not.toMatch(/(?:^|\s)0\.0\.0\.0:/);
    expect(output).toContain("/etc/deploykit/apps/sample-app/production.env");
    expect(output).toContain("LOG_LEVEL: info");
    expect(output).not.toContain("POSTGRES_PASSWORD");
  });

  it("does not publish a service routed only by another target's hostname", () => {
    const project = manifest();
    project.services.stagingApi = {
      type: "compose",
      service: "staging-api",
      internalPort: 3_001,
      healthCheck: {
        type: "command",
        command: ["node", "health.js"],
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 12,
        startPeriodSeconds: 0,
      },
    };
    project.routes.push({
      hostname: "staging.example.com",
      path: "/staging/",
      match: "prefix",
      target: "stagingApi",
      preservePrefix: true,
      websocket: false,
      sse: false,
      buffering: true,
      requestBuffering: true,
      timeouts: { connect: 60, send: 60, read: 60 },
    });

    const output = generateComposeOverride(project, {
      target: "production",
      ports: { api: 20_001, "database:compose": 25_432 },
      databaseInternalPort: 5_432,
    });
    const parsed = parseYaml(output, {
      customTags: [
        {
          tag: "!override",
          collection: "seq",
          resolve: (value) => value,
        },
      ],
    }) as { services: Record<string, { ports?: string[] }> };
    expect(parsed.services["staging-api"]?.ports).toBeUndefined();
  });
});
