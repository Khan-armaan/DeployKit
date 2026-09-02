import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePackageRoot } from "../src/package-root.js";
import { REQUIRED_BUNDLE_ENTRIES, resolveRuntimeBundle } from "../src/orchestrator/runtime-bundle.js";
import { BOOTSTRAP_NODE_VERSION, PM2_VERSION, VERSION } from "../src/version.js";

/**
 * Phase 14: what actually ships.
 *
 * Every other suite exercises the source tree, where a module sits at
 * `src/<area>/…` and the repository root is two directories up. The published
 * artifact has neither property: the CLI is bundled into `dist/`, split into
 * `dist/chunks/`, and installed under a scoped directory. A packaged install is
 * therefore a genuinely different program layout, and the only way to know it
 * works is to build it, pack it, install it, and run it.
 *
 * That is not a theoretical distinction. This suite is what caught a packaged
 * CLI that failed on its very first command because two modules located the
 * package root by assuming a fixed depth that is correct only in the source
 * tree.
 */

const run = promisify(execFile);

/** Packing, installing, and running a real tarball is slow; none of it is 5s work. */
const PACK_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 600_000;

interface PackedFile {
  readonly path: string;
  readonly mode: number;
}

interface PackResult {
  readonly filename: string;
  readonly files: readonly PackedFile[];
}

const EXECUTABLE_MODE = 0o755;
const READABLE_MODE = 0o644;

/** The only entries in the tarball that may be executable. */
const EXECUTABLE_ENTRIES: readonly string[] = [
  "assets/bootstrap.sh",
  "assets/gateway-binding.sh",
  "assets/gateway-keys.sh",
  "assets/gateway-source-probe.sh",
  "dist/cli.js",
  "dist/server-cli.cjs",
];

/** Files a deployment cannot happen without. */
const REQUIRED_ENTRIES: readonly string[] = [
  "package.json",
  "npm-shrinkwrap.json",
  "README.md",
  "SECURITY.md",
  "LICENSE",
  "CHANGELOG.md",
  // The one-file config the CLI copies on a first run.
  "assets/deploykit.config.example.yaml",
  // The installer and its root-owned helpers.
  "assets/bootstrap.sh",
  "assets/gateway-binding.sh",
  "assets/gateway-keys.sh",
  "assets/gateway-source-probe.sh",
  // The bounded client the managed workflow embeds verbatim.
  "assets/gateway-client.mjs",
  // The GitHub host keys the VPS pins instead of fetching.
  "assets/github-known-hosts",
  // The CLI, the library, and the standalone VPS runtime.
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/server-cli.cjs",
];

/** Directories the allowlist may produce. Anything else is a packaging mistake. */
const ALLOWED_TOP_LEVEL: readonly string[] = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "assets",
  "dist",
  "docs",
  "npm-shrinkwrap.json",
  "package.json",
];

let packed: PackResult;
const temporaryRoots: string[] = [];

async function workspace(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

beforeAll(async () => {
  // The dry run inspects the allowlist without writing a tarball, and reports
  // the exact modes npm will publish.
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], {
    cwd: resolve("."),
    maxBuffer: 32 * 1024 * 1024,
  });
  const entries = JSON.parse(stdout) as readonly PackResult[];
  const first = entries[0];
  expect(first, "npm pack reported no package").toBeDefined();
  packed = first as PackResult;
}, PACK_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// ----------------------------------------------------------- package root --

describe("locating the installed package root", () => {
  /**
   * The three layouts a module in this package is actually loaded from. Only
   * the first is what the rest of the test suite exercises, which is exactly
   * why the other two have to be asserted here.
   */
  const LAYOUTS: readonly string[] = [
    join("src", "orchestrator"),
    "dist",
    join("dist", "chunks"),
  ];

  it("finds the root from the source tree, from dist, and from dist/chunks", async () => {
    const scope = await workspace("deploykit-root-");
    // A scoped install puts the package one level below a directory that is
    // *not* a package. A fixed `../..` from `dist/` lands on it.
    const root = join(scope, "@deploykit001", "deploykit");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "assets", "bootstrap.sh"), "#!/usr/bin/env bash\n");

    for (const layout of LAYOUTS) {
      await mkdir(join(root, layout), { recursive: true });
      const moduleFile = join(root, layout, "module.js");
      await writeFile(moduleFile, "");
      expect(
        resolvePackageRoot({
          moduleUrl: pathToFileURL(moduleFile).href,
          markers: ["package.json", "assets/bootstrap.sh"],
          subject: "DeployKit package",
        }),
        `layout ${layout}`,
      ).toBe(root);
    }
  });

  it("refuses rather than guessing when the markers are not there", async () => {
    const scope = await workspace("deploykit-root-missing-");
    const moduleFile = join(scope, "dist", "module.js");
    await mkdir(join(scope, "dist"), { recursive: true });
    await writeFile(moduleFile, "");
    expect(() =>
      resolvePackageRoot({
        moduleUrl: pathToFileURL(moduleFile).href,
        markers: ["assets/deploykit.config.example.yaml"],
        subject: "deployment configuration template",
      }),
    ).toThrow(/not installed beside the DeployKit CLI/u);
  });

  it("says so plainly in the standalone VPS runtime, which has no package around it", () => {
    expect(() =>
      resolvePackageRoot({ moduleUrl: undefined, markers: ["package.json"], subject: "DeployKit package" }),
    ).toThrow(/unavailable in the standalone VPS runtime/u);
  });
});

