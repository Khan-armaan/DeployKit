import type { CommandRunner } from "./command.js";
import { ServerError } from "./errors.js";

export type SupportedUbuntuVersion = "22.04" | "24.04";
export type SupportedArchitecture = "amd64" | "arm64";

export interface UbuntuFacts {
  readonly id: "ubuntu";
  readonly version: SupportedUbuntuVersion;
  readonly architecture: SupportedArchitecture;
}

function parseOsRelease(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function assertSupportedUbuntu(osRelease: string, machine: string): UbuntuFacts {
  const values = parseOsRelease(osRelease);
  if (values.ID !== "ubuntu" || (values.VERSION_ID !== "22.04" && values.VERSION_ID !== "24.04")) {
    throw new ServerError(
      "SERVER_UNSUPPORTED_OS",
      `DeployKit v0.1 requires Ubuntu 22.04 or 24.04 (found ${values.ID ?? "unknown"} ${values.VERSION_ID ?? "unknown"})`,
      { id: values.ID, version: values.VERSION_ID },
    );
  }
  const architecture = machine.trim() === "x86_64"
    ? "amd64"
    : machine.trim() === "aarch64" || machine.trim() === "arm64"
      ? "arm64"
      : undefined;
  if (architecture === undefined) {
    throw new ServerError(
      "SERVER_UNSUPPORTED_ARCH",
      `DeployKit v0.1 requires amd64 or arm64 (found ${machine.trim()})`,
      { machine: machine.trim() },
    );
  }
  return { id: "ubuntu", version: values.VERSION_ID, architecture };
}

export async function inspectUbuntu(runner: CommandRunner): Promise<UbuntuFacts> {
  const [release, machine] = await Promise.all([
    runner.run({ command: "cat", args: ["/etc/os-release"] }),
    runner.run({ command: "uname", args: ["-m"] }),
  ]);
  return assertSupportedUbuntu(release.stdout, machine.stdout);
}

export interface BootstrapOptions {
  readonly repository: string;
  readonly githubEnvironment: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly configureFirewall?: boolean;
  readonly sshPort?: number;
  readonly pm2Version?: string;
}

export interface BootstrapAction {
  readonly phase: "packages" | "directories" | "services" | "gateway" | "firewall";
  readonly description: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly path?: string;
  readonly mode?: number;
}

const REQUIRED_PACKAGES = [
  "ca-certificates",
  "curl",
  "docker.io",
  "docker-compose-plugin",
  "nginx",
  "certbot",
  "git",
  "jq",
  "dnsutils",
  "openssl",
  "openssh-client",
  "util-linux",
] as const;

const GATEWAY_USER = "deploykit-gateway";

/**
 * Describes what a bootstrap does to a host, without doing any of it.
 *
 * The `gateway` phase replaced the v0.1 `runner` phase: a fresh host receives a
 * non-login account reachable only through a forced command, never a
 * repository-controlled Actions runner with root.
 */
export function planBootstrap(
  facts: UbuntuFacts,
  options: BootstrapOptions,
): readonly BootstrapAction[] {
  // Make support validation part of pure planning too, even for hand-built facts.
  if (facts.architecture !== "amd64" && facts.architecture !== "arm64") {
    throw new ServerError("SERVER_UNSUPPORTED_ARCH", `unsupported architecture ${String(facts.architecture)}`);
  }
  assertSupportedUbuntu(`ID=${facts.id}\nVERSION_ID=${facts.version}\n`, facts.architecture === "amd64" ? "x86_64" : "aarch64");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new ServerError("SERVER_STATE_INVALID", "repository must be owner/name", { repository: options.repository });
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(options.githubEnvironment)) {
    throw new ServerError("SERVER_STATE_INVALID", "GitHub Environment contains unsupported characters");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.targetName)) {
    throw new ServerError("SERVER_STATE_INVALID", "target name contains unsupported characters");
  }
  if (!/^[0-9a-f]{32}$/.test(options.targetId)) {
    throw new ServerError("SERVER_STATE_INVALID", "target id must be a 32-character lower-case identifier");
  }

  const actions: BootstrapAction[] = [
    { phase: "packages", description: "Refresh apt package metadata", command: "apt-get", args: ["update"] },
    {
      phase: "packages",
      description: "Install pinned server capabilities",
      command: "apt-get",
      args: ["install", "-y", ...REQUIRED_PACKAGES],
    },
    ...[
      "/etc/deploykit",
      "/etc/deploykit/targets",
      "/etc/deploykit/gateway",
      "/var/lib/deploykit",
      "/var/lib/deploykit/targets",
      "/var/lib/deploykit/source",
      "/srv/deploykit",
    ]
      .map<BootstrapAction>((path) => ({
        phase: "directories",
        description: `Create ${path}`,
        path,
        mode: path.startsWith("/etc/deploykit") || path === "/var/lib/deploykit/source" ? 0o700 : 0o755,
      })),
    { phase: "services", description: "Enable Docker", command: "systemctl", args: ["enable", "--now", "docker"] },
    { phase: "services", description: "Enable Nginx", command: "systemctl", args: ["enable", "--now", "nginx"] },
    {
      phase: "services",
      description: `Install DeployKit-pinned PM2 ${options.pm2Version ?? "6.0.8"}`,
      command: "npm",
      args: ["install", "--global", `pm2@${options.pm2Version ?? "6.0.8"}`],
    },
    {
      phase: "gateway",
      description: `Create the non-login ${GATEWAY_USER} account with no shell and no docker membership`,
      command: "useradd",
      args: ["--system", "--shell", "/usr/sbin/nologin", GATEWAY_USER],
    },
    {
      phase: "gateway",
      description: `Write the root-owned binding for ${options.repository} target ${options.targetName}`,
      path: "/etc/deploykit/gateway/binding.json",
      mode: 0o644,
    },
    {
      phase: "gateway",
      description: "Install the forced-command entry the gateway account may run as root",
      path: "/usr/local/lib/deploykit/gateway-entry",
      mode: 0o755,
    },
    {
      phase: "gateway",
      description: `Grant ${GATEWAY_USER} exactly one no-argument sudo entry`,
      path: "/etc/sudoers.d/deploykit-gateway",
      mode: 0o440,
    },
    {
      phase: "gateway",
      description: "Generate the stable read-only VPS-to-GitHub repository key",
      path: "/etc/deploykit/gateway/repository-key",
      mode: 0o600,
    },
  ];
  if (options.configureFirewall) {
    actions.push(
      { phase: "firewall", description: "Allow SSH before enabling the firewall", command: "ufw", args: ["allow", "OpenSSH"] },
      {
        phase: "firewall",
        description: `Allow the administrator SSH port ${String(options.sshPort ?? 22)}`,
        command: "ufw",
        args: ["allow", `${String(options.sshPort ?? 22)}/tcp`],
      },
      { phase: "firewall", description: "Allow HTTP and HTTPS", command: "ufw", args: ["allow", "Nginx Full"] },
      { phase: "firewall", description: "Enable UFW", command: "ufw", args: ["--force", "enable"] },
    );
  }
  return actions;
}
