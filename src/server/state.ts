import type {
  AllocatedPortResult,
  DeploymentStateIdentity,
  HealthResult,
} from "../orchestrator/contracts.js";
import { atomicWriteJson, readJsonFile } from "./atomic.js";
import { ServerError } from "./errors.js";
import { assertCommitSha, assertTargetName } from "./ids.js";
import {
  assertDeploymentIdentity,
  identityMismatchFields,
  sameDeploymentIdentity,
} from "./identity.js";
import type { LockProvider } from "./lock.js";
import { LOOPBACK_ADDRESS } from "./registry.js";

export const DEPLOYMENT_PHASES = [
  "manifest-validated",
  "dns-verified",
  "resources-reserved",
  "source-staged",
  "workloads-ready",
  "migrations-complete",
  "health-verified",
  "proxy-staged",
  "tls-issued",
  "activated",
  "complete",
] as const;

export type ServerDeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];
export type DeploymentStatus = "running" | "failed" | "succeeded";

/** The current on-disk state version. Version 1 predates identity binding. */
export const DEPLOYMENT_STATE_VERSION = 2 as const;

export interface DeploymentCheckpoint {
  readonly phase: ServerDeploymentPhase;
  readonly completedAt: string;
}

export interface DeploymentFailure {
  readonly phase: ServerDeploymentPhase | "starting";
  readonly code: string;
  readonly message: string;
  readonly failedAt: string;
}

/**
 * Reservations the server allocated for this identity. They are persisted so a
 * retry keeps the same loopback ports and so inspection can report them without
 * the manifest the deployment was applied from.
 */
export interface DeploymentStateResources {
  readonly domains: readonly string[];
  readonly ports: readonly AllocatedPortResult[];
}

export interface DeploymentState {
  readonly version: typeof DEPLOYMENT_STATE_VERSION;
  readonly identity: DeploymentStateIdentity;
  readonly targetName: string;
  readonly status: DeploymentStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly checkpoints: readonly DeploymentCheckpoint[];
  readonly failures: readonly DeploymentFailure[];
  readonly resources: DeploymentStateResources;
  readonly health: readonly HealthResult[];
}

/**
 * Pre-digest state. DeployKit never guesses which commit or manifest such a
 * record belongs to: a completed target is preserved and still refuses another
 * apply, and failed or running state must be migrated explicitly.
 */
export interface LegacyDeploymentState {
  readonly version: 1;
  readonly targetId: string;
  readonly commitSha: string | null;
  readonly status: DeploymentStatus;
  readonly phase: ServerDeploymentPhase | null;
  readonly checkpoints: readonly DeploymentCheckpoint[];
  readonly failures: readonly DeploymentFailure[];
}

export type StoredDeploymentState =
  | { readonly kind: "none" }
  | { readonly kind: "current"; readonly state: DeploymentState }
  | { readonly kind: "legacy"; readonly state: LegacyDeploymentState };

export interface BeginDeploymentResult {
  readonly state: DeploymentState;
  readonly resumed: boolean;
}

export interface BeginDeploymentOptions {
  /**
   * Set only by a caller that already holds the server-wide deployment lock.
   * Without that proof a `running` record may belong to a live deployment, so
   * it is refused instead of being mistaken for an interrupted one.
   */
  readonly serverDeploymentLockHeld?: boolean;
}

export interface DeploymentStateStoreOptions {
  readonly file: string;
  readonly lockFile: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly lock: LockProvider;
  readonly now?: () => Date;
}

const STATUSES: readonly DeploymentStatus[] = ["running", "failed", "succeeded"];
const HEALTH_CHECK_TYPES: readonly HealthResult["check"][] = ["http", "tcp", "command", "process"];

function isStatus(value: unknown): value is DeploymentStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function assertContiguousCheckpoints(checkpoints: readonly DeploymentCheckpoint[]): void {
  let lastIndex = -1;
  for (const checkpoint of checkpoints) {
    const index = DEPLOYMENT_PHASES.indexOf(checkpoint.phase);
    if (index !== lastIndex + 1) {
      throw new ServerError("SERVER_STATE_INVALID", "deployment checkpoints are not contiguous", {
        checkpoint: checkpoint.phase,
      });
    }
    lastIndex = index;
  }
}

