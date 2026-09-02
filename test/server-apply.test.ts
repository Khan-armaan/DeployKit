import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseManifest } from "../src/manifest.js";
import { DeploymentApplier, type DeploymentDriver } from "../src/server/apply.js";
import type { DnsRecordType, DnsResolver } from "../src/server/dns.js";
import { ServerError } from "../src/server/errors.js";
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

/**
 * Fails once at `tls-issued`, which is the first phase that runs *after*
 * `stageProxy` has already enabled the managed Nginx site. That ordering is the
 * whole point of the APP-01 rollback: the only thing a failed attempt may undo
 * is the link this attempt just activated.
 */
class FailingTlsDriver implements DeploymentDriver {
  readonly calls: string[] = [];
  private failTls = true;

  async stageSource(): Promise<void> { this.calls.push("source"); }
  async startWorkloads(): Promise<void> { this.calls.push("workloads"); }
  async runMigrations(): Promise<void> { this.calls.push("migrations"); }
  async verifyHealth(): Promise<void> { this.calls.push("health"); }
  async stageProxy(): Promise<void> { this.calls.push("proxy"); }
  async issueTls(): Promise<void> {
    this.calls.push("tls");
    if (this.failTls) {
      this.failTls = false;
      throw new ServerError("SERVER_COMMAND_FAILED", "certbot failed for super-secret reasons");
    }
  }
  async activate(): Promise<void> { this.calls.push("activate"); }
  async disableNewProxyAfterFailure(): Promise<void> { this.calls.push("disable-proxy"); }
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

/**
 * Everything an applier needs, on a fresh temporary root. Returned rather than
 * built inline so two scenarios exercise the same phase sequence, registry, and
 * redactor and differ only in where the driver fails.
 */
async function applierFixture(prefix: string, driver: DeploymentDriver): Promise<{
  readonly options: ConstructorParameters<typeof DeploymentApplier>[0];
  readonly paths: ReturnType<typeof serverPaths>;
  readonly registryFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "source"), { recursive: true });
  const roots = {
    config: join(directory, "etc"),
    state: join(directory, "state"),
    data: join(directory, "srv"),
    nginxAvailable: join(directory, "nginx-available"),
    nginxEnabled: join(directory, "nginx-enabled"),
    letsEncryptWebroot: join(directory, "acme"),
  };
  const lock = new InProcessLockProvider();
  const registryFile = join(roots.state, "registry.json");
  const registry = new RegistryStore({
    file: registryFile,
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
  return {
    options: {
      manifest,
      targetName: "prod",
      commitSha: "a".repeat(40),
      manifestDigest: "b".repeat(64),
      sourceDirectory: join(directory, "source"),
      serverAddresses: ["203.0.113.10"],
      roots,
      lock,
      registry,
      dnsResolver: new StaticDnsResolver(),
      driver,
      redactor: new SecretRedactor(["super-secret"]),
    },
    paths: serverPaths(makeTargetId("sample", "prod"), roots),
    registryFile,
  };
}

describe("DeploymentApplier", () => {
  it("resumes after the last durable checkpoint and then refuses redeployment", async () => {
    const driver = new FailingOnceDriver();
    const { options, paths } = await applierFixture("deploykit-apply-", driver);

    await expect(new DeploymentApplier(options).apply()).rejects.toThrow("[REDACTED]");
    expect(await readFile(paths.deploymentStateFile, "utf8")).not.toContain("super-secret");
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

  /**
   * APP-01. A phase that fails after the managed Nginx site is live is the one
   * case where a failed attempt must undo something, and the boundary of that
   * undo is exactly one link. Everything else a deployment produced — the
   * durable checkpoints up to the failure, the reserved ports and domains, the
   * release, the event log — has to survive, because the retry is what finishes
   * the deployment and it resumes from precisely those artifacts.
   */
  it("disables only the proxy it just activated when a later phase fails, and finishes on retry", async () => {
    const driver = new FailingTlsDriver();
    const { options, paths, registryFile } = await applierFixture("deploykit-apply-tls-", driver);

    await expect(new DeploymentApplier(options).apply())
      .rejects.toMatchObject({ code: "SERVER_COMMAND_FAILED" });

    // The rollback ran, and it ran once, after the phase that activated the site.
    expect(driver.calls).toEqual(["source", "workloads", "migrations", "health", "proxy", "tls", "disable-proxy"]);

    const failed = JSON.parse(await readFile(paths.deploymentStateFile, "utf8")) as {
      status: string;
      checkpoints: { phase: string }[];
      failures: { phase: string; code: string; message: string }[];
    };
    expect(failed.status).toBe("failed");
    expect(failed.failures).toHaveLength(1);
    expect(failed.failures[0]?.phase).toBe("tls-issued");
    expect(failed.failures[0]?.code).toBe("SERVER_COMMAND_FAILED");
    expect(failed.failures[0]?.message).not.toContain("super-secret");
    // Every phase before the failure is retained and contiguous, so the retry
    // skips them rather than repeating a workload start or a migration.
    expect(failed.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "manifest-validated", "dns-verified", "resources-reserved",
      "source-staged", "workloads-ready", "migrations-complete",
      "health-verified", "proxy-staged",
    ]);

    // Reservations are not released by a failure: the retry must get the same
    // loopback ports and the same domain, and nobody else may take them first.
    const reservedAfterFailure = await readFile(registryFile, "utf8");
    expect(reservedAfterFailure).toContain("app.example.com");

    const result = await new DeploymentApplier(options).apply();
    expect(result.resumed).toBe(true);
    expect(result.state.status).toBe("succeeded");
    expect(driver.calls).toEqual([
      "source", "workloads", "migrations", "health", "proxy", "tls", "disable-proxy",
      "tls", "activate",
    ]);
    expect(await readFile(registryFile, "utf8")).toBe(reservedAfterFailure);
  });
});
