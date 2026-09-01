import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { DeployKitError } from "../errors.js";
import type { ProjectManifest } from "../manifest.js";
import {
  type GatewayDeploymentResult,
  type GatewayHandshakeResult,
  type GatewayOperation,
  type GatewayProgressPhase,
  type RootOwnedGatewayBinding,
} from "../orchestrator/contracts.js";
import { toProjectManifest } from "../orchestrator/project.js";
import { validateProject } from "../project-validation.js";
import {
  DeploymentApplier,
  DigDnsResolver,
  FlockLockProvider,
  ProcessCommandRunner,
  ProductionDeploymentDriver,
  RegistryStore,
  SecretsStore,
  inspectDeployment,
  secretRequirementsFromManifest,
  serializeSecretsEnv,
  serverPaths,
  type DeploymentEvent,
  type ServerRoots,
} from "../server/index.js";
import { DEFAULT_SERVER_ROOTS } from "../server/paths.js";
import { VERSION, versionSatisfiesRequirement } from "../version.js";
import { gatewayError } from "./failures.js";
import { minimalGatewayEnvironment } from "./invocation.js";
import type {
  GatewayApplyContext,
  GatewayInspectContext,
  GatewayOperations,
  GatewayProgressReporter,
} from "./session.js";

/**
 * The production implementation of the four exposed gateway operations. It is
 * a thin, deliberately boring adapter: every decision that matters already
 * belongs to the deterministic deployment engine, and everything identity-bound
 * comes from the root-owned binding rather than from the request.
 *
 * Source retrieval is injected rather than reached for. Phase 7 implements it
 * in `./source.ts`, and the forced command installs that provider; an
 * installation constructed without one advertises only the non-mutating
 * operations and refuses `apply` and `retry` as an incomplete bootstrap instead
 * of guessing where a tree came from.
 */

export interface GatewaySourceRequest {
  readonly binding: RootOwnedGatewayBinding;
  readonly applicationRef: string;
  readonly commitSha: string;
  readonly report: GatewayProgressReporter;
}

export interface GatewayRetrievedSource {
  /** Absolute root of the verified tree; never a DeployKit-owned runtime path. */
  readonly sourceDirectory: string;
  /** True when an identical verified tree was already present for this commit. */
  readonly reused?: boolean;
}

export interface GatewaySourcePort {
  retrieve(request: GatewaySourceRequest): Promise<GatewayRetrievedSource>;
}

/**
 * Host facts the deployment engine needs and the binding deliberately does not
 * carry: which addresses this host answers on, and the loopback port range the
 * registry may allocate from. Bootstrap writes the file as root.
 */
export interface GatewayHostFacts {
  readonly publicAddresses: readonly string[];
  readonly portRange?: { readonly start: number; readonly end: number };
}

const hostFactsSchema = z.strictObject({
  version: z.literal(1),
  publicAddresses: z.array(z.string().min(1).max(64)).min(1).max(16),
  portRange: z
    .strictObject({
      start: z.number().int().min(1).max(65_535),
      end: z.number().int().min(1).max(65_535),
    })
    .refine((range) => range.start < range.end, "portRange.start must be below portRange.end")
    .optional(),
});

export function gatewayHostFactsFile(roots: ServerRoots = DEFAULT_SERVER_ROOTS): string {
  return join(roots.config, "gateway", "host.json");
}

