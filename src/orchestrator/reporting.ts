import type { Reporter } from "../output.js";
import type {
  ClockPort,
  OrchestratorProgressEvent,
  OrchestratorResult,
  OutputPort,
} from "./dependencies.js";

/**
 * Phase 12: the clock and the operator-facing output boundary.
 *
 * Both are trivial on purpose. Every value that reaches an operator passes
 * through {@link Reporter}, which is where redaction already lives, so this
 * module adds no formatting of its own that could quote a value the redactor
 * has not seen.
 */

export const systemClock: ClockPort = {
  now(): Date {
    return new Date();
  },
  async sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((done) => {
      setTimeout(done, milliseconds);
    });
  },
};

export const ORCHESTRATOR_RESULT_CODE = "DK_DEPLOY_RESULT";

export function createOrchestratorOutput(reporter: Reporter): OutputPort {
  return {
    progress(event: OrchestratorProgressEvent): void {
      reporter.event(event.level === "warning" ? "warn" : "info", event.code, event.message, {
        phase: event.phase,
      });
    },
    result(result: OrchestratorResult): void {
      // `config-created` and `waiting-for-review` are reported through a thrown
      // failure too, so neither is an `ok` result: each one means the operator
      // still has something to do before a deployment can happen.
      reporter.result(ORCHESTRATOR_RESULT_CODE, result, {
        ok: result.outcome === "succeeded" || result.outcome === "dispatched" || result.outcome === "dry-run",
      });
    },
  };
}