// ------------------------------------------------------------ package API --

describe("published library surface", () => {
  it("exposes the deployment contract and withholds the orchestrator's wiring", async () => {
    const api = (await import("../src/index.js")) as Record<string, unknown>;

    // What a consumer needs to read `--json` output, validate a config, and
    // compile it into the manifest a VPS executes.
    for (const name of [
      "VERSION",
      "DeployKitError",
      "exitCodeFor",
      "ORCHESTRATOR_FAILURES",
      "FAILURE_CONTRACTS",
      "RECOVERY_INSTRUCTIONS",
      "failureContract",
      "recoveryInstruction",
      "loadOperatorConfig",
      "parseOperatorConfig",
      "compileRuntimeManifest",
      "canonicalRuntimeManifestBytes",
      "computeManifestDigest",
      "manifestDigestMatches",
      "validateCompiledProject",
      "GATEWAY_PROTOCOL_VERSION",
      "CONTRACT_KEY_ORDER",
    ]) {
      expect(Object.hasOwn(api, name), `${name} is not exported`).toBe(true);
    }

    // What it must not reach: running a deployment is the CLI's job, and a
    // half-wired composition root points at somebody's production host.
    for (const name of [
      "runProductionDeployment",
      "createProductionOrchestrator",
      "runDeployment",
      "createGitHubPort",
      "createGatewayTransport",
      "createOperationStatePort",
      "createGitHubClient",
      "createAdministratorSshPort",
    ]) {
      expect(Object.hasOwn(api, name), `${name} must not be part of the package API`).toBe(false);
    }
  });

  it("keeps the orchestrator's adapter modules out of the entrypoint", async () => {
    const source = await readFile("src/index.ts", "utf8");
    for (const module of [
      "orchestrator/production",
      "orchestrator/github-port",
      "orchestrator/gateway-transport",
      "orchestrator/operation-store",
      "orchestrator/administrator-ssh",
      "orchestrator/deploy",
    ]) {
      expect(source, `${module} must not be re-exported`).not.toContain(module);
    }
  });
});

// ------------------------------------------------------------- allowlist --

describe("published package allowlist", () => {
  it("ships every file a deployment needs", () => {
    const paths = packed.files.map((file) => file.path);
    for (const required of REQUIRED_ENTRIES) {
      expect(paths, `${required} is missing from the tarball`).toContain(required);
    }
  });

  it("ships nothing outside the declared allowlist", () => {
    const tops = new Set(packed.files.map((file) => file.path.split("/")[0] ?? ""));
    expect([...tops].sort()).toEqual([...ALLOWED_TOP_LEVEL].sort());
  });

  it("never ships sources, tests, local configuration, or a previous tarball", () => {
    for (const file of packed.files) {
      // A packed `deploykit.config.yaml` or `.env` would publish credentials;
      // a packed tarball or source map bloats every install for no benefit.
      expect(file.path.startsWith("src/"), file.path).toBe(false);
      expect(file.path.startsWith("test/"), file.path).toBe(false);
      expect(file.path.startsWith("coverage/"), file.path).toBe(false);
      expect(file.path.startsWith(".deploykit/"), file.path).toBe(false);
      expect(file.path.endsWith(".tgz"), file.path).toBe(false);
      expect(file.path.endsWith(".map"), file.path).toBe(false);
      expect(file.path.includes("deploykit.config.yaml"), file.path).toBe(false);
      expect(file.path.includes(".env"), file.path).toBe(false);
    }
  });

  it("marks exactly the installer helpers and the two executables as executable", () => {
    const executable = packed.files
      .filter((file) => (file.mode & 0o111) !== 0)
      .map((file) => file.path)
      .sort();
    expect(executable).toEqual([...EXECUTABLE_ENTRIES].sort());
    for (const file of packed.files) {
      const expected = EXECUTABLE_ENTRIES.includes(file.path) ? EXECUTABLE_MODE : READABLE_MODE;
      expect(file.mode & 0o777, `${file.path} has unexpected permissions`).toBe(expected);
    }
  });

  it("declares a bin the tarball actually contains", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
      files: readonly string[];
    };
    for (const target of Object.values(manifest.bin)) {
      expect(packed.files.map((file) => file.path)).toContain(target.replace(/^\.\//u, ""));
    }
  });

  it("carries every entry the VPS installer reads out of the tarball", () => {
    const paths = packed.files.map((file) => `package/${file.path}`);
    for (const entry of REQUIRED_BUNDLE_ENTRIES) {
      expect(paths, `the installer reads ${entry}`).toContain(entry);
    }
  });
});

