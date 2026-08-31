import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProjectManifest } from "./manifest.js";
import { inspectCompose, type ComposeInspection } from "./compose.js";
import { pathExists } from "./fs.js";
import { parsePackageManagerDeclaration, type SupportedPackageManagerName } from "./package-manager.js";
import { validateManifest, type ValidationIssue, type ValidationResult } from "./validation.js";

export interface ProjectValidationResult extends ValidationResult<ProjectManifest> {
  compose?: ComposeInspection;
}

function issue(code: string, path: Array<string | number>, message: string, remediation?: string, severity: "error" | "warning" = "error"): ValidationIssue {
  return { code, path, message, remediation, severity };
}

async function validateNodeProject(
  root: string,
  workingDirectory: string,
  scripts: string[],
  packageManager: SupportedPackageManagerName,
  path: Array<string | number>,
  issues: ValidationIssue[]
): Promise<void> {
  const directory = resolve(root, workingDirectory);
  if (!(await pathExists(directory))) {
    issues.push(issue("WORKING_DIRECTORY_MISSING", path, `Working directory does not exist: ${workingDirectory}`));
    return;
  }
  const packagePath = join(directory, "package.json");
  if (!(await pathExists(packagePath))) {
    issues.push(issue("PACKAGE_JSON_MISSING", path, `No package.json exists in ${workingDirectory}`));
    return;
  }
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string>; packageManager?: unknown };
    for (const script of scripts) {
      if (!packageJson.scripts?.[script]) {
        issues.push(issue("PACKAGE_SCRIPT_MISSING", path, `package.json does not define script '${script}'`));
      }
    }
    const declaration = parsePackageManagerDeclaration(packageJson.packageManager);
    if (packageJson.packageManager !== undefined && declaration === undefined) {
      issues.push(issue(
        "PACKAGE_MANAGER_VERSION_INVALID",
        path,
        `package.json packageManager must pin an exact supported version (for example ${packageManager}@9.15.0)`,
      ));
    } else if (declaration !== undefined && declaration.name !== packageManager) {
      issues.push(issue(
        "PACKAGE_MANAGER_DECLARATION_MISMATCH",
        path,
        `Manifest selects '${packageManager}' but package.json pins '${declaration.name}'`,
      ));
    } else if (packageManager !== "npm" && declaration === undefined) {
      issues.push(issue(
        "PACKAGE_MANAGER_VERSION_REQUIRED",
        path,
        `${packageManager} workloads must pin an exact packageManager version in package.json`,
        `Add "packageManager": "${packageManager}@<exact-version>" to package.json.`,
      ));
    }
  } catch (error) {
    issues.push(issue("PACKAGE_JSON_INVALID", path, `Unable to parse ${packagePath}: ${String(error)}`));
  }
}

