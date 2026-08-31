import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeployKitError } from "./errors.js";
import { run } from "./process.js";
import { saveServer, type ServerRecord } from "./local-config.js";
import { ACTIONS_RUNNER_VERSION, BOOTSTRAP_NODE_VERSION, PM2_VERSION } from "./version.js";

export interface BootstrapOptions {
  host: string;
  repository: string;
  label: string;
  configureFirewall?: boolean;
  acceptRootRunnerRisk: boolean;
  acceptHostKey?: boolean;
  dryRun?: boolean;
  packageRoot?: string;
}

export interface BootstrapPlan {
  host: string;
  repository: string;
  label: string;
  fingerprint: string;
  remoteDirectory: string;
  packages: string[];
  rootRunner: true;
  configureFirewall: boolean;
}

interface ScannedHostKey {
  hostname: string;
  key: string;
  fingerprint: string;
}

// `readSshFingerprint` is called before the interactive trust prompt. Reuse the
// exact key that was displayed so a DNS change between the prompt and the SSH
// connection cannot silently substitute a different key.
const approvedScanCandidates = new Map<string, ScannedHostKey>();

function packageRootFromModule(): string {
  const moduleUrl: string | undefined = import.meta.url;
  if (!moduleUrl) {
    throw new DeployKitError("DK_UNSUPPORTED", "Server enrollment must be run from the local npm CLI, not the VPS runtime bundle");
  }
  return resolve(dirname(fileURLToPath(moduleUrl)), "..");
}

function hostnameFromSshTarget(target: string): string {
  const hasUnsafeCharacter = [...target].some((character) => {
    const code = character.charCodeAt(0);
    return /\s/.test(character) || code <= 31 || code === 127;
  });
  if (target.length === 0 || target.length > 320 || hasUnsafeCharacter || target.startsWith("-")) {
    throw new DeployKitError("DK_USAGE", "SSH target must be a hostname or user@hostname without whitespace or options");
  }
  const pieces = target.split("@");
  if (pieces.length > 2) throw new DeployKitError("DK_USAGE", "SSH target must contain at most one '@'");
  const hostname = pieces.at(-1) ?? "";
  const username = pieces.length === 2 ? pieces[0] : undefined;
  if (username !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username)) {
    throw new DeployKitError("DK_USAGE", "SSH username contains unsupported characters");
  }
  if (hostname.length === 0 || hostname.length > 253) {
    throw new DeployKitError("DK_USAGE", "SSH hostname is empty or too long");
  }
  const labels = hostname.split(".");
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new DeployKitError(
      "DK_USAGE",
      "SSH host must be a DNS name or IPv4 address; use an SSH config alias for custom ports or IPv6 hosts"
    );
  }
  return hostname;
}

async function scanSshHostKey(target: string): Promise<ScannedHostKey> {
  const hostname = hostnameFromSshTarget(target);
  const scan = await run("ssh-keyscan", ["-T", "10", "-t", "ed25519", hostname]);
  if (!scan.stdout.trim()) throw new DeployKitError("DK_PREFLIGHT_FAILED", `No ED25519 SSH host key returned by ${hostname}`);
  const key = scan.stdout.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
  if (!key) throw new DeployKitError("DK_PREFLIGHT_FAILED", `No usable SSH host key returned by ${hostname}`);
  const keyFields = key.trim().split(/\s+/);
  if (keyFields.length < 3 || keyFields[1] !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(keyFields[2] ?? "")) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", `Malformed ED25519 SSH host key returned by ${hostname}`);
  }
  const fingerprint = await run("ssh-keygen", ["-lf", "-"], { input: `${key}\n` });
  return { hostname, key, fingerprint: fingerprint.stdout.trim() };
}

export async function readSshFingerprint(target: string): Promise<string> {
  const scanned = await scanSshHostKey(target);
  approvedScanCandidates.set(target, scanned);
  return scanned.fingerprint;
}

export async function getRunnerRegistrationToken(repository: string): Promise<string> {
  const result = await run("gh", [
    "api",
    `repos/${repository}/actions/runners/registration-token`,
    "--method",
    "POST",
    "--jq",
    ".token"
  ]);
  if (!result.stdout.trim()) throw new DeployKitError("DK_PREFLIGHT_FAILED", "GitHub returned an empty runner registration token");
  return result.stdout.trim();
}

