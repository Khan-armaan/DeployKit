import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Reporter } from "../output.js";
import {
  createAdministratorSshPort,
  processAdministratorCommandRunner,
  resolvePinnedHostKey,
  type AdministratorCommandRunner,
  type AdministratorSshBoundary,
} from "./administrator-ssh.js";
import { createConfigFileSystemPort } from "./config-port.js";
import type {
  AdministratorSshConnection,
  OrchestratorDependencies,
  OrchestratorResult,
} from "./dependencies.js";
import {
  runDeployment,
  type GatewayAccessProvider,
  type GatewayAccessRequest,
  type GatewayAccessSession,
  type OrchestratorPollingOptions,
} from "./deploy.js";
import { createGatewayKeyRotator, type GatewayKeyPairGenerator } from "./gateway-keys.js";
import { createGatewayTransport } from "./gateway-transport.js";
import { createGitHubPort } from "./github-port.js";
import { createGitHubClient, type GitHubCommandRunner } from "./github.js";
import { createOperationStatePort } from "./operation-store.js";
import type { RuntimeBundleReference } from "./planner.js";
import { createOrchestratorOutput, systemClock } from "./reporting.js";
import { resolveRuntimeBundle } from "./runtime-bundle.js";

/**
 * Phase 12: the composition root that turns the Phase 4 state machine into a
 * real deployment.
 *
 * Every adapter it assembles already existed and was already tested against its
 * own boundary. What is new here is only the wiring — and one policy the wiring
 * has to own, because no single adapter can: the gateway key's lifecycle spans
 * two planes. The key is generated locally, staged on the VPS, proven by a real
 * session, uploaded to GitHub, and only then promoted to the host's active
 * entry. {@link createGatewayAccessProvider} is where those five steps are tied
 * to the one moment in the state machine at which each is safe.
 *
 * A dry run reaches none of it. The provider refuses to stage or rotate
 * anything when `dryRun` is set, and returns no facts at all, so the state
 * machine reports what it would reconcile instead of touching a host.
 *
 * This module is deliberately unreachable from `src/index.ts` and from
 * `src/cli.ts`. Phase 13 owns the cutover; until then `deploykit deploy` still
 * stops after compiling, and the only caller of {@link runProductionDeployment}
 * is the hermetic integration suite.
 */

export interface ProductionRunnerOverrides {
  /** Injected by the hermetic suite; production uses the real `gh` boundary. */
  readonly githubRunner?: GitHubCommandRunner;
  /** Injected by the hermetic suite; production uses real `ssh`/`scp`. */
  readonly administratorRunner?: AdministratorCommandRunner;
  /** Injected by the hermetic suite; defaults to the administrator runner. */
  readonly gatewayRunner?: AdministratorCommandRunner;
  readonly keyPairs?: GatewayKeyPairGenerator;
  readonly temporaryRoot?: string;
  readonly operationStateRoot?: string;
  readonly assetsDirectory?: string;
  readonly packageRoot?: string;
}

export interface ProductionDeploymentOptions extends ProductionRunnerOverrides {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly dryRun?: boolean;
  readonly noWait?: boolean;
  readonly reporter?: Reporter;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly interactive?: boolean;
  /** Packed once by the caller when a suite must not shell out to `npm pack`. */
  readonly runtimeBundle?: RuntimeBundleReference;
  readonly polling?: OrchestratorPollingOptions;
  readonly requiredVersion?: string;
  readonly validateSource?: boolean;
  readonly inspectComposeConfig?: boolean;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  /** How often the setup pull request is re-read while it awaits review. */
  readonly pollIntervalMs?: number;
  readonly maxWaitMs?: number;
}

export interface ProductionOrchestrator {
  readonly dependencies: OrchestratorDependencies;
  readonly administratorSsh: AdministratorSshBoundary;
  readonly gatewayAccess: GatewayAccessProvider;
}

/**
 * The gateway key's crash-safe rotation, expressed as the state machine's
 * `gatewayAccess` hook.
 *
 * `prepare` generates into a mode-0700 temporary directory, stages the public
 * half as a *pending* DeployKit-owned forced-command entry, and opens a real
 * gateway session with the private half. Only a key that answered that session
 * is ever offered for upload. The state machine calls `activate` after the
 * Environment holds the private key and `dispose` before it returns, so the
 * private key exists locally for exactly as long as the upload needs it.
 *
 * Recovery is rotation rather than inference: an Environment secret cannot be
 * read back, so a resumed run has no way to learn whether the stored secret
 * matches a pending entry whose private half it no longer holds. Every run
 * therefore prepares a fresh pair, and staging drops this binding's stale
 * pending entries as it appends the replacement.
 */
