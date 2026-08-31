import { join } from "node:path";

import { assertCommitSha, assertSafeId } from "./ids.js";

export interface ServerRoots {
  readonly config: string;
  readonly state: string;
  readonly data: string;
  readonly nginxAvailable: string;
  readonly nginxEnabled: string;
  readonly letsEncryptWebroot: string;
}

export const DEFAULT_SERVER_ROOTS: ServerRoots = Object.freeze({
  config: "/etc/deploykit",
  state: "/var/lib/deploykit",
  data: "/srv/deploykit",
  nginxAvailable: "/etc/nginx/sites-available",
  nginxEnabled: "/etc/nginx/sites-enabled",
  letsEncryptWebroot: "/var/lib/deploykit/acme-webroot",
});

export interface ServerPaths {
  readonly targetId: string;
  readonly targetConfigDirectory: string;
  readonly secretsFile: string;
  readonly deploymentStateFile: string;
  readonly deploymentLogFile: string;
  readonly deploymentStateLockFile: string;
  readonly deploymentLockFile: string;
  readonly registryFile: string;
  readonly registryLockFile: string;
  readonly releasesDirectory: string;
  readonly releaseDirectory: (commitSha: string) => string;
  readonly currentReleaseLink: string;
  readonly logsDirectory: string;
  readonly nginxAvailableFile: string;
  readonly nginxEnabledLink: string;
  readonly acmeWebroot: string;
}

export function serverPaths(
  targetId: string,
  roots: ServerRoots = DEFAULT_SERVER_ROOTS,
): ServerPaths {
  assertSafeId(targetId, "target id");
  const targetConfigDirectory = join(roots.config, "targets", targetId);
  const targetStateDirectory = join(roots.state, "targets", targetId);
  const targetDataDirectory = join(roots.data, targetId);
  const releasesDirectory = join(targetDataDirectory, "releases");

  return {
    targetId,
    targetConfigDirectory,
    secretsFile: join(targetConfigDirectory, "secrets.env"),
    deploymentStateFile: join(targetStateDirectory, "deployment.json"),
    deploymentLogFile: join(targetStateDirectory, "deployment.log"),
    deploymentStateLockFile: join(targetStateDirectory, "deployment-state.lock"),
    // Nginx validation/reload and shared host resources are global operations.
    // Serializing the whole first-deployment transaction avoids cross-runner
    // races even after the registry allocation phase has completed.
    deploymentLockFile: join(roots.state, "deploy.lock"),
    registryFile: join(roots.state, "registry.json"),
    registryLockFile: join(roots.state, "registry.lock"),
    releasesDirectory,
    releaseDirectory: (commitSha: string) => join(releasesDirectory, assertCommitSha(commitSha)),
    currentReleaseLink: join(targetDataDirectory, "current"),
    logsDirectory: join(targetStateDirectory, "logs"),
    nginxAvailableFile: join(roots.nginxAvailable, `deploykit-${targetId}.conf`),
    nginxEnabledLink: join(roots.nginxEnabled, `deploykit-${targetId}.conf`),
    acmeWebroot: roots.letsEncryptWebroot,
  };
}
