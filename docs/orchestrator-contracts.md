# Orchestrator contracts (Phase 1)

Status: **frozen design contract, not implemented behavior.**

This file records the boundaries that [`orchestrator-implementation-plan.md`](orchestrator-implementation-plan.md) freezes in Phase 1. `src/orchestrator/` is still not exported from `src/index.ts`, and no orchestration code path performs a network request or an SSH connection.

Phase 2 made the catalog's first four rows real. The `config-filesystem` and `config-schema` boundaries are now raised by bare `deploykit deploy`, and each failure carries its frozen recovery action and resume instruction in the error details. Every other row below remains a design contract until the phase that owns it lands.

Phase 3 made the compiled runtime manifest, its canonicalization, and its digest real. `src/orchestrator/compile.ts` produces `CompiledRuntimeManifest` values, `src/orchestrator/canonical.ts` serializes them under `deploykit/runtime-yaml-canonical/v1` and digests those exact bytes, and `test/orchestrator-compile.test.ts` asserts that compiling `test/fixtures/static-compose/deploykit.config.fixture.yaml` reproduces the manifest frame in `protocol/valid/apply.jsonl` byte for byte — payload, byte length, and digest. `RuntimeServiceFrontend` additionally carries `publicEnvironment`, because a containerized or server-rendered frontend needs the same public build values a static one does; the field is nested under the frozen `frontend` key and does not change `CONTRACT_KEY_ORDER`.

Phase 4 made the dependency-injected ports real. `src/orchestrator/deploy.ts` drives the whole sequence — secure config load and compile, local and remote preflight, exact commit resolution, control-artifact readiness, gateway readiness, repository-key readiness, Environment readiness, a final readiness recheck, dispatch and run correlation, wait, inspect, and report — entirely through `OrchestratorDependencies`. It raises only codes from the catalog below, emits `OrchestratorProgressEvent`s, and returns an `OrchestratorResult`; `test/orchestrator-deploy.test.ts` exercises it with reconciling fakes only. A scaffolded config reports the `config-created` outcome, a pending setup pull request or Environment approval reports `waiting-for-review`, and every other failure reports `failed`.

`src/orchestrator/planner.ts` computes the desired state each inspection is compared against. Managed branch, pull-request, and deploy-key names are keyed by target ID rather than by the operator's target name, so renaming a target in the config cannot claim another target's resources. A gateway binding is compared through `gatewayBindingIdentityDigest`, which covers identity, forced command, runtime version, and bundle digest but excludes the host-owned key identifiers and fingerprints, so a key rotation never reads as a binding mismatch.

The `LocalOperationRecord` is explicitly non-authoritative. An unreadable, malformed, or foreign record is discarded with an operation-state warning and the run continues from GitHub and VPS state; a dispatch is skipped whenever an existing run correlates by request UUID or by deployment identity, so losing the record cannot produce a duplicate run.

Phase 5 made `DeploymentStateIdentity` and `GatewayDeploymentResult` real on the server. `src/server/state.ts` stores version-`2` deployment state whose identity is exactly the frozen triple, and `src/server/inspect.ts` builds the frozen deployment result — outcome, target, commit SHA, manifest digest, phase, domains, allocated ports, health, resume flag, and failure code — paired with the recovery action from the catalog below. `src/server/failures.ts` is the single translation from a `SERVER_*` runtime failure to that catalog, so the same code and the same resume instruction reach an operator through the local CLI and through the future gateway. `test/server-identity.test.ts` proves same-identity retry, different-SHA and different-digest refusal, completed-target refusal, pre-digest state handling, and crash recovery after every durable phase. The gateway protocol frames that will carry the result are still Phase 6's.

Phase 6 made the gateway protocol real. `src/gateway/protocol.ts` is the production parser the Phase 1 reference checker described: it enforces the trailing LF, every bound in the table below, the frozen key set and canonical key order of each frame, one request frame first and one end frame last with nothing after it, a single shared request UUID, and strictly increasing output sequence numbers ending in exactly one result frame. `src/gateway/runtime-manifest.ts` decodes the manifest payload into the frozen runtime shape and then refuses it unless re-serializing that value reproduces the received bytes exactly, which is what makes a digest taken over bytes meaningful on a second host. `test/gateway-protocol.test.ts` asserts that every `protocol/valid/` stream is accepted, that every `protocol/invalid/` stream is refused with exactly the code and recovery `expectations.json` names, and that no canary reaches an error, a detail, or the output stream.

