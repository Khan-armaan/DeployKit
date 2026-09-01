import type { ErrorCode, OrchestratorErrorCode } from "../errors.js";

import type { RecoveryAction } from "./contracts.js";

/**
 * Phase 1 freezes the stable failure vocabulary for every orchestration trust
 * boundary. This module is a declarative catalog: it throws nothing, performs
 * no I/O, and is not reachable from the current CLI. Later phases must raise
 * exactly these codes and must not invent boundary-specific variants.
 */

export const FAILURE_CATALOG_API_VERSION = "deploykit/failures/v1alpha1" as const;

/** Each boundary owns at least one frozen failure. */
export type OrchestratorBoundary =
  | "config-filesystem"
  | "config-schema"
  | "github-identity"
  | "commit-resolution"
  | "control-artifacts"
  | "administrator-ssh"
  | "gateway-bootstrap"
  | "gateway-protocol"
  | "key-lifecycle"
  | "github-environment"
  | "dispatch"
  | "workflow-run"
  | "source-retrieval"
  | "deployment-identity"
  | "operation-state";

export const ORCHESTRATOR_BOUNDARIES: readonly OrchestratorBoundary[] = Object.freeze([
  "config-filesystem",
  "config-schema",
  "github-identity",
  "commit-resolution",
  "control-artifacts",
  "administrator-ssh",
  "gateway-bootstrap",
  "gateway-protocol",
  "key-lifecycle",
  "github-environment",
  "dispatch",
  "workflow-run",
  "source-retrieval",
  "deployment-identity",
  "operation-state",
] as const);

/**
 * What a caller may assume about external state when the failure is reported.
 * `none` forbids any remote or runtime write before the refusal, `owned-only`
 * permits reconciliation of DeployKit-owned resources, and `runtime` means a
 * deployment phase may already have mutated the VPS.
 */
export type MutationBoundary = "none" | "owned-only" | "runtime";

export interface OrchestratorFailureContract {
  readonly code: ErrorCode;
  readonly boundary: OrchestratorBoundary;
  readonly summary: string;
  readonly recovery: RecoveryAction;
  readonly mutationBoundary: MutationBoundary;
}

/** Operator-facing resume instruction for each recovery action. */
export const RECOVERY_INSTRUCTIONS: Readonly<Record<RecoveryAction, string>> = Object.freeze({
  "edit-config-and-rerun":
    "Correct the reported values in deploykit.config.yaml, then run the same deploykit deploy command again.",
  "secure-config-and-rerun":
    "Make deploykit.config.yaml a regular file owned by you with mode 0600, keep it untracked, unstaged, and Git-ignored inside the repository, then run the same command again.",
  "rerun-same-command":
    "Run the same deploykit deploy command again. DeployKit re-reads authoritative GitHub and VPS state and resumes from the last verified checkpoint.",
  "review-setup-pull-request":
    "Review and merge the DeployKit setup pull request on the protected default branch, then run the same command again.",
  "wait-and-rerun":
    "Wait for the pending approval, rate-limit window, lock, or workflow run to settle, then run the same command again.",
  "resolve-ownership-conflict":
    "Inspect the conflicting resource and either remove it yourself or choose a different name in deploykit.config.yaml. DeployKit never overwrites a resource it does not own.",
  "restore-same-sha-and-digest":
    "Resume the failed deployment with its original commit SHA and runtime-manifest digest, or clear the failed target on the VPS before deploying a different identity.",
  "migrate-legacy-state":
    "Run the documented legacy state migration for this target, or start from a clean target. DeployKit never guesses the identity of pre-digest state.",
  "repair-vps-and-rerun":
    "Restore administrator SSH access and gateway health on the VPS, then run the same command again.",
  "reauthenticate-github-and-rerun":
    "Authenticate the GitHub CLI with an account holding the required repository permissions, then run the same command again.",
  "verify-ssh-host-key-and-rerun":
    "Verify the VPS host key out of band and update server.hostKeyFingerprint in deploykit.config.yaml before running the command again.",
  "not-resumable":
    "This request cannot be resumed. Correct the reported input or conflict and start a new deployment attempt.",
  none: "No action is required.",
} as const);

