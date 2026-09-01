import { satisfies, validRange } from "semver";

export const VERSION = "0.1.1";
export const PM2_VERSION = "6.0.8";
export const BOOTSTRAP_NODE_VERSION = "22.18.0";
export const ACTIONS_RUNNER_VERSION = "2.337.0";

export function isValidVersionRequirement(requirement: string): boolean {
  return validRange(requirement, { includePrerelease: true }) !== null;
}

export function versionSatisfiesRequirement(
  requirement: string,
  installedVersion = VERSION,
): boolean {
  return isValidVersionRequirement(requirement) && satisfies(installedVersion, requirement, {
    includePrerelease: true,
  });
}