function assertResources(resources: DeploymentStateResources): DeploymentStateResources {
  if (!Array.isArray(resources?.domains) || !Array.isArray(resources?.ports)) {
    throw new ServerError("SERVER_STATE_INVALID", "deployment state has invalid reserved resources");
  }
  for (const port of resources.ports) {
    if (
      typeof port.service !== "string" || port.service === "" ||
      port.address !== LOOPBACK_ADDRESS ||
      !Number.isInteger(port.port) || port.port < 1024 || port.port > 65535
    ) {
      throw new ServerError("SERVER_STATE_INVALID", "deployment state has an invalid allocated port");
    }
  }
  return resources;
}

function assertHealth(health: readonly HealthResult[]): readonly HealthResult[] {
  if (!Array.isArray(health)) {
    throw new ServerError("SERVER_STATE_INVALID", "deployment state has an invalid health record");
  }
  for (const result of health) {
    if (
      typeof result.service !== "string" || result.service === "" ||
      typeof result.healthy !== "boolean" ||
      !HEALTH_CHECK_TYPES.includes(result.check)
    ) {
      throw new ServerError("SERVER_STATE_INVALID", "deployment state has an invalid health record");
    }
  }
  return health;
}

function assertCurrentState(value: DeploymentState, expectedTargetId: string): DeploymentState {
  if (
    value.version !== DEPLOYMENT_STATE_VERSION ||
    !isStatus(value.status) ||
    !Number.isInteger(value.attempt) || value.attempt < 1 ||
    !Array.isArray(value.checkpoints) ||
    !Array.isArray(value.failures)
  ) {
    throw new ServerError("SERVER_STATE_INVALID", "deployment state has an unsupported shape", {
      expectedTargetId,
    });
  }
  const identity = assertDeploymentIdentity(value.identity, expectedTargetId);
  assertTargetName(value.targetName);
  assertContiguousCheckpoints(value.checkpoints);
  if (value.status === "succeeded" && value.checkpoints.at(-1)?.phase !== "complete") {
    throw new ServerError("SERVER_STATE_INVALID", "successful deployment lacks the complete checkpoint");
  }
  return {
    ...value,
    identity,
    resources: assertResources(value.resources),
    health: assertHealth(value.health),
  };
}

function assertLegacyState(value: Record<string, unknown>, expectedTargetId: string): LegacyDeploymentState {
  if (value.targetId !== expectedTargetId || !isStatus(value.status)) {
    throw new ServerError("SERVER_STATE_INVALID", "legacy deployment state has an unsupported shape", {
      expectedTargetId,
    });
  }
  const checkpoints = Array.isArray(value.checkpoints) ? (value.checkpoints as DeploymentCheckpoint[]) : [];
  assertContiguousCheckpoints(checkpoints);
  const phase = typeof value.phase === "string" &&
    (DEPLOYMENT_PHASES as readonly string[]).includes(value.phase)
    ? (value.phase as ServerDeploymentPhase)
    : checkpoints.at(-1)?.phase ?? null;
  return {
    version: 1,
    targetId: expectedTargetId,
    commitSha: typeof value.commitSha === "string" ? assertCommitSha(value.commitSha) : null,
    status: value.status,
    phase,
    checkpoints,
    failures: Array.isArray(value.failures) ? (value.failures as DeploymentFailure[]) : [],
  };
}

