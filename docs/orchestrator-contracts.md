# Orchestrator contracts (Phase 1)

Status: **frozen design contract, not implemented behavior.**

This file records the boundaries that [`orchestrator-implementation-plan.md`](orchestrator-implementation-plan.md) freezes in Phase 1. Nothing described here is reachable from the shipped CLI: `src/orchestrator/` contains type declarations and a failure catalog only, it is not exported from `src/index.ts`, and no code path in this phase performs a network request, an SSH connection, or a filesystem mutation.

The authoritative definitions live in:

- `src/orchestrator/contracts.ts` — versioned shapes, canonical key order, and protocol limits.
- `src/orchestrator/dependencies.ts` — dependency-injected ports for GitHub, administrator SSH, gateway transport, config filesystem, operation state, clock, and output.
- `src/orchestrator/failures.ts` — the stable `DK_*` failure and recovery catalog reproduced below.
- `test/fixtures/orchestrator/` — protocol, ownership, state, and config examples with their expected failures.

`test/orchestrator-contracts.test.ts` pins a SHA-256 digest over the whole contract surface, so any edit to a version string, key order, limit, recovery instruction, or failure entry fails the suite until it is made deliberately.

## Versioned shapes

| Contract | API version | Declared in |
| --- | --- | --- |
| Local operator config | `deploykit/config/v1alpha1` | `DeployKitOperatorConfig` |
| Compiled runtime manifest | `deploykit/runtime/v1alpha1` | `CompiledRuntimeManifest` |
| Manifest digest | `deploykit/digest/v1alpha1` | `ManifestDigest` |
| Gateway protocol | `deploykit/gateway/v1alpha1` | `GatewayInputFrame`, `GatewayOutputFrame` |
| Root-owned gateway binding | `deploykit/gateway-binding/v1alpha1` | `RootOwnedGatewayBinding` |
| Deployment state identity | `deploykit/deployment-identity/v1alpha1` | `DeploymentStateIdentity` |
| GitHub ownership marker | `deploykit/github-ownership/v1alpha1` | `GitHubOwnershipMarker` |
| Local operation record | `deploykit/operation/v1alpha1` | `LocalOperationRecord` |

Only the operator config and the transient gateway secret frames may carry secret values. Every other contract carries secret **names** and public values.

## Canonicalization and identity

Runtime-manifest bytes are canonicalized under `deploykit/runtime-yaml-canonical/v1`: UTF-8 YAML 1.2, two-space indentation, LF endings, one trailing LF, no aliases, tags, or comments, keys emitted in frozen contract order followed by remaining keys in ascending code-point order, and array ordering supplied by the manifest contract itself.

The manifest digest is the SHA-256 of exactly those bytes. A deployment identity is the triple (target ID, full 40-character lower-case commit SHA, manifest digest). Two configs that differ only in a backend secret **value** compile to identical manifest bytes and therefore to the same digest; that property is what makes a resume safe.

Protocol frames are canonical UTF-8 JSON Lines. Each line serializes its object keys in the frozen order from `CONTRACT_KEY_ORDER`, then any remaining keys in ascending code-point order, with no insignificant whitespace and one trailing LF per frame. Binary-safe payloads use canonical base64 whose re-encoding is byte-identical to the transmitted string.

## Protocol limits

Every bound is frozen in `GATEWAY_PROTOCOL_LIMITS`; the gateway must fail closed rather than truncate.

| Bound | Value |
| --- | --- |
| Request frame | 32 KiB |
| Manifest payload | 2 MiB |
| Secret frames | 256 |
| Secret name | 128 bytes |
| Secret value | 256 KiB |
| Total secret payload | 8 MiB |
| Any single frame | 3 MiB |
| Whole input stream | 12 MiB |
| Progress event | 64 KiB |
| Progress events | 10 000 |
| Result frame | 256 KiB |

## Failure and recovery catalog

Later phases must raise exactly these codes at these boundaries. `Mutation` states what a caller may assume about external state at the moment the failure is reported: `none` forbids any remote or runtime write before the refusal, `owned-only` permits reconciliation of DeployKit-owned resources, and `runtime` means a deployment phase may already have mutated the VPS.

