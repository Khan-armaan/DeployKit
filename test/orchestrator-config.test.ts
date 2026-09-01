import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exitCodeFor, type ErrorCode } from "../src/errors.js";
import { clearRedactedValues, redact } from "../src/output.js";
import {
  DEPLOY_CONFIG_FILE,
  loadOperatorConfig,
  locateOperatorConfig,
  parseOperatorConfig,
  partitionEnvironment,
  resolveBundledConfigExamplePath,
  scaffoldOperatorConfig,
  secureReadOperatorConfig,
} from "../src/orchestrator/config.js";
import { createExactValueRedactor } from "../src/orchestrator/redaction.js";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(".");
const FIXTURE_ROOT = resolve("test", "fixtures", "orchestrator");
const EXAMPLE_PATH = resolveBundledConfigExamplePath(packageRoot);

/** Replaces every placeholder the bundled example deliberately ships with. */
const EXAMPLE_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/your-org\/your-repo/gu, "acme-inc/storefront"],
  [/name: example-app/u, "name: storefront"],
  [/www\.app\.example\.com/gu, "www.app.acme.test"],
  [/app\.example\.com/gu, "app.acme.test"],
  [/vps\.example\.com/gu, "vps.acme.test"],
  [/\/home\/you\/\.ssh\/id_ed25519/gu, "/home/operator/.ssh/acme-production"],
  [/SHA256:replace-with-verified-ed25519-fingerprint/u, "SHA256:d0OhqaT54RQfWpZgR4SUpVx/ZFUMNXdYDdi5RlPALiI"],
  [/ops@example\.com/gu, "ops@acme.test"],
  [/example_app/gu, "storefront"],
];

interface ExpectationCase {
  readonly fixture: string;
  readonly code: ErrorCode;
  readonly recovery: string;
}

type Json = Record<string, unknown>;

async function temporaryRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-config-")));
  await execFileAsync("git", ["init", "--quiet", root]);
  return root;
}

async function fixtureConfig(name: string): Promise<Json> {
  const source = await readFile(resolve("test", "fixtures", name, "deploykit.config.fixture.yaml"), "utf8");
  return parseYaml(source) as Json;
}

async function filledExample(): Promise<string> {
  let source = await readFile(EXAMPLE_PATH, "utf8");
  for (const [pattern, value] of EXAMPLE_REPLACEMENTS) source = source.replace(pattern, value);
  return source;
}

async function writeConfig(root: string, contents: string): Promise<string> {
  const path = join(root, DEPLOY_CONFIG_FILE);
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function seedIgnoredRepository(contents: string): Promise<{ root: string; configPath: string }> {
  const root = await temporaryRepository();
  await scaffoldOperatorConfig({ cwd: root, packageRoot });
  const configPath = await writeConfig(root, contents);
  return { root, configPath };
}

interface Failure {
  readonly code?: string;
  readonly message: string;
  readonly details?: unknown;
}

/** Captures a synchronous DeployKit failure without swallowing other errors. */
function threw(action: () => unknown): Failure {
  try {
    action();
  } catch (error) {
    const failure = error as Failure;
    if (failure.code === undefined) throw error;
    return failure;
  }
  throw new Error("expected the call to fail");
}

async function thrown(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
    throw new Error("expected the call to fail");
  } catch (error) {
    const failure = error as { code?: string; message: string; details?: unknown };
    if (failure.code === undefined) throw error;
    return failure;
  }
}

afterEach(() => {
  clearRedactedValues();
  vi.restoreAllMocks();
});

// --------------------------------------------------------------- packaging --

