import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeployKitError } from "./errors.js";
import {
  createAdministratorSshPort,
  type AdministratorSshBoundary,
} from "./orchestrator/administrator-ssh.js";
import { makeOrchestratorTargetId } from "./orchestrator/compile.js";
import {
  GATEWAY_BINDING_API_VERSION,
  GATEWAY_FORCED_COMMAND,
  GATEWAY_USER,
  type RootOwnedGatewayBinding,
} from "./orchestrator/contracts.js";
import type { AdministratorSshConnection } from "./orchestrator/dependencies.js";
import { makeGatewayBindingId } from "./orchestrator/planner.js";
import { resolveRuntimeBundle } from "./orchestrator/runtime-bundle.js";
import { run } from "./process.js";
import { BOOTSTRAP_NODE_VERSION, PM2_VERSION } from "./version.js";

/**
 * Installs the restricted DeployKit gateway on one Ubuntu VPS.
 *
 * The v0.1 path enrolled a repository-scoped GitHub Actions runner as root.
 * Nothing here does: the host receives a non-login gateway account reachable
 * only through a forced command, a root-owned binding that fixes which
 * repository, Environment, and target it serves, one narrowly scoped sudo
 * entry, and a stable read-only key it uses to fetch its own source. The
 * deployment itself arrives from a GitHub-hosted runner.
 *
 * Identity is deliberately *not* recorded locally. The binding on the VPS and
 * the resources on GitHub are the authoritative state, so deleting anything on
 * the operator's machine never makes a host unrecoverable.
 */

export interface BootstrapOptions {
  readonly host: string;
  readonly user: string;
  readonly port?: number;
  readonly identityFile: string;
  readonly hostKeyFingerprint: string;
  readonly repository: string;
  readonly githubEnvironment: string;
  readonly targetName: string;
  readonly configureFirewall?: boolean;
  readonly dryRun?: boolean;
  readonly packageRoot?: string;
  /** Overridden by tests; production always uses real SSH. */
  readonly administratorSsh?: AdministratorSshBoundary;
}

export interface BootstrapPlan {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly repository: string;
  readonly githubEnvironment: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly bindingId: string;
  readonly gatewayUser: string;
  readonly forcedCommand: string;
  readonly packages: readonly string[];
  /** The fresh-install path never enrolls a repository-controlled root runner. */
  readonly rootRunner: false;
  readonly configureFirewall: boolean;
  readonly changed: boolean | null;
  readonly runtimeVersion: string | null;
  readonly runtimeBundleSha256: string | null;
  readonly repositoryPublicKey: string | null;
  readonly repositoryPublicKeyFingerprint: string | null;
}

export const BOOTSTRAP_PACKAGES: readonly string[] = Object.freeze([
  "ca-certificates",
  "curl",
  "gnupg",
  "git",
  "jq",
  "openssl",
  "dnsutils",
  "nginx",
  "certbot",
  "ufw",
  "xz-utils",
  "util-linux",
  "openssh-client",
  "docker-ce",
  "docker-ce-cli",
  "containerd.io",
  "docker-buildx-plugin",
  "docker-compose-plugin",
  `node@${BOOTSTRAP_NODE_VERSION}`,
  `pm2@${PM2_VERSION}`,
]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GITHUB_ENVIRONMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/u;
const TARGET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Reads the host key an operator must confirm before pinning its fingerprint. */
export async function readSshFingerprint(host: string, port = 22): Promise<string> {
  const scan = await run("ssh-keyscan", ["-T", "10", "-p", String(port), host]);
  const line = scan.stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== "" && !candidate.startsWith("#"));
  if (line === undefined) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", `No SSH host key returned by ${host}`);
  }
  const digest = await run("ssh-keygen", ["-lf", "-"], { input: `${line}\n` });
  return digest.stdout.trim();
}

export function gatewayBindingFor(options: BootstrapOptions): RootOwnedGatewayBinding {
  const targetId = makeOrchestratorTargetId(options.repository, options.targetName);
  return {
    apiVersion: GATEWAY_BINDING_API_VERSION,
    bindingId: makeGatewayBindingId(
      options.repository,
      options.githubEnvironment,
      options.targetName,
      targetId,
    ),
    repository: options.repository,
    githubEnvironment: options.githubEnvironment,
    targetName: options.targetName,
    targetId,
    gatewayUser: GATEWAY_USER,
    forcedCommand: GATEWAY_FORCED_COMMAND,
    // Filled in by the host: only the VPS knows which bundle it installed and
    // which repository key it holds.
    runtimeVersion: "",
    runtimeBundleSha256: "",
    repositoryKeyId: "",
    repositoryKeyFingerprint: "",
    activeGatewayKeyId: null,
    pendingGatewayKeyId: null,
  };
}

export async function bootstrapServer(options: BootstrapOptions): Promise<BootstrapPlan> {
  if (!REPOSITORY_PATTERN.test(options.repository)) {
    throw new DeployKitError("DK_USAGE", "Repository must use owner/name format");
  }
  if (!GITHUB_ENVIRONMENT_PATTERN.test(options.githubEnvironment)) {
    throw new DeployKitError("DK_USAGE", "GitHub Environment name contains unsupported characters");
  }
  if (!TARGET_NAME_PATTERN.test(options.targetName)) {
    throw new DeployKitError("DK_USAGE", "Target name must contain lowercase letters, digits, and hyphens");
  }

  const port = options.port ?? 22;
  const connection: AdministratorSshConnection = {
    host: options.host,
    user: options.user,
    port,
    identityFile: options.identityFile,
    hostKeyFingerprint: options.hostKeyFingerprint,
  };
  const binding = gatewayBindingFor(options);
  const plan: BootstrapPlan = {
    host: connection.host,
    user: connection.user,
    port,
    repository: binding.repository,
    githubEnvironment: binding.githubEnvironment,
    targetName: binding.targetName,
    targetId: binding.targetId,
    bindingId: binding.bindingId,
    gatewayUser: GATEWAY_USER,
    forcedCommand: GATEWAY_FORCED_COMMAND,
    packages: BOOTSTRAP_PACKAGES,
    rootRunner: false,
    configureFirewall: options.configureFirewall ?? false,
    changed: null,
    runtimeVersion: null,
    runtimeBundleSha256: null,
    repositoryPublicKey: null,
    repositoryPublicKeyFingerprint: null,
  };
  if (options.dryRun) return plan;

  const administratorSsh = options.administratorSsh ?? createAdministratorSshPort();
  const preflight = await administratorSsh.preflight(connection);
  if (!preflight.administrator) {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      `${connection.user}@${connection.host} cannot run privileged commands without a password`,
    );
  }

  const staging = await mkdtemp(join(tmpdir(), "deploykit-bundle-"));
  try {
    const bundle = await resolveRuntimeBundle({
      destination: staging,
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    });
    const result = await administratorSsh.bootstrapGateway({
      connection,
      binding,
      packageFile: bundle.packageFile,
      packageName: bundle.packageName,
      packageSha256: bundle.packageSha256,
      configureFirewall: plan.configureFirewall,
    });
    return {
      ...plan,
      changed: result.changed,
      runtimeVersion: result.handshake.runtimeVersion,
      runtimeBundleSha256: result.handshake.runtimeBundleSha256,
      // Nonsecret: the private half never leaves the VPS.
      repositoryPublicKey: result.repositoryPublicKey,
      repositoryPublicKeyFingerprint: result.repositoryPublicKeyFingerprint,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
