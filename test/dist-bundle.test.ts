import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { Reporter } from "../src/output.js";
import { run as runProcess } from "../src/process.js";
import {
  CANARY_BACKEND_SECRET,
  HermeticGitHub,
  HermeticHost,
  HermeticKeyPairs,
  createApplicationRepository,
  fingerprintOf,
} from "./helpers/hermetic-world.js";

/**
 * The built bundle, driven end to end.
 *
 * Every other orchestrator suite imports from `src/`. The published CLI is a
 * different program: esbuild bundles it into `dist/cli.js` and splits shared
 * code into `dist/chunks/`, so every path a module derives from
 * `import.meta.url` resolves from a directory that does not exist in the source
 * tree. Three separate assets are located that way — the bundled config
 * example, the gateway client the managed workflow embeds, and the installer
 * assets beside the packed runtime bundle — and a source-tree test cannot fail
 * on any of them.
 *
 * So this suite runs a whole deployment through `dist/cli.js` with only the two
 * process boundaries replaced, exactly as `orchestrator-integration.test.ts`
 * does for `src/`. It deliberately lets the bundle pack its *own* runtime
 * bundle rather than being handed one, because locating the package root in
 * order to pack it is precisely the step that was broken.
 */

const REPOSITORY = "deploykit-fixtures/static-compose";
const ENVIRONMENT = "fixture-static-production";
const HOST = "vps.static.example.test";

/** The surface `dist/cli.js` exposes; typed here so `tsc` never needs `dist/`. */
interface BundledCli {
  runConfigDeployment(options: Record<string, unknown>): Promise<{
    outcome: string;
    httpsUrl: string | null;
    commitSha: string | null;
    manifestDigest: { value: string } | null;
    workflowRunUrl: string | null;
    healthy: boolean | null;
    recovery: string;
  }>;
  configureProgram(): { commands: { name(): string }[] };
}

class MemoryStream extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.text += String(chunk);
    done();
  }
}

/**
 * Lift the gateway client back out of the managed workflow. The step writes the
 * client through a quoted heredoc inside a YAML block scalar, so the bytes on
 * the branch are indented; parsing the document undoes the block indentation and
 * the heredoc delimiters bound the client exactly.
 */
function gatewayClientFromWorkflow(workflow: string): string {
  const document = parseYaml(workflow) as {
    jobs?: Record<string, { steps?: { name?: string; run?: string }[] }>;
  };
  const steps = Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const step = steps.find((candidate) => candidate.name === "Install the bounded gateway client");
  expect(step, "the managed workflow installs the bounded gateway client").toBeDefined();
  const lines = (step?.run ?? "").split("\n");
  const opened = lines.findIndex((line) => line.includes("<<'DEPLOYKIT_GATEWAY_CLIENT'"));
  expect(opened, "the client is written through the reserved quoted heredoc").toBeGreaterThanOrEqual(0);
  const closed = lines.indexOf("DEPLOYKIT_GATEWAY_CLIENT", opened + 1);
  expect(closed, "the heredoc is closed").toBeGreaterThan(opened);
  return lines.slice(opened + 1, closed).join("\n");
}

let bundle: BundledCli;
let temporaryRoots: string[] = [];

beforeAll(async () => {
  const entry = resolve("dist", "cli.js");
  expect(
    existsSync(entry),
    "run `npm run build` before this suite; it verifies the built bundle",
  ).toBe(true);
  // Imported by URL so this is the real published entrypoint rather than a
  // re-resolution of the source it was built from.
  bundle = (await import(pathToFileURL(entry).href)) as unknown as BundledCli;
});

beforeEach(() => {
  temporaryRoots = [];
});

