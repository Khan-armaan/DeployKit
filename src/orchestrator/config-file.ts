import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { DeployKitError } from "../errors.js";
import { resolvePackageRoot } from "../package-root.js";
import { run } from "../process.js";
import type { ConfigConfirmationResult, SecureConfigReadResult } from "./dependencies.js";
import { orchestratorError } from "./failures.js";

/**
 * Phase 2 owns the `config-filesystem` boundary. Everything here protects one
 * file: the single secret-bearing `deploykit.config.yaml`.
 *
 * The rules are deliberately strict and fail closed. DeployKit refuses to read
 * the file unless it is a regular file inside the repository, owned by the
 * current user, mode 0600 exactly, not a symlink, and untracked, unstaged, and
 * Git-ignored — because reading it is what puts operator secrets in memory.
 */

export const DEPLOY_CONFIG_FILE = "deploykit.config.yaml";
export const DEPLOY_CONFIG_EXAMPLE_ASSET = "assets/deploykit.config.example.yaml";

/** A hand-written deployment config far below this is already suspicious. */
export const MAX_CONFIG_BYTES = 512 * 1024;

/** Exact permissions required of the secret-bearing config. */
export const REQUIRED_CONFIG_MODE = 0o600;

export interface ConfigLocation {
  readonly repositoryRoot: string;
  readonly configPath: string;
  /** POSIX-style path of the config relative to the repository root. */
  readonly relativePath: string;
  /** Repository-local exclude file; the tracked .gitignore is never modified. */
  readonly excludePath: string;
}

export interface ConfigScaffoldOutcome extends ConfigLocation {
  readonly status: "created" | "existing";
  readonly examplePath: string;
}

function insecure(message: string, cause?: unknown): DeployKitError {
  return orchestratorError("DK_CONFIG_INSECURE", `${DEPLOY_CONFIG_FILE} ${message}`, { cause });
}

// ------------------------------------------------------------- packaging --

/**
 * Found rather than assumed: this module is loaded from `src/orchestrator/`
 * under test and from `dist/` or `dist/chunks/` once the CLI is bundled, and a
 * fixed depth is right for only one of those. See {@link resolvePackageRoot}.
 */
function modulePackageRoot(): string {
  return resolvePackageRoot({
    moduleUrl: import.meta.url,
    markers: [DEPLOY_CONFIG_EXAMPLE_ASSET],
    subject: "deployment configuration template",
  });
}

export function resolveBundledConfigExamplePath(packageRoot = modulePackageRoot()): string {
  return resolve(packageRoot, DEPLOY_CONFIG_EXAMPLE_ASSET);
}

// ------------------------------------------------------------------- git --

async function gitResult(cwd: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  return run("git", ["-C", cwd, ...args], { reject: false });
}

async function repositoryRoot(cwd: string): Promise<string> {
  const result = await gitResult(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      "Run deploykit deploy from inside the Git application repository",
    );
  }
  return resolve(result.stdout);
}

/**
 * `--git-path info/exclude` resolves through the common directory, so a linked
 * worktree shares the main checkout's exclude file instead of writing into its
 * own per-worktree Git directory.
 */
async function repositoryExcludePath(root: string): Promise<string> {
  const result = await gitResult(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (result.exitCode !== 0 || !result.stdout.startsWith("/")) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", "Unable to resolve the repository-local Git exclude file");
  }
  return resolve(result.stdout);
}

async function isTracked(root: string, relativePath: string): Promise<boolean> {
  const result = await gitResult(root, ["ls-files", "--error-unmatch", "--", relativePath]);
  return result.exitCode === 0;
}

async function isStaged(root: string, relativePath: string): Promise<boolean> {
  const result = await gitResult(root, ["diff", "--cached", "--name-only", "--", relativePath]);
  return result.exitCode === 0 && result.stdout.length > 0;
}

async function isIgnored(root: string, relativePath: string): Promise<boolean> {
  const result = await gitResult(root, ["check-ignore", "--quiet", "--no-index", "--", relativePath]);
  return result.exitCode === 0;
}

function repositoryRelativePath(root: string, absolutePath: string): string {
  const value = relative(root, absolutePath);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || resolve(root, value) !== absolutePath) {
    throw insecure("must be inside the application repository");
  }
  return value.split(sep).join("/");
}

export async function locateOperatorConfig(cwd = process.cwd()): Promise<ConfigLocation> {
  const root = await repositoryRoot(resolve(cwd));
  const configPath = resolve(root, DEPLOY_CONFIG_FILE);
  return {
    repositoryRoot: root,
    configPath,
    relativePath: repositoryRelativePath(root, configPath),
    excludePath: await repositoryExcludePath(root),
  };
}

