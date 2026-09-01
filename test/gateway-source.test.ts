import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  GITHUB_HOST_KEY_FINGERPRINTS,
  GITHUB_KNOWN_HOSTS,
  GITHUB_KNOWN_HOSTS_ASSET,
  assertFrozenCommitSha,
  assertPinnedGitHubKnownHosts,
  assertSafeApplicationRef,
  assertSafeSourceTree,
  createGitSourceProvider,
  gatewayRepositoryKeyFile,
  gatewaySourcePaths,
  productionRemote,
  qualifyApplicationRef,
  sshRepositoryUrl,
  type GatewaySourcePort,
} from "../src/gateway/index.js";
import type { RootOwnedGatewayBinding } from "../src/orchestrator/contracts.js";
import {
  InProcessLockProvider,
  ProcessCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
  type ServerRoots,
} from "../src/server/index.js";

/**
 * Phase 7 covers the boundary where a repository DeployKit does not control
 * meets a root-owned runtime. Every test here builds a real Git repository and
 * runs the real provider against it, because the guarantees being asserted —
 * no hooks, no inherited configuration, one transport, one commit, no `.git`,
 * no escaping symlink — are properties of how Git is actually invoked.
 */

const execFileAsync = promisify(execFile);

const BINDING: RootOwnedGatewayBinding = Object.freeze({
  apiVersion: "deploykit/gateway-binding/v1alpha1",
  bindingId: "13a5ce1e444db74a784f1c1e9c205703",
  repository: "deploykit-fixtures/static-compose",
  githubEnvironment: "fixture-static-production",
  targetName: "production",
  targetId: "04809ce707a77a199e6b989440139ba0",
  gatewayUser: "deploykit-gateway",
  forcedCommand: "deploykit gateway",
  runtimeVersion: "0.1.3",
  runtimeBundleSha256: "4d6d152facae078ff01608c5deb012c4918c88f8b3c0cd67ffbeae780014069c",
  repositoryKeyId: "deploykit-repository-static-production",
  repositoryKeyFingerprint: "SHA256:Rk1lbEMwbnRyYWN0Rml4dHVyZUtleUZpbmdlcnByaW50MDE",
  activeGatewayKeyId: "deploykit-gateway-static-production-1",
  pendingGatewayKeyId: null,
} as const);

/** Fixture repositories are built with a hermetic Git of their own. */
async function fixtureGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "DeployKit Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "DeployKit Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** Plumbing a hostile tree needs a stdin Git that is not the provider's. */
async function fixtureGitInput(cwd: string, args: readonly string[], stdin: string): Promise<string> {
  const result = await new ProcessCommandRunner().run({
    command: "git",
    args: [...args],
    cwd,
    stdin,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return result.stdout.trim();
}

/** Wraps the real runner so a test can read the exact argv and environment. */
class CapturingRunner implements CommandRunner {
  readonly specs: CommandSpec[] = [];

  constructor(private readonly inner: CommandRunner) {}

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.specs.push(spec);
    return this.inner.run(spec);
  }
}

interface Harness {
  readonly base: string;
  readonly roots: ServerRoots;
  readonly origin: string;
  readonly keyFile: string;
  readonly runner: CapturingRunner;
  readonly events: { phase: string; code: string }[];
  readonly provider: GatewaySourcePort;
  readonly paths: ReturnType<typeof gatewaySourcePaths>;
}

interface HarnessOptions {
  readonly remotePath?: string;
  readonly remoteUrl?: string;
  readonly baseEnvironment?: Record<string, string | undefined>;
  readonly repositoryKeyFile?: string;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), "deploykit-source-"));
  const roots: ServerRoots = {
    config: join(base, "etc"),
    state: join(base, "state"),
    data: join(base, "data"),
    nginxAvailable: join(base, "nginx", "sites-available"),
    nginxEnabled: join(base, "nginx", "sites-enabled"),
    letsEncryptWebroot: join(base, "acme"),
  };
  const keyFile = gatewayRepositoryKeyFile(roots);
  await mkdir(join(roots.config, "gateway"), { recursive: true });
  await writeFile(keyFile, "PRIVATE KEY PLACEHOLDER\n", { mode: 0o600 });
  await chmod(keyFile, 0o600);

  const origin = join(base, "origin");
  const runner = new CapturingRunner(
    new ProcessCommandRunner({ baseEnvironment: options.baseEnvironment ?? {} }),
  );
  const events: { phase: string; code: string }[] = [];
  const provider = createGitSourceProvider({
    roots,
    runner,
    lock: new InProcessLockProvider(),
    requireRootOwnership: false,
    repositoryKeyFile: options.repositoryKeyFile ?? keyFile,
    remote: () => ({ url: options.remoteUrl ?? options.remotePath ?? origin, protocol: "file" }),
  });
  return { base, roots, origin, keyFile, runner, events, provider, paths: gatewaySourcePaths(BINDING.targetId, roots) };
}

