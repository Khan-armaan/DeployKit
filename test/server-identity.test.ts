import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseManifest, type ProjectManifest } from "../src/manifest.js";
import {
  DeploymentApplier,
  assertIncomingSourceRoot,
  planDeployment,
  type DeploymentDriver,
  type ServerDeploymentPlan,
} from "../src/server/apply.js";
import type { DnsRecordType, DnsResolver } from "../src/server/dns.js";
import type { ServerError } from "../src/server/errors.js";
import { deployKitCodeForServerError, recoveryForServerError } from "../src/server/failures.js";
import { makeTargetId } from "../src/server/ids.js";
import { makeDeploymentIdentity } from "../src/server/identity.js";
import { inspectDeployment } from "../src/server/inspect.js";
import { InProcessLockProvider } from "../src/server/lock.js";
import { serverPaths, type ServerRoots } from "../src/server/paths.js";
import { RegistryStore, type ReserveResourcesRequest, type ReservedResources } from "../src/server/registry.js";
import { SecretRedactor } from "../src/server/secrets.js";
import {
  DEPLOYMENT_PHASES,
  DeploymentStateStore,
  type ServerDeploymentPhase,
} from "../src/server/state.js";

const CANARY = "DK_CANARY_POSTGRES_PASSWORD_c481ad";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "c".repeat(40);
const DIGEST_A = "b".repeat(64);
const DIGEST_B = "d".repeat(64);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function rootsIn(directory: string): ServerRoots {
  return {
    config: join(directory, "etc"),
    state: join(directory, "state"),
    data: join(directory, "srv"),
    nginxAvailable: join(directory, "nginx-available"),
    nginxEnabled: join(directory, "nginx-enabled"),
    letsEncryptWebroot: join(directory, "acme"),
  };
}

const MANIFEST: ProjectManifest = parseManifest({
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
  targets: { prod: { runnerLabel: "vps-one", primaryDomain: "app.example.com" } },
});

const TARGET_ID = makeTargetId("sample", "prod");

class StaticDnsResolver implements DnsResolver {
  async resolve(_domain: string, type: DnsRecordType): Promise<readonly string[]> {
    return type === "A" ? ["203.0.113.10"] : [];
  }
}

/** Fails one named phase, then succeeds, so every durable phase can be interrupted. */
class PhaseFailingDriver implements DeploymentDriver {
  readonly calls: string[] = [];

  constructor(private failAt: ServerDeploymentPhase | undefined) {}

  private async run(phase: ServerDeploymentPhase): Promise<void> {
    this.calls.push(phase);
    if (this.failAt === phase) {
      this.failAt = undefined;
      throw new Error(`simulated crash in ${phase} with ${CANARY}`);
    }
  }

  async stageSource(): Promise<void> { await this.run("source-staged"); }
  async startWorkloads(): Promise<void> { await this.run("workloads-ready"); }
  async runMigrations(): Promise<void> { await this.run("migrations-complete"); }
  async verifyHealth(): Promise<void> { await this.run("health-verified"); }
  async stageProxy(): Promise<void> { await this.run("proxy-staged"); }
  async issueTls(): Promise<void> { await this.run("tls-issued"); }
  async activate(): Promise<void> { await this.run("activated"); }
  async disableNewProxyAfterFailure(): Promise<void> { this.calls.push("disable-proxy"); }
}

interface Harness {
  readonly directory: string;
  readonly roots: ServerRoots;
  readonly plan: ServerDeploymentPlan;
  readonly registry: RegistryStore;
  readonly lock: InProcessLockProvider;
  readonly source: string;
  applierOptions(overrides?: {
    commitSha?: string;
    manifestDigest?: string;
    driver?: DeploymentDriver;
    registry?: RegistryStore;
  }): ConstructorParameters<typeof DeploymentApplier>[0];
}

async function harness(prefix = "deploykit-identity-"): Promise<Harness> {
  const directory = await temporaryDirectory(prefix);
  const roots = rootsIn(directory);
  const source = join(directory, "source");
  await mkdir(source, { recursive: true });
  const lock = new InProcessLockProvider();
  const registry = new RegistryStore({
    file: join(roots.state, "registry.json"),
    lockFile: join(roots.state, "registry.lock"),
    lock,
    portProbe: { isAvailable: async () => true },
    portRange: { start: 35_000, end: 35_010 },
  });
  const plan = planDeployment(MANIFEST, "prod", COMMIT_A, roots);
  return {
    directory,
    roots,
    plan,
    registry,
    lock,
    source,
    applierOptions(overrides = {}) {
      return {
        manifest: MANIFEST,
        targetName: "prod",
        commitSha: overrides.commitSha ?? COMMIT_A,
        manifestDigest: overrides.manifestDigest ?? DIGEST_A,
        sourceDirectory: source,
        serverAddresses: ["203.0.113.10"],
        roots,
        lock,
        registry: overrides.registry ?? registry,
        dnsResolver: new StaticDnsResolver(),
        driver: overrides.driver ?? new PhaseFailingDriver(undefined),
        redactor: new SecretRedactor([CANARY]),
      };
    },
  };
}

