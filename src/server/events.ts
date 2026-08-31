import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { SecretRedactor } from "./secrets.js";
import type { ServerDeploymentPhase } from "./state.js";

export type DeploymentEventCode =
  | "SERVER_DEPLOYMENT_STARTED"
  | "SERVER_PHASE_STARTED"
  | "SERVER_PHASE_SKIPPED"
  | "SERVER_PHASE_COMPLETED"
  | "SERVER_DEPLOYMENT_FAILED"
  | "SERVER_DEPLOYMENT_SUCCEEDED";

export interface DeploymentEvent {
  readonly time: string;
  readonly level: "info" | "error";
  readonly code: DeploymentEventCode;
  readonly targetId: string;
  readonly phase: ServerDeploymentPhase | "starting";
  readonly message: string;
  readonly data?: unknown;
}

export class DeploymentEventLogger {
  constructor(
    private readonly file: string,
    private readonly targetId: string,
    private readonly redactor: SecretRedactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write(
    level: DeploymentEvent["level"],
    code: DeploymentEventCode,
    phase: DeploymentEvent["phase"],
    message: string,
    data?: unknown,
  ): Promise<void> {
    const event: DeploymentEvent = {
      time: this.now().toISOString(),
      level,
      code,
      targetId: this.targetId,
      phase,
      message: this.redactor.redactText(message),
      ...(data === undefined ? {} : { data: this.redactor.redact(data) }),
    };
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(this.file, 0o600);
  }
}