afterEach(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

describe("the built dist bundle", () => {
  it("deploys end to end, resolving every packaged asset from dist/", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-dist-")));
    temporaryRoots.push(root);

    const applicationRoot = join(root, "app");
    await createApplicationRepository(applicationRoot, async (args) => {
      await runProcess("git", args, { cwd: root });
    });

    const github = new HermeticGitHub({ repository: REPOSITORY });
    const host = new HermeticHost({ host: HOST, repository: REPOSITORY });
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();

    const configPath = join(applicationRoot, "deploykit.config.yaml");
    const source = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      source.replace(
        /hostKeyFingerprint: .*/u,
        `hostKeyFingerprint: ${fingerprintOf(host.hostKeyLine.split(" ").slice(1).join(" "))}`,
      ),
    );

    const result = await bundle.runConfigDeployment({
      reporter: new Reporter("json", false, stdout, stderr),
      cwd: applicationRoot,
      githubRunner: github,
      administratorRunner: host,
      keyPairs: new HermeticKeyPairs(),
      temporaryRoot: root,
      operationStateRoot: join(root, "state"),
      interactive: false,
      polling: { intervalMs: 0, correlationAttempts: 4, runAttempts: 8 },
      pollIntervalMs: 0,
      sleep: async () => undefined,
      // No `runtimeBundle`: the bundle must locate its own package root, pack
      // it, and verify the tarball carries the standalone runtime.
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.httpsUrl).toBe("https://static.example.test/");
    expect(result.healthy).toBe(true);
    expect(result.commitSha).toBe(github.applicationCommitSha);

    // The gateway client asset was found from `dist/` and embedded verbatim in
    // the managed workflow that reached the protected default branch. The
    // workflow is YAML, so the client lives inside a block scalar and every one
    // of its lines is indented; comparing against the raw file means parsing the
    // document and lifting the heredoc body back out rather than substring
    // matching the serialized bytes.
    const workflow = github.branches.get("main")?.files.get(".github/workflows/deploykit.yml") ?? "";
    const embedded = gatewayClientFromWorkflow(workflow);
    // Bytes that exist only inside the asset, so this proves the real file was
    // read from `dist/` rather than a fallback or an empty string.
    const client = await readFile(resolve("assets", "gateway-client.mjs"), "utf8");
    expect(embedded).toBe(client.endsWith("\n") ? client.slice(0, -1) : client);

    // The installer assets were found from `dist/` and uploaded beside a real
    // packed tarball whose checksum the host confirmed.
    const uploaded = host.calls.filter((call) => call.command === "scp").flatMap((call) => call.args);
    for (const asset of ["bootstrap.sh", "gateway-binding.sh", "gateway-keys.sh", "gateway-source-probe.sh", "github-known-hosts"]) {
      expect(uploaded.some((argument) => argument.endsWith(`/assets/${asset}`)), asset).toBe(true);
    }
    expect(host.binding?.runtimeBundleSha256).toMatch(/^[0-9a-f]{64}$/u);

    // The bundle carries its own copy of the redactor, so this proves the
    // shipped one works rather than the source tree's.
    expect(stdout.text).not.toContain(CANARY_BACKEND_SECRET);
    expect(stderr.text).not.toContain(CANARY_BACKEND_SECRET);
    expect(github.environments.get(ENVIRONMENT)?.secrets.get("CERTBOT_EMAIL")).toBe(CANARY_BACKEND_SECRET);
  }, 300_000);

  it("scaffolds the bundled config example from dist/", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-dist-scaffold-")));
    temporaryRoots.push(root);
    await runProcess("git", ["init", "--quiet", root]);

    const stdout = new MemoryStream();
    const failure = await bundle
      .runConfigDeployment({
        reporter: new Reporter("json", false, stdout, new MemoryStream()),
        cwd: root,
        interactive: false,
        operationStateRoot: join(root, "state"),
      })
      .then(() => undefined, (error: unknown) => error as { code?: string });

    // Locating `assets/deploykit.config.example.yaml` from `dist/` is what
    // failed in the packaged CLI while every source-tree test passed.
    expect(failure?.code).toBe("DK_CONFIG_SCAFFOLDED");
    expect(existsSync(join(root, "deploykit.config.yaml"))).toBe(true);
  }, 120_000);

  it("exposes the same command surface as the source tree", () => {
    expect(bundle.configureProgram().commands.map((command) => command.name())).toEqual([
      "init",
      "validate",
      "plan",
      "advise",
      "server",
      "secrets",
      "deploy",
      "retry",
      "status",
      "logs",
    ]);
  });
});
