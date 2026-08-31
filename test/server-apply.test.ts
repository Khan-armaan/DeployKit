import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseManifest } from "../src/manifest.js";
import { DeploymentApplier, type DeploymentDriver } from "../src/server/apply.js";
import type { DnsRecordType, DnsResolver } from "../src/server/dns.js";
import { InProcessLockProvider } from "../src/server/lock.js";
import { makeTargetId } from "../src/server/ids.js";
import { serverPaths } from "../src/server/paths.js";
import { RegistryStore } from "../src/server/registry.js";
import { SecretRedactor } from "../src/server/secrets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class StaticDnsResolver implements DnsResolver {
  async resolve(_domain: string, type: DnsRecordType): Promise<readonly string[]> {
    return type === "A" ? ["203.0.113.10"] : [];
  }
}

class FailingOnceDriver implements DeploymentDriver {
  readonly calls: string[] = [];
  private failMigration = true;

  async stageSource(): Promise<void> { this.calls.push("source"); }
  async startWorkloads(): Promise<void> { this.calls.push("workloads"); }
  async runMigrations(): Promise<void> {
    this.calls.push("migrations");
    if (this.failMigration) {
      this.failMigration = false;
      throw new Error("database password super-secret was rejected");
    }
  }
  async verifyHealth(): Promise<void> { this.calls.push("health"); }
  async stageProxy(): Promise<void> { this.calls.push("proxy"); }
  async issueTls(): Promise<void> { this.calls.push("tls"); }
  async activate(): Promise<void> { this.calls.push("activate"); }
  async disableNewProxyAfterFailure(): Promise<void> { this.calls.push("disable-proxy"); }
}

describe("DeploymentApplier", () => {
  it("resumes after the last durable checkpoint and then refuses redeployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-apply-"));
    temporaryDirectories.push(directory);
    const roots = {
      config: join(directory, "etc"),
      state: join(directory, "state"),
      data: join(directory, "srv"),
      nginxAvailable: join(directory, "nginx-available"),
      nginxEnabled: join(directory, "nginx-enabled"),
      letsEncryptWebroot: join(directory, "acme"),
    };
    const lock = new InProcessLockProvider();
    const registry = new RegistryStore({
      file: join(roots.state, "registry.json"),
      lockFile: join(roots.state, "registry.lock"),
      lock,
      portProbe: { isAvailable: async () => true },
      portRange: { start: 35_000, end: 35_010 },
    });
    const manifest = parseManifest({
      apiVersion: "deploykit/v1alpha1",
      metadata: { name: "sample", requiredVersion: "0.1.0" },
      services: {
        api: {
          type: "pm2",
          role: "api",
          nodeVersion: "22.14.0",
          packageManager: "npm",
          startScript: "start",
          healthCheck: { type: "process" },
        },
      },
      routes: [{ path: "/api", target: "api" }],
      targets: {
        prod: {
          runnerLabel: "vps-one",
          primaryDomain: "app.example.com",
        },
      },
    });
    const driver = new FailingOnceDriver();
    const options = {
      manifest,
      targetName: "prod",
      commitSha: "a".repeat(40),
      sourceDirectory: directory,
      serverAddresses: ["203.0.113.10"],
      roots,
      lock,
      registry,
      dnsResolver: new StaticDnsResolver(),
      driver,
      redactor: new SecretRedactor(["super-secret"]),
    };

    await expect(new DeploymentApplier(options).apply()).rejects.toThrow("[REDACTED]");
    const paths = serverPaths(makeTargetId("sample", "prod"), roots);
    const stateFile = paths.deploymentStateFile;
    expect(await readFile(stateFile, "utf8")).not.toContain("super-secret");
    const failureLog = await readFile(paths.deploymentLogFile, "utf8");
    expect(failureLog).toContain("SERVER_DEPLOYMENT_FAILED");
    expect(failureLog).not.toContain("super-secret");
    expect(driver.calls).toEqual(["source", "workloads", "migrations", "disable-proxy"]);

    const result = await new DeploymentApplier(options).apply();
    expect(result.resumed).toBe(true);
    expect(result.state.status).toBe("succeeded");
    expect(await readFile(paths.deploymentLogFile, "utf8")).toContain("SERVER_DEPLOYMENT_SUCCEEDED");
    expect(driver.calls).toEqual([
      "source", "workloads", "migrations", "disable-proxy",
      "migrations", "health", "proxy", "tls", "activate",
    ]);
    await expect(new DeploymentApplier(options).apply())
      .rejects.toMatchObject({ code: "SERVER_DEPLOYMENT_EXISTS" });
  });
});