async function createOrigin(directory: string): Promise<string> {
  await mkdir(join(directory, "api"), { recursive: true });
  await writeFile(join(directory, "README.md"), "hello\n");
  await writeFile(join(directory, "api", "server.js"), "console.log('serve');\n");
  await symlink("server.js", join(directory, "api", "current.js"));
  await fixtureGit(directory, ["init", "-q", "-b", "main", "."]);
  await fixtureGit(directory, ["add", "-A"]);
  await fixtureGit(directory, ["commit", "-qm", "one"]);
  return (await fixtureGit(directory, ["rev-parse", "HEAD"])).trim();
}

async function commitFile(directory: string, path: string, contents: string): Promise<string> {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), contents);
  await fixtureGit(directory, ["add", "-A"]);
  await fixtureGit(directory, ["commit", "-qm", `add ${path}`]);
  return (await fixtureGit(directory, ["rev-parse", "HEAD"])).trim();
}

function retrieve(
  test: Harness,
  commitSha: string,
  applicationRef = "main",
): ReturnType<GatewaySourcePort["retrieve"]> {
  return test.provider.retrieve({
    binding: BINDING,
    applicationRef,
    commitSha,
    report: (event) => { test.events.push({ phase: event.phase, code: event.code }); },
  });
}

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      found.push(full.slice(root.length));
      if (entry.isDirectory()) await visit(full);
    }
  };
  await visit(root);
  return found.sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function failure(operation: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await operation;
  } catch (error) {
    return error as { code: string; details: unknown };
  }
  throw new Error("expected the retrieval to be refused");
}

// ------------------------------------------------------------- retrieval --

describe("exact-SHA source retrieval", () => {
  it("materializes the frozen commit as a plain tree with no .git", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);

    const retrieved = await retrieve(test, sha);

    expect(retrieved.sourceDirectory).toBe(test.paths.treeDirectory(sha));
    expect(retrieved.reused).toBe(false);
    expect(await walk(retrieved.sourceDirectory)).toEqual([
      "/README.md",
      "/api",
      "/api/current.js",
      "/api/server.js",
    ]);
    expect(await readFile(join(retrieved.sourceDirectory, "README.md"), "utf8")).toBe("hello\n");
    expect(await readlink(join(retrieved.sourceDirectory, "api", "current.js"))).toBe("server.js");
    expect(test.events).toEqual([{ phase: "source-staged", code: "DK_GATEWAY_SOURCE_VERIFIED" }]);
    expect(test.runner.specs.every((spec) => spec.command === "git")).toBe(true);
  }, 60_000);

  it("is deterministic and ownership-safe when the same commit is retrieved again", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);

    const first = await retrieve(test, sha);
    const listing = await walk(first.sourceDirectory);
    const second = await retrieve(test, sha);

    expect(second.sourceDirectory).toBe(first.sourceDirectory);
    expect(second.reused).toBe(true);
    expect(await walk(second.sourceDirectory)).toEqual(listing);
    const checkouts = test.runner.specs.filter((spec) => spec.args.includes("checkout"));
    expect(checkouts).toHaveLength(1);
  }, 60_000);

  it("keeps only the tree for the commit it just verified", async () => {
    const test = await harness();
    const first = await createOrigin(test.origin);
    await retrieve(test, first);
    const second = await commitFile(test.origin, "api/extra.js", "// extra\n");

    await retrieve(test, second);

    expect((await readdir(test.paths.incomingDirectory)).sort()).toEqual([second, `${second}.json`].sort());
    expect(await exists(test.paths.treeDirectory(first))).toBe(false);
  }, 60_000);

  it("cannot create a release, reserve resources, or write generated configuration", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);
    const before = await walk(test.base);

    await retrieve(test, sha);

    const area = `/state/source/${BINDING.targetId}`;
    const created = (await walk(test.base)).filter((path) => !before.includes(path));
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((path) => path.startsWith(area) || area.startsWith(path))).toBe(true);
    expect(await exists(join(test.roots.data, BINDING.targetId))).toBe(false);
    expect(await exists(join(test.roots.state, "registry.json"))).toBe(false);
    expect(await exists(join(test.roots.state, "targets"))).toBe(false);
    expect(await exists(join(test.roots.config, "targets"))).toBe(false);
    expect(await exists(test.roots.nginxAvailable)).toBe(false);
    expect(await exists(test.roots.letsEncryptWebroot)).toBe(false);
  }, 60_000);
});

