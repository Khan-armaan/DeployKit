import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSupportedUbuntu, planBootstrap } from "../src/server/bootstrap.js";
import { ProcessCommandRunner } from "../src/server/command.js";
import { verifyDirectDns, type DnsResolver } from "../src/server/dns.js";
import { pollHealth } from "../src/server/health.js";
import { serverPaths } from "../src/server/paths.js";
import { ReleaseManager } from "../src/server/release.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("server primitives", () => {
  it("uses one server-wide deployment lock for every target", () => {
    const roots = {
      config: "/tmp/deploykit-test/etc",
      state: "/tmp/deploykit-test/state",
      data: "/tmp/deploykit-test/srv",
      nginxAvailable: "/tmp/deploykit-test/nginx-available",
      nginxEnabled: "/tmp/deploykit-test/nginx-enabled",
      letsEncryptWebroot: "/tmp/deploykit-test/acme",
    };
    expect(serverPaths("app-production-a123456789", roots).deploymentLockFile).toBe(
      serverPaths("other-staging-b123456789", roots).deploymentLockFile,
    );
  });

  it("stages immutable releases and atomically activates a validated release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-release-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "checkout");
    await mkdir(source);
    await writeFile(join(source, "app.txt"), "release contents\n");
    const roots = {
      config: join(directory, "server", "etc"),
      state: join(directory, "server", "state"),
      data: join(directory, "server", "srv"),
      nginxAvailable: join(directory, "server", "nginx-available"),
      nginxEnabled: join(directory, "server", "nginx-enabled"),
      letsEncryptWebroot: join(directory, "server", "acme"),
    };
    const manager = new ReleaseManager(serverPaths("sample-prod-a123456789", roots));
    const sha = "b".repeat(40);

    expect(await manager.stage(source, sha)).toMatchObject({ reused: false });
    expect(await manager.stage(source, sha)).toMatchObject({ reused: true });
    const active = await manager.activate(sha);
    expect(await manager.current()).toBe(active);
  });

  it("validates all direct DNS answers, including canonical IPv6 forms", async () => {
    const resolver: DnsResolver = {
      resolve: async (_domain, type) => {
        if (type === "A") return ["203.0.113.10"];
        if (type === "AAAA") return ["2001:0db8:0:0:0:0:0:10"];
        return [];
      },
    };
    const result = await verifyDirectDns(
      ["app.example.com"],
      ["203.0.113.10", "2001:db8::10"],
      resolver,
    );
    expect(result[0]?.addresses).toEqual(["203.0.113.10", "2001:db8::10"]);

    await expect(verifyDirectDns(["app.example.com"], ["192.0.2.1"], resolver))
      .rejects.toMatchObject({ code: "SERVER_DNS_MISMATCH" });

    await expect(verifyDirectDns(["app.example.com"], ["203.0.113.10"], {
      resolve: async (_domain, type) => type === "CNAME" ? ["proxy.example.net"] : ["203.0.113.10"],
    })).rejects.toMatchObject({ code: "SERVER_DNS_MISMATCH" });
  });

  it("polls health until ready and keeps command dry-runs as argv arrays", async () => {
    let clock = 0;
    let attempts = 0;
    const health = await pollHealth({
      url: "http://127.0.0.1:32000/health",
      timeoutMs: 1_000,
      intervalMs: 100,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      client: {
        get: async () => ({ status: ++attempts === 3 ? 204 : 503 }),
      },
    });
    expect(health).toMatchObject({ attempts: 3, status: 204, elapsedMs: 200 });

    const runner = new ProcessCommandRunner({ dryRun: true });
    const result = await runner.run({ command: "docker", args: ["compose", "up", "--detach"] });
    expect(result.dryRun).toBe(true);
    expect(runner.invocations[0]?.args).toEqual(["compose", "up", "--detach"]);
  });

  it("plans supported Ubuntu hosts around the gateway rather than a root runner", () => {
    const facts = assertSupportedUbuntu("ID=ubuntu\nVERSION_ID=24.04\n", "aarch64\n");
    expect(() => planBootstrap(facts, {
      repository: "owner/repo",
      githubEnvironment: "production",
      targetName: "production",
      targetId: "0".repeat(31),
    })).toThrowError(expect.objectContaining({ code: "SERVER_STATE_INVALID" }));

    const actions = planBootstrap(facts, {
      repository: "owner/repo",
      githubEnvironment: "production",
      targetName: "production",
      targetId: "04809ce707a77a199e6b989440139ba0",
    });
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: "Enable Docker" }),
      expect.objectContaining({ phase: "gateway", path: "/etc/deploykit/gateway/binding.json" }),
      expect.objectContaining({ phase: "gateway", path: "/etc/sudoers.d/deploykit-gateway", mode: 0o440 }),
      expect.objectContaining({ phase: "gateway", path: "/etc/deploykit/gateway/repository-key", mode: 0o600 }),
    ]));
    expect(actions.some((action) => action.phase === ("runner" as never))).toBe(false);
    expect(JSON.stringify(actions)).not.toContain("actions-runner");
  });
});
