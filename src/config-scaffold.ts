import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { DeployKitError } from "./errors.js";
import { pathExists } from "./fs.js";
import { run } from "./process.js";

export const DEFAULT_DEPLOY_CONFIG_FILE = "deploykit.config.yaml";
export const DEPLOY_CONFIG_EXAMPLE_FILE = "assets/deploykit.config.example.yaml";

export interface DeployConfigScaffoldResult {
  readonly status: "created" | "existing";
  readonly configPath: string;
  readonly examplePath: string;
  readonly repositoryRoot: string;
  readonly excludePath: string;
}

export interface DeployConfigScaffoldOptions {
  readonly cwd?: string;
  readonly packageRoot?: string;
}

function modulePackageRoot(): string {
  const moduleUrl: string | undefined = import.meta.url;
  if (!moduleUrl) {
    throw new DeployKitError(
      "DK_UNSUPPORTED",
      "The deployment configuration template is unavailable in the standalone VPS runtime",
    );
  }
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

export function resolveBundledConfigExamplePath(packageRoot = modulePackageRoot()): string {
  return resolve(packageRoot, DEPLOY_CONFIG_EXAMPLE_FILE);
}

function repositoryRelativePath(root: string, absolutePath: string): string {
  const value = relative(root, absolutePath);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || resolve(root, value) !== absolutePath) {
    throw new DeployKitError("DK_USAGE", "Deployment configuration must be inside the application repository");
  }
  return value.split(sep).join("/");
}

async function gitResult(root: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  return run("git", ["-C", root, ...args], { reject: false });
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

async function isIgnored(root: string, relativePath: string): Promise<boolean> {
  const result = await gitResult(root, ["check-ignore", "--quiet", "--no-index", "--", relativePath]);
  return result.exitCode === 0;
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
    const lines = existing.split(/\r?\n/u);
    if (!lines.includes(pattern)) {
      const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      await handle.writeFile(`${prefix}${pattern}\n`);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

async function verifySecureConfigFile(root: string, configPath: string, relativePath: string): Promise<void> {
  const stats = await lstat(configPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", `${DEFAULT_DEPLOY_CONFIG_FILE} must be a regular file, not a symlink`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", `${DEFAULT_DEPLOY_CONFIG_FILE} must be owned by the current user`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      `${DEFAULT_DEPLOY_CONFIG_FILE} must use mode 0600 and must not be readable by group or other users`,
    );
  }
  if (await isTracked(root, relativePath)) {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      `${DEFAULT_DEPLOY_CONFIG_FILE} contains deployment credentials and must not be tracked or staged by Git`,
    );
  }
  if (!(await isIgnored(root, relativePath))) {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      `${DEFAULT_DEPLOY_CONFIG_FILE} must be ignored by Git before DeployKit can read it`,
    );
  }
}

async function createExclusiveFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(
    dirname(path),
    `.${DEFAULT_DEPLOY_CONFIG_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DeployKitError("DK_CONFLICT", `Refusing to overwrite existing file: ${path}`, { cause: error });
      }
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function scaffoldDeployConfig(
  options: DeployConfigScaffoldOptions = {},
): Promise<DeployConfigScaffoldResult> {
  const root = await repositoryRoot(resolve(options.cwd ?? process.cwd()));
  const configPath = resolve(root, DEFAULT_DEPLOY_CONFIG_FILE);
  const relativePath = repositoryRelativePath(root, configPath);
  const excludePath = await repositoryExcludePath(root);
  const excludePattern = `/${relativePath}`;
  const examplePath = resolveBundledConfigExamplePath(options.packageRoot);

  if (await isTracked(root, relativePath)) {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      `${DEFAULT_DEPLOY_CONFIG_FILE} contains deployment credentials and must not be tracked or staged by Git`,
    );
  }
  if (!(await isIgnored(root, relativePath))) {
    await appendLocalExclude(excludePath, excludePattern);
  }

  let status: DeployConfigScaffoldResult["status"] = "existing";
  if (!(await pathExists(configPath))) {
    let example: string;
    try {
      example = await readFile(examplePath, "utf8");
    } catch (error) {
      throw new DeployKitError("DK_UNSUPPORTED", "The installed DeployKit package is missing its configuration template", {
        cause: error,
      });
    }
    await createExclusiveFile(configPath, example);
    status = "created";
  }

  await verifySecureConfigFile(root, configPath, relativePath);
  return { status, configPath, examplePath, repositoryRoot: root, excludePath };
}