export function createGatewayAccessProvider(
  administratorSsh: AdministratorSshBoundary,
  gateway: OrchestratorDependencies["gateway"],
  overrides: ProductionRunnerOverrides & {
    readonly runner: AdministratorCommandRunner;
  },
): GatewayAccessProvider {
  return async (_context, _handshake, request: GatewayAccessRequest): Promise<GatewayAccessSession> => {
    const connection: AdministratorSshConnection = request.connection;
    // The scanned line already carries the `[host]:port` form for a non-default
    // port, so it is pinned exactly as received rather than reassembled. It
    // carries no terminating newline on purpose: this value becomes an
    // Environment variable, `gh` stores variables without a trailing newline,
    // and a value that could not be read back byte for byte would make the
    // Environment read as drifted on every rerun. The workflow and the local
    // transport each append the newline when they materialize the file.
    const hostKey = await resolvePinnedHostKey(overrides.runner, connection);
    const knownHosts = hostKey.line;

    if (request.dryRun) {
      // Nothing is generated, staged, uploaded, or promoted. The caller reports
      // what it would reconcile and mutates no host and no Environment.
      return {
        facts: {
          host: connection.host,
          port: connection.port,
          user: request.binding.gatewayUser,
          knownHosts,
          secrets: {},
        },
      };
    }

    if (request.repositoryKeyFingerprint === null) {
      throw new Error("the repository key fingerprint must be proven before a gateway key is staged");
    }

    const rotator = createGatewayKeyRotator({
      administratorSsh,
      gateway,
      knownHosts,
      ...(overrides.keyPairs === undefined ? {} : { keyPairs: overrides.keyPairs }),
      ...(overrides.temporaryRoot === undefined ? {} : { temporaryRoot: overrides.temporaryRoot }),
    });
    const prepared = await rotator.prepare(connection, request.binding, {
      repositoryKeyFingerprint: request.repositoryKeyFingerprint,
    });
    return {
      facts: prepared.access,
      async activate(): Promise<void> {
        await prepared.activate();
      },
      dispose: prepared.dispose,
    };
  };
}

export function createProductionOrchestrator(
  options: ProductionDeploymentOptions = {},
): ProductionOrchestrator {
  const administratorRunner = options.administratorRunner ?? processAdministratorCommandRunner;
  const gatewayRunner = options.gatewayRunner ?? administratorRunner;
  const administratorSsh = createAdministratorSshPort({
    runner: administratorRunner,
    ...(options.assetsDirectory === undefined ? {} : { assetsDirectory: options.assetsDirectory }),
  });
  const gateway = createGatewayTransport({
    runner: gatewayRunner,
    ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
  });
  const github = createGitHubPort({
    client: createGitHubClient({
      ...(options.githubRunner === undefined ? {} : { runner: options.githubRunner }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    }),
    // `--no-wait` must not block on a human review.
    waitForMerge: options.noWait !== true,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const dependencies: OrchestratorDependencies = {
    github,
    administratorSsh,
    gateway,
    configFileSystem: createConfigFileSystemPort({
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
      ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
    }),
    operationState: createOperationStatePort(
      options.operationStateRoot === undefined ? {} : { root: options.operationStateRoot },
    ),
    clock: systemClock,
    output: createOrchestratorOutput(options.reporter ?? new Reporter()),
  };

  return {
    dependencies,
    administratorSsh,
    gatewayAccess: createGatewayAccessProvider(administratorSsh, gateway, {
      ...options,
      runner: administratorRunner,
    }),
  };
}

/**
 * The internal Phase 12 entrypoint. It performs a complete real deployment and
 * is reachable only from tests until Phase 13 routes `deploykit deploy` here.
 */
export async function runProductionDeployment(
  options: ProductionDeploymentOptions = {},
): Promise<OrchestratorResult> {
  const orchestrator = createProductionOrchestrator(options);

  let temporaryBundleRoot: string | undefined;
  try {
    let runtimeBundle = options.runtimeBundle;
    if (runtimeBundle === undefined) {
      temporaryBundleRoot = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "deploykit-bundle-"));
      runtimeBundle = await resolveRuntimeBundle({
        destination: temporaryBundleRoot,
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      });
    }

    return await runDeployment(orchestrator.dependencies, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      ...(options.noWait === undefined ? {} : { noWait: options.noWait }),
      ...(options.polling === undefined ? {} : { polling: options.polling }),
      ...(options.requiredVersion === undefined ? {} : { requiredVersion: options.requiredVersion }),
      ...(options.validateSource === undefined ? {} : { validateSource: options.validateSource }),
      ...(options.inspectComposeConfig === undefined
        ? {}
        : { inspectComposeConfig: options.inspectComposeConfig }),
      runtimeBundle,
      gatewayAccess: orchestrator.gatewayAccess,
    });
  } finally {
    if (temporaryBundleRoot !== undefined) {
      await rm(temporaryBundleRoot, { recursive: true, force: true });
    }
  }
}