export class DeploymentStateStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly targetId: string;
  private readonly targetName: string;
  private readonly lock: LockProvider;
  private readonly now: () => Date;

  constructor(options: DeploymentStateStoreOptions) {
    this.file = options.file;
    this.lockFile = options.lockFile;
    this.targetId = options.targetId;
    this.targetName = assertTargetName(options.targetName);
    this.lock = options.lock;
    this.now = options.now ?? (() => new Date());
  }

  /** Reads whatever is on disk, including pre-digest state, without judging it. */
  async readStored(): Promise<StoredDeploymentState> {
    const value = await readJsonFile<Record<string, unknown> | null>(this.file, null);
    if (value === null) return { kind: "none" };
    if (value.version === 1) {
      return { kind: "legacy", state: assertLegacyState(value, this.targetId) };
    }
    return { kind: "current", state: assertCurrentState(value as unknown as DeploymentState, this.targetId) };
  }

  /** Identity-bound state only. Pre-digest state is reported, never guessed. */
  async read(): Promise<DeploymentState | undefined> {
    const stored = await this.readStored();
    if (stored.kind === "none") return undefined;
    if (stored.kind === "legacy") throw this.legacyFailure(stored.state);
    return stored.state;
  }

  async begin(
    identity: DeploymentStateIdentity,
    options: BeginDeploymentOptions = {},
  ): Promise<BeginDeploymentResult> {
    const requested = assertDeploymentIdentity(identity, this.targetId);
    return await this.lock.withLock(this.lockFile, async () => {
      const stored = await this.readStored();
      const timestamp = this.now().toISOString();

      if (stored.kind === "none") {
        const state: DeploymentState = {
          version: DEPLOYMENT_STATE_VERSION,
          identity: requested,
          targetName: this.targetName,
          status: "running",
          attempt: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          checkpoints: [],
          failures: [],
          resources: { domains: [], ports: [] },
          health: [],
        };
        await this.write(state);
        return { state, resumed: false };
      }

      if (stored.kind === "legacy") {
        if (stored.state.status === "succeeded") throw this.alreadyDeployedFailure(stored.state.commitSha);
        throw this.legacyFailure(stored.state);
      }

      const existing = stored.state;
      if (existing.status === "succeeded") throw this.alreadyDeployedFailure(existing.identity.commitSha);
      if (!sameDeploymentIdentity(existing.identity, requested)) {
        throw new ServerError(
          "SERVER_IDENTITY_MISMATCH",
          `target ${this.targetId} can only resume commit ${existing.identity.commitSha} with manifest digest ${existing.identity.manifestDigest.value}`,
          {
            mismatched: identityMismatchFields(existing.identity, requested),
            recorded: existing.identity,
            requested,
          },
        );
      }
      if (existing.status === "running" && options.serverDeploymentLockHeld !== true) {
        throw new ServerError(
          "SERVER_DEPLOYMENT_IN_PROGRESS",
          `target ${this.targetId} already has a deployment in progress`,
          { targetId: this.targetId },
        );
      }

      const resumed: DeploymentState = {
        ...existing,
        targetName: this.targetName,
        status: "running",
        attempt: existing.attempt + 1,
        updatedAt: timestamp,
      };
      await this.write(resumed);
      return { state: resumed, resumed: true };
    });
  }

  /**
   * Binds pre-digest state to an explicit identity supplied by an operator.
   * Nothing else may convert legacy state: the runtime cannot know which commit
   * or manifest produced it.
   */
  async migrateLegacyState(identity: DeploymentStateIdentity): Promise<DeploymentState> {
    const requested = assertDeploymentIdentity(identity, this.targetId);
    return await this.lock.withLock(this.lockFile, async () => {
      const stored = await this.readStored();
      if (stored.kind !== "legacy") {
        throw new ServerError(
          "SERVER_STATE_INVALID",
          `target ${this.targetId} has no pre-digest deployment state to migrate`,
          { targetId: this.targetId },
        );
      }
      const timestamp = this.now().toISOString();
      const migrated: DeploymentState = {
        version: DEPLOYMENT_STATE_VERSION,
        identity: requested,
        targetName: this.targetName,
        status: stored.state.status,
        attempt: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        checkpoints: stored.state.checkpoints,
        failures: stored.state.failures,
        resources: { domains: [], ports: [] },
        health: [],
      };
      await this.write(assertCurrentState(migrated, this.targetId));
      return migrated;
    });
  }

  async checkpoint(phase: ServerDeploymentPhase): Promise<DeploymentState> {
    return await this.update((state) => {
      if (state.status !== "running") {
        throw new ServerError("SERVER_STATE_INVALID", `cannot checkpoint a ${state.status} deployment`);
      }
      const requestedIndex = DEPLOYMENT_PHASES.indexOf(phase);
      const existingIndex = state.checkpoints.findIndex((item) => item.phase === phase);
      if (existingIndex >= 0) return state;
      if (requestedIndex !== state.checkpoints.length) {
        const expected = DEPLOYMENT_PHASES[state.checkpoints.length];
        throw new ServerError(
          "SERVER_CHECKPOINT_ORDER",
          `cannot checkpoint ${phase}; expected ${expected ?? "no further phase"}`,
          { phase, expected },
        );
      }
      const timestamp = this.now().toISOString();
      return {
        ...state,
        updatedAt: timestamp,
        checkpoints: [...state.checkpoints, { phase, completedAt: timestamp }],
      };
    });
  }

  /** Persists the ports and domains the registry allocated for this identity. */
  async recordResources(resources: DeploymentStateResources): Promise<DeploymentState> {
    const validated = assertResources({
      domains: [...resources.domains].sort(),
      ports: [...resources.ports].sort((left, right) => left.service.localeCompare(right.service)),
    });
    return await this.update((state) => ({
      ...state,
      updatedAt: this.now().toISOString(),
      resources: validated,
    }));
  }

  async recordHealth(health: readonly HealthResult[]): Promise<DeploymentState> {
    const validated = assertHealth([...health].sort((left, right) => left.service.localeCompare(right.service)));
    return await this.update((state) => ({
      ...state,
      updatedAt: this.now().toISOString(),
      health: validated,
    }));
  }

  async fail(
    phase: ServerDeploymentPhase | "starting",
    code: string,
    message: string,
  ): Promise<DeploymentState> {
    return await this.update((state) => {
      if (state.status === "succeeded") {
        throw new ServerError("SERVER_STATE_INVALID", "cannot fail a successful deployment");
      }
      const timestamp = this.now().toISOString();
      return {
        ...state,
        status: "failed",
        updatedAt: timestamp,
        failures: [...state.failures, { phase, code, message, failedAt: timestamp }],
      };
    });
  }

  async succeed(): Promise<DeploymentState> {
    return await this.update((state) => {
      if (state.status !== "running") {
        throw new ServerError("SERVER_STATE_INVALID", `cannot complete a ${state.status} deployment`);
      }
      const completeIndex = DEPLOYMENT_PHASES.indexOf("complete");
      const alreadyComplete = state.checkpoints.at(-1)?.phase === "complete";
      if (!alreadyComplete && state.checkpoints.length !== completeIndex) {
        throw new ServerError(
          "SERVER_CHECKPOINT_ORDER",
          `cannot complete deployment; expected ${DEPLOYMENT_PHASES[state.checkpoints.length] ?? "no further phase"}`,
        );
      }
      const timestamp = this.now().toISOString();
      return {
        ...state,
        status: "succeeded",
        updatedAt: timestamp,
        checkpoints: alreadyComplete
          ? state.checkpoints
          : [...state.checkpoints, { phase: "complete", completedAt: timestamp }],
      };
    });
  }

  private alreadyDeployedFailure(commitSha: string | null): ServerError {
    return new ServerError(
      "SERVER_DEPLOYMENT_EXISTS",
      `target ${this.targetId} was already deployed successfully; v0.1 supports first deployment only`,
      { targetId: this.targetId, ...(commitSha === null ? {} : { commitSha }) },
    );
  }

  private legacyFailure(state: LegacyDeploymentState): ServerError {
    return new ServerError(
      "SERVER_STATE_LEGACY",
      `target ${this.targetId} holds ${state.status} deployment state that predates manifest-digest binding`,
      { targetId: this.targetId, status: state.status, phase: state.phase },
    );
  }

  private async update(
    transform: (state: DeploymentState) => DeploymentState,
  ): Promise<DeploymentState> {
    return await this.lock.withLock(this.lockFile, async () => {
      const state = await this.read();
      if (state === undefined) {
        throw new ServerError("SERVER_STATE_INVALID", "deployment has not been started");
      }
      const next = transform(state);
      await this.write(next);
      return next;
    });
  }

  private async write(state: DeploymentState): Promise<void> {
    await atomicWriteJson(this.file, state, { mode: 0o600 });
  }
}
