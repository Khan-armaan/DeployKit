import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { DeployKitError, type ErrorCode } from "../errors.js";
import type { RootOwnedGatewayBinding } from "../orchestrator/contracts.js";
import { atomicWriteFile, atomicWriteJson, readJsonFile } from "../server/atomic.js";
import { ProcessCommandRunner, type CommandResult, type CommandRunner } from "../server/command.js";
import { assertSafeId } from "../server/ids.js";
import { FlockLockProvider, type LockProvider } from "../server/lock.js";
import { DEFAULT_SERVER_ROOTS, type ServerRoots } from "../server/paths.js";
import { gatewayError } from "./failures.js";
import { GITHUB_KNOWN_HOSTS, GITHUB_HOST_KEY_ALGORITHMS, GITHUB_SSH_HOST } from "./github-known-hosts.js";
import { minimalGatewayEnvironment } from "./invocation.js";
import type { GatewayRetrievedSource, GatewaySourcePort, GatewaySourceRequest } from "./runtime.js";
import { assertSafeSourceTree, MAX_SOURCE_ENTRIES } from "./source-tree.js";

/**
 * Phase 7: the only way application source reaches a bound VPS.
 *
 * Everything this module retrieves is attacker-influenced, so it assumes the
 * repository is hostile and the network is hostile, and proves the result
 * instead of trusting it:
 *
 * - the repository URL comes from the root-owned binding, never from the
 *   request, so a caller cannot redirect the fetch at another repository;
 * - Git runs with a constructed environment — no inherited configuration, no
 *   hooks, no credential helper, no askpass, no agent, no arbitrary SSH
 *   command, and one allowed transport;
 * - the frozen commit must still be what the requested ref resolves to, and the
 *   object must be a commit;
 * - gitlinks, submodules, `.git` paths, and escaping symlinks are refused
 *   before the tree is promoted;
 * - nothing here reserves a port or domain, creates a release, starts a
 *   workload, writes Nginx, issues TLS, or activates anything. It fetches into
 *   a root-owned area beside the runtime and hands back a plain directory.
 */

/** The ref every fetch writes into the cache; it is replaced on every run. */
const FROZEN_REF = "refs/deploykit/frozen" as const;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REF_CHARACTER_PATTERN = /^[A-Za-z0-9._\-/]+$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
/** Every path interpolated into `GIT_SSH_COMMAND`, which Git runs through sh. */
const SHELL_SAFE_PATH_PATTERN = /^[A-Za-z0-9_./:@%+,=-]+$/u;

const NETWORK_TIMEOUT_MS = 15 * 60_000;
const LOCAL_TIMEOUT_MS = 10 * 60_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const CACHE_MARKER_VERSION = 1;
/** Git's own report that a fetched object is malformed or carries a `.git` path. */
const REJECTED_OBJECT_PATTERN = /fsck|hasdotgit|invalid path|corrupt|malformed|index-pack failed/iu;

// ------------------------------------------------------------------ paths --

export interface GatewaySourcePaths {
  /** Root-owned area holding the cache, the pinned known hosts, and staging. */
  readonly root: string;
  readonly lockFile: string;
  readonly cacheDirectory: string;
  readonly cacheMarkerFile: string;
  readonly knownHostsFile: string;
  readonly incomingDirectory: string;
  readonly treeDirectory: (commitSha: string) => string;
  readonly treeMarkerFile: (commitSha: string) => string;
}

/**
 * Deliberately under the state root: the incoming tree must never overlap the
 * immutable releases, the activated release link, the target's generated
 * configuration, or its deployment state, all of which `assertIncomingSourceRoot`
 * refuses when the deployment engine is handed this directory.
 */
export function gatewaySourcePaths(
  targetId: string,
  roots: ServerRoots = DEFAULT_SERVER_ROOTS,
): GatewaySourcePaths {
  assertSafeId(targetId, "target id");
  const root = join(roots.state, "source", targetId);
  const incomingDirectory = join(root, "incoming");
  return {
    root,
    lockFile: join(root, "source.lock"),
    cacheDirectory: join(root, "repository.git"),
    cacheMarkerFile: join(root, "cache.json"),
    knownHostsFile: join(root, "known_hosts"),
    incomingDirectory,
    treeDirectory: (commitSha: string) => join(incomingDirectory, assertFrozenCommitSha(commitSha)),
    treeMarkerFile: (commitSha: string) => join(incomingDirectory, `${assertFrozenCommitSha(commitSha)}.json`),
  };
}