Caller input confirms identity and never chooses it. `confirmGatewayBinding` compares the request *and* the manifest it carries against the root-owned binding, so binding substitution is reported as a binding mismatch rather than as a malformed frame. `src/gateway/invocation.ts` refuses a client-supplied command, extra arguments, a PTY, agent forwarding, and X11 forwarding before stdin is read at all, and `src/gateway/session.ts` turns every outcome into a bounded, redacted output stream whose result frame carries a catalog code, its recovery action, and the process exit code. The forced command is registered on the standalone server CLI as `deploykit gateway` with no options, no arguments, and no subcommands. Phase 7 owns exact-SHA source retrieval, so an installation without a verified source provider advertises only the non-mutating capabilities and refuses a mutating operation as an incomplete bootstrap.

Phase 7 made source retrieval real, so a gateway installation now advertises `apply` and `retry`. `src/gateway/source.ts` derives the SSH URL from the root-owned binding alone, runs Git with a constructed environment and a single permitted transport, and proves the frozen commit before anything is written. A ref that resolves to no commit, and a ref that has moved off the frozen commit, raise the two commit-resolution failures in the catalog below rather than new ones: the VPS is reverifying exactly the fact the local orchestrator froze, and an operator must see the same code and the same instruction wherever it was caught. Hostile content raises the source-retrieval failures instead — the unsafe-source code for a gitlink, a submodule declaration, a `.git` path, an escaping symlink, or an object Git's own fsck refuses, and the unverified-source code for an object that is not the frozen commit. A transport, authentication, or reachability failure is reported as a gateway-bootstrap failure, because a VPS that cannot reach its bound repository with its read-only identity has an incomplete installation rather than a bad source.

The retrieved tree is a plain directory with no `.git`, fetched into `/var/lib/deploykit/source/<target-id>/` — outside the immutable releases, the activated release link, and the target's configuration and state — and handed to the deployment engine as an explicit incoming root. Retrieval reserves no port or domain, creates no release, starts no workload, and writes no Nginx, certificate, or activation. The GitHub host keys it pins are the frozen `assets/github-known-hosts` asset, and `test/gateway-source.test.ts` asserts the packaged bytes and the compiled-in pin are the same keys.

Phase 8 put those paths on a host. `assets/bootstrap.sh` no longer enrolls an Actions runner; it writes the root-owned binding, the root-owned host facts at `/etc/deploykit/gateway/host.json`, the pinned host keys, and the stable mode-`0600` repository key that Phase 7's provider reads, and it installs the `deploykit-gateway` account whose single sudoers entry names one no-argument program. `src/orchestrator/administrator-ssh.ts` is the production `AdministratorSshPort`: it pins the VPS host key by fingerprint, speaks the frozen handshake request in the protocol table below over a real forced-command invocation, and treats the installer's own report as a claim to be verified rather than a fact.

Three failures in the catalog below become reachable from the local side here, and no new ones are invented. A host already bound to another repository, Environment, target, or binding id raises the gateway binding-mismatch failure — the installer exits with that code's frozen exit status and leaves the binding file untouched — and a host presenting a key other than the pinned one raises the administrator-SSH host-key failure before any data is sent. Staged and active gateway key entries are DeployKit-owned by comment marker alone, so a failed promotion raises the key-lifecycle failure with the last verified entry still in place, and no operator key or second target's entry is ever rewritten. `RuntimeBundleReference` and `GatewayBootstrapRequest` gained `packageName` so the installer compares the name it was handed with the name inside the tarball; nothing in `CONTRACT_KEY_ORDER` or any digest changed.

Phase 9 made the GitHub side typed and bounded without letting it write anything from a command. `src/orchestrator/github.ts` is the whole GitHub vocabulary the orchestrator is allowed to speak — repository metadata, authenticated identity and scopes, commits, contents, branches, pull requests, environments, variables, secrets, deploy keys, workflow dispatch, and workflow runs — spoken through the authenticated `gh` boundary. The credential never leaves that boundary: DeployKit does not run `gh auth token`, does not read a token from the environment, and does not copy one into an argument, a file, or a diagnostic, so an unauthenticated CLI is recognized from its own refusal rather than by inspecting what it holds. Every refusal is classified once — rate limiting ahead of permission, since GitHub answers both with 403 — and mapped to exactly one code already in the catalog below.