// ------------------------------------------------------------- identity --

describe("frozen commit identity", () => {
  it("refuses a ref that has moved past the frozen commit", async () => {
    const test = await harness();
    const frozen = await createOrigin(test.origin);
    await commitFile(test.origin, "api/late.js", "// late\n");

    expect(await failure(retrieve(test, frozen))).toMatchObject({ code: "DK_REF_MOVED" });
    expect(await exists(test.paths.treeDirectory(frozen))).toBe(false);
  }, 60_000);

  it("refuses a ref the bound repository does not have", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);

    expect(await failure(retrieve(test, sha, "release"))).toMatchObject({ code: "DK_REF_NOT_FOUND" });
  }, 60_000);

  it("refuses a repository that does not carry the frozen commit", async () => {
    const test = await harness();
    const frozen = await createOrigin(test.origin);
    const other = join(test.base, "other");
    await mkdir(other, { recursive: true });
    await createOrigin(other);
    await commitFile(other, "elsewhere.js", "// elsewhere\n");
    const elsewhere = createGitSourceProvider({
      roots: test.roots,
      runner: test.runner,
      lock: new InProcessLockProvider(),
      requireRootOwnership: false,
      repositoryKeyFile: test.keyFile,
      remote: () => ({ url: other, protocol: "file" }),
    });

    const refused = await failure(elsewhere.retrieve({
      binding: BINDING,
      applicationRef: "main",
      commitSha: frozen,
      report: () => undefined,
    }));

    expect(refused).toMatchObject({ code: "DK_REF_MOVED" });
    expect(await exists(test.paths.treeDirectory(frozen))).toBe(false);
  }, 60_000);

  it("refuses an object that is not a commit", async () => {
    const test = await harness();
    await createOrigin(test.origin);
    await fixtureGit(test.origin, ["tag", "-a", "v1", "-m", "release"]);
    const tagObject = (await fixtureGit(test.origin, ["rev-parse", "refs/tags/v1"])).trim();

    expect(await failure(retrieve(test, tagObject, "refs/tags/v1")))
      .toMatchObject({ code: "DK_SOURCE_UNVERIFIED" });
  }, 60_000);

  it("refuses an unsafe ref or a commit that is not a full object id", () => {
    for (const ref of ["refs/heads/../evil", "-oProxyCommand=touch /tmp/x", "refs/heads/.hidden", "a//b", "x.lock"]) {
      expect(() => assertSafeApplicationRef(ref)).toThrowError(/safe Git ref/u);
    }
    expect(qualifyApplicationRef("main")).toBe("refs/heads/main");
    expect(qualifyApplicationRef("refs/tags/v1")).toBe("refs/tags/v1");
    for (const sha of ["", "abc", "3F0A1B2C4D5E6F708192A3B4C5D6E7F809A1B2C3", "3f0a1b2c4d5e6f708192a3b4c5d6e7f809a1b2c"]) {
      expect(() => assertFrozenCommitSha(sha)).toThrowError(/object id/u);
    }
  });
});

// ------------------------------------------------------------ hostile source --

