import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseManifest } from "../src/manifest.js";
import { parsePackageManagerDeclaration } from "../src/package-manager.js";
import { validateProject } from "../src/project-validation.js";
import { RecordingCommandRunner } from "../src/server/command.js";
import { COREPACK_VERSION, NodeToolchainManager } from "../src/server/toolchains.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("deterministic package-manager adapters", () => {
  it("parses only exact supported packageManager declarations", () => {
    expect(parsePackageManagerDeclaration("pnpm@10.6.2")).toEqual({ name: "pnpm", version: "10.6.2" });
    expect(parsePackageManagerDeclaration("bun@1.2.5-beta.1")).toEqual({ name: "bun", version: "1.2.5-beta.1" });
    expect(parsePackageManagerDeclaration("pnpm@latest")).toBeUndefined();
    expect(parsePackageManagerDeclaration("other@1.0.0")).toBeUndefined();
  });

  it("activates the exact pnpm version with a pinned Corepack runtime", async () => {
    let pnpmChecks = 0;
    const runner = new RecordingCommandRunner((spec) => {
      if (spec.command.endsWith("/pnpm")) {
        pnpmChecks += 1;
        return pnpmChecks === 1
          ? { exitCode: 1, dryRun: false }
          : { stdout: "10.6.2\n", dryRun: false };
      }
      if (spec.command.endsWith("/corepack")) return { stdout: `${COREPACK_VERSION}\n`, dryRun: false };
      return { exitCode: 0, dryRun: false };
    });
    const manager = new NodeToolchainManager({ runner, installRoot: "/opt/deploykit/node", architecture: "x64" });
    const toolchain = {
      version: "22.18.0",
      directory: "/opt/deploykit/node/22.18.0",
      binDirectory: "/opt/deploykit/node/22.18.0/bin",
      nodeExecutable: "/opt/deploykit/node/22.18.0/bin/node",
    };

    await expect(manager.ensurePackageManager(toolchain, "pnpm", "10.6.2"))
      .resolves.toBe("/opt/deploykit/node/22.18.0/bin/pnpm");
    expect(runner.invocations).toContainEqual(expect.objectContaining({
      command: "/opt/deploykit/node/22.18.0/bin/corepack",
      args: ["prepare", "pnpm@10.6.2", "--activate"],
      env: { COREPACK_HOME: "[SET]" },
    }));
  });

  it("installs an exact Bun npm package instead of an unpinned global binary", async () => {
    let bunChecks = 0;
    const runner = new RecordingCommandRunner((spec) => {
      if (spec.command.endsWith("/bun")) {
        bunChecks += 1;
        return bunChecks === 1
          ? { exitCode: 1, dryRun: false }
          : { stdout: "1.2.5\n", dryRun: false };
      }
      return { exitCode: 0, dryRun: false };
    });
    const manager = new NodeToolchainManager({ runner, installRoot: "/opt/deploykit/node", architecture: "x64" });
    const toolchain = {
      version: "22.18.0",
      directory: "/opt/deploykit/node/22.18.0",
      binDirectory: "/opt/deploykit/node/22.18.0/bin",
      nodeExecutable: "/opt/deploykit/node/22.18.0/bin/node",
    };

    await manager.ensurePackageManager(toolchain, "bun", "1.2.5");
    expect(runner.invocations).toContainEqual(expect.objectContaining({
      command: "/opt/deploykit/node/22.18.0/bin/npm",
      args: expect.arrayContaining(["bun@1.2.5"]),
    }));
  });

  it("rejects non-npm projects that omit an exact packageManager version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-manager-"));
    directories.push(directory);
    await mkdir(join(directory, "api"));
    await writeFile(join(directory, "api", "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
    const manifest = parseManifest({
      apiVersion: "deploykit/v1alpha1",
      metadata: { name: "manager-fixture", requiredVersion: "0.1.0" },
      services: {
        api: {
          type: "pm2",
          role: "api",
          workingDirectory: "api",
          nodeVersion: "22.18.0",
          packageManager: "pnpm",
          startScript: "start",
          portEnvironmentVariable: "PORT",
          healthCheck: { type: "http", path: "/health" },
        },
      },
      routes: [{ path: "/api/", target: "api" }],
      secrets: { required: ["CERTBOT_EMAIL"] },
      targets: { production: { runnerLabel: "vps-one", primaryDomain: "manager.example.com" } },
    });

    const validation = await validateProject(manifest, {
      manifestPath: join(directory, "deploykit.yaml"),
      inspectComposeConfig: false,
    });
    expect(validation.errors.map((issue) => issue.code)).toContain("PACKAGE_MANAGER_VERSION_REQUIRED");
  });
});