async function getDefaultBranch(repository: string): Promise<string> {
  const result = await run("gh", ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  if (!/^[A-Za-z0-9._/-]+$/.test(result.stdout) || result.stdout.includes("..")) {
    throw new DeployKitError("DK_PREFLIGHT_FAILED", "GitHub returned an unsafe default branch name");
  }
  const branch = result.stdout;
  const protection = await run("gh", [
    "api",
    `repos/${repository}/branches/${encodeURIComponent(branch)}`,
    "--jq",
    ".protected"
  ]);
  if (protection.stdout.trim() !== "true") {
    throw new DeployKitError(
      "DK_PREFLIGHT_FAILED",
      `The default branch '${branch}' must be protected before enrolling a root DeployKit runner`
    );
  }
  return branch;
}

async function packCli(packageRoot: string, destination: string): Promise<string> {
  const packed = await run("npm", ["pack", packageRoot, "--json", "--pack-destination", destination]);
  let entries: Array<{ filename: string }>;
  try {
    entries = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  } catch (error) {
    throw new DeployKitError("DK_COMMAND_FAILED", "npm pack returned malformed JSON", { cause: error });
  }
  const filename = entries[0]?.filename;
  if (!filename || basename(filename) !== filename) {
    throw new DeployKitError("DK_COMMAND_FAILED", "npm pack did not report a safe output filename");
  }
  return join(destination, filename);
}

export async function bootstrapServer(options: BootstrapOptions): Promise<BootstrapPlan> {
  hostnameFromSshTarget(options.host);
  if (!options.acceptRootRunnerRisk) {
    throw new DeployKitError(
      "DK_SECURITY_ACK_REQUIRED",
      "A root self-hosted runner can give trusted repository code full control of this VPS. Re-run with --accept-root-runner-risk."
    );
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new DeployKitError("DK_USAGE", "Repository must use owner/name format");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(options.label)) {
    throw new DeployKitError("DK_USAGE", "Server label must contain lowercase letters, digits, and hyphens");
  }

  const cachedScan = approvedScanCandidates.get(options.host);
  approvedScanCandidates.delete(options.host);
  const scanned = options.dryRun ? undefined : cachedScan ?? await scanSshHostKey(options.host);
  const fingerprint = scanned?.fingerprint ?? "checked during apply";
  if (!options.dryRun && !options.acceptHostKey) {
    throw new DeployKitError("DK_SECURITY_ACK_REQUIRED", `SSH host key requires confirmation: ${fingerprint}`, {
      details: { fingerprint }
    });
  }
  const remoteDirectory = options.dryRun
    ? "/tmp/deploykit-bootstrap-<random>"
    : `/tmp/deploykit-bootstrap-${randomBytes(8).toString("hex")}`;
  const plan: BootstrapPlan = {
    host: options.host,
    repository: options.repository,
    label: options.label,
    fingerprint,
    remoteDirectory,
    packages: [
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
      "docker-ce",
      "docker-ce-cli",
      "containerd.io",
      "docker-buildx-plugin",
      "docker-compose-plugin",
      `node@${BOOTSTRAP_NODE_VERSION}`,
      `pm2@${PM2_VERSION}`,
      `actions-runner@${ACTIONS_RUNNER_VERSION}`
    ],
    rootRunner: true,
    configureFirewall: options.configureFirewall ?? false
  };
  if (options.dryRun) return plan;

  const packageRoot = options.packageRoot ?? packageRootFromModule();
  const defaultBranch = await getDefaultBranch(options.repository);
  const temporary = await mkdtemp(join(tmpdir(), "deploykit-pack-"));
  try {
    const tarball = await packCli(packageRoot, temporary);
    const tarballBytes = await readFile(tarball);
    const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
    const installer = join(packageRoot, "assets", "bootstrap.sh");
    const remoteTarball = `${remoteDirectory}/${basename(tarball)}`;
    const remoteInstaller = `${remoteDirectory}/bootstrap.sh`;
    const knownHosts = join(temporary, "known_hosts");
    await writeFile(knownHosts, `${scanned!.key}\n`, { mode: 0o600 });
    await chmod(knownHosts, 0o600);
    const sshSecurity = ["-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes"];

    await run("ssh", [...sshSecurity, options.host, "mkdir", "-p", remoteDirectory]);
    await run("scp", [...sshSecurity, installer, tarball, `${options.host}:${remoteDirectory}/`]);
    const token = await getRunnerRegistrationToken(options.repository);
    const args = [
      ...sshSecurity,
      options.host,
      "sudo",
      "bash",
      remoteInstaller,
      "--repo",
      options.repository,
      "--label",
      options.label,
      "--package",
      remoteTarball,
      "--sha256",
      sha256,
      "--default-branch",
      defaultBranch
    ];
    if (options.configureFirewall) args.push("--configure-firewall");
    await run("ssh", args, { input: `${token}\n`, timeoutMs: 30 * 60_000, stdio: "stream" });
    await run("ssh", [...sshSecurity, options.host, "rm", "-rf", remoteDirectory], { reject: false });

    const record: ServerRecord = {
      host: options.host,
      repository: options.repository,
      label: options.label,
      fingerprint,
      hostKey: scanned!.key,
      enrolledAt: new Date().toISOString()
    };
    await saveServer(record);
    return plan;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