Reads and writes are deliberately asymmetric. A GET retries with deterministic backoff and reports DK_GITHUB_RATE_LIMITED only once the read budget is spent; a mutation is attempted exactly once, because `gh` cannot say whether a failed write landed and repeating it is how a second branch, pull request, or deploy key appears. Pagination is DeployKit's own rather than the installed CLI's, and a listing that runs past the frozen page ceiling fails closed instead of truncating: an unseen deploy key is precisely what would cause a duplicate. Responses are size-bounded before they are parsed, each field is read through a checked accessor, an unrecognized workflow-run status or conclusion is refused rather than coerced, and neither the response body nor the CLI's stderr is ever attached to a failure. Secret material reaches a child process on stdin alone.

`src/orchestrator/github-ownership.ts` decides what DeployKit may touch. A resource is DeployKit's only when the committed ownership document claims it, a managed name keyed by target id matches it, or it carries the reserved `DEPLOYKIT_` prefix the config schema forbids operators from using; everything else belongs to somebody and is refused rather than overwritten. Two deploy keys wearing DeployKit's title, a DeployKit key with write access, a foreign key holding the same public material, a pull request that redirected the setup branch, and an Environment value somebody else already set are all ambiguity, not drift. The marker parser keeps the two apart exactly as the catalog does: another tool's document, another target's identity, or a claim on a file outside the three managed paths is an ownership conflict a human resolves, while a moved digest or a name list that grew a value instead of a name is drift a rerun reconciles. Deploy keys are created read-only and a response that comes back writable is refused, and an Environment that already exists is returned untouched so its reviewers, wait timer, and branch policy survive every rerun. Nothing here is reachable from a command: `test/orchestrator-github.test.ts` drives all of it with a recording fake, and no production path constructs the client.

Phase 10 made the reviewed control plane real. `src/orchestrator/workflow.ts` renders `.github/workflows/deploykit.yml` as a pure function of the deployment context, and `assets/gateway-client.mjs` is the bounded client that workflow embeds verbatim through a quoted heredoc — so the code that will hold an operator's secrets is the code they merge, not something fetched at run time. There is no install step and one pinned third-party action addressed by commit SHA. `permissions` grants `contents: read`, the checkout does not persist credentials, concurrency is keyed by target id, and the staged key and `known_hosts` live in a mode-0700 directory under `RUNNER_TEMP` that is shredded in `always()`.

The workflow re-checks at run time everything it was rendered with. It refuses a ref that is not the protected default branch, a `github.repository` that is not the bound one, a dispatch aimed at another target, and an Environment whose `DEPLOYKIT_TARGET_ID` disagrees. Before a frame is sent, the client hashes the committed runtime manifest against the dispatched digest and the running workflow file against the digest the ownership marker recorded. Secret *names* come from that marker, never from the runner: the whole bundle arrives through `toJSON(secrets)` and only the declared operator secrets are framed, so the gateway key and the Actions token are never sent. Generated secrets are deliberately withheld — the VPS creates and preserves them, and a name DeployKit holds no value for would be a lie on the wire.

`src/orchestrator/control-artifacts.ts` compares bytes rather than claims. A managed path is DeployKit's only when the ownership marker sits beside it and names this deployment; a path occupied without that marker, a marker bound to another target, a redirected or retargeted setup pull request, and a setup branch carrying any change outside the three managed files are refused. Those refusals are raised rather than returned, because `ControlArtifactsState` has one `conflict` status and no room to say which resource and why; drift, which a rerun fixes, stays a status. The branch is verified before and after the writes, DeployKit never merges or approves for the operator, `--no-wait` stops resumably at DK_SETUP_PR_REVIEW_REQUIRED, and a merge is followed by an exact re-read of the default branch whose disagreement is DK_CONTROL_ARTIFACTS_DRIFTED. `GitHubClient` gained the bounded read-only `compareCommits` for that proof; a comparison that hits GitHub's 300-file ceiling fails closed rather than truncating. Environment synchronization and workflow dispatch remain unreachable.

Phase 11 established the two trust paths that cross the planes. `assets/gateway-source-probe.sh` proves from the VPS that the read-only repository key opens the bound repository and no other — GitHub greets a deploy key with `Hi owner/name!`, and any other identity is refused as an ownership conflict — and `src/orchestrator/administrator-ssh.ts` re-checks that identity rather than trusting the helper's word. `src/orchestrator/github-environment.ts` reconciles the deploy key and the target Environment: rotation is delete-then-create only after ownership is unambiguous, an existing Environment is read rather than PUT so reviewers, wait timers, and branch policies survive, and ownership is recorded on GitHub itself in four reserved-prefix variables — `DEPLOYKIT_MANAGED_VARIABLES`, `DEPLOYKIT_MANAGED_SECRETS`, `DEPLOYKIT_GENERATED_SECRETS`, and `DEPLOYKIT_MANAGED_DIGEST` — which the `DEPLOYKIT_` prefix already makes DeployKit's, so `GitHubManagedResourceNames` and every committed ownership-marker byte are unchanged. A first run therefore refuses a desired name somebody else already set instead of overwriting it, and only names a previous run recorded are ever deleted.