// --------------------------------------------------------- version alignment --

describe("version alignment", () => {
  it("agrees across package.json, the shrinkwrap, and src/version.ts", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const shrinkwrap = JSON.parse(await readFile("npm-shrinkwrap.json", "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(manifest.version).toBe(VERSION);
    expect(shrinkwrap.version).toBe(VERSION);
    expect(shrinkwrap.packages[""]?.version).toBe(VERSION);
    expect(packed.filename).toContain(VERSION);
  });

  it("pins the same Node and PM2 versions in the installer as in the source", async () => {
    const installer = await readFile("assets/bootstrap.sh", "utf8");
    expect(installer).toContain(`DEPLOYKIT_NODE_VERSION="${BOOTSTRAP_NODE_VERSION}"`);
    expect(installer).toContain(`DEPLOYKIT_PM2_VERSION="${PM2_VERSION}"`);
  });

  it("keeps the frozen protocol fixture on the version the compiler stamps", async () => {
    // The compiled runtime manifest carries `requiredVersion: VERSION`, and
    // Phase 1 froze the exact manifest bytes and their digest in this fixture.
    // Changing VERSION therefore changes a frozen contract, and must be a
    // deliberate act that regenerates the fixture rather than a silent bump.
    const frame = await readFile("test/fixtures/orchestrator/protocol/valid/apply.jsonl", "utf8");
    const manifest = frame
      .split("\n")
      .map((line) => (line.trim() === "" ? undefined : (JSON.parse(line) as { frame: string; payload?: string })))
      .find((entry) => entry?.frame === "manifest");
    expect(manifest?.payload).toBeDefined();
    const decoded = Buffer.from(manifest?.payload ?? "", "base64").toString("utf8");
    expect(decoded).toContain(`"requiredVersion": "${VERSION}"`);
  });

  it("records the release in the changelog", async () => {
    const changelog = await readFile("CHANGELOG.md", "utf8");
    expect(changelog).toContain("## Unreleased");
    expect(changelog).toContain(`## ${VERSION}`);
  });
});

// -------------------------------------------------- the real installed CLI --

describe("the packaged CLI, installed and run", () => {
  let prefix: string;
  let binary: string;
  let installedRoot: string;
  let tarball: string;

  beforeAll(async () => {
    const root = await workspace("deploykit-package-");
    // `npm run check` builds before it tests, so `dist/` is this commit's.
    // Rebuilding here instead would delete `dist/` out from under the suites
    // running beside this one, several of which pack the package themselves.
    expect(
      existsSync(resolve("dist", "cli.js")) && existsSync(resolve("dist", "server-cli.cjs")),
      "run `npm run build` before this suite; it verifies the built artifact",
    ).toBe(true);
    const { stdout } = await run("npm", ["pack", "--json", "--dry-run=false", "--pack-destination", root], {
      cwd: resolve("."),
      maxBuffer: 32 * 1024 * 1024,
    });
    const filename = (JSON.parse(stdout) as readonly { filename: string }[])[0]?.filename ?? "";
    tarball = join(root, filename);

    prefix = join(root, "prefix");
    // `--dry-run=false` on both npm calls above and here: npm reads its own
    // configuration from the environment, so an ambient `npm_config_dry_run` —
    // which `npm publish --dry-run` of this package sets while it runs
    // `prepublishOnly` — would otherwise make the pack write no tarball and the
    // install create no prefix, and deliverable 3 would silently verify nothing.
    await run(
      "npm",
      [
        "install", "--global", "--dry-run=false", "--prefix", prefix,
        "--prefer-offline", "--no-audit", "--no-fund", tarball,
      ],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );
    binary = join(prefix, "bin", "deploykit");
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { name: string };
    installedRoot = join(prefix, "lib", "node_modules", ...manifest.name.split("/"));
  }, INSTALL_TIMEOUT_MS);

  /** Runs the installed binary, returning its output rather than throwing. */
  async function cli(
    args: readonly string[],
    options: { cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await run(binary, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        maxBuffer: 32 * 1024 * 1024,
      });
      return { ...result, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
    }
  }

  it("reports the packaged version from both entrypoints", async () => {
    expect((await cli(["--version"])).stdout.trim()).toBe(VERSION);
    // The standalone runtime is a separate CommonJS bundle; it must not drift.
    const server = await run(process.execPath, [join(installedRoot, "dist", "server-cli.cjs"), "--version"]);
    expect(server.stdout.trim()).toBe(VERSION);
  }, INSTALL_TIMEOUT_MS);

  it("prints help that leads with the one-file deployment", async () => {
    const help = await cli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("deploy [options]");
    const deployHelp = await cli(["deploy", "--help"]);
    for (const flag of ["--config <path>", "--dry-run", "--no-wait"]) {
      expect(deployHelp.stdout).toContain(flag);
    }
  }, INSTALL_TIMEOUT_MS);

  it("scaffolds, waits, and then refuses the untouched example", async () => {
    const application = join(await workspace("deploykit-package-app-"), "app");
    await run("git", ["init", "--quiet", application]);

    // 1. A first run creates the config and stops without any remote work.
    const scaffolded = await cli(["deploy", "--json"], { cwd: application });
    expect(scaffolded.exitCode).toBe(2);
    expect(JSON.parse(scaffolded.stderr)).toMatchObject({ ok: false, code: "DK_CONFIG_SCAFFOLDED" });

    const configPath = join(application, "deploykit.config.yaml");
    expect((await stat(configPath)).mode & 0o7777).toBe(0o600);
    const exclude = await readFile(join(application, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/deploykit.config.yaml");

    // 2. The bundled example resolved from inside the installed package, so it
    // still carries its placeholders and is refused.
    const untouched = await cli(["deploy", "--json"], { cwd: application });
    expect(untouched.exitCode).toBe(3);
    expect(JSON.parse(untouched.stderr)).toMatchObject({ ok: false, code: "DK_CONFIG_PLACEHOLDER" });

    // 3. `--dry-run` parses and reaches the same refusal, mutating nothing.
    const dryRun = await cli(["deploy", "--dry-run", "--json"], { cwd: application });
    expect(dryRun.exitCode).toBe(3);
    expect(JSON.parse(dryRun.stderr)).toMatchObject({ ok: false, code: "DK_CONFIG_PLACEHOLDER" });
  }, INSTALL_TIMEOUT_MS);

  it("emits one stable error envelope for a usage mistake", async () => {
    const failure = await cli(["deploy", "--target", "production", "--json"]);
    expect(failure.exitCode).toBe(2);
    expect(failure.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(failure.stderr)).toMatchObject({ ok: false, code: "DK_USAGE" });
  }, INSTALL_TIMEOUT_MS);

  it("packs a runtime bundle from the installed root that names the published package", async () => {
    const destination = await workspace("deploykit-package-bundle-");
    const bundle = await resolveRuntimeBundle({ packageRoot: installedRoot, destination });

    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { name: string };
    // The installer compares the name it is handed against the name inside the
    // tarball, so these two must be the published name and not a hard-coded one.
    expect(bundle.packageName).toBe(manifest.name);
    expect(bundle.version).toBe(VERSION);
    expect(bundle.packageSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(bundle.packageFile.startsWith(destination)).toBe(true);
  }, INSTALL_TIMEOUT_MS);

  // ------------------------------------------------------------ leak scan --

  it("carries no secret canary anywhere in the published tarball", async () => {
    const expectations = JSON.parse(
      await readFile("test/fixtures/orchestrator/expectations.json", "utf8"),
    ) as { canaries: readonly string[] };
    expect(expectations.canaries.length).toBeGreaterThan(2);

    const extracted = await workspace("deploykit-package-scan-");
    await run("tar", ["-xzf", tarball, "-C", extracted]);

    const needles = expectations.canaries.flatMap((canary) => [
      canary,
      Buffer.from(canary).toString("base64"),
    ]);
    let scanned = 0;
    for (const file of await walk(join(extracted, "package"))) {
      const contents = await readFile(file);
      scanned += 1;
      for (const needle of needles) {
        expect(contents.includes(needle), `${file} leaks a secret canary`).toBe(false);
      }
    }
    expect(scanned).toBeGreaterThan(50);
  }, INSTALL_TIMEOUT_MS);
});

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}