function failure(
  boundary: OrchestratorBoundary,
  code: ErrorCode,
  summary: string,
  recovery: RecoveryAction,
  mutationBoundary: MutationBoundary,
): OrchestratorFailureContract {
  return Object.freeze({ code, boundary, summary, recovery, mutationBoundary });
}

/**
 * Keyed by code so TypeScript refuses a missing or unknown orchestrator
 * failure. Order here is the frozen catalog order used by documentation and
 * snapshots.
 */
export const ORCHESTRATOR_FAILURES: Readonly<
  Record<OrchestratorErrorCode, OrchestratorFailureContract>
> = Object.freeze({
  DK_CONFIG_SCAFFOLDED: failure(
    "config-filesystem",
    "DK_CONFIG_SCAFFOLDED",
    "deploykit.config.yaml was created from the bundled example and still needs operator values.",
    "edit-config-and-rerun",
    "none",
  ),
  DK_CONFIG_INSECURE: failure(
    "config-filesystem",
    "DK_CONFIG_INSECURE",
    "The config is a symlink, has the wrong owner or mode, or is tracked, staged, or not Git-ignored.",
    "secure-config-and-rerun",
    "none",
  ),
  DK_CONFIG_INVALID: failure(
    "config-schema",
    "DK_CONFIG_INVALID",
    "The config failed strict schema or semantic validation.",
    "edit-config-and-rerun",
    "none",
  ),
  DK_CONFIG_PLACEHOLDER: failure(
    "config-schema",
    "DK_CONFIG_PLACEHOLDER",
    "The config still contains bundled example placeholder values.",
    "edit-config-and-rerun",
    "none",
  ),
  DK_GITHUB_AUTH_REQUIRED: failure(
    "github-identity",
    "DK_GITHUB_AUTH_REQUIRED",
    "The GitHub CLI is not authenticated for the configured repository.",
    "reauthenticate-github-and-rerun",
    "none",
  ),
  DK_GITHUB_PERMISSION_DENIED: failure(
    "github-identity",
    "DK_GITHUB_PERMISSION_DENIED",
    "The authenticated actor lacks a permission required for contents, workflows, environments, deploy keys, or pull requests.",
    "reauthenticate-github-and-rerun",
    "none",
  ),
  DK_GITHUB_API_FAILED: failure(
    "github-identity",
    "DK_GITHUB_API_FAILED",
    "A bounded GitHub request failed or returned an unparsable response.",
    "rerun-same-command",
    "owned-only",
  ),
  DK_GITHUB_RATE_LIMITED: failure(
    "github-identity",
    "DK_GITHUB_RATE_LIMITED",
    "GitHub rate limiting stopped the run before the next reconciliation step.",
    "wait-and-rerun",
    "owned-only",
  ),
  DK_REF_NOT_FOUND: failure(
    "commit-resolution",
    "DK_REF_NOT_FOUND",
    "The configured ref does not resolve to a commit in the bound repository.",
    "edit-config-and-rerun",
    "none",
  ),
  DK_REF_MOVED: failure(
    "commit-resolution",
    "DK_REF_MOVED",
    "The ref changed between freezing and verification, so the frozen commit SHA is no longer authoritative.",
    "rerun-same-command",
    "owned-only",
  ),
  DK_SETUP_PR_REVIEW_REQUIRED: failure(
    "control-artifacts",
    "DK_SETUP_PR_REVIEW_REQUIRED",
    "The managed workflow, runtime manifest, and ownership marker are not yet merged into the protected default branch.",
    "review-setup-pull-request",
    "owned-only",
  ),
  DK_CONTROL_ARTIFACTS_DRIFTED: failure(
    "control-artifacts",
    "DK_CONTROL_ARTIFACTS_DRIFTED",
    "Default-branch control artifacts no longer match the bytes DeployKit expects.",
    "rerun-same-command",
    "owned-only",
  ),
  DK_OWNERSHIP_CONFLICT: failure(
    "control-artifacts",
    "DK_OWNERSHIP_CONFLICT",
    "A branch, file, deploy key, Environment value, port, or domain exists that DeployKit does not own.",
    "resolve-ownership-conflict",
    "none",
  ),
  DK_SSH_UNREACHABLE: failure(
    "administrator-ssh",
    "DK_SSH_UNREACHABLE",
    "The VPS did not accept an administrator SSH connection.",
    "repair-vps-and-rerun",
    "none",
  ),
  DK_SSH_HOST_KEY_MISMATCH: failure(
    "administrator-ssh",
    "DK_SSH_HOST_KEY_MISMATCH",
    "The presented VPS host key does not match the pinned fingerprint.",
    "verify-ssh-host-key-and-rerun",
    "none",
  ),
  DK_GATEWAY_BOOTSTRAP_FAILED: failure(
    "gateway-bootstrap",
    "DK_GATEWAY_BOOTSTRAP_FAILED",
    "Gateway user, binding, bundle, or handshake installation did not complete.",
    "repair-vps-and-rerun",
    "owned-only",
  ),
  DK_GATEWAY_BINDING_MISMATCH: failure(
    "gateway-protocol",
    "DK_GATEWAY_BINDING_MISMATCH",
    "The root-owned binding names a different repository, Environment, target, or target ID than the request.",
    "resolve-ownership-conflict",
    "none",
  ),
  DK_GATEWAY_PROTOCOL_INVALID: failure(
    "gateway-protocol",
    "DK_GATEWAY_PROTOCOL_INVALID",
    "A frame was malformed, noncanonical, oversized, duplicated, undeclared, truncated, or trailing.",
    "not-resumable",
    "none",
  ),
  DK_GATEWAY_VERSION_MISMATCH: failure(
    "gateway-protocol",
    "DK_GATEWAY_VERSION_MISMATCH",
    "The client and gateway disagree on the frozen protocol version.",
    "rerun-same-command",
    "none",
  ),
  DK_KEY_ROTATION_FAILED: failure(
    "key-lifecycle",
    "DK_KEY_ROTATION_FAILED",
    "A staged or active DeployKit-owned key entry could not be proven, so rotation stopped with the last verified key intact.",
    "rerun-same-command",
    "owned-only",
  ),
  DK_ENVIRONMENT_CONFLICT: failure(
    "github-environment",
    "DK_ENVIRONMENT_CONFLICT",
    "The target Environment holds a conflicting value DeployKit has not marked as owned.",
    "resolve-ownership-conflict",
    "owned-only",
  ),
  DK_ENVIRONMENT_APPROVAL_REQUIRED: failure(
    "github-environment",
    "DK_ENVIRONMENT_APPROVAL_REQUIRED",
    "The protected Environment is waiting on reviewers or a wait timer.",
    "wait-and-rerun",
    "owned-only",
  ),
  DK_DISPATCH_NOT_READY: failure(
    "dispatch",
    "DK_DISPATCH_NOT_READY",
    "A readiness fact could not be freshly reverified, so no workflow was dispatched.",
    "rerun-same-command",
    "owned-only",
  ),
  DK_WORKFLOW_RUN_NOT_FOUND: failure(
    "workflow-run",
    "DK_WORKFLOW_RUN_NOT_FOUND",
    "The dispatched run for this request UUID has not appeared or has not been correlated yet.",
    "wait-and-rerun",
    "owned-only",
  ),
  DK_WORKFLOW_RUN_FAILED: failure(
    "workflow-run",
    "DK_WORKFLOW_RUN_FAILED",
    "The correlated workflow run finished without success.",
    "rerun-same-command",
    "runtime",
  ),
  DK_SOURCE_UNVERIFIED: failure(
    "source-retrieval",
    "DK_SOURCE_UNVERIFIED",
    "The retrieved source is not the frozen commit of the bound repository, or the object is not a commit.",
    "not-resumable",
    "none",
  ),
  DK_SOURCE_UNSAFE: failure(
    "source-retrieval",
    "DK_SOURCE_UNSAFE",
    "The source contains a gitlink, submodule, escaping symlink, or hostile Git configuration.",
    "not-resumable",
    "none",
  ),
  DK_IDENTITY_MISMATCH: failure(
    "deployment-identity",
    "DK_IDENTITY_MISMATCH",
    "Existing deployment state was recorded for a different commit SHA or manifest digest.",
    "restore-same-sha-and-digest",
    "none",
  ),
  DK_STATE_LEGACY: failure(
    "deployment-identity",
    "DK_STATE_LEGACY",
    "Failed or running state predates manifest-digest binding and cannot be resumed automatically.",
    "migrate-legacy-state",
    "none",
  ),
  DK_OPERATION_STATE_INVALID: failure(
    "operation-state",
    "DK_OPERATION_STATE_INVALID",
    "The local operation record is unreadable or does not match its frozen shape; authoritative GitHub and VPS state remain the source of truth.",
    "rerun-same-command",
    "owned-only",
  ),
} as const);

