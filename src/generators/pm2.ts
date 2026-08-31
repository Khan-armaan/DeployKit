import type { ProjectManifest } from "../manifest.js";
import {
  asRecord,
  assertPort,
  assertSafeName,
  manifestRecord,
  namedEntries,
  optionalString,
  requiredString,
  type ManifestRecord,
} from "./model.js";

export interface Pm2GenerationOptions {
  target: string;
  releaseDirectory: string;
  /** Stable loopback ports keyed by manifest service name. */
  ports: Readonly<Record<string, number>>;
  logDirectory?: string;
  /** Non-secret values supplied by the server runtime. */
  environment?: Readonly<Record<string, string>>;
  nodeInstallRoot?: string;
}

interface Pm2Application {
  name: string;
  cwd: string;
  script: string;
  args: string[];
  interpreter: "none";
  exec_mode: "fork";
  instances: 1;
  autorestart: true;
  watch: false;
  max_restarts: number;
  restart_delay: number;
  kill_timeout: number;
  time: true;
  out_file: string;
  error_file: string;
  env: Record<string, string>;
}

function safeAbsolutePath(value: string, label: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
    throw new Error(`${label} must be a safe absolute path`);
  }
  return value.replace(/\/$/, "");
}

function safeWorkingDirectory(value: string, label: string): string {
  if (
    value === "." ||
    (/^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("/") && !value.split("/").includes(".."))
  ) {
    return value === "." ? "" : value.replace(/\/$/, "");
  }
  throw new Error(`${label} must be a repository-relative path`);
}

function environmentRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string") {
      throw new Error(`${label} must contain string environment variables with valid names`);
    }
    result[key] = entry;
  }
  return result;
}

function commandForService(
  service: ManifestRecord,
  label: string,
  nodeInstallRoot: string,
): { script: string; args: string[]; path: string; corepackHome: string } {
  const packageManager = requiredString(service, "packageManager", label);
  if (!new Set(["npm", "pnpm", "yarn", "bun"]).has(packageManager)) {
    throw new Error(`${label}.packageManager is unsupported`);
  }
  const nodeVersion = requiredString(service, "nodeVersion", label);
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion)) {
    throw new Error(`${label}.nodeVersion must be an exact semantic version`);
  }
  const normalizedVersion = nodeVersion.startsWith("v") ? nodeVersion.slice(1) : nodeVersion;
  const binDirectory = `${nodeInstallRoot}/${normalizedVersion}/bin`;
  return {
    script: `${binDirectory}/${packageManager}`,
    args: ["run", requiredString(service, "startScript", label)],
    path: `${binDirectory}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    corepackHome: `${nodeInstallRoot}/${normalizedVersion}/corepack`,
  };
}

/**
 * Render a `.cjs` PM2 ecosystem file. Secret values are intentionally absent;
 * the runtime loads its 0600 environment file before invoking PM2.
 */
export function generatePm2Ecosystem(
  manifest: ProjectManifest,
  options: Pm2GenerationOptions,
): string {
  const root = manifestRecord(manifest);
  const metadata = asRecord(root.metadata, "metadata");
  const projectName = assertSafeName(
    requiredString(metadata, "name", "metadata"),
    "metadata.name",
  );
  const target = namedEntries(root.targets, "targets").find(
    (entry) => entry.name === options.target,
  );
  if (!target) throw new Error(`Unknown target '${options.target}'`);

  const releaseDirectory = safeAbsolutePath(options.releaseDirectory, "releaseDirectory");
  const logDirectory = safeAbsolutePath(
    options.logDirectory ?? `/var/log/deploykit/${projectName}/${options.target}`,
    "logDirectory",
  );
  const nodeInstallRoot = safeAbsolutePath(
    options.nodeInstallRoot ?? "/opt/deploykit/node",
    "nodeInstallRoot",
  );
  const targetEnvironment = environmentRecord(
    target.value.runtimeOverrides,
    `targets.${options.target}.runtimeOverrides`,
  );
  const suppliedEnvironment = environmentRecord(options.environment, "environment");

  const apps: Pm2Application[] = [];
  for (const { name, value } of namedEntries(root.services, "services")) {
    if (value.type !== "pm2") continue;
    const safeName = assertSafeName(name, `services.${name}`);
    const label = `services.${name}`;
    const workingDirectory = safeWorkingDirectory(
      requiredString(value, "workingDirectory", label),
      `${label}.workingDirectory`,
    );
    const command = commandForService(value, label, nodeInstallRoot);
    const environment: Record<string, string> = {
      NODE_ENV: "production",
      PATH: command.path,
      COREPACK_HOME: command.corepackHome,
      ...targetEnvironment,
      ...suppliedEnvironment,
    };
    const portVariable = optionalString(value, "portEnvironmentVariable");
    if (portVariable) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(portVariable)) {
        throw new Error(`${label}.portEnvironmentVariable is invalid`);
      }
      const port = options.ports[name];
      if (port === undefined) throw new Error(`No allocated port was provided for PM2 service '${name}'`);
      environment[portVariable] = String(assertPort(port, `Port for PM2 service '${name}'`));
      environment.HOST = "127.0.0.1";
    }
    apps.push({
      name: `${projectName}-${assertSafeName(options.target, "target")}-${safeName}`,
      cwd: workingDirectory ? `${releaseDirectory}/${workingDirectory}` : releaseDirectory,
      script: command.script,
      args: command.args,
      interpreter: "none",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 1_000,
      kill_timeout: 10_000,
      time: true,
      out_file: `${logDirectory}/${safeName}.out.log`,
      error_file: `${logDirectory}/${safeName}.error.log`,
      env: environment,
    });
  }

  return [
    "// Generated by DeployKit. Secret values are inherited from the server environment.",
    `module.exports = ${JSON.stringify({ apps }, null, 2)};`,
    "",
  ].join("\n");
}
