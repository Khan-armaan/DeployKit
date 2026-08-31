import { randomBytes } from "node:crypto";

import type { Pm2Service, StaticFrontend } from "../manifest.js";
import { parsePackageManagerDeclaration } from "../package-manager.js";
import type { CommandRunner, CommandSpec } from "./command.js";
import { ServerError } from "./errors.js";

export const DEFAULT_NODE_INSTALL_ROOT = "/opt/deploykit/node";
export const COREPACK_VERSION = "0.34.0";

export type NodePackageManager = Pm2Service["packageManager"] | StaticFrontend["packageManager"];
export type NodeDistributionArchitecture = "x64" | "arm64";

export interface NodeToolchain {
  readonly version: string;
  readonly directory: string;
  readonly binDirectory: string;
  readonly nodeExecutable: string;
}

export interface NodeToolchainProvider {
  readonly installRoot: string;
  ensure(version: string): Promise<NodeToolchain>;
  ensurePackageManager(toolchain: NodeToolchain, packageManager: NodePackageManager, version?: string): Promise<string>;
}

export interface NodeToolchainManagerOptions {
  readonly runner: CommandRunner;
  readonly installRoot?: string;
  readonly architecture?: NodeDistributionArchitecture;
  readonly distributionBaseUrl?: string;
}

const EXACT_NODE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_INSTALL_ROOT = /^\/[A-Za-z0-9._/-]+$/;

export function normalizeNodeVersion(version: string): string {
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  if (!EXACT_NODE_VERSION.test(normalized)) {
    throw new ServerError(
      "SERVER_STATE_INVALID",
      `Node.js version ${JSON.stringify(version)} is not an exact semantic version`,
      { version },
    );
  }
  return normalized;
}

export function nodeDistributionArchitecture(machine: string): NodeDistributionArchitecture {
  switch (machine.trim()) {
    case "x86_64":
    case "amd64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      throw new ServerError(
        "SERVER_UNSUPPORTED_ARCH",
        `Node.js binary distributions are unsupported on ${machine.trim() || "an unknown architecture"}`,
        { machine: machine.trim() },
      );
  }
}

export function nodeArchiveName(
  version: string,
  architecture: NodeDistributionArchitecture,
): string {
  return `node-v${normalizeNodeVersion(version)}-linux-${architecture}.tar.xz`;
}

/** Extract the checksum for one exact archive; substring matches are never accepted. */
export function checksumForNodeArchive(contents: string, archive: string): string {
  const escaped = archive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = contents.match(new RegExp(`^([a-fA-F0-9]{64})\\s+\\*?${escaped}$`, "gm")) ?? [];
  if (matches.length !== 1) {
    throw new ServerError(
      "SERVER_COMMAND_FAILED",
      `Node.js checksum manifest did not contain exactly one entry for ${archive}`,
      { archive, matches: matches.length },
    );
  }
  const checksum = /^([a-fA-F0-9]{64})/.exec(matches[0])?.[1];
  if (checksum === undefined) {
    throw new ServerError("SERVER_COMMAND_FAILED", `could not parse the checksum for ${archive}`);
  }
  return checksum.toLowerCase();
}

function assertInstallRoot(value: string): string {
  const normalized = value.replace(/\/$/, "");
  if (!SAFE_INSTALL_ROOT.test(normalized) || normalized.includes("..")) {
    throw new ServerError("SERVER_STATE_INVALID", "Node.js install root must be a safe absolute path", {
      installRoot: value,
    });
  }
  return normalized;
}

function localArchitecture(): NodeDistributionArchitecture {
  return process.arch === "arm64" ? "arm64" : "x64";
}

async function verifyInstalledNode(
  runner: CommandRunner,
  executable: string,
  version: string,
): Promise<{ readonly installed: boolean; readonly dryRun: boolean }> {
  const result = await runner.run({
    command: executable,
    args: ["--version"],
    allowFailure: true,
    timeoutMs: 30_000,
  });
  return {
    installed: !result.dryRun && result.exitCode === 0 && result.stdout.trim() === `v${version}`,
    dryRun: result.dryRun,
  };
}

/**
 * Installs official Node.js binary distributions only after validating the
 * archive against the release's SHA256 manifest and then checking `node -v`.
 */
export class NodeToolchainManager implements NodeToolchainProvider {
  readonly installRoot: string;
  private readonly runner: CommandRunner;
  private readonly architecture?: NodeDistributionArchitecture;
  private readonly distributionBaseUrl: string;

