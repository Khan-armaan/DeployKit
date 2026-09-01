import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEPLOY_CONFIG_FILE,
  resolveBundledConfigExamplePath,
  scaffoldDeployConfig,
} from "../src/config-scaffold.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(".");

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deploykit-config-"));
  await execFileAsync("git", ["init", "--quiet", root]);
  return root;
}

describe("deployment configuration scaffolding", () => {
  it("resolves the example shipped in the npm package", async () => {
    const examplePath = resolveBundledConfigExamplePath(packageRoot);
    expect(examplePath).toBe(resolve("assets/deploykit.config.example.yaml"));
    await expect(readFile(examplePath, "utf8")).resolves.toContain("deploykit/config/v1alpha1");

    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };
    expect(packageJson.files).toContain("assets");
  });

  it("creates a mode-0600 config, locally ignores it, and never overwrites it", async () => {
    const root = await temporaryRepository();
    const first = await scaffoldDeployConfig({ cwd: root, packageRoot });
    const expected = await readFile(resolveBundledConfigExamplePath(packageRoot), "utf8");

    expect(first.status).toBe("created");
    expect(first.configPath).toBe(join(await realpath(root), DEFAULT_DEPLOY_CONFIG_FILE));
    expect(await readFile(first.configPath, "utf8")).toBe(expected);
    expect((await stat(first.configPath)).mode & 0o777).toBe(0o600);
    await expect(readFile(first.excludePath, "utf8")).resolves.toContain("/deploykit.config.yaml");
    await expect(execFileAsync("git", ["-C", root, "check-ignore", "--quiet", "--no-index", "--", DEFAULT_DEPLOY_CONFIG_FILE]))
      .resolves.toBeDefined();

    await writeFile(first.configPath, `${expected}\n# user edit\n`, { mode: 0o600 });
    const second = await scaffoldDeployConfig({ cwd: root, packageRoot });
    expect(second.status).toBe("existing");
    await expect(readFile(second.configPath, "utf8")).resolves.toContain("# user edit");
  });

  it("rejects a tracked deployment config before reading it", async () => {
    const root = await temporaryRepository();
    const configPath = join(root, DEFAULT_DEPLOY_CONFIG_FILE);
    await writeFile(configPath, "backend-password: must-not-be-read\n", { mode: 0o600 });
    await execFileAsync("git", ["-C", root, "add", "--force", DEFAULT_DEPLOY_CONFIG_FILE]);

    await expect(scaffoldDeployConfig({ cwd: root, packageRoot })).rejects.toMatchObject({
      code: "DK_PREFLIGHT_FAILED",
      message: expect.stringContaining("must not be tracked or staged"),
    });
  });

  it("rejects symlinked and group-readable deployment configs", async () => {
    const symlinkRoot = await temporaryRepository();
    const outside = join(symlinkRoot, "outside.yaml");
    await writeFile(outside, "value: secret\n", { mode: 0o600 });
    await symlink(outside, join(symlinkRoot, DEFAULT_DEPLOY_CONFIG_FILE));
    await expect(scaffoldDeployConfig({ cwd: symlinkRoot, packageRoot })).rejects.toMatchObject({
      code: "DK_PREFLIGHT_FAILED",
      message: expect.stringContaining("regular file"),
    });

    const readableRoot = await temporaryRepository();
    const readableConfig = join(readableRoot, DEFAULT_DEPLOY_CONFIG_FILE);
    await writeFile(readableConfig, "value: secret\n", { mode: 0o600 });
    await chmod(readableConfig, 0o640);
    await expect(scaffoldDeployConfig({ cwd: readableRoot, packageRoot })).rejects.toMatchObject({
      code: "DK_PREFLIGHT_FAILED",
      message: expect.stringContaining("mode 0600"),
    });
  });
});