describe("bundled configuration template", () => {
  it("is published at the path the scaffolder resolves", async () => {
    expect(EXAMPLE_PATH).toBe(resolve("assets", DEPLOY_CONFIG_FILE.replace(".yaml", ".example.yaml")));
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };
    expect(packageJson.files).toContain("assets");

    const packed = await execFileAsync("npm", ["pack", "--dry-run", "--json"], { maxBuffer: 32 * 1024 * 1024 });
    const entries = JSON.parse(packed.stdout) as readonly { files: readonly { path: string }[] }[];
    const paths = entries.flatMap((entry) => entry.files.map((file) => file.path));
    expect(paths).toContain("assets/deploykit.config.example.yaml");
  }, 120_000);

  it("demonstrates every workload, database, routing, and secret union", async () => {
    const source = await readFile(EXAMPLE_PATH, "utf8");
    for (const marker of [
      "type: compose",
      "type: pm2",
      "role: worker",
      "type: static",
      "type: service",
      "hostPort: auto",
      "healthCheck:",
      "database:",
      "connectionStringTemplate:",
      "generated:",
      "routes:",
    ]) {
      expect(source, `example is missing '${marker}'`).toContain(marker);
    }
  });

  it("refuses to deploy while its placeholders remain and parses once they are replaced", async () => {
    const example = parseYaml(await readFile(EXAMPLE_PATH, "utf8")) as unknown;
    const failure = threw(() => parseOperatorConfig(example));
    expect(failure.code).toBe("DK_CONFIG_PLACEHOLDER");
    expect((failure.details as Json).recovery).toBe("edit-config-and-rerun");

    const parsed = parseOperatorConfig(parseYaml(await filledExample()));
    expect(parsed.config.project.name).toBe("storefront");
    expect(parsed.environment.generatedNames).toEqual(["DATABASE_URL", "POSTGRES_PASSWORD", "SESSION_SECRET"]);
  });
});

// ---------------------------------------------------------------- scaffold --