/** The read-only repository identity bootstrap installs for this gateway. */
export function gatewayRepositoryKeyFile(roots: ServerRoots = DEFAULT_SERVER_ROOTS): string {
  return join(roots.config, "gateway", "repository-key");
}

// ------------------------------------------------------------ validation --

function unverified(message: string, details: Record<string, unknown> = {}): DeployKitError {
  return gatewayError("DK_SOURCE_UNVERIFIED", message, { details });
}

export function assertFrozenCommitSha(value: string): string {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw unverified("the frozen commit must be a lower-case 40-character object id");
  }
  return value;
}

/**
 * The gateway re-validates the ref even though the local schema already did:
 * the request arrived over the wire, and this string becomes a Git argument.
 */
export function assertSafeApplicationRef(value: string): string {
  const invalid = value.length === 0 ||
    value.length > 255 ||
    !REF_CHARACTER_PATTERN.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "" || segment.startsWith(".") || segment.endsWith(".lock"));
  if (invalid) throw unverified("the requested application ref is not a safe Git ref");
  return value;
}

/** `main` is a branch; anything already under `refs/` is taken as written. */
export function qualifyApplicationRef(value: string): string {
  const ref = assertSafeApplicationRef(value);
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

/**
 * The one place a repository name becomes a URL. It is derived from the
 * root-owned binding, so a caller can confirm the repository but never choose
 * where the VPS fetches from.
 */
export function sshRepositoryUrl(repository: string): string {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw gatewayError(
      "DK_GATEWAY_BOOTSTRAP_FAILED",
      "the root-owned binding does not name a GitHub repository as owner/name",
    );
  }
  return `ssh://git@${GITHUB_SSH_HOST}/${repository}.git`;
}

export interface GitRemote {
  readonly url: string;
  /** The single transport Git is allowed to use for this remote. */
  readonly protocol: "ssh" | "file";
}

export function productionRemote(binding: RootOwnedGatewayBinding): GitRemote {
  return { url: sshRepositoryUrl(binding.repository), protocol: "ssh" };
}

// ------------------------------------------------------------ environment --

/**
 * Git is given an environment rather than allowed to inherit one. Values that
 * could redirect configuration, authentication, transport, or process
 * execution are set explicitly or removed, so nothing an SSH client, a parent
 * process, or a previous phase managed to set can change what Git does.
 *
 * `GIT_CONFIG_COUNT=0` matters more than it looks: it neutralizes any
 * inherited `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pair, which would otherwise
 * inject configuration that no `--git-dir` or `-c` flag could override.
 */