| Code | Boundary | Meaning | Recovery | Mutation | Exit |
| --- | --- | --- | --- | --- | --- |
| `DK_CONFIG_SCAFFOLDED` | config-filesystem | deploykit.config.yaml was created from the bundled example and still needs operator values. | `edit-config-and-rerun` | none | 2 |
| `DK_CONFIG_INSECURE` | config-filesystem | The config is a symlink, has the wrong owner or mode, or is tracked, staged, or not Git-ignored. | `secure-config-and-rerun` | none | 3 |
| `DK_CONFIG_INVALID` | config-schema | The config failed strict schema or semantic validation. | `edit-config-and-rerun` | none | 3 |
| `DK_CONFIG_PLACEHOLDER` | config-schema | The config still contains bundled example placeholder values. | `edit-config-and-rerun` | none | 3 |
| `DK_GITHUB_AUTH_REQUIRED` | github-identity | The GitHub CLI is not authenticated for the configured repository. | `reauthenticate-github-and-rerun` | none | 4 |
| `DK_GITHUB_PERMISSION_DENIED` | github-identity | The authenticated actor lacks a permission required for contents, workflows, environments, deploy keys, or pull requests. | `reauthenticate-github-and-rerun` | none | 4 |
| `DK_GITHUB_API_FAILED` | github-identity | A bounded GitHub request failed or returned an unparsable response. | `rerun-same-command` | owned-only | 1 |
| `DK_GITHUB_RATE_LIMITED` | github-identity | GitHub rate limiting stopped the run before the next reconciliation step. | `wait-and-rerun` | owned-only | 9 |
| `DK_REF_NOT_FOUND` | commit-resolution | The configured ref does not resolve to a commit in the bound repository. | `edit-config-and-rerun` | none | 4 |
| `DK_REF_MOVED` | commit-resolution | The ref changed between freezing and verification, so the frozen commit SHA is no longer authoritative. | `rerun-same-command` | owned-only | 1 |
| `DK_SETUP_PR_REVIEW_REQUIRED` | control-artifacts | The managed workflow, runtime manifest, and ownership marker are not yet merged into the protected default branch. | `review-setup-pull-request` | owned-only | 9 |
| `DK_CONTROL_ARTIFACTS_DRIFTED` | control-artifacts | Default-branch control artifacts no longer match the bytes DeployKit expects. | `rerun-same-command` | owned-only | 1 |
| `DK_OWNERSHIP_CONFLICT` | control-artifacts | A branch, file, deploy key, Environment value, port, or domain exists that DeployKit does not own. | `resolve-ownership-conflict` | none | 4 |
| `DK_SSH_UNREACHABLE` | administrator-ssh | The VPS did not accept an administrator SSH connection. | `repair-vps-and-rerun` | none | 4 |
| `DK_SSH_HOST_KEY_MISMATCH` | administrator-ssh | The presented VPS host key does not match the pinned fingerprint. | `verify-ssh-host-key-and-rerun` | none | 4 |
| `DK_GATEWAY_BOOTSTRAP_FAILED` | gateway-bootstrap | Gateway user, binding, bundle, or handshake installation did not complete. | `repair-vps-and-rerun` | owned-only | 1 |
| `DK_GATEWAY_BINDING_MISMATCH` | gateway-protocol | The root-owned binding names a different repository, Environment, target, or target ID than the request. | `resolve-ownership-conflict` | none | 4 |
| `DK_GATEWAY_PROTOCOL_INVALID` | gateway-protocol | A frame was malformed, noncanonical, oversized, duplicated, undeclared, truncated, or trailing. | `not-resumable` | none | 1 |
| `DK_GATEWAY_VERSION_MISMATCH` | gateway-protocol | The client and gateway disagree on the frozen protocol version. | `rerun-same-command` | none | 8 |
| `DK_SECRET_MISSING` | gateway-protocol | A secret declared by the runtime manifest was not supplied in the request stream. | `rerun-same-command` | none | 6 |
| `DK_KEY_ROTATION_FAILED` | key-lifecycle | A staged or active DeployKit-owned key entry could not be proven, so rotation stopped with the last verified key intact. | `rerun-same-command` | owned-only | 1 |
| `DK_ENVIRONMENT_CONFLICT` | github-environment | The target Environment holds a conflicting value DeployKit has not marked as owned. | `resolve-ownership-conflict` | owned-only | 4 |
| `DK_ENVIRONMENT_APPROVAL_REQUIRED` | github-environment | The protected Environment is waiting on reviewers or a wait timer. | `wait-and-rerun` | owned-only | 9 |
| `DK_DISPATCH_NOT_READY` | dispatch | A readiness fact could not be freshly reverified, so no workflow was dispatched. | `rerun-same-command` | owned-only | 1 |
| `DK_WORKFLOW_RUN_NOT_FOUND` | workflow-run | The dispatched run for this request UUID has not appeared or has not been correlated yet. | `wait-and-rerun` | owned-only | 9 |
| `DK_WORKFLOW_RUN_FAILED` | workflow-run | The correlated workflow run finished without success. | `rerun-same-command` | runtime | 1 |
| `DK_SOURCE_UNVERIFIED` | source-retrieval | The retrieved source is not the frozen commit of the bound repository, or the object is not a commit. | `not-resumable` | none | 1 |
| `DK_SOURCE_UNSAFE` | source-retrieval | The source contains a gitlink, submodule, escaping symlink, or hostile Git configuration. | `not-resumable` | none | 1 |
| `DK_IDENTITY_MISMATCH` | deployment-identity | Existing deployment state was recorded for a different commit SHA or manifest digest. | `restore-same-sha-and-digest` | none | 4 |
| `DK_STATE_LEGACY` | deployment-identity | Failed or running state predates manifest-digest binding and cannot be resumed automatically. | `migrate-legacy-state` | none | 4 |
| `DK_ALREADY_DEPLOYED` | deployment-identity | The target already completed its first deployment, so no further apply is accepted. | `not-resumable` | none | 5 |
| `DK_PREFLIGHT_FAILED` | deployment-identity | A server-side preflight gate such as direct DNS verification refused the deployment. | `edit-config-and-rerun` | none | 4 |
| `DK_CONFLICT` | deployment-identity | A port, domain, or deployment lock is held by another owner. | `wait-and-rerun` | none | 4 |
| `DK_DEPLOYMENT_FAILED` | deployment-identity | An ordered deployment phase failed on the VPS after runtime mutation began. | `rerun-same-command` | runtime | 1 |
| `DK_OPERATION_STATE_INVALID` | operation-state | The local operation record is unreadable or does not match its frozen shape; authoritative GitHub and VPS state remain the source of truth. | `rerun-same-command` | owned-only | 1 |