describe("secure configuration scaffolding", () => {
  it("creates a mode-0600 config, excludes it locally, and never overwrites it", async () => {
    const root = await temporaryRepository();
    const first = await scaffoldOperatorConfig({ cwd: root, packageRoot });
    const expected = await readFile(EXAMPLE_PATH, "utf8");

    expect(first.status).toBe("created");
    expect(first.configPath).toBe(join(root, DEPLOY_CONFIG_FILE));
    expect(first.relativePath).toBe(DEPLOY_CONFIG_FILE);
    expect(await readFile(first.configPath, "utf8")).toBe(expected);
    expect((await stat(first.configPath)).mode & 0o7777).toBe(0o600);
    await expect(readFile(first.excludePath, "utf8")).resolves.toContain(`/${DEPLOY_CONFIG_FILE}`);
    await expect(
      execFileAsync("git", ["-C", root, "check-ignore", "--quiet", "--no-index", "--", DEPLOY_CONFIG_FILE]),
    ).resolves.toBeDefined();

    await writeConfig(root, `${expected}\n# operator edit\n`);
    const second = await scaffoldOperatorConfig({ cwd: root, packageRoot });
    expect(second.status).toBe("existing");
    await expect(readFile(second.configPath, "utf8")).resolves.toContain("# operator edit");
  });

  it("leaves the tracked .gitignore untouched", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await scaffoldOperatorConfig({ cwd: root, packageRoot });
    await expect(readFile(join(root, ".gitignore"), "utf8")).resolves.toBe("node_modules\n");
  });

  it("shares the main checkout's exclude file from a linked worktree", async () => {
    const root = await temporaryRepository();
    await execFileAsync("git", [
      "-C", root, "-c", "user.email=fixture@example.test", "-c", "user.name=fixture",
      "commit", "--quiet", "--allow-empty", "-m", "init",
    ]);
    const worktree = join(root, "..", `${root.split("/").at(-1) ?? "wt"}-linked`);
    await execFileAsync("git", ["-C", root, "worktree", "add", "--quiet", worktree, "-b", "feature"]);
    try {
      const outcome = await scaffoldOperatorConfig({ cwd: worktree, packageRoot });
      expect(outcome.status).toBe("created");
      expect(outcome.repositoryRoot).toBe(await realpath(worktree));
      expect(outcome.excludePath).toBe(join(root, ".git", "info", "exclude"));
      await expect(readFile(outcome.excludePath, "utf8")).resolves.toContain(`/${DEPLOY_CONFIG_FILE}`);
      expect((await stat(outcome.configPath)).mode & 0o7777).toBe(0o600);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("lets exactly one racing invocation win and leaves one intact file", async () => {
    const root = await temporaryRepository();
    const outcomes = await Promise.all([
      scaffoldOperatorConfig({ cwd: root, packageRoot }),
      scaffoldOperatorConfig({ cwd: root, packageRoot }),
      scaffoldOperatorConfig({ cwd: root, packageRoot }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "created")).toHaveLength(1);
    expect(await readFile(join(root, DEPLOY_CONFIG_FILE), "utf8")).toBe(await readFile(EXAMPLE_PATH, "utf8"));
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to scaffold beside a tracked configuration", async () => {
    const root = await temporaryRepository();
    await writeConfig(root, "backend-password: must-not-be-read\n");
    await execFileAsync("git", ["-C", root, "add", "--force", DEPLOY_CONFIG_FILE]);

    const failure = await thrown(scaffoldOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("must not be tracked or staged");
  });

  it("requires a Git repository before touching anything", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-nogit-")));
    const failure = await thrown(scaffoldOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_PREFLIGHT_FAILED");
    await expect(stat(join(root, DEPLOY_CONFIG_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ------------------------------------------------------------- secure read --

describe("secure configuration read", () => {
  it("returns the source only for a private, untracked, ignored regular file", async () => {
    const { root, configPath } = await seedIgnoredRepository(await filledExample());
    const read = await secureReadOperatorConfig({ cwd: root, packageRoot });
    expect(read).toMatchObject({
      repositoryRoot: root,
      configPath,
      mode: 0o600,
      ignored: true,
      tracked: false,
      staged: false,
    });
    expect(read.source).toContain("apiVersion: deploykit/config/v1alpha1");
  });

  it("rejects a symlinked configuration without following it", async () => {
    const root = await temporaryRepository();
    await scaffoldOperatorConfig({ cwd: root, packageRoot });
    const outside = join(root, "outside.yaml");
    await writeFile(outside, "value: secret\n", { mode: 0o600 });
    await rm(join(root, DEPLOY_CONFIG_FILE));
    await symlink(outside, join(root, DEPLOY_CONFIG_FILE));

    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("regular file");
  });

  it.each([0o640, 0o644, 0o660, 0o777])("rejects mode %s", async (mode) => {
    const { root, configPath } = await seedIgnoredRepository(await filledExample());
    await chmod(configPath, mode);
    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("mode 0600");
  });

  it("rejects a configuration owned by another user", async () => {
    const { root } = await seedIgnoredRepository(await filledExample());
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, "getuid").mockReturnValue(uid + 1);
    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("owned by the current user");
  });

  it("rejects a staged configuration before reading it", async () => {
    const { root } = await seedIgnoredRepository("backend-password: must-not-be-read\n");
    await execFileAsync("git", ["-C", root, "add", "--force", DEPLOY_CONFIG_FILE]);
    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("must not be tracked");
  });

  it("rejects a configuration Git no longer ignores", async () => {
    const { root } = await seedIgnoredRepository(await filledExample());
    const location = await locateOperatorConfig(root);
    await writeFile(location.excludePath, "");
    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("ignored by Git");
  });

  it("rejects an implausibly large configuration", async () => {
    const { root } = await seedIgnoredRepository(`# ${"padding ".repeat(80_000)}\n`);
    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_INSECURE");
    expect(failure.message).toContain("bytes");
  });

  it("reports a missing configuration as not yet scaffolded", async () => {
    const root = await temporaryRepository();
    await scaffoldOperatorConfig({ cwd: root, packageRoot });
    await rm(join(root, DEPLOY_CONFIG_FILE));
    const failure = await thrown(secureReadOperatorConfig({ cwd: root, packageRoot }));
    expect(failure.code).toBe("DK_CONFIG_SCAFFOLDED");
  });
});

// ------------------------------------------------------------------ schema --

describe("operator configuration schema", () => {
  it.each(["static-compose", "pm2-compose-db", "container-external"])(
    "accepts the complete %s topology",
    async (name) => {
      const parsed = parseOperatorConfig(await fixtureConfig(name));
      expect(parsed.config.apiVersion).toBe("deploykit/config/v1alpha1");
      expect(parsed.config.project.name).toBe(name);
      expect(parsed.environment.declaredSecretNames).toEqual([...parsed.environment.declaredSecretNames].sort());
    },
  );

  it("accepts every health-check and host-port union", async () => {
    const config = await fixtureConfig("pm2-compose-db");
    const services = config.services as Json;
    (services.api as Json).healthCheck = { type: "tcp", port: 3000, retries: 3 };
    (services.ssr as Json).healthCheck = { type: "process", startPeriodSeconds: 5 };
    (services.ssr as Json).hostPort = 41_000;
    (services.worker as Json).healthCheck = {
      type: "command",
      command: ["bun", "run", "health"],
      intervalSeconds: 30,
      timeoutSeconds: 10,
    };
    const parsed = parseOperatorConfig(config);
    expect(parsed.config.services.api?.healthCheck.type).toBe("tcp");
    expect(parsed.config.services.ssr?.healthCheck.type).toBe("process");
    expect(parsed.config.services.worker?.healthCheck.type).toBe("command");
  });

  it("rejects two workloads that pin the same host port", async () => {
    const config = await fixtureConfig("container-external");
    (((config.services as Json).api) as Json).hostPort = 41_000;
    (((config.services as Json).web) as Json).hostPort = 41_000;
    const failure = threw(() => parseOperatorConfig(config));
    expect(failure.code).toBe("DK_CONFIG_INVALID");
    expect(failure.message).toContain("host port 41000");
  });

  it("rejects a route pointed at a worker and a route hostname no target declares", async () => {
    const workerRoute = await fixtureConfig("pm2-compose-db");
    (workerRoute.routes as Json[])[0]!.target = "worker";
    expect((threw(() => parseOperatorConfig(workerRoute))).message)
      .toContain("is a worker and has no port");

    const foreignHost = await fixtureConfig("pm2-compose-db");
    (foreignHost.routes as Json[])[0]!.hostname = "other.example.test";
    expect((threw(() => parseOperatorConfig(foreignHost))).message)
      .toContain("is not a declared target domain");
  });

  it("rejects Compose workloads with no Compose files and unused Compose files", async () => {
    const missing = await fixtureConfig("static-compose");
    delete missing.compose;
    expect((threw(() => parseOperatorConfig(missing))).message)
      .toContain("must list the application Compose files");

    const unused = await fixtureConfig("pm2-compose-db");
    unused.database = { type: "external", connectionStringSecret: "DATABASE_URL" };
    (unused.environment as Json).generated = ["POSTGRES_PASSWORD"];
    ((unused.environment as Json).backend as Json).DATABASE_URL = "postgresql://example";
    expect((threw(() => parseOperatorConfig(unused))).message)
      .toContain("no workload or database uses Compose");
  });

  it("rejects a database secret that no private partition declares", async () => {
    const config = await fixtureConfig("container-external");
    delete ((config.environment as Json).backend as Json).DATABASE_CA;
    const failure = threw(() => parseOperatorConfig(config));
    expect(failure.message).toContain("environment.backend or environment.generated");
  });

  it("rejects unsafe refs, hosts, identity files, and fingerprints", async () => {
    const cases: readonly (readonly [readonly string[], unknown])[] = [
      [["project", "ref"], "refs/heads/../evil"],
      [["project", "ref"], "-oProxyCommand=touch"],
      [["project", "repository"], "not-a-repository"],
      [["server", "host"], "vps.example.test/../evil"],
      [["server", "identityFile"], "~/.ssh/id_ed25519"],
      [["server", "identityFile"], "/home/op/../../etc/shadow"],
      [["server", "hostKeyFingerprint"], "MD5:aa:bb:cc:dd"],
      [["server", "user"], "root; rm -rf /"],
      [["server", "port"], 0],
    ];
    for (const [path, value] of cases) {
      const config = await fixtureConfig("static-compose");
      const parent = config[path[0]!] as Json;
      parent[path[1]!] = value;
      const failure = threw(() => parseOperatorConfig(config));
      expect(failure.code, path.join(".")).toBe("DK_CONFIG_INVALID");
    }
  });

  it("partitions public values, backend values, and generated names deterministically", async () => {
    const parsed = parseOperatorConfig(await fixtureConfig("container-external"));
    expect(parsed.environment.publicValues).toEqual({ PUBLIC_API_BASE_URL: "/api" });
    expect(Object.keys(parsed.environment.backendValues)).toEqual([
      "CERTBOT_EMAIL",
      "DATABASE_CA",
      "DATABASE_URL",
    ]);
    expect(parsed.environment.generatedNames).toEqual([]);
    expect(parsed.environment.declaredSecretNames).toEqual(["CERTBOT_EMAIL", "DATABASE_CA", "DATABASE_URL"]);
    expect(partitionEnvironment(parsed.config)).toEqual(parsed.environment);
  });
});

// ------------------------------------------------------- frozen expectations --

describe("frozen hostile-config expectations", () => {
  it("rejects every Phase 1 config fixture with its frozen code and recovery", async () => {
    const expectations = JSON.parse(
      await readFile(join(FIXTURE_ROOT, "expectations.json"), "utf8"),
    ) as { cases: readonly ExpectationCase[] };
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("config/invalid/"));
    expect(cases.length).toBeGreaterThan(8);

    for (const entry of cases) {
      const document = parseYaml(await readFile(join(FIXTURE_ROOT, entry.fixture), "utf8")) as unknown;
      const failure = threw(() => parseOperatorConfig(document));
      expect(failure.code, entry.fixture).toBe(entry.code);
      expect((failure.details as Json).recovery, entry.fixture).toBe(entry.recovery);
      expect(exitCodeFor(entry.code)).toBe(entry.code === "DK_CONFIG_PLACEHOLDER" ? 3 : 3);
    }
  });
});

// ----------------------------------------------------------------- loading --

describe("loadOperatorConfig", () => {
  it("scaffolds, refuses to continue, and reports the resume instruction", async () => {
    const root = await temporaryRepository();
    const scaffoldEvents: string[] = [];
    const failure = await thrown(loadOperatorConfig({
      cwd: root,
      packageRoot,
      interactive: false,
      onScaffold: (location) => { scaffoldEvents.push(location.configPath); },
    }));

    expect(failure.code).toBe("DK_CONFIG_SCAFFOLDED");
    expect(exitCodeFor("DK_CONFIG_SCAFFOLDED")).toBe(2);
    expect((failure.details as Json).resume).toContain("run the same deploykit deploy command again");
    expect(scaffoldEvents).toEqual([join(root, DEPLOY_CONFIG_FILE)]);
    expect((await stat(join(root, DEPLOY_CONFIG_FILE))).mode & 0o7777).toBe(0o600);
  });

  it("continues past the interactive wait and then reports the unfilled placeholders", async () => {
    const root = await temporaryRepository();
    const confirm = vi.fn().mockResolvedValue(true);
    const failure = await thrown(loadOperatorConfig({ cwd: root, packageRoot, interactive: true, confirm }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(failure.code).toBe("DK_CONFIG_PLACEHOLDER");
  });

  it("loads, validates, and partitions a filled configuration", async () => {
    const { root } = await seedIgnoredRepository(await filledExample());
    const loaded = await loadOperatorConfig({ cwd: root, packageRoot, interactive: false });
    expect(loaded.scaffolded).toBe(false);
    expect(loaded.config.target.primaryDomain).toBe("app.acme.test");
    expect(loaded.location.repositoryRoot).toBe(root);
    expect(loaded.environment.backendValues.CERTBOT_EMAIL).toBe("ops@acme.test");
  });

  it("reports invalid YAML without echoing the offending source", async () => {
    const { root } = await seedIgnoredRepository("apiVersion: [unterminated\n  DK_CANARY_YAML_ffffff\n");
    const failure = await thrown(loadOperatorConfig({ cwd: root, packageRoot, interactive: false }));
    expect(failure.code).toBe("DK_CONFIG_INVALID");
    expect(JSON.stringify(failure)).not.toContain("DK_CANARY_YAML_ffffff");
  });
});

// ------------------------------------------------------------- containment --

describe("secret containment", () => {
  const CANARY = "DK_CANARY_SESSION_SECRET_a17c39";

  async function canaryConfig(): Promise<Json> {
    const config = await fixtureConfig("static-compose");
    ((config.environment as Json).backend as Json).APP_SESSION_SECRET = CANARY;
    return config;
  }

  it("keeps backend values out of every schema and semantic diagnostic", async () => {
    const config = await canaryConfig();
    (config.routes as Json[])[0]!.target = "does-not-exist";
    const failure = threw(() => parseOperatorConfig(config));
    expect(failure.code).toBe("DK_CONFIG_INVALID");
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(CANARY);
  });

  it("keeps backend values out of placeholder reports", async () => {
    const config = await canaryConfig();
    ((config.environment as Json).backend as Json).APP_SESSION_SECRET = `${CANARY}-changeme`;
    const failure = threw(() => parseOperatorConfig(config));
    expect(failure.code).toBe("DK_CONFIG_PLACEHOLDER");
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(CANARY);
  });

  it("redacts the operator's exact values in every later diagnostic", async () => {
    const { root } = await seedIgnoredRepository(stringifyYaml(await canaryConfig()));
    const loaded = await loadOperatorConfig({ cwd: root, packageRoot, interactive: false });
    expect(loaded.environment.backendValues.APP_SESSION_SECRET).toBe(CANARY);
    expect(loaded.redactor.redactText(`value=${CANARY}`)).toBe("value=[REDACTED]");

    expect(redact(`connection uses ${CANARY} once`)).toBe("connection uses [REDACTED] once");
    expect(JSON.stringify(redact({ note: `contains ${CANARY}` }))).not.toContain(CANARY);
  });

  it("replaces the longest overlapping value first and ignores trivially short ones", () => {
    const redactor = createExactValueRedactor(["abcd", "abcdefgh", "xy", ""]);
    expect(redactor.size).toBe(2);
    expect(redactor.redactText("abcdefgh and abcd and xy")).toBe("[REDACTED] and [REDACTED] and xy");
  });
});