export function gitEnvironment(options: {
  readonly knownHostsFile: string;
  readonly identityFile: string;
}): Record<string, string | undefined> {
  for (const path of [options.knownHostsFile, options.identityFile]) {
    if (!SHELL_SAFE_PATH_PATTERN.test(path)) {
      throw gatewayError("DK_GATEWAY_BOOTSTRAP_FAILED", "a gateway SSH path contains unsupported characters");
    }
  }
  const ssh = [
    "ssh",
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${options.knownHostsFile}`,
    "-o", `HostKeyAlgorithms=${GITHUB_HOST_KEY_ALGORITHMS}`,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ConnectTimeout=30",
    "-i", options.identityFile,
  ].join(" ");

  return {
    ...minimalGatewayEnvironment(),
    GIT_SSH_COMMAND: ssh,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_ADVICE: "0",
    GIT_SSH: undefined,
    GIT_SSH_VARIANT: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_CEILING_DIRECTORIES: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_TEMPLATE_DIR: undefined,
    GIT_PROTOCOL: undefined,
    GIT_PROTOCOL_FROM_USER: undefined,
    GIT_ALLOW_PROTOCOL: undefined,
    GIT_PROXY_COMMAND: undefined,
    GIT_HTTP_PROXY_AUTHMETHOD: undefined,
    GIT_TRACE: undefined,
    SSH_AUTH_SOCK: undefined,
    DISPLAY: undefined,
    XAUTHORITY: undefined,
    LD_PRELOAD: undefined,
    LD_AUDIT: undefined,
    LD_LIBRARY_PATH: undefined,
    DYLD_INSERT_LIBRARIES: undefined,
    NODE_OPTIONS: undefined,
    IFS: undefined,
    ALL_PROXY: undefined,
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    NO_PROXY: undefined,
    all_proxy: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    no_proxy: undefined,
  };
}

/**
 * Applied to every invocation. Hooks, filters, credential helpers, submodule
 * recursion, and every transport but the one this remote uses are disabled at
 * the command line, where no repository configuration can override them.
 */
export function gitHardeningArguments(remote: GitRemote): readonly string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.askPass=",
    "-c", "core.pager=",
    "-c", "core.autocrlf=false",
    "-c", "core.symlinks=true",
    "-c", "core.protectHFS=true",
    "-c", "core.protectNTFS=true",
    "-c", "credential.helper=",
    "-c", "transfer.fsckObjects=true",
    "-c", "fetch.fsckObjects=true",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "submodule.recurse=false",
    "-c", "protocol.version=2",
    "-c", "protocol.allow=never",
    "-c", `protocol.${remote.protocol}.allow=always`,
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "advice.detachedHead=false",
    "-c", "init.defaultBranch=main",
  ];
}

// -------------------------------------------------------------- ownership --

async function assertOwnedDirectory(path: string, requireRootOwnership: boolean): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) {
    throw gatewayError("DK_SOURCE_UNSAFE", `the gateway source path ${path} is not a directory`, {
      details: { path },
    });
  }
  if (requireRootOwnership && stats.uid !== 0) {
    throw gatewayError("DK_SOURCE_UNSAFE", `the gateway source path ${path} is not owned by root`, {
      details: { path },
    });
  }
  if ((stats.mode & 0o022) !== 0) {
    throw gatewayError("DK_SOURCE_UNSAFE", `the gateway source path ${path} is group- or world-writable`, {
      details: { path },
    });
  }
}

async function ensureOwnedDirectory(path: string, requireRootOwnership: boolean): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await assertOwnedDirectory(path, requireRootOwnership);
}

/** The read-only repository key: present, regular, root-owned, and private. */
async function assertRepositoryIdentity(path: string, requireRootOwnership: boolean): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw gatewayError(
      "DK_GATEWAY_BOOTSTRAP_FAILED",
      "this gateway installation has no read-only repository identity",
      { details: { path, cause: (error as NodeJS.ErrnoException).code ?? "unknown" } },
    );
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (requireRootOwnership && stats.uid !== 0) || (stats.mode & 0o077) !== 0) {
      throw gatewayError(
        "DK_GATEWAY_BOOTSTRAP_FAILED",
        "the repository identity is not a private root-owned file",
        { details: { path } },
      );
    }
    return path;
  } finally {
    await handle.close();
  }
}

// --------------------------------------------------------------- provider --

interface CacheMarker {
  readonly version: typeof CACHE_MARKER_VERSION;
  readonly targetId: string;
  readonly repository: string;
}

interface TreeMarker extends CacheMarker {
  readonly commitSha: string;
}

export interface GitSourceProviderOptions {
  readonly roots?: ServerRoots;
  readonly runner?: CommandRunner;
  readonly lock?: LockProvider;
  /** Ownership checks are relaxed only where a test cannot own files as root. */
  readonly requireRootOwnership?: boolean;
  /** Overridden only by tests; production always derives the URL from the binding. */
  readonly remote?: (binding: RootOwnedGatewayBinding) => GitRemote;
  readonly repositoryKeyFile?: string;
  readonly networkTimeoutMs?: number;
  readonly localTimeoutMs?: number;
}

interface GitStep {
  readonly step: string;
  readonly code: ErrorCode;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly extraEnvironment?: Record<string, string | undefined>;
  readonly allowFailure?: boolean;
}

class GitSourceProvider implements GatewaySourcePort {
  private readonly requireRootOwnership: boolean;

  constructor(private readonly options: GitSourceProviderOptions = {}) {
    this.requireRootOwnership = options.requireRootOwnership ?? true;
  }

  private get roots(): ServerRoots {
    return this.options.roots ?? DEFAULT_SERVER_ROOTS;
  }

  private get runner(): CommandRunner {
    return this.options.runner ??
      new ProcessCommandRunner({
        baseEnvironment: minimalGatewayEnvironment(),
        maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      });
  }

  async retrieve(request: GatewaySourceRequest): Promise<GatewayRetrievedSource> {
    const paths = gatewaySourcePaths(request.binding.targetId, this.roots);
    const lock = this.options.lock ?? new FlockLockProvider();
    await ensureOwnedDirectory(paths.root, this.requireRootOwnership);
    return lock.withLock(paths.lockFile, () => this.retrieveLocked(request, paths), {
      timeoutMs: this.options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS,
    });
  }

  private async retrieveLocked(
    request: GatewaySourceRequest,
    paths: GatewaySourcePaths,
  ): Promise<GatewayRetrievedSource> {
    const commitSha = assertFrozenCommitSha(request.commitSha);
    const ref = qualifyApplicationRef(request.applicationRef);
    const repository = request.binding.repository;
    const remote = (this.options.remote ?? productionRemote)(request.binding);
    const runner = this.runner;

    await ensureOwnedDirectory(paths.incomingDirectory, this.requireRootOwnership);
    // The pinned host keys are rewritten on every retrieval: the gateway never
    // trusts a known_hosts file that something else may have appended to.
    await atomicWriteFile(paths.knownHostsFile, GITHUB_KNOWN_HOSTS, { mode: 0o600 });
    const identityFile = await assertRepositoryIdentity(
      this.options.repositoryKeyFile ?? gatewayRepositoryKeyFile(this.roots),
      this.requireRootOwnership,
    );
    const environment = gitEnvironment({ knownHostsFile: paths.knownHostsFile, identityFile });

    const git = async (args: readonly string[], step: GitStep): Promise<CommandResult> => {
      try {
        return await runner.run({
          command: "git",
          args: [...gitHardeningArguments(remote), ...args],
          env: { ...environment, ...step.extraEnvironment },
          timeoutMs: step.timeoutMs ?? this.options.localTimeoutMs ?? LOCAL_TIMEOUT_MS,
          ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
          ...(step.allowFailure === true ? { allowFailure: true } : {}),
        });
      } catch (error) {
        if (error instanceof DeployKitError) throw error;
        throw gatewayError(step.code, `git ${step.step} failed while retrieving the bound repository`, {
          details: { step: step.step, repository },
        });
      }
    };

    await this.prepareCache(paths, repository, request.binding.targetId, git);

    // 1. Resolve the ref at the remote first. Nothing is downloaded, so a moved
    //    ref or a repository that no longer carries the frozen commit is
    //    refused before an object reaches this host.
    const listed = await git(
      ["--git-dir", paths.cacheDirectory, "ls-remote", "--exit-code", "--", remote.url, ref],
      { step: "ls-remote", code: "DK_GATEWAY_BOOTSTRAP_FAILED", timeoutMs: this.networkTimeout, allowFailure: true },
    );
    if (listed.exitCode === 2) {
      throw gatewayError("DK_REF_NOT_FOUND", `${ref} does not exist in ${repository}`, {
        details: { repository, ref },
      });
    }
    if (listed.exitCode !== 0) {
      throw gatewayError(
        "DK_GATEWAY_BOOTSTRAP_FAILED",
        `the VPS could not reach ${repository} with its read-only repository identity`,
        { details: { repository, ref, step: "ls-remote" } },
      );
    }
    this.assertRemoteTip(listed.stdout, ref, commitSha, repository);

    // 2. Fetch exactly that ref, shallow, without tags or submodules. Object
    //    checking is on, so a pack carrying a `.git` path or a corrupt object
    //    is refused here as hostile content rather than as a transport error.
    const fetched = await git(
      [
        "--git-dir", paths.cacheDirectory,
        "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
        "--depth=1", "--quiet", "--force",
        "--", remote.url, `+${ref}:${FROZEN_REF}`,
      ],
      { step: "fetch", code: "DK_GATEWAY_BOOTSTRAP_FAILED", timeoutMs: this.networkTimeout, allowFailure: true },
    );
    if (fetched.exitCode !== 0) {
      const rejected = REJECTED_OBJECT_PATTERN.test(fetched.stderr);
      throw gatewayError(
        rejected ? "DK_SOURCE_UNSAFE" : "DK_GATEWAY_BOOTSTRAP_FAILED",
        rejected
          ? `${repository} served an object DeployKit refuses to deploy`
          : `the VPS could not fetch ${ref} from ${repository}`,
        { details: { repository, ref, step: "fetch" } },
      );
    }

    // 3. Prove what actually landed: the frozen object is a commit rather than
    //    a tag, tree, or blob, and the fetched tip is exactly that commit.
    const type = await git(
      ["--git-dir", paths.cacheDirectory, "cat-file", "-t", "--", commitSha],
      { step: "cat-file", code: "DK_SOURCE_UNVERIFIED" },
    );
    if (type.stdout.trim() !== "commit") {
      throw unverified("the frozen object is not a commit", { repository, objectType: type.stdout.trim() });
    }
    const tip = await git(
      ["--git-dir", paths.cacheDirectory, "rev-parse", "--verify", "--end-of-options", `${FROZEN_REF}^{commit}`],
      { step: "rev-parse", code: "DK_SOURCE_UNVERIFIED" },
    );
    if (tip.stdout.trim() !== commitSha) {
      throw gatewayError("DK_REF_MOVED", `${ref} no longer resolves to the frozen commit in ${repository}`, {
        details: { repository, ref },
      });
    }

    // 4. Refuse hostile tree shapes from the object database, before a single
    //    byte is written into the incoming area.
    await this.assertSafeTreeObjects(paths, commitSha, git);

    const directory = await this.materialize(paths, repository, commitSha, request.binding.targetId, git);
    await this.pruneIncoming(paths, commitSha);

    request.report({
      phase: "source-staged",
      code: "DK_GATEWAY_SOURCE_VERIFIED",
      message: `Retrieved ${repository} at the frozen commit ${commitSha.slice(0, 12)}.`,
      level: "info",
    });
    return { sourceDirectory: directory.path, reused: directory.reused };
  }

  private get networkTimeout(): number {
    return this.options.networkTimeoutMs ?? NETWORK_TIMEOUT_MS;
  }

  private assertRemoteTip(stdout: string, ref: string, commitSha: string, repository: string): void {
    const matches = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => line.split("\t"))
      .filter((parts) => parts[1] === ref);
    const tip = matches.length === 1 ? matches[0]?.[0] : undefined;
    if (tip === undefined) {
      throw gatewayError("DK_REF_NOT_FOUND", `${ref} does not resolve to exactly one ref in ${repository}`, {
        details: { repository, ref, matched: matches.length },
      });
    }
    if (tip !== commitSha) {
      throw gatewayError("DK_REF_MOVED", `${ref} no longer points at the frozen commit in ${repository}`, {
        details: { repository, ref },
      });
    }
  }

  /**
   * The cache is bound to one repository and one target. A cache recorded for
   * anything else is discarded rather than reused, so objects fetched for
   * another identity can never satisfy this deployment.
   */
  private async prepareCache(
    paths: GatewaySourcePaths,
    repository: string,
    targetId: string,
    git: (args: readonly string[], step: GitStep) => Promise<CommandResult>,
  ): Promise<void> {
    const marker = await readMarker<CacheMarker>(paths.cacheMarkerFile);
    const bound = marker !== null &&
      marker.version === CACHE_MARKER_VERSION &&
      marker.targetId === targetId &&
      marker.repository === repository;
    if (bound && (await pathExists(paths.cacheDirectory))) {
      await assertOwnedDirectory(paths.cacheDirectory, this.requireRootOwnership);
      return;
    }
    await rm(paths.cacheDirectory, { recursive: true, force: true });
    await rm(paths.cacheMarkerFile, { force: true });
    await ensureOwnedDirectory(paths.cacheDirectory, this.requireRootOwnership);
    await git(["init", "--bare", "--quiet", "--", paths.cacheDirectory], {
      step: "init",
      code: "DK_GATEWAY_BOOTSTRAP_FAILED",
    });
    await atomicWriteJson(
      paths.cacheMarkerFile,
      { version: CACHE_MARKER_VERSION, targetId, repository } satisfies CacheMarker,
      { mode: 0o600 },
    );
  }

  /**
   * A gitlink leaves an empty directory where a service is expected and a
   * `.git` path would make the deployed release a repository of its own.
   * Both are refused from the object database, which cannot be tricked by
   * anything the filesystem does later.
   */
  private async assertSafeTreeObjects(
    paths: GatewaySourcePaths,
    commitSha: string,
    git: (args: readonly string[], step: GitStep) => Promise<CommandResult>,
  ): Promise<void> {
    const listed = await git(
      ["--git-dir", paths.cacheDirectory, "ls-tree", "-r", "-t", "-z", "--full-tree", "--", commitSha],
      { step: "ls-tree", code: "DK_SOURCE_UNVERIFIED" },
    );
    const entries = listed.stdout.split("\0").filter((entry) => entry !== "");
    if (entries.length > MAX_SOURCE_ENTRIES) {
      throw gatewayError("DK_SOURCE_UNSAFE", `the frozen commit holds more than ${String(MAX_SOURCE_ENTRIES)} entries`);
    }
    for (const entry of entries) {
      const separator = entry.indexOf("\t");
      const path = separator === -1 ? "" : entry.slice(separator + 1);
      const mode = entry.slice(0, entry.indexOf(" "));
      if (mode === "160000") {
        throw gatewayError("DK_SOURCE_UNSAFE", "the frozen commit contains a gitlink DeployKit does not fetch", {
          details: { path },
        });
      }
      const segments = path.split("/");
      if (segments.includes(".git") || segments.includes(".gitmodules")) {
        throw gatewayError("DK_SOURCE_UNSAFE", "the frozen commit contains a .git path or submodule declaration", {
          details: { path },
        });
      }
    }
  }

  /**
   * Materializes the verified commit as a plain directory with no `.git`, then
   * promotes it atomically. A tree already recorded for this identity is
   * reused, which is what makes a retry deterministic and cheap.
   */
  private async materialize(
    paths: GatewaySourcePaths,
    repository: string,
    commitSha: string,
    targetId: string,
    git: (args: readonly string[], step: GitStep) => Promise<CommandResult>,
  ): Promise<{ path: string; reused: boolean }> {
    const destination = paths.treeDirectory(commitSha);
    const markerFile = paths.treeMarkerFile(commitSha);
    const expected: TreeMarker = { version: CACHE_MARKER_VERSION, targetId, repository, commitSha };
    const existing = await readMarker<TreeMarker>(markerFile);
    if (
      existing !== null &&
      existing.version === expected.version &&
      existing.targetId === expected.targetId &&
      existing.repository === expected.repository &&
      existing.commitSha === expected.commitSha &&
      (await pathExists(destination))
    ) {
      await assertOwnedDirectory(destination, this.requireRootOwnership);
      return { path: destination, reused: true };
    }

    await rm(markerFile, { force: true });
    await rm(destination, { recursive: true, force: true });
    const suffix = randomBytes(10).toString("hex");
    const staging = join(paths.incomingDirectory, `.staging-${suffix}`);
    const indexFile = join(paths.incomingDirectory, `.index-${suffix}`);
    try {
      await ensureOwnedDirectory(staging, this.requireRootOwnership);
      // A fresh index per run: a stale one could make Git believe a path from a
      // previous commit is already up to date.
      await git(
        [
          "--git-dir", paths.cacheDirectory,
          "--work-tree", staging,
          "checkout", "--force", commitSha, "--", ".",
        ],
        {
          step: "checkout",
          code: "DK_SOURCE_UNSAFE",
          cwd: staging,
          extraEnvironment: { GIT_INDEX_FILE: indexFile },
        },
      );
      await assertSafeSourceTree(staging);
      await rename(staging, destination);
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    await assertOwnedDirectory(destination, this.requireRootOwnership);
    await atomicWriteJson(markerFile, expected, { mode: 0o600 });
    return { path: destination, reused: false };
  }

  /** Removes trees and markers this target retrieved for other commits. */
  private async pruneIncoming(paths: GatewaySourcePaths, commitSha: string): Promise<void> {
    const keep = new Set([commitSha, `${commitSha}.json`]);
    for (const entry of await readdir(paths.incomingDirectory, { withFileTypes: true })) {
      if (keep.has(entry.name)) continue;
      if (!/^(?:[0-9a-f]{40}(?:\.json)?|\.staging-[0-9a-f]{20}|\.index-[0-9a-f]{20})$/u.test(entry.name)) continue;
      await rm(join(paths.incomingDirectory, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** A marker DeployKit cannot parse is treated as absent and rebuilt. */
async function readMarker<T>(file: string): Promise<T | null> {
  try {
    return await readJsonFile<T | null>(file, null);
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createGitSourceProvider(options: GitSourceProviderOptions = {}): GatewaySourcePort {
  return new GitSourceProvider(options);
}
