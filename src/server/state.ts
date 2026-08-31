import { atomicWriteJson, readJsonFile } from "./atomic.js";
import { ServerError } from "./errors.js";
import { assertCommitSha } from "./ids.js";
import type { LockProvider } from "./lock.js";

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

export interface DeploymentState {
  readonly version: 1;
  readonly targetId: string;
  readonly commitSha: string;
  readonly status: DeploymentStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly checkpoints: readonly DeploymentCheckpoint[];
  readonly failures: readonly DeploymentFailure[];
}

export interface BeginDeploymentResult {
  readonly state: DeploymentState;
  readonly resumed: boolean;
}

export interface DeploymentStateStoreOptions {
  readonly file: string;
  readonly lockFile: string;
  readonly targetId: string;
  readonly lock: LockProvider;
  readonly now?: () => Date;
}

function assertState(value: DeploymentState, expectedTargetId: string): DeploymentState {
  if (
    value.version !== 1 ||
    value.targetId !== expectedTargetId ||
    !["running", "failed", "succeeded"].includes(value.status) ||
    !Array.isArray(value.checkpoints) ||
    !Array.isArray(value.failures)
  ) {
    throw new ServerError("SERVER_STATE_INVALID", "deployment state has an unsupported shape", {
      expectedTargetId,
    });
  }
  assertCommitSha(value.commitSha);
  let lastIndex = -1;
  for (const checkpoint of value.checkpoints) {
    const index = DEPLOYMENT_PHASES.indexOf(checkpoint.phase);
    if (index !== lastIndex + 1) {
      throw new ServerError("SERVER_STATE_INVALID", "deployment checkpoints are not contiguous", {
        checkpoint: checkpoint.phase,
      });
    }
    lastIndex = index;
  }
  if (value.status === "succeeded" && value.checkpoints.at(-1)?.phase !== "complete") {
    throw new ServerError("SERVER_STATE_INVALID", "successful deployment lacks the complete checkpoint");
  }
  return value;
}

export class DeploymentStateStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly targetId: string;
  private readonly lock: LockProvider;
  private readonly now: () => Date;

  constructor(options: DeploymentStateStoreOptions) {
    this.file = options.file;
    this.lockFile = options.lockFile;
    this.targetId = options.targetId;
    this.lock = options.lock;
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<DeploymentState | undefined> {
    const value = await readJsonFile<DeploymentState | null>(this.file, null);
    return value === null ? undefined : assertState(value, this.targetId);
  }

  async begin(commitSha: string): Promise<BeginDeploymentResult> {
    const normalizedSha = assertCommitSha(commitSha);
    return await this.lock.withLock(this.lockFile, async () => {
      const existing = await this.read();
      const timestamp = this.now().toISOString();
      if (existing === undefined) {
        const state: DeploymentState = {
          version: 1,
          targetId: this.targetId,
          commitSha: normalizedSha,
          status: "running",
          attempt: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          checkpoints: [],
          failures: [],
        };
        await this.write(state);
        return { state, resumed: false };
      }
      if (existing.status === "succeeded") {
        throw new ServerError(
          "SERVER_DEPLOYMENT_EXISTS",
          `target ${this.targetId} was already deployed successfully; v0.1 supports first deployment only`,
          { targetId: this.targetId, commitSha: existing.commitSha },
        );
      }
      if (existing.status === "running") {
        throw new ServerError(
          "SERVER_DEPLOYMENT_IN_PROGRESS",
          `target ${this.targetId} already has a deployment in progress`,
          { targetId: this.targetId },
        );
      }
      if (existing.commitSha !== normalizedSha) {
        throw new ServerError(
          "SERVER_DEPLOYMENT_REF_MISMATCH",
          `failed deployment for ${this.targetId} can only resume commit ${existing.commitSha}`,
          { expected: existing.commitSha, received: normalizedSha },
        );
      }
      const resumed: DeploymentState = {
        ...existing,
        status: "running",
        attempt: existing.attempt + 1,
        updatedAt: timestamp,
      };
      await this.write(resumed);
      return { state: resumed, resumed: true };
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