export async function readGatewayHostFacts(
  options: { path?: string; roots?: ServerRoots; requireRootOwnership?: boolean } = {},
): Promise<GatewayHostFacts> {
  const path = options.path ?? gatewayHostFactsFile(options.roots);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw gatewayError("DK_GATEWAY_BOOTSTRAP_FAILED", `the gateway host facts at ${path} could not be read`, {
      details: { path, cause: (error as NodeJS.ErrnoException).code ?? "unknown" },
    });
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || ((options.requireRootOwnership ?? true) && stats.uid !== 0)) {
      throw gatewayError("DK_GATEWAY_BOOTSTRAP_FAILED", `the gateway host facts at ${path} are not a root-owned file`, {
        details: { path },
      });
    }
    const parsed = hostFactsSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    if (!parsed.success) {
      throw gatewayError("DK_GATEWAY_BOOTSTRAP_FAILED", `the gateway host facts at ${path} are not valid`, {
        details: { path },
      });
    }
    return {
      publicAddresses: parsed.data.publicAddresses,
      ...(parsed.data.portRange === undefined ? {} : { portRange: parsed.data.portRange }),
    };
  } catch (error) {
    if (error instanceof DeployKitError) throw error;
    throw gatewayError("DK_GATEWAY_BOOTSTRAP_FAILED", `the gateway host facts at ${path} could not be parsed`, {
      cause: error,
      details: { path },
    });
  } finally {
    await handle.close();
  }
}

const NON_MUTATING: readonly GatewayOperation[] = Object.freeze(["handshake", "inspect"] as const);
const ALL_OPERATIONS: readonly GatewayOperation[] = Object.freeze([
  "handshake",
  "apply",
  "retry",
  "inspect",
] as const);

/** Phases the session already reports itself; reporting them twice is noise. */
const SESSION_OWNED_PHASES: ReadonlySet<string> = new Set(["starting", "manifest-validated"]);

function gatewayPhaseCode(phase: string): string {
  return `DK_GATEWAY_${phase.toUpperCase().replaceAll("-", "_")}`;
}

export interface GatewayRuntimeOptions {
  /** Absent only in an installation with no verified exact-SHA source provider. */
  readonly source?: GatewaySourcePort;
  readonly hostFacts?: () => Promise<GatewayHostFacts>;
  readonly roots?: ServerRoots;
  readonly runtimeVersion?: string;
  /** Injected so tests can prove the root check without running as root. */
  readonly currentUid?: () => number | undefined;
}

class ProductionGatewayOperations implements GatewayOperations {
  readonly capabilities: readonly GatewayOperation[];

  constructor(private readonly options: GatewayRuntimeOptions) {
    this.capabilities = options.source === undefined ? NON_MUTATING : ALL_OPERATIONS;
  }

  private get version(): string {
    return this.options.runtimeVersion ?? VERSION;
  }

  private get roots(): ServerRoots {
    return this.options.roots ?? DEFAULT_SERVER_ROOTS;
  }

  /**
   * Non-mutating by construction: it reports what this host is, and refuses if
   * the installed runtime is not the one the binding was written for.
   */
  async handshake(binding: RootOwnedGatewayBinding): Promise<GatewayHandshakeResult> {
    if (binding.runtimeVersion !== this.version) {
      throw gatewayError(
        "DK_GATEWAY_BOOTSTRAP_FAILED",
        "the installed gateway runtime is not the version the root-owned binding records",
        { details: { binding: binding.runtimeVersion, installed: this.version } },
      );
    }
    return {
      kind: "handshake",
      bindingId: binding.bindingId,
      targetId: binding.targetId,
      runtimeVersion: this.version,
      runtimeBundleSha256: binding.runtimeBundleSha256,
      capabilities: [...this.capabilities],
    };
  }

  async inspect(context: GatewayInspectContext): Promise<GatewayDeploymentResult> {
    const inspection = await inspectDeployment({
      targetId: context.binding.targetId,
      targetName: context.binding.targetName,
      roots: this.roots,
    });
    return inspection.result;
  }