function stateStoreFor(roots: ServerRoots, lock: InProcessLockProvider): DeploymentStateStore {
  const paths = serverPaths(TARGET_ID, roots);
  return new DeploymentStateStore({
    file: paths.deploymentStateFile,
    lockFile: paths.deploymentStateLockFile,
    targetId: TARGET_ID,
    targetName: "prod",
    lock,
  });
}

describe("deployment identity binding", () => {
  it("resumes the same SHA and digest and refuses either identity change", async () => {
    const fixture = await harness();
    const driver = new PhaseFailingDriver("migrations-complete");
    await expect(new DeploymentApplier(fixture.applierOptions({ driver })).apply()).rejects.toMatchObject({
      code: "SERVER_APPLY_FAILED",
    });

    await expect(new DeploymentApplier(fixture.applierOptions({ commitSha: COMMIT_B })).apply())
      .rejects.toMatchObject({ code: "SERVER_IDENTITY_MISMATCH" } satisfies Partial<ServerError>);
    await expect(new DeploymentApplier(fixture.applierOptions({ manifestDigest: DIGEST_B })).apply())
      .rejects.toMatchObject({ code: "SERVER_IDENTITY_MISMATCH" } satisfies Partial<ServerError>);

    const resumed = await new DeploymentApplier(fixture.applierOptions({ driver })).apply();
    expect(resumed.resumed).toBe(true);
    expect(resumed.state.identity).toMatchObject({
      targetId: TARGET_ID,
      commitSha: COMMIT_A,
      manifestDigest: { value: DIGEST_A },
    });
    // The failure history from the interrupted attempt survives the resume.
    expect(resumed.state.failures).toHaveLength(1);
    expect(resumed.state.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(DEPLOYMENT_PHASES);

    // A completed target refuses every further apply, including its own identity.
    await expect(new DeploymentApplier(fixture.applierOptions()).apply())
      .rejects.toMatchObject({ code: "SERVER_DEPLOYMENT_EXISTS" } satisfies Partial<ServerError>);
    await expect(new DeploymentApplier(fixture.applierOptions({ commitSha: COMMIT_B, manifestDigest: DIGEST_B })).apply())
      .rejects.toMatchObject({ code: "SERVER_DEPLOYMENT_EXISTS" } satisfies Partial<ServerError>);
  });

  it("recovers after every durable phase without changing identity or checkpoint order", async () => {
    const interruptible = DEPLOYMENT_PHASES.slice(3, -1);
    for (const phase of interruptible) {
      const fixture = await harness(`deploykit-resume-${phase}-`);
      const driver = new PhaseFailingDriver(phase);
      await expect(new DeploymentApplier(fixture.applierOptions({ driver })).apply()).rejects.toThrow();

      const failed = await stateStoreFor(fixture.roots, fixture.lock).read();
      expect(failed?.status).toBe("failed");
      expect(failed?.checkpoints.map((checkpoint) => checkpoint.phase))
        .toEqual(DEPLOYMENT_PHASES.slice(0, DEPLOYMENT_PHASES.indexOf(phase)));

      driver.calls.length = 0;
      const result = await new DeploymentApplier(fixture.applierOptions({ driver })).apply();
      expect(result.state.status).toBe("succeeded");
      expect(result.state.identity.commitSha).toBe(COMMIT_A);
      expect(result.state.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(DEPLOYMENT_PHASES);
      // The resume re-runs the interrupted phase and everything after it, and
      // skips every phase that already has a durable checkpoint.
      expect(driver.calls).toEqual(DEPLOYMENT_PHASES.slice(DEPLOYMENT_PHASES.indexOf(phase), -1));
    }
    // Seven full interrupt-and-resume cycles, each taking real file locks; the
    // default five-second budget is not enough once the suite runs in parallel.
  }, 60_000);

  it("treats a running record as interrupted only under the server-wide deployment lock", async () => {
    const fixture = await harness();
    const store = stateStoreFor(fixture.roots, fixture.lock);
    const identity = makeDeploymentIdentity(TARGET_ID, COMMIT_A, DIGEST_A);
    await store.begin(identity);

    await expect(store.begin(identity))
      .rejects.toMatchObject({ code: "SERVER_DEPLOYMENT_IN_PROGRESS" } satisfies Partial<ServerError>);
    expect(await store.begin(identity, { serverDeploymentLockHeld: true }))
      .toMatchObject({ resumed: true, state: { attempt: 2 } });
  });

  it("preserves a completed legacy target and refuses to guess failed legacy state", async () => {
    const fixture = await harness();
    const paths = serverPaths(TARGET_ID, fixture.roots);
    await mkdir(join(paths.deploymentStateFile, ".."), { recursive: true });
    await writeFile(
      paths.deploymentStateFile,
      JSON.stringify({ version: 1, targetId: TARGET_ID, ref: "main", phase: "workloads-ready", status: "failed" }),
      { mode: 0o600 },
    );

    await expect(new DeploymentApplier(fixture.applierOptions()).apply())
      .rejects.toMatchObject({ code: "SERVER_STATE_LEGACY" } satisfies Partial<ServerError>);
    expect(deployKitCodeForServerError("SERVER_STATE_LEGACY")).toBe("DK_STATE_LEGACY");
    expect(recoveryForServerError("SERVER_STATE_LEGACY")).toBe("migrate-legacy-state");

    const legacyInspection = await inspectDeployment({
      targetId: TARGET_ID,
      targetName: "prod",
      roots: fixture.roots,
    });
    expect(legacyInspection).toMatchObject({
      recovery: "migrate-legacy-state",
      result: { outcome: "failed", manifestDigest: null, phase: "workloads-ready", failureCode: "DK_STATE_LEGACY" },
    });

    // Explicit migration is the only way to bind pre-digest state to an identity.
    const store = stateStoreFor(fixture.roots, fixture.lock);
    await store.migrateLegacyState(makeDeploymentIdentity(TARGET_ID, COMMIT_A, DIGEST_A));
    const migrated = await new DeploymentApplier(fixture.applierOptions()).apply();
    expect(migrated.state.status).toBe("succeeded");

    // A completed legacy target is preserved rather than migrated or redeployed.
    await writeFile(
      paths.deploymentStateFile,
      JSON.stringify({ version: 1, targetId: TARGET_ID, ref: "main", phase: "complete", status: "succeeded" }),
      { mode: 0o600 },
    );
    await expect(new DeploymentApplier(fixture.applierOptions()).apply())
      .rejects.toMatchObject({ code: "SERVER_DEPLOYMENT_EXISTS" } satisfies Partial<ServerError>);
    expect(await readFile(paths.deploymentStateFile, "utf8")).toContain('"version":1');
  });
});

describe("incoming project root", () => {
  it("refuses relative, missing, and runtime-owned roots", async () => {
    const fixture = await harness();
    const paths = fixture.plan.paths;
    await expect(assertIncomingSourceRoot("relative/source", paths))
      .rejects.toMatchObject({ code: "SERVER_SOURCE_ROOT_INVALID" } satisfies Partial<ServerError>);
    await expect(assertIncomingSourceRoot(join(fixture.directory, "absent"), paths))
      .rejects.toMatchObject({ code: "SERVER_SOURCE_ROOT_INVALID" } satisfies Partial<ServerError>);

    const file = join(fixture.directory, "not-a-directory");
    await writeFile(file, "");
    await expect(assertIncomingSourceRoot(file, paths))
      .rejects.toMatchObject({ code: "SERVER_SOURCE_ROOT_INVALID" } satisfies Partial<ServerError>);

    for (const owned of [paths.releasesDirectory, join(paths.releasesDirectory, "inner"), paths.targetConfigDirectory]) {
      await mkdir(owned, { recursive: true });
      await expect(assertIncomingSourceRoot(owned, paths))
        .rejects.toMatchObject({ code: "SERVER_SOURCE_ROOT_INVALID" } satisfies Partial<ServerError>);
    }

    // A symlink that resolves into a runtime-owned path is refused too.
    const link = join(fixture.directory, "link");
    await symlink(paths.releasesDirectory, link);
    await expect(assertIncomingSourceRoot(link, paths))
      .rejects.toMatchObject({ code: "SERVER_SOURCE_ROOT_INVALID" } satisfies Partial<ServerError>);

    // The validated root is the resolved path the deployment engine will use.
    expect(await assertIncomingSourceRoot(fixture.source, paths)).toBe(await realpath(fixture.source));
  });

  it("refuses a release created before the source-staged phase", async () => {
    const fixture = await harness();
    class ReleaseCreatingRegistry extends RegistryStore {
      async reserve(request: ReserveResourcesRequest): Promise<ReservedResources> {
        const reserved = await super.reserve(request);
        await mkdir(fixture.plan.paths.releaseDirectory(COMMIT_A), { recursive: true });
        return reserved;
      }
    }
    const registry = new ReleaseCreatingRegistry({
      file: join(fixture.roots.state, "registry.json"),
      lockFile: join(fixture.roots.state, "registry.lock"),
      lock: fixture.lock,
      portProbe: { isAvailable: async () => true },
      portRange: { start: 35_000, end: 35_010 },
    });

    await expect(new DeploymentApplier(fixture.applierOptions({ registry })).apply())
      .rejects.toMatchObject({ code: "SERVER_RELEASE_CONFLICT" } satisfies Partial<ServerError>);
  });
});

describe("redacted inspection result", () => {
  it("reports identity, resources, health, and recovery without leaking a secret", async () => {
    const fixture = await harness();
    const notDeployed = await inspectDeployment({
      targetId: TARGET_ID,
      targetName: "prod",
      roots: fixture.roots,
    });
    expect(notDeployed).toEqual({
      recovery: "none",
      result: {
        kind: "deployment",
        outcome: "not-deployed",
        targetName: "prod",
        targetId: TARGET_ID,
        commitSha: null,
        manifestDigest: null,
        phase: null,
        domains: [],
        ports: [],
        health: [],
        resumed: false,
        failureCode: null,
      },
    });

    const driver = new PhaseFailingDriver("health-verified");
    await expect(new DeploymentApplier(fixture.applierOptions({ driver })).apply()).rejects.toThrow();
    const failed = await inspectDeployment({ targetId: TARGET_ID, roots: fixture.roots });
    expect(failed.result).toMatchObject({
      outcome: "failed",
      targetName: "prod",
      commitSha: COMMIT_A,
      manifestDigest: { value: DIGEST_A },
      phase: "migrations-complete",
      domains: ["app.example.com"],
      ports: [{ service: "api", address: "127.0.0.1", port: 35_000 }],
      health: [],
      failureCode: "DK_DEPLOYMENT_FAILED",
    });
    expect(failed.recovery).toBe("rerun-same-command");
    expect(JSON.stringify(failed)).not.toContain(CANARY);
    const stateFile = serverPaths(TARGET_ID, fixture.roots).deploymentStateFile;
    expect(await readFile(stateFile, "utf8")).not.toContain(CANARY);

    const succeeded = await new DeploymentApplier(fixture.applierOptions({ driver })).apply();
    expect(succeeded.inspection).toMatchObject({
      recovery: "none",
      result: {
        outcome: "succeeded",
        phase: "complete",
        resumed: true,
        failureCode: null,
        health: [{ service: "api", healthy: true, check: "process" }],
        ports: [{ service: "api", address: "127.0.0.1", port: 35_000 }],
      },
    });
  });
});

describe("registry allocations", () => {
  it("keeps auto ports stable across retries and separates conflicting projects", async () => {
    const directory = await temporaryDirectory("deploykit-ports-");
    const lock = new InProcessLockProvider();
    const registry = new RegistryStore({
      file: join(directory, "registry.json"),
      lockFile: join(directory, "registry.lock"),
      lock,
      portProbe: { isAvailable: async () => true },
      portRange: { start: 36_000, end: 36_001 },
    });
    const request = (targetId: string, domain: string): ReserveResourcesRequest => ({
      targetId,
      domains: [domain],
      ports: [{ serviceKey: `${targetId}:api`, targetId, service: "api" }],
    });

    const first = await registry.reserve(request("alpha-a123456789", "alpha.example.com"));
    const second = await registry.reserve(request("beta-b123456789", "beta.example.com"));
    expect(first.portsByService).toEqual({ api: 36_000 });
    expect(second.portsByService).toEqual({ api: 36_001 });

    const retry = await registry.reserve(request("alpha-a123456789", "alpha.example.com"));
    expect(retry.portsByService).toEqual({ api: 36_000 });
    expect(await registry.describe("alpha-a123456789")).toMatchObject({
      portsByService: { api: 36_000 },
      domains: [{ domain: "alpha.example.com", targetId: "alpha-a123456789" }],
    });

    // The exhausted range refuses a third project without writing a partial reservation.
    await expect(registry.reserve(request("gamma-c123456789", "gamma.example.com")))
      .rejects.toMatchObject({ code: "SERVER_PORT_EXHAUSTED" } satisfies Partial<ServerError>);
    const registryState = await registry.read();
    expect(registryState.ports).toHaveLength(2);
    expect(registryState.domains.map((entry) => entry.domain)).toEqual([
      "alpha.example.com",
      "beta.example.com",
    ]);
  });
});