  constructor(options: NodeToolchainManagerOptions) {
    this.runner = options.runner;
    this.installRoot = assertInstallRoot(options.installRoot ?? DEFAULT_NODE_INSTALL_ROOT);
    this.architecture = options.architecture;
    this.distributionBaseUrl = (options.distributionBaseUrl ?? "https://nodejs.org/dist").replace(/\/$/, "");
    if (!/^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._/-]*)?$/.test(this.distributionBaseUrl)) {
      throw new ServerError("SERVER_STATE_INVALID", "Node.js distribution URL must use HTTPS", {
        distributionBaseUrl: this.distributionBaseUrl,
      });
    }
  }

  async ensure(requestedVersion: string): Promise<NodeToolchain> {
    const version = normalizeNodeVersion(requestedVersion);
    const directory = `${this.installRoot}/${version}`;
    const toolchain: NodeToolchain = {
      version,
      directory,
      binDirectory: `${directory}/bin`,
      nodeExecutable: `${directory}/bin/node`,
    };
    const existing = await verifyInstalledNode(this.runner, toolchain.nodeExecutable, version);
    if (existing.installed) return toolchain;

    const architecture = this.architecture ?? await this.detectArchitecture(existing.dryRun);
    const archive = nodeArchiveName(version, architecture);
    const releaseUrl = `${this.distributionBaseUrl}/v${version}`;
    const suffix = randomBytes(10).toString("hex");
    const download = `${this.installRoot}/.${archive}.${suffix}`;
    const staging = `${this.installRoot}/.${version}-${architecture}.${suffix}.staging`;
    await this.runner.run({ command: "mkdir", args: ["--parents", this.installRoot] });

    let checksum = "0".repeat(64);
    try {
      const checksumResult = await this.runner.run({
        command: "curl",
        args: ["--fail", "--silent", "--show-error", "--location", `${releaseUrl}/SHASUMS256.txt`],
        timeoutMs: 120_000,
      });
      if (!checksumResult.dryRun) checksum = checksumForNodeArchive(checksumResult.stdout, archive);
      await this.runner.run({
        command: "curl",
        args: [
          "--fail", "--silent", "--show-error", "--location",
          "--output", download,
          `${releaseUrl}/${archive}`,
        ],
        timeoutMs: 600_000,
      });
      await this.runner.run({
        command: "sha256sum",
        args: ["--check", "--strict"],
        cwd: this.installRoot,
        stdin: `${checksum}  ${download.slice(this.installRoot.length + 1)}\n`,
        timeoutMs: 120_000,
      });
      await this.runner.run({ command: "mkdir", args: ["--parents", staging] });
      await this.runner.run({
        command: "tar",
        args: [
          "--extract", "--xz", "--file", download,
          "--directory", staging,
          "--strip-components", "1",
          "--no-same-owner",
        ],
        timeoutMs: 600_000,
      });
      const staged = await verifyInstalledNode(this.runner, `${staging}/bin/node`, version);
      if (!staged.dryRun && !staged.installed) {
        throw new ServerError(
          "SERVER_COMMAND_FAILED",
          `downloaded Node.js toolchain did not report the expected version v${version}`,
          { version, architecture },
        );
      }
      const move = await this.runner.run({
        command: "mv",
        args: ["--no-target-directory", staging, directory],
        allowFailure: true,
      });
      if (!move.dryRun && move.exitCode !== 0) {
        const concurrent = await verifyInstalledNode(this.runner, toolchain.nodeExecutable, version);
        if (!concurrent.installed) {
          throw new ServerError(
            "SERVER_COMMAND_FAILED",
            `could not atomically install Node.js v${version}`,
            { version, architecture, stderr: move.stderr },
          );
        }
      }
      return toolchain;
    } finally {
      await this.runner.run({
        command: "rm",
        args: ["--recursive", "--force", "--one-file-system", download, staging],
        allowFailure: true,
      }).catch(() => undefined);
    }
  }

  async ensurePackageManager(
    toolchain: NodeToolchain,
    packageManager: NodePackageManager,
    requestedVersion?: string,
  ): Promise<string> {
    const executable = `${toolchain.binDirectory}/${packageManager}`;
    const parsed = requestedVersion === undefined
      ? undefined
      : parsePackageManagerDeclaration(`${packageManager}@${requestedVersion}`);
    if (requestedVersion !== undefined && parsed === undefined) {
      throw new ServerError("SERVER_STATE_INVALID", `Invalid exact ${packageManager} version ${JSON.stringify(requestedVersion)}`);
    }
    if (packageManager === "npm") {
      const result = await this.runner.run({
        command: executable,
        args: ["--version"],
        allowFailure: true,
        timeoutMs: 30_000,
      });
      if (!result.dryRun && result.exitCode !== 0) {
        throw new ServerError("SERVER_COMMAND_FAILED", `Node.js ${toolchain.version} does not include npm`);
      }
      if (!result.dryRun && requestedVersion !== undefined && result.stdout.trim() !== requestedVersion) {
        throw new ServerError(
          "SERVER_COMMAND_FAILED",
          `Node.js ${toolchain.version} includes npm ${result.stdout.trim()}, not requested npm ${requestedVersion}`,
        );
      }
      return executable;
    }
    if (requestedVersion === undefined) {
      throw new ServerError(
        "SERVER_STATE_INVALID",
        `${packageManager} requires an exact packageManager version in package.json`,
      );
    }
    const managerEnvironment = { COREPACK_HOME: `${toolchain.directory}/corepack` };
    const existing = await this.runner.run({
      command: executable,
      args: ["--version"],
      env: managerEnvironment,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (!existing.dryRun && existing.exitCode === 0 && existing.stdout.trim() === requestedVersion) {
      return executable;
    }
    if (packageManager === "bun") {
      await this.runner.run({
        command: `${toolchain.binDirectory}/npm`,
        args: [
          "install", "--global", "--prefix", toolchain.directory,
          "--no-audit", "--no-fund", `bun@${requestedVersion}`,
        ],
        timeoutMs: 300_000,
      });
    } else {
      const corepack = `${toolchain.binDirectory}/corepack`;
      let corepackCheck = await this.runner.run({
        command: corepack,
        args: ["--version"],
        allowFailure: true,
        timeoutMs: 30_000,
      });
      if (
        !corepackCheck.dryRun &&
        (corepackCheck.exitCode !== 0 || corepackCheck.stdout.trim() !== COREPACK_VERSION)
      ) {
        await this.runner.run({
          command: `${toolchain.binDirectory}/npm`,
          args: [
            "install", "--global", "--prefix", toolchain.directory,
            "--no-audit", "--no-fund", `corepack@${COREPACK_VERSION}`,
          ],
          timeoutMs: 300_000,
        });
        corepackCheck = await this.runner.run({ command: corepack, args: ["--version"], timeoutMs: 30_000 });
      }
      if (!corepackCheck.dryRun && corepackCheck.stdout.trim() !== COREPACK_VERSION) {
        throw new ServerError(
          "SERVER_COMMAND_FAILED",
          `Corepack ${COREPACK_VERSION} is required, but ${corepackCheck.stdout.trim() || "an unknown version"} is installed`,
        );
      }
      await this.runner.run({ command: "mkdir", args: ["--parents", managerEnvironment.COREPACK_HOME] });
      await this.runner.run({ command: "chmod", args: ["0755", managerEnvironment.COREPACK_HOME] });
      await this.runner.run({
        command: corepack,
        args: ["prepare", `${packageManager}@${requestedVersion}`, "--activate"],
        env: managerEnvironment,
        timeoutMs: 300_000,
      });
      await this.runner.run({
        command: corepack,
        args: ["enable", "--install-directory", toolchain.binDirectory, packageManager],
        env: managerEnvironment,
        timeoutMs: 120_000,
      });
    }
    const managerCheck = await this.runner.run({
      command: executable,
      args: ["--version"],
      env: managerEnvironment,
      allowFailure: true,
      timeoutMs: 120_000,
    });
    if (!managerCheck.dryRun && (managerCheck.exitCode !== 0 || managerCheck.stdout.trim() !== requestedVersion)) {
      throw new ServerError(
        "SERVER_COMMAND_FAILED",
        `${packageManager} did not report the requested version ${requestedVersion}`,
      );
    }
    return executable;
  }

  private async detectArchitecture(dryRun: boolean): Promise<NodeDistributionArchitecture> {
    const result = await this.runner.run({ command: "uname", args: ["-m"] });
    if (result.dryRun && result.stdout.trim() === "") return dryRun ? localArchitecture() : localArchitecture();
    return nodeDistributionArchitecture(result.stdout);
  }
}

export function defaultInstallArgv(packageManager: NodePackageManager): readonly string[] {
  switch (packageManager) {
    case "npm": return ["npm", "ci"];
    case "pnpm": return ["pnpm", "install", "--frozen-lockfile"];
    case "yarn": return ["yarn", "install", "--immutable"];
    case "bun": return ["bun", "install", "--frozen-lockfile"];
  }
}

export function packageScriptArgv(
  packageManager: NodePackageManager,
  script: string,
): readonly string[] {
  return packageManager === "npm"
    ? ["npm", "run", script]
    : [packageManager, "run", script];
}

export function withToolchainExecutable(
  argv: readonly string[],
  packageManager: NodePackageManager,
  packageManagerExecutable: string,
  toolchain: NodeToolchain,
): CommandSpec {
  const [requested, ...args] = argv;
  if (requested === undefined) {
    throw new ServerError("SERVER_STATE_INVALID", "Node.js command cannot be empty");
  }
  const command = requested === packageManager
    ? packageManagerExecutable
    : requested === "corepack"
      ? `${toolchain.binDirectory}/corepack`
      : requested;
  return { command, args };
}