async function appendLocalExclude(excludePath: string, pattern: string): Promise<void> {
  await mkdir(dirname(excludePath), { recursive: true });
  const handle = await open(
    excludePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
      throw new DeployKitError(
        "DK_PREFLIGHT_FAILED",
        "The repository-local Git exclude path must be a regular file owned by the current user",
      );
    }
    const existing = await handle.readFile("utf8");
    if (!existing.split(/\r?\n/u).includes(pattern)) {
      const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      await handle.writeFile(`${prefix}${pattern}\n`);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

// -------------------------------------------------------------- scaffold --

/**
 * Writes the bundled example to a private temporary file, then links it into
 * place. `link` fails with EEXIST rather than truncating, so a concurrent
 * `deploykit deploy` can never clobber a config another process just created,
 * and no reader can observe a half-written file.
 */
async function createExclusiveFile(path: string, contents: string): Promise<"created" | "existing"> {
  const temporary = resolve(
    dirname(path),
    `.${DEPLOY_CONFIG_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", REQUIRED_CONFIG_MODE);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      // Another process won the race; its file is authoritative.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    }
    return "created";
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface ConfigScaffoldOptions {
  readonly cwd?: string;
  readonly packageRoot?: string;
}

/**
 * Creates `deploykit.config.yaml` from the bundled example when it is missing
 * and makes sure it is Git-ignored. Performs no network, GitHub, or VPS work.
 */
export async function scaffoldOperatorConfig(
  options: ConfigScaffoldOptions = {},
): Promise<ConfigScaffoldOutcome> {
  const location = await locateOperatorConfig(options.cwd);
  const examplePath = resolveBundledConfigExamplePath(options.packageRoot);

  if (await isTracked(location.repositoryRoot, location.relativePath)) {
    throw insecure("holds deployment credentials and must not be tracked or staged by Git");
  }
  if (!(await isIgnored(location.repositoryRoot, location.relativePath))) {
    await appendLocalExclude(location.excludePath, `/${location.relativePath}`);
  }

  let status: ConfigScaffoldOutcome["status"] = "existing";
  const existing = await lstat(location.configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) {
    let example: string;
    try {
      example = await readFile(examplePath, "utf8");
    } catch (error) {
      throw new DeployKitError(
        "DK_UNSUPPORTED",
        "The installed DeployKit package is missing its configuration template",
        { cause: error },
      );
    }
    status = await createExclusiveFile(location.configPath, example);
  }

  return { ...location, status, examplePath };
}

// ----------------------------------------------------------- secure read --

/**
 * Opens without following symlinks and validates the *opened descriptor*, not
 * the path, so the file cannot be swapped between the check and the read.
 */
export async function secureReadOperatorConfig(
  options: ConfigScaffoldOptions = {},
): Promise<SecureConfigReadResult> {
  const location = await locateOperatorConfig(options.cwd);
  const { repositoryRoot, configPath, relativePath } = location;

  if (await isTracked(repositoryRoot, relativePath)) {
    throw insecure("holds deployment credentials and must not be tracked by Git");
  }
  if (await isStaged(repositoryRoot, relativePath)) {
    throw insecure("holds deployment credentials and must not be staged for commit");
  }
  if (!(await isIgnored(repositoryRoot, relativePath))) {
    throw insecure("must be ignored by Git before DeployKit can read it");
  }

  let handle;
  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw insecure("must be a regular file, not a symlink", error);
    if (code === "ENOENT") {
      throw orchestratorError("DK_CONFIG_SCAFFOLDED", `${DEPLOY_CONFIG_FILE} does not exist yet`, { cause: error });
    }
    throw insecure("could not be opened securely", error);
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw insecure("must be a regular file, not a symlink");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw insecure("must be owned by the current user");
    }
    if ((stats.mode & 0o7777) !== REQUIRED_CONFIG_MODE) {
      throw insecure("must use mode 0600 and must not be readable by group or other users");
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      throw insecure(`must be at most ${MAX_CONFIG_BYTES} bytes`);
    }

    return {
      repositoryRoot,
      configPath,
      source: await handle.readFile("utf8"),
      mode: REQUIRED_CONFIG_MODE,
      ownerUid: stats.uid,
      ignored: true,
      tracked: false,
      staged: false,
    };
  } finally {
    await handle.close();
  }
}

// ------------------------------------------------------ wait and continue --

export interface ConfigConfirmationOptions {
  /** Injected in tests; defaults to the real TTY prompt. */
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly interactive?: boolean;
}

/**
 * Interactive sessions wait at the prompt so the same `deploykit deploy`
 * invocation can continue once the operator has filled the file in. Every other
 * session returns unconfirmed and the caller reports the fill-and-rerun result.
 */
export async function waitForConfigCompletion(
  configPath: string,
  options: ConfigConfirmationOptions = {},
): Promise<ConfigConfirmationResult> {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || options.confirm === undefined) return { confirmed: false, interactive };
  const confirmed = await options.confirm(
    `Edit ${configPath} with your project, VPS, workload, route, and environment values. Continue when it is ready?`,
  );
  return { confirmed, interactive };
}