export async function validateProject(
  manifest: ProjectManifest,
  options: { manifestPath?: string; inspectComposeConfig?: boolean } = {}
): Promise<ProjectValidationResult> {
  const semantic = validateManifest(manifest);
  const root = dirname(resolve(options.manifestPath ?? "deploykit.yaml"));
  const issues = [...semantic.issues];
  let compose: ComposeInspection | undefined;

  if (manifest.compose) {
    for (const [index, file] of manifest.compose.files.entries()) {
      if (!(await pathExists(resolve(root, file)))) {
        issues.push(issue("COMPOSE_FILE_MISSING", ["compose", "files", index], `Compose file does not exist: ${file}`));
      }
    }
    if ((options.inspectComposeConfig ?? true) && !issues.some((entry) => entry.code === "COMPOSE_FILE_MISSING")) {
      try {
        compose = await inspectCompose(root, manifest.compose.files);
        const declaredSecrets = new Set([...manifest.secrets.required, ...manifest.secrets.generated]);
        for (const reference of compose.environmentReferences.filter((entry) => entry.required)) {
          if (declaredSecrets.has(reference.name) || reference.name === "COMPOSE_PROJECT_NAME") continue;
          for (const [targetName, target] of Object.entries(manifest.targets)) {
            if (Object.hasOwn(target.runtimeOverrides, reference.name)) continue;
            issues.push(issue(
              "COMPOSE_ENV_REFERENCE_UNDECLARED",
              ["targets", targetName, "runtimeOverrides", reference.name],
              `Compose requires '${reference.name}', but target '${targetName}' does not provide it`,
              `Declare ${reference.name} in secrets.required/generated or targets.${targetName}.runtimeOverrides. Referenced at ${reference.locations.join(", ")}.`
            ));
          }
        }
        const knownServices = new Set(compose.services.map((service) => service.name));
        for (const [name, service] of Object.entries(manifest.services)) {
          if (service.type === "compose" && !knownServices.has(service.service)) {
            issues.push(issue("COMPOSE_SERVICE_MISSING", ["services", name, "service"], `Compose service '${service.service}' was not found`));
          }
        }
        if (manifest.database?.type === "compose" && !knownServices.has(manifest.database.service)) {
          issues.push(issue("DATABASE_SERVICE_MISSING", ["database", "service"], `Compose database service '${manifest.database.service}' was not found`));
        }
        if (
          manifest.database?.type === "compose" &&
          !compose.volumes.includes(manifest.database.volume)
        ) {
          issues.push(issue(
            "DATABASE_VOLUME_MISSING",
            ["database", "volume"],
            `Compose named volume '${manifest.database.volume}' was not found`,
            "Declare the persistent named volume in the effective Compose configuration."
          ));
        }
        if (manifest.database?.type === "compose") {
          const composeDatabase = manifest.database;
          const databaseService = compose.services.find((service) => service.name === composeDatabase.service);
          if (databaseService && !databaseService.namedVolumes.includes(composeDatabase.volume)) {
            issues.push(issue(
              "DATABASE_VOLUME_NOT_MOUNTED",
              ["database", "volume"],
              `Compose database service '${databaseService.name}' does not mount named volume '${composeDatabase.volume}'`,
              "Mount the declared named volume on the database service's durable data directory.",
            ));
          }
        }
        for (const service of compose.services) {
          if (service.containerName) {
            issues.push(issue(
              "COMPOSE_CONTAINER_NAME_FORBIDDEN",
              ["compose", "services", service.name, "container_name"],
              `Compose service '${service.name}' sets container_name`,
              "Remove container_name so the generated Compose project name can isolate deployments."
            ));
          }
          if (service.ports.length > 0) {
            issues.push(issue(
              "COMPOSE_PORTS_FORBIDDEN",
              ["compose", "services", service.name, "ports"],
              `Compose service '${service.name}' publishes host ports`,
              "Remove ports; DeployKit generates loopback-only bindings in its override."
            ));
          }
          if (service.networkMode !== undefined) {
            issues.push(issue(
              "COMPOSE_NETWORK_MODE_FORBIDDEN",
              ["compose", "services", service.name, "network_mode"],
              `Compose service '${service.name}' sets network_mode '${service.networkMode}'`,
              "Remove network_mode and use Compose networks so DeployKit can isolate and publish only loopback ports.",
            ));
          }
          if (service.replicas !== undefined && service.replicas !== 1) {
            issues.push(issue(
              "COMPOSE_REPLICAS_UNSUPPORTED",
              ["compose", "services", service.name, "deploy", "replicas"],
              `Compose service '${service.name}' requests ${service.replicas} replicas`,
              "Use one replica in v0.1; shared loopback ports and health checks do not support Compose scaling.",
            ));
          }
        }
      } catch (error) {
        issues.push(issue("COMPOSE_CONFIG_FAILED", ["compose"], error instanceof Error ? error.message : String(error)));
      }
    }
  }

  for (const [name, service] of Object.entries(manifest.services)) {
    if (service.type === "pm2") {
      await validateNodeProject(root, service.workingDirectory, [service.buildScript, service.startScript].filter((value): value is string => Boolean(value)), service.packageManager, ["services", name], issues);
    }
  }
  if (manifest.frontend?.type === "static") {
    await validateNodeProject(root, manifest.frontend.workingDirectory, [manifest.frontend.buildScript], manifest.frontend.packageManager, ["frontend"], issues);
  }

  const sorted = issues.sort((left, right) => `${left.path.join(".")}:${left.code}`.localeCompare(`${right.path.join(".")}:${right.code}`));
  const errors = sorted.filter((entry) => entry.severity === "error");
  const warnings = sorted.filter((entry) => entry.severity === "warning");
  return {
    valid: errors.length === 0,
    issues: sorted,
    errors,
    warnings,
    value: manifest,
    manifest,
    compose
  };
}