describe("hostile source content", () => {
  it("refuses a gitlink", async () => {
    const test = await harness();
    await createOrigin(test.origin);
    const parent = (await fixtureGit(test.origin, ["rev-parse", "HEAD"])).trim();
    const blob = await fixtureGitInput(test.origin, ["hash-object", "-w", "--stdin"], "placeholder\n");
    const tree = await fixtureGitInput(
      test.origin,
      ["mktree"],
      `160000 commit ${parent}\tvendor\n100644 blob ${blob}\tREADME.md\n`,
    );
    const commit = (await fixtureGit(test.origin, ["commit-tree", tree, "-p", parent, "-m", "gitlink"])).trim();
    await fixtureGit(test.origin, ["update-ref", "refs/heads/main", commit]);

    expect(await failure(retrieve(test, commit))).toMatchObject({ code: "DK_SOURCE_UNSAFE" });
    expect(await exists(test.paths.treeDirectory(commit))).toBe(false);
  }, 60_000);

  it("refuses a submodule declaration", async () => {
    const test = await harness();
    await createOrigin(test.origin);
    const sha = await commitFile(
      test.origin,
      ".gitmodules",
      '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.test/vendor.git\n',
    );

    expect(await failure(retrieve(test, sha))).toMatchObject({ code: "DK_SOURCE_UNSAFE" });
    expect(await exists(test.paths.treeDirectory(sha))).toBe(false);
  }, 60_000);

  it("refuses a tree that carries a .git path", async () => {
    const test = await harness();
    await createOrigin(test.origin);
    const parent = (await fixtureGit(test.origin, ["rev-parse", "HEAD"])).trim();
    const blob = await fixtureGitInput(test.origin, ["hash-object", "-w", "--stdin"], "placeholder\n");
    const inner = await fixtureGitInput(test.origin, ["mktree"], `100644 blob ${blob}\tconfig\n`);
    const tree = await fixtureGitInput(
      test.origin,
      ["mktree"],
      `040000 tree ${inner}\t.git\n100644 blob ${blob}\tREADME.md\n`,
    );
    const commit = (await fixtureGit(test.origin, ["commit-tree", tree, "-p", parent, "-m", "dotgit"])).trim();
    await fixtureGit(test.origin, ["update-ref", "refs/heads/main", commit]);

    expect(await failure(retrieve(test, commit))).toMatchObject({ code: "DK_SOURCE_UNSAFE" });
    expect(await exists(test.paths.treeDirectory(commit))).toBe(false);
  }, 60_000);

  it("refuses a symlink that escapes the retrieved tree", async () => {
    for (const target of ["../../../etc/passwd", "/etc/passwd"]) {
      const test = await harness();
      await createOrigin(test.origin);
      await symlink(target, join(test.origin, "escape"));
      await fixtureGit(test.origin, ["add", "-A"]);
      await fixtureGit(test.origin, ["commit", "-qm", "escape"]);
      const sha = (await fixtureGit(test.origin, ["rev-parse", "HEAD"])).trim();

      expect(await failure(retrieve(test, sha))).toMatchObject({ code: "DK_SOURCE_UNSAFE" });
      expect(await exists(test.paths.treeDirectory(sha))).toBe(false);
    }
  }, 120_000);

  it("accepts a symlink that stays inside the tree and refuses everything else", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploykit-tree-"));
    await mkdir(join(directory, "api"), { recursive: true });
    await writeFile(join(directory, "api", "server.js"), "");
    await symlink("server.js", join(directory, "api", "current.js"));
    expect(await assertSafeSourceTree(directory)).toEqual({ files: 1, directories: 1, symlinks: 1 });

    await symlink("../../outside", join(directory, "api", "escape.js"));
    await expect(assertSafeSourceTree(directory)).rejects.toMatchObject({ code: "DK_SOURCE_UNSAFE" });
  });
});

// ------------------------------------------------------------ git isolation --