/**
 * Pre-existing codes that orchestration boundaries reuse instead of
 * duplicating. Their messages and exit codes are unchanged by Phase 1.
 */
export const REUSED_FAILURES: readonly OrchestratorFailureContract[] = Object.freeze([
  failure(
    "deployment-identity",
    "DK_ALREADY_DEPLOYED",
    "The target already completed its first deployment, so no further apply is accepted.",
    "not-resumable",
    "none",
  ),
  failure(
    "gateway-protocol",
    "DK_SECRET_MISSING",
    "A secret declared by the runtime manifest was not supplied in the request stream.",
    "rerun-same-command",
    "none",
  ),
  failure(
    "deployment-identity",
    "DK_PREFLIGHT_FAILED",
    "A server-side preflight gate such as direct DNS verification refused the deployment.",
    "edit-config-and-rerun",
    "none",
  ),
  failure(
    "deployment-identity",
    "DK_CONFLICT",
    "A port, domain, or deployment lock is held by another owner.",
    "wait-and-rerun",
    "none",
  ),
  failure(
    "deployment-identity",
    "DK_DEPLOYMENT_FAILED",
    "An ordered deployment phase failed on the VPS after runtime mutation began.",
    "rerun-same-command",
    "runtime",
  ),
] as const);

/** Every frozen boundary failure, orchestrator-specific first. */
export const FAILURE_CONTRACTS: readonly OrchestratorFailureContract[] = Object.freeze([
  ...Object.values(ORCHESTRATOR_FAILURES),
  ...REUSED_FAILURES,
]);

export function orchestratorFailure(code: OrchestratorErrorCode): OrchestratorFailureContract {
  return ORCHESTRATOR_FAILURES[code];
}

/** Lookup across orchestrator-specific and reused codes. */
export function failureContract(code: ErrorCode): OrchestratorFailureContract | undefined {
  return FAILURE_CONTRACTS.find((entry) => entry.code === code);
}

export function recoveryInstruction(recovery: RecoveryAction): string {
  return RECOVERY_INSTRUCTIONS[recovery];
}

export function isOrchestratorErrorCode(code: ErrorCode): code is OrchestratorErrorCode {
  return Object.hasOwn(ORCHESTRATOR_FAILURES, code);
}

/** Failures raised for each boundary, in frozen catalog order. */
export function failuresForBoundary(
  boundary: OrchestratorBoundary,
): readonly OrchestratorFailureContract[] {
  return FAILURE_CONTRACTS.filter((entry) => entry.boundary === boundary);
}