`src/orchestrator/gateway-keys.ts` rotates the workflow-to-VPS key without a window in which no key works: generate into a mode-0700 local temporary directory, stage the public key as a pending owned entry, prove it by opening a real gateway session, upload the private key on stdin, atomically promote the pending entry, then shred the directory. An interrupted run is repaired by rotating again rather than by assuming an unreadable Environment secret matches an unknown pending entry. The managed-resource digest is dropped before a reconciliation and written after it, so a half-finished Environment reads as drift rather than as current; it covers variable values and secret *names* only, because no secret value may reach something DeployKit could later log, persist, or compare. Dispatch stays unreachable.

Phase 12 wired the production adapters into the Phase 4 state machine and made the whole flow real end to end. `src/orchestrator/production.ts` is the composition root; `src/orchestrator/github-port.ts`, `gateway-transport.ts`, `config-port.ts`, `operation-store.ts`, and `reporting.ts` are the seams onto modules earlier phases already froze. The two genuinely new operations are dispatch and run correlation, and correlation uses the only key GitHub actually discloses: a run's name. The managed workflow's `run-name` is `DeployKit <target> <request uuid>`, so a run whose name is not that shape is not correlated at all, and an *active* run of the same workflow for the same target is adopted rather than raced — a rerun that lost its local record therefore cannot dispatch a duplicate. `WorkflowDispatchRequest` gained `workflowSha` and `actor`, `WorkflowRunIdentity` gained `repository`, and `OrchestratorResult` gained `workflowRunUrl`, so an operator is handed a run page rather than raw workflow logs; none of that touches `CONTRACT_KEY_ORDER` or any digest.

The gateway key is the one policy the wiring owns, because it spans both planes. `GatewayAccessProvider` now receives the administrator connection, the expected binding, the proven repository-key fingerprint, and a dry-run flag, and may answer with a session: the state machine calls `activate` only after the target Environment holds the uploaded private key, refuses to activate at all if the Environment did not reconcile, and calls `dispose` in a `finally` so the local private key never outlives the invocation. A dry run stages nothing, uploads nothing, and promotes nothing. The local operation record moved out of the application repository entirely — it lives in the operator's state directory, named by a digest of `(repository, target id)`, opened `O_NOFOLLOW`, and written atomically with mode `0600`.

`test/orchestrator-integration.test.ts` replaces only the two process boundaries, `gh` argv and `ssh`/`scp` argv, and drives a real Git repository, a real mode-0600 config, real canonical frames, and the real state directory through fresh, dry-run, no-wait, interrupted-rotation, interrupted-reconciliation, failed-run, retry, moved-ref, and canary scenarios. It is what caught the one real defect of the phase: the pinned `known_hosts` value carried a terminating newline that `gh` strips, so the Environment could never read back as current and every rerun re-rotated the gateway key. `src/orchestrator/production.ts` stays unexported from `src/index.ts`, no CLI path constructs it, and bare `deploykit deploy` still stops at `DK_UNSUPPORTED` after compiling.

A deployment's target id is `sha256(repository + NUL + targetName)` truncated to 32 hex characters. It is derived from identity alone, never from the manifest, so editing the config never moves a target's server state, ports, release directory, or Nginx file.

The authoritative definitions live in:

- `src/orchestrator/contracts.ts` — versioned shapes, canonical key order, and protocol limits.
- `src/orchestrator/dependencies.ts` — dependency-injected ports for GitHub, administrator SSH, gateway transport, config filesystem, operation state, clock, and output.
- `src/orchestrator/failures.ts` — the stable `DK_*` failure and recovery catalog reproduced below.
- `test/fixtures/orchestrator/` — protocol, ownership, state, and config examples with their expected failures.

Phase 2 additionally implements the config boundary in `src/orchestrator/config-file.ts`, `src/orchestrator/config-schema.ts`, `src/orchestrator/config.ts`, and `src/orchestrator/redaction.ts`; `test/orchestrator-config.test.ts` asserts that every `config/invalid/` fixture is rejected with exactly the code and recovery `expectations.json` names.

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
