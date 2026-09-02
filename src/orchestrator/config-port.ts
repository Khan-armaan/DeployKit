import { dirname, resolve } from "node:path";

import type {
  ConfigConfirmationResult,
  ConfigFileSystemPort,
  ConfigScaffoldRequest,
  ConfigScaffoldResult,
  SecureConfigReadResult,
} from "./dependencies.js";
import {
  DEPLOY_CONFIG_FILE,
  scaffoldOperatorConfig,
  secureReadOperatorConfig,
  waitForConfigCompletion,
} from "./config-file.js";
import { orchestratorError } from "./failures.js";

/**
 * Phase 12: the production `config-filesystem` adapter.
 *
 * It adds no policy of its own. Phase 2 already decided what a readable config
 * is — regular file, owned by this user, mode 0600, untracked, unstaged, and
 * Git-ignored — and this module only turns those functions into the injected
 * port the state machine speaks to, so the orchestrator has exactly one way to
 * reach the one secret-bearing file.
 *
 * The requested path is honoured but not trusted: DeployKit reads
 * `deploykit.config.yaml` at the repository root, so a path pointing anywhere
 * else is refused rather than silently redirected to the root file. Phase 13
 * owns the `--config` flag; until then the only caller passes the path it was
 * just handed by {@link ConfigFileSystemPort.scaffold}.
 */

export interface ConfigFileSystemPortOptions {
  /** Root of the installed npm package holding the bundled example. */
  readonly packageRoot?: string;
  /** Injected in tests; defaults to the real TTY prompt. */
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly interactive?: boolean;
}

/** The directory whose repository root holds the config the caller means. */
function requestedDirectory(request: { readonly cwd: string; readonly configPath?: string }): string {
  return request.configPath === undefined ? request.cwd : dirname(resolve(request.configPath));
}

function assertRequestedPath(configPath: string | undefined, located: string): void {
  if (configPath === undefined) return;
  if (resolve(configPath) !== located) {
    throw orchestratorError(
      "DK_CONFIG_INSECURE",
      `must be ${DEPLOY_CONFIG_FILE} at the application repository root`,
      { details: { requested: resolve(configPath), expected: located } },
    );
  }
}

export function createConfigFileSystemPort(
  options: ConfigFileSystemPortOptions = {},
): ConfigFileSystemPort {
  return {
    async scaffold(request: ConfigScaffoldRequest): Promise<ConfigScaffoldResult> {
      const outcome = await scaffoldOperatorConfig({
        cwd: requestedDirectory(request),
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      });
      assertRequestedPath(request.configPath, outcome.configPath);
      return {
        status: outcome.status,
        repositoryRoot: outcome.repositoryRoot,
        configPath: outcome.configPath,
        excludePath: outcome.excludePath,
      };
    },

    async secureRead(configPath: string): Promise<SecureConfigReadResult> {
      const read = await secureReadOperatorConfig({ cwd: dirname(resolve(configPath)) });
      assertRequestedPath(configPath, read.configPath);
      return read;
    },

    async waitForConfirmation(configPath: string): Promise<ConfigConfirmationResult> {
      return waitForConfigCompletion(configPath, {
        ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
        ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
      });
    },
  };
}