  async apply(context: GatewayApplyContext): Promise<GatewayDeploymentResult> {
    const projectManifest = toProjectManifest(context.manifest);
    if (!versionSatisfiesRequirement(projectManifest.metadata.requiredVersion, this.version)) {
      throw gatewayError(
        "DK_PREFLIGHT_FAILED",
        `the runtime manifest requires DeployKit ${projectManifest.metadata.requiredVersion}, but this gateway runs ${this.version}`,
      );
    }

    // A dry run answers from durable state alone. It reserves nothing, writes
    // no secret, stages no source, and leaves the target exactly as it was.
    if (context.dryRun) {
      const inspection = await inspectDeployment({
        targetId: context.binding.targetId,
        targetName: context.binding.targetName,
        roots: this.roots,
        dryRun: true,
      });
      return inspection.result;
    }

    const uid = (this.options.currentUid ?? (() => process.getuid?.()))();
    if (uid !== undefined && uid !== 0) {
      throw gatewayError("DK_PREFLIGHT_FAILED", "the gateway runtime must apply a deployment as root");
    }

    const source = this.options.source;
    if (source === undefined) {
      throw gatewayError(
        "DK_GATEWAY_BOOTSTRAP_FAILED",
        "this gateway installation has no verified source provider",
      );
    }

    // Source retrieval happens before any runtime mutation, so a gateway that
    // cannot prove the frozen commit never touches state, secrets, or ports.
    const retrieved = await source.retrieve({
      binding: context.binding,
      applicationRef: context.applicationRef,
      commitSha: context.commitSha,
      report: context.report,
    });

    const paths = serverPaths(context.binding.targetId, this.roots);
    const requirements = secretRequirementsFromManifest(projectManifest);
    const secretsStore = new SecretsStore({ file: paths.secretsFile, requirements });
    await secretsStore.writeFromStdin(
      serializeSecretsEnv(Object.fromEntries(context.secrets)),
      true,
    );
    const secretValues = await secretsStore.read();
    const redactor = await secretsStore.redactor();

    await this.assertProjectValidates(projectManifest, retrieved.sourceDirectory);

    const hostFacts = await (this.options.hostFacts ?? (() => readGatewayHostFacts({ roots: this.roots })))();
    const lock = new FlockLockProvider();
    // Every deployment command starts from a minimal environment: nothing the
    // SSH client set can reach Docker, npm, Nginx, or Certbot.
    const runner = new ProcessCommandRunner({ redactor, baseEnvironment: minimalGatewayEnvironment() });
    const registry = new RegistryStore({
      file: paths.registryFile,
      lockFile: paths.registryLockFile,
      lock,
      portRange: hostFacts.portRange ?? { start: 20_000, end: 39_999 },
    });
    const applier = new DeploymentApplier({
      manifest: projectManifest,
      targetName: context.binding.targetName,
      commitSha: context.commitSha,
      manifestDigest: context.manifestDigest,
      targetId: context.binding.targetId,
      sourceDirectory: retrieved.sourceDirectory,
      serverAddresses: [...hostFacts.publicAddresses],
      roots: this.roots,
      lock,
      registry,
      dnsResolver: new DigDnsResolver(runner),
      driver: new ProductionDeploymentDriver({ runner, secrets: secretValues }),
      redactor,
      observe: (event) => { reportDeploymentEvent(context.report, event); },
    });
    const result = await applier.apply();
    return result.inspection.result;
  }

  private async assertProjectValidates(manifest: ProjectManifest, sourceRoot: string): Promise<void> {
    const validation = await validateProject(manifest, { sourceRoot, inspectComposeConfig: true });
    if (!validation.valid) {
      throw gatewayError("DK_PREFLIGHT_FAILED", "the retrieved source does not satisfy the runtime manifest", {
        details: { issues: validation.issues },
      });
    }
  }
}

/** Turns one durable deployment event into at most one bounded progress frame. */
export function reportDeploymentEvent(report: GatewayProgressReporter, event: DeploymentEvent): void {
  if (SESSION_OWNED_PHASES.has(event.phase)) return;
  if (event.code !== "SERVER_PHASE_COMPLETED" && event.code !== "SERVER_PHASE_SKIPPED") return;
  report({
    phase: event.phase as GatewayProgressPhase,
    code: gatewayPhaseCode(event.phase),
    message: event.message,
    level: "info",
  });
}

export function createGatewayOperations(options: GatewayRuntimeOptions = {}): GatewayOperations {
  return new ProductionGatewayOperations(options);
}
