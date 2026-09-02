export * from "./errors.js";
export * from "./version.js";
export * from "./manifest.js";
export * from "./validation.js";
export * from "./plan.js";
export * from "./project-validation.js";
export * from "./package-manager.js";
export * from "./generators/index.js";
export * from "./advisor/index.js";
export * from "./server/index.js";

/**
 * The one-file deployment contract.
 *
 * These are the shapes, digests, and failure vocabulary a consumer needs to
 * read `deploykit deploy --json`, validate a `deploykit.config.yaml`, or
 * compile one into the secret-free runtime manifest a VPS actually executes.
 *
 * The orchestrator's composition root, its GitHub/SSH/gateway adapters, and its
 * operation store are deliberately absent. Running a deployment is what the CLI
 * is for; half-wiring one from a library is not a supported way to reach a
 * production host.
 */
export * from "./orchestrator/contracts.js";
export * from "./orchestrator/failures.js";
export * from "./orchestrator/config.js";
export type {
  OrchestratorResult,
  OrchestratorProgressEvent,
  OrchestratorProgressPhase,
  GitHubRepositoryFacts,
  LegacyRunnerFacts,
  LegacyRunnerRetirement,
} from "./orchestrator/dependencies.js";