### Recovery actions

| Recovery | Resume instruction |
| --- | --- |
| `edit-config-and-rerun` | Correct the reported values in deploykit.config.yaml, then run the same deploykit deploy command again. |
| `secure-config-and-rerun` | Make deploykit.config.yaml a regular file owned by you with mode 0600, keep it untracked, unstaged, and Git-ignored inside the repository, then run the same command again. |
| `rerun-same-command` | Run the same deploykit deploy command again. DeployKit re-reads authoritative GitHub and VPS state and resumes from the last verified checkpoint. |
| `review-setup-pull-request` | Review and merge the DeployKit setup pull request on the protected default branch, then run the same command again. |
| `wait-and-rerun` | Wait for the pending approval, rate-limit window, lock, or workflow run to settle, then run the same command again. |
| `resolve-ownership-conflict` | Inspect the conflicting resource and either remove it yourself or choose a different name in deploykit.config.yaml. DeployKit never overwrites a resource it does not own. |
| `restore-same-sha-and-digest` | Resume the failed deployment with its original commit SHA and runtime-manifest digest, or clear the failed target on the VPS before deploying a different identity. |
| `migrate-legacy-state` | Run the documented legacy state migration for this target, or start from a clean target. DeployKit never guesses the identity of pre-digest state. |
| `repair-vps-and-rerun` | Restore administrator SSH access and gateway health on the VPS, then run the same command again. |
| `reauthenticate-github-and-rerun` | Authenticate the GitHub CLI with an account holding the required repository permissions, then run the same command again. |
| `verify-ssh-host-key-and-rerun` | Verify the VPS host key out of band and update server.hostKeyFingerprint in deploykit.config.yaml before running the command again. |
| `not-resumable` | This request cannot be resumed. Correct the reported input or conflict and start a new deployment attempt. |
| `none` | No action is required. |

## Fixtures

`test/fixtures/orchestrator/expectations.json` binds every hostile fixture to exactly one code and recovery from the table above. The suite refuses an expectation naming an unknown code, a recovery that disagrees with the catalog, an invalid fixture with no matching expectation, and a hostile fixture that turns out to satisfy the contract.

| Directory | Contents |
| --- | --- |
| `protocol/valid/` | handshake, inspect, apply, retry, dry-run input streams, and success, failure, and handshake output streams |
| `protocol/invalid/` | unsupported version, malformed JSON, noncanonical key order and base64, oversized frame, truncated stream, trailing frame, duplicate and undeclared secrets, digest and byte-length mismatch, unknown operation and key, invalid SHA and request UUID, oversized secret name, payload on a non-mutating operation, declared-count mismatch, binding substitution, and progress-sequence regression |
| `binding/valid/` | the root-owned gateway binding that protocol requests may only confirm |
| `ownership/` | a valid GitHub ownership marker plus foreign owner, target-ID mismatch, application-file claim, secret value in a secret-free marker, and workflow-digest drift |
| `state/` | a valid deployment identity and operation record plus SHA mismatch, digest mismatch, legacy pre-digest state, completed reapply, a record carrying a secret, and an unknown status |
| `config/invalid/` | unknown key, non-string environment value, reserved `DEPLOYKIT_` prefix, duplicate name across partitions, secret-like public frontend name, ambiguous routes, unresolved route target, bad host-key fingerprint, traversal in the ref, escaping working directory, and unreplaced placeholders |

The three complete topologies used by the acceptance matrix live beside them in `test/fixtures/static-compose/`, `test/fixtures/pm2-compose-db/`, and `test/fixtures/container-external/`.

Secret material in fixtures is synthetic. Every value is a `DK_CANARY_*` string, and the suite asserts that a canary appears only in the fixtures that deliberately demonstrate a leak, and never in `src/`, `docs/`, or `assets/`.
