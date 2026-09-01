import { dirname } from "node:path";

import { parse as parseYaml } from "yaml";

import { registerRedactedValues } from "../output.js";
import type { ConfigFileSystemPort, ConfigScaffoldRequest } from "./dependencies.js";
import {
  DEPLOY_CONFIG_FILE,
  scaffoldOperatorConfig,
  secureReadOperatorConfig,
  waitForConfigCompletion,
  type ConfigConfirmationOptions,
  type ConfigLocation,
  type ConfigScaffoldOptions,
} from "./config-file.js";
import { parseOperatorConfig, type ParsedOperatorConfig } from "./config-schema.js";
import { orchestratorError } from "./failures.js";

/**
 * Composes the Phase 2 config boundary: scaffold, wait, securely read, parse,
 * partition, and start redacting the operator's exact secret values.
 *
 * Nothing in this path authenticates to GitHub, connects to a VPS, or mutates
 * anything outside `deploykit.config.yaml` and the repository-local Git exclude
 * file.
 */

export interface LoadOperatorConfigOptions extends ConfigScaffoldOptions, ConfigConfirmationOptions {
  /** Invoked after a config is created so the caller can tell the operator. */
  readonly onScaffold?: (outcome: ConfigLocation) => void | Promise<void>;
}

export interface LoadedOperatorConfig extends ParsedOperatorConfig {
  readonly location: ConfigLocation;
  /** True when this invocation created the config from the bundled example. */
  readonly scaffolded: boolean;
}

function scaffolded(location: ConfigLocation): never {
  throw orchestratorError(
    "DK_CONFIG_SCAFFOLDED",
    `Created ${location.configPath} with mode 0600 from the bundled example. Fill it in, then run the same command again.`,
    { details: { config: location.configPath, excludeFile: location.excludePath } },
  );
}

/**
 * Parses the config document. The YAML parser echoes offending source text in
 * its messages, which may be a credential, so its error never reaches the
 * operator.
 */
export function parseConfigDocument(source: string, configPath: string): unknown {
  try {
    return parseYaml(source, { merge: false, uniqueKeys: true });
  } catch {
    throw orchestratorError("DK_CONFIG_INVALID", `${DEPLOY_CONFIG_FILE} is not valid YAML`, {
      details: { config: configPath },
    });
  }
}

export async function loadOperatorConfig(
  options: LoadOperatorConfigOptions = {},
): Promise<LoadedOperatorConfig> {
  const outcome = await scaffoldOperatorConfig(options);
  const location: ConfigLocation = {
    repositoryRoot: outcome.repositoryRoot,
    configPath: outcome.configPath,
    relativePath: outcome.relativePath,
    excludePath: outcome.excludePath,
  };

  if (outcome.status === "created") {
    await options.onScaffold?.(location);
    const confirmation = await waitForConfigCompletion(location.configPath, options);
    if (!confirmation.confirmed) scaffolded(location);
  }

  const read = await secureReadOperatorConfig(options);
  const parsed = parseOperatorConfig(parseConfigDocument(read.source, read.configPath));

  // Redact the operator's exact secret values in every later diagnostic.
  registerRedactedValues(Object.values(parsed.environment.backendValues));

  return { ...parsed, location, scaffolded: outcome.status === "created" };
}

/** Dependency-injected view of this boundary for the Phase 4 state machine. */
export function createConfigFileSystemPort(
  options: ConfigConfirmationOptions & { readonly packageRoot?: string } = {},
): ConfigFileSystemPort {
  return {
    async scaffold(request: ConfigScaffoldRequest) {
      const outcome = await scaffoldOperatorConfig({ cwd: request.cwd, packageRoot: options.packageRoot });
      return {
        status: outcome.status,
        repositoryRoot: outcome.repositoryRoot,
        configPath: outcome.configPath,
        excludePath: outcome.excludePath,
      };
    },
    async secureRead(configPath: string) {
      return secureReadOperatorConfig({ cwd: dirname(configPath), packageRoot: options.packageRoot });
    },
    async waitForConfirmation(configPath: string) {
      return waitForConfigCompletion(configPath, options);
    },
  };
}

export {
  DEPLOY_CONFIG_FILE,
  DEPLOY_CONFIG_EXAMPLE_ASSET,
  MAX_CONFIG_BYTES,
  REQUIRED_CONFIG_MODE,
  locateOperatorConfig,
  resolveBundledConfigExamplePath,
  scaffoldOperatorConfig,
  secureReadOperatorConfig,
  waitForConfigCompletion,
  type ConfigLocation,
  type ConfigScaffoldOutcome,
} from "./config-file.js";
export {
  CONFIG_PLACEHOLDER_TOKENS,
  findConfigPlaceholders,
  operatorConfigSchema,
  parseOperatorConfig,
  partitionEnvironment,
  validateOperatorConfigSemantics,
  type ConfigIssue,
  type EnvironmentPartition,
  type ParsedOperatorConfig,
} from "./config-schema.js";
export {
  canonicalYaml,
  canonicalRuntimeManifestBytes,
  compareCodePoints,
  computeManifestDigest,
  manifestDigestMatches,
  CanonicalizationError,
  type CanonicalValue,
} from "./canonical.js";
export {
  compareRuntimeRoutes,
  compileRuntimeManifest,
  makeOrchestratorTargetId,
  RUNTIME_HEALTH_DEFAULTS,
  RUNTIME_HTTP_EXPECTED_STATUSES,
  RUNTIME_ROUTE_TIMEOUT_DEFAULTS,
  type CompiledDeployment,
  type CompileOptions,
} from "./compile.js";
export {
  createCompiledDeploymentPlan,
  toProjectManifest,
  validateCompiledProject,
  type CompiledProjectValidationOptions,
} from "./project.js";