describe("Git isolation", () => {
  it("never runs a repository hook", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);
    await retrieve(test, sha);

    // The fetched ref is removed first: this same plumbing call would fire the
    // hook itself, and the test must observe only what the provider does.
    await rm(test.paths.treeMarkerFile(sha), { force: true });
    await rm(test.paths.treeDirectory(sha), { recursive: true, force: true });
    await fixtureGit(test.base, ["--git-dir", test.paths.cacheDirectory, "update-ref", "-d", "refs/deploykit/frozen"]);

    const canary = join(test.base, "hook-ran");
    const hook = join(test.paths.cacheDirectory, "hooks", "reference-transaction");
    await mkdir(join(test.paths.cacheDirectory, "hooks"), { recursive: true });
    await writeFile(hook, `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
    await chmod(hook, 0o755);
    expect(await exists(canary)).toBe(false);

    await retrieve(test, sha);

    expect(await exists(canary)).toBe(false);
    expect(await exists(test.paths.treeDirectory(sha))).toBe(true);
  }, 60_000);

  it("ignores hostile inherited configuration, prompts, and transports", async () => {
    const base = await mkdtemp(join(tmpdir(), "deploykit-hostile-"));
    const canary = join(base, "config-ran");
    const hooks = join(base, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "reference-transaction"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
    await chmod(join(hooks, "reference-transaction"), 0o755);
    const hostileConfig = join(base, "hostile.gitconfig");
    await writeFile(
      hostileConfig,
      `[core]\n\thooksPath = ${hooks}\n\tsshCommand = touch ${canary}\n[protocol]\n\tallow = always\n`,
    );

    const test = await harness({
      baseEnvironment: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: base,
        GIT_CONFIG_GLOBAL: hostileConfig,
        GIT_CONFIG_SYSTEM: hostileConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hooks,
        GIT_SSH_COMMAND: `touch ${canary}`,
        GIT_ALLOW_PROTOCOL: "ext",
        GIT_TERMINAL_PROMPT: "1",
        GIT_ASKPASS: `/bin/echo`,
      },
    });
    await writeFile(join(base, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
    const sha = await createOrigin(test.origin);
    await writeFile(join(test.origin, ".gitattributes"), "* filter=evil\n");
    await fixtureGit(test.origin, ["add", "-A"]);
    await fixtureGit(test.origin, ["commit", "-qm", "attributes"]);
    await fixtureGit(test.origin, ["config", "core.sshCommand", `touch ${canary}`]);
    const attributed = (await fixtureGit(test.origin, ["rev-parse", "HEAD"])).trim();
    expect(attributed).not.toBe(sha);

    const retrieved = await retrieve(test, attributed);

    expect(await exists(canary)).toBe(false);
    expect(await readFile(join(retrieved.sourceDirectory, "README.md"), "utf8")).toBe("hello\n");
    const fetch = test.runner.specs.find((spec) => spec.args.includes("fetch"));
    expect(fetch?.env).toMatchObject({
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      SSH_AUTH_SOCK: undefined,
      GIT_ALLOW_PROTOCOL: undefined,
      LD_PRELOAD: undefined,
      NODE_OPTIONS: undefined,
      HTTPS_PROXY: undefined,
    });
    expect(fetch?.args).toEqual(expect.arrayContaining([
      "core.hooksPath=/dev/null",
      "credential.helper=",
      "protocol.allow=never",
      "protocol.file.allow=always",
      "fetch.fsckObjects=true",
      "fetch.recurseSubmodules=false",
      "submodule.recurse=false",
    ]));
    expect(fetch?.args).not.toContain("--recurse-submodules");
  }, 60_000);

  it("refuses a transport the allowlist does not permit", async () => {
    const canaryBase = await mkdtemp(join(tmpdir(), "deploykit-ext-"));
    const canary = join(canaryBase, "ext-ran");
    const test = await harness({ remoteUrl: `ext::sh -c touch% ${canary}` });
    await createOrigin(test.origin);

    const refused = await failure(retrieve(test, "3f0a1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3"));

    expect(refused).toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
    expect(await exists(canary)).toBe(false);
  }, 60_000);
});

// ------------------------------------------------------------- installation --

describe("bound repository identity", () => {
  it("derives the repository URL only from the root-owned binding", () => {
    expect(productionRemote(BINDING)).toEqual({
      url: "ssh://git@github.com/deploykit-fixtures/static-compose.git",
      protocol: "ssh",
    });
    expect(() => sshRepositoryUrl("not-a-repository")).toThrowError(/owner\/name/u);
    expect(() => sshRepositoryUrl("owner/name;rm -rf /")).toThrowError(/owner\/name/u);
  });

  it("requires a private root-owned read-only repository identity", async () => {
    const missing = await harness({ repositoryKeyFile: join(tmpdir(), "deploykit-absent-key") });
    const sha = await createOrigin(missing.origin);
    expect(await failure(retrieve(missing, sha))).toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });

    const exposed = await harness();
    const exposedSha = await createOrigin(exposed.origin);
    await chmod(exposed.keyFile, 0o644);
    expect(await failure(retrieve(exposed, exposedSha))).toMatchObject({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" });
  }, 60_000);

  it("rebuilds a cache recorded for another repository", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);
    await retrieve(test, sha);
    await writeFile(
      test.paths.cacheMarkerFile,
      JSON.stringify({ version: 1, targetId: BINDING.targetId, repository: "someone-else/elsewhere" }),
    );
    await rm(test.paths.treeMarkerFile(sha), { force: true });
    await rm(test.paths.treeDirectory(sha), { recursive: true, force: true });

    const retrieved = await retrieve(test, sha);

    expect(retrieved.reused).toBe(false);
    expect(JSON.parse(await readFile(test.paths.cacheMarkerFile, "utf8"))).toEqual({
      version: 1,
      targetId: BINDING.targetId,
      repository: BINDING.repository,
    });
  }, 60_000);

  it("fetches outside every DeployKit-owned runtime path", () => {
    const roots: ServerRoots = {
      config: "/etc/deploykit",
      state: "/var/lib/deploykit",
      data: "/srv/deploykit",
      nginxAvailable: "/etc/nginx/sites-available",
      nginxEnabled: "/etc/nginx/sites-enabled",
      letsEncryptWebroot: "/var/lib/deploykit/acme-webroot",
    };
    const paths = gatewaySourcePaths(BINDING.targetId, roots);
    expect(paths.root).toBe(`/var/lib/deploykit/source/${BINDING.targetId}`);
    expect(paths.root.startsWith(join(roots.state, "targets"))).toBe(false);
    expect(paths.root.startsWith(roots.data)).toBe(false);
    expect(paths.root.startsWith(roots.config)).toBe(false);
    expect(gatewayRepositoryKeyFile(roots)).toBe("/etc/deploykit/gateway/repository-key");
  });
});

// -------------------------------------------------------------- known hosts --

describe("pinned GitHub host keys", () => {
  it("writes the pinned known hosts and pins strict host-key checking", async () => {
    const test = await harness();
    const sha = await createOrigin(test.origin);
    await retrieve(test, sha);

    expect(await readFile(test.paths.knownHostsFile, "utf8")).toBe(GITHUB_KNOWN_HOSTS);
    expect((await lstat(test.paths.knownHostsFile)).mode & 0o777).toBe(0o600);
    const ssh = test.runner.specs.find((spec) => spec.args.includes("fetch"))?.env?.GIT_SSH_COMMAND ?? "";
    expect(ssh).toContain("StrictHostKeyChecking=yes");
    expect(ssh).toContain(`UserKnownHostsFile=${test.paths.knownHostsFile}`);
    expect(ssh).toContain("IdentitiesOnly=yes");
    expect(ssh).toContain("IdentityAgent=none");
    expect(ssh).toContain("BatchMode=yes");
    expect(ssh).toContain(`-i ${test.keyFile}`);
  }, 60_000);

  it("ships the same keys as a package asset", async () => {
    const asset = await readFile(resolve(GITHUB_KNOWN_HOSTS_ASSET), "utf8");
    const keyLines = asset.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(`${keyLines.join("\n")}\n`).toBe(GITHUB_KNOWN_HOSTS);
    for (const fingerprint of Object.values(GITHUB_HOST_KEY_FINGERPRINTS)) {
      expect(asset).toContain(fingerprint);
    }
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[] };
    expect(packageJson.files).toContain("assets");
  });

  it("refuses a known hosts file that is not exactly the pinned set", () => {
    expect(() => assertPinnedGitHubKnownHosts(GITHUB_KNOWN_HOSTS, "test")).not.toThrow();
    expect(() => assertPinnedGitHubKnownHosts(`${GITHUB_KNOWN_HOSTS}evil.test ssh-ed25519 AAAA\n`, "test"))
      .toThrowError(/pinned GitHub host keys/u);
    expect(() => assertPinnedGitHubKnownHosts("", "test")).toThrowError(/pinned GitHub host keys/u);
  });
});
