# Full orchestrator implementation plan

Status: **planning complete; implementation must proceed through the phases below in order**.

DeployKit's intended first-deployment experience is:

```bash
deploykit deploy
```

The operator enters all project, VPS, workload, route, database, frontend environment, backend secret, and generated-secret settings in one local `deploykit.config.yaml`. DeployKit handles GitHub setup, restricted VPS access, exact-commit source retrieval, services, collision-free ports, Nginx, DNS verification, TLS, health checks, and final reporting.

The current scaffold-only behavior must continue to be described as incomplete until Phase 14 passes.

## Target user flow

1. Install DeployKit.
2. Run `deploykit deploy` inside the application repository.
3. If `deploykit.config.yaml` is missing, DeployKit copies the bundled example directly to that path with mode `0600`, adds it to the repository-local Git exclude file, and waits without making remote changes.
4. Edit the generated `deploykit.config.yaml`, return to the waiting prompt, and confirm. In a non-interactive session, fill the file and rerun the same command.
5. DeployKit validates and compiles the config before any remote mutation.
6. If the managed workflow is not on the protected default branch, DeployKit creates a narrowly scoped setup pull request and waits for the operator to review and merge it.
7. The same command resumes, prepares the VPS gateway and repository key, synchronizes the GitHub Environment, dispatches a GitHub-hosted workflow, waits for deployment, and reports the outcome.

The target path requires no `--target` flag when the config identifies one target, no manual runner enrollment, no manual clone, no manual service or Nginx setup, and no manual port selection for `hostPort: auto`.

## Target architecture

```text
Local deploykit.config.yaml (mode 0600 and Git-ignored)
        |
        v
Local DeployKit CLI
  |-- validates and compiles a secret-free runtime manifest
  |-- creates/verifies the GitHub setup PR and Environment
  |-- bootstraps a restricted VPS gateway over administrator SSH
  `-- dispatches and follows the exact GitHub workflow run
        |
        v
GitHub-hosted ubuntu-latest runner
  |-- reads control artifacts from the protected default branch
  `-- streams a bounded apply request to the VPS forced command
        |
        v
Repository/target-bound VPS gateway
  |-- retrieves the private repository at the exact commit SHA
  |-- stores declared secrets outside the release
  `-- invokes the existing deterministic server deployment engine
        |
        v
Compose / PM2 / static build / Nginx / Certbot / health checks
```

## Rules for completing phases

- Complete and merge exactly one phase before starting the next.
- A phase is complete only when every listed deliverable and completion gate passes. Partial existing code does not make a phase complete.
- Add the nearest focused tests during the phase, then run `npm run check` before merging it.
- Keep new orchestration modules internal until Phase 13. Bare `deploykit deploy` must not expose a partially wired production path.
- Preserve deterministic output, stable `DK_*` errors, redaction, ownership checks, atomic writes, and the existing first-deployment-only boundary at every phase.
- Review `SECURITY.md` before every gateway, bootstrap, secret, GitHub workflow, command execution, source retrieval, or privileged-runtime change.
- Update the phase tracker only after its gate passes.

## Sequential phases

### Phase 1 — Freeze contracts and acceptance fixtures

Goal: define every boundary before adding side effects.

Deliverables:

1. Freeze versioned shapes for:
   - local operator config;
   - secret-free compiled runtime manifest;
   - manifest digest;
   - gateway request, secret framing, progress events, and result;
   - root-owned gateway binding;
   - deployment state identity;
   - GitHub ownership markers and managed resource names;
   - secret-free local operation records.
2. Define dependency-injected interfaces for GitHub, administrator SSH, gateway transport, config filesystem, operation state, clock, and output.
3. Define stable `DK_*` failures and resume instructions for every boundary.
4. Add config-driven fixtures for:
   - static frontend plus Compose API;
   - PM2 API/worker plus Compose database;
   - containerized frontend/API plus external database.
5. Add protocol examples and hostile-input fixtures without real credentials.
6. Add the disposable-VPS acceptance matrix outline to `docs/acceptance.md`.

Completion gate:

- Contract snapshots are deterministic.
- Every fixture represents a complete valid topology.
- Invalid protocol, ownership, state, and config examples have explicit expected errors.
- No production behavior or external state changes in this phase.

Delivered by: `src/orchestrator/contracts.ts`, `src/orchestrator/dependencies.ts`, `src/orchestrator/failures.ts`, `test/fixtures/orchestrator/`, the three topology fixtures under `test/fixtures/`, `test/orchestrator-contracts.test.ts`, `test/orchestrator-fixtures.test.ts`, [`orchestrator-contracts.md`](orchestrator-contracts.md), and the planned matrix in [`acceptance.md`](acceptance.md). `src/errors.ts` gained the orchestrator `DK_*` codes additively; existing codes, messages, and exit codes are unchanged, and `src/orchestrator/` is not exported from `src/index.ts`.

### Phase 2 — Secure config scaffolding, loading, and schema

Depends on: Phase 1 complete.

Goal: safely obtain and understand the single secret-bearing operator file.

Deliverables:

1. Keep `assets/deploykit.config.example.yaml` in the published package and expand it with database, generated-secret, Compose, PM2, static, routing, health-check, and automatic-port examples.
2. When missing, atomically create `deploykit.config.yaml` directly from the bundled asset with create-exclusive behavior and mode `0600`.
3. Add it to the repository-local Git exclude file without modifying the tracked `.gitignore`; support Git worktrees.
4. Secure-open without following symlinks, then verify the opened descriptor is a regular file owned by the current user with exact private permissions.
5. Require the config to be inside the repository, ignored, untracked, and unstaged.
6. Implement a strict Zod schema for repository/ref, target/environment, VPS connection, domains, workloads, Compose, PM2, static frontend, database, routes, health checks, public frontend values, backend values, and generated names.
7. Parse environment values as strings and reject unknown fields, placeholders, invalid paths/domains/refs/fingerprints, overlapping names, ambiguous routes, and reserved `DEPLOYKIT_*` keys.
8. Partition public values, backend values, and generated names immediately after parsing and initialize the exact-value redactor before further processing.
9. Implement the interactive wait-and-continue behavior and the non-interactive fill-and-rerun result.

Completion gate:

- Config/scaffold/CLI tests cover symlinks, ownership, modes, tracking, staging, ignore rules, worktrees, races, placeholders, and all schema unions.
- Packed-artifact tests prove the example is shipped at the expected path.
- A secret canary never appears in JSON output, error details, snapshots, or captured logs.
- No network or VPS work exists in this phase.

Delivered by: `src/orchestrator/config-file.ts` (scaffold, repository-local exclude, worktree-aware Git checks, `O_NOFOLLOW` secure read), `src/orchestrator/config-schema.ts` (strict Zod schema, placeholder detection, cross-field semantics, environment partitioning), `src/orchestrator/config.ts` (composition plus the `ConfigFileSystemPort` implementation), `src/orchestrator/redaction.ts` and the `registerRedactedValues` hook in `src/output.ts`, the expanded `assets/deploykit.config.example.yaml`, `test/orchestrator-config.test.ts`, and `test/orchestrator-config-isolation.test.ts`. `src/config-scaffold.ts` was replaced by these modules; bare `deploykit deploy` now scaffolds, waits, securely reads, and validates the config, then still stops at `DK_UNSUPPORTED` because Phases 3-13 own compilation, GitHub setup, the gateway, and dispatch. `src/orchestrator/` remains unexported from `src/index.ts`.

### Phase 3 — Deterministic compiler and project validation

Depends on: Phase 2 complete.

Goal: turn the local config into the exact secret-free input accepted by the deterministic deployment engine.

Deliverables:

1. Compile validated config into a normalized runtime manifest containing public values and declared secret names, never backend secret values.
2. Canonically sort maps, targets, domains, workloads, routes, ports, generated files, and secret names.
3. Calculate a versioned SHA-256 digest from the canonical secret-free bytes.
4. Map `hostPort: auto` to no caller-requested port so allocation remains server-owned.
5. Extend project validation to accept an explicit application source root independent of the compiled manifest's location.
6. Run existing schema, semantic, filesystem, package-script, package-manager, effective-Compose, route, and public-plan validation against the compiled form.
7. Update the public plan and server plan where the new config expresses behavior not currently represented.
8. Keep application Dockerfiles, Compose files, source, and `package.json` read-only.

Completion gate:

- Equivalent configs produce byte-identical manifests and digests.
- Changing only a backend secret value changes neither manifest bytes nor digest.
- All topology fixtures pass parsing, project validation, public planning, server planning, and deterministic generation.
- Config secrets are absent from every compiled artifact.

Delivered by: `src/orchestrator/canonical.ts` (the `deploykit/runtime-yaml-canonical/v1` serializer, code-point key ordering, and the versioned SHA-256 digest), `src/orchestrator/compile.ts` (runtime defaults, canonical sorting, `hostPort: auto` handling, the repository/target-derived target id, and compile-time semantics), `src/orchestrator/project.ts` (the lossless projection onto the existing manifest shape plus compiled project validation and planning), and `test/orchestrator-compile.test.ts`. The compiler reproduces the frozen Phase 1 gateway manifest frame byte for byte, so `test/fixtures/orchestrator/protocol/valid/apply.jsonl` is now generated behavior rather than an illustration.

Supporting changes to existing modules: `validateProject` accepts an explicit `sourceRoot`; `DeploymentPlan` gained `execution`, a nullable `runnerLabel`, `source.manifestDigest`, and a `targetId` option so gateway-managed targets use the identity frozen by the manifest; `pm2ServiceSchema` gained `hostPort`; `serviceFrontendSchema` gained `publicEnvironment`; `targetSchema.runnerLabel` became optional behind `requireRunnerLabel` because a gateway-managed target has no enrolled runner; and `ROUTE_STREAM_BUFFERING_ENABLED` narrowed to server-sent events, which is the only case where `proxy_buffering` still applies. `src/orchestrator/` remains unexported from `src/index.ts`, and bare `deploykit deploy` compiles and reports the digest but still stops at `DK_UNSUPPORTED`.

### Phase 4 — Local orchestrator core with fake adapters

Depends on: Phase 3 complete.

Goal: prove the orchestration logic before connecting it to GitHub or a VPS.

Deliverables:

1. Implement a dependency-injected orchestration state machine for:
   - secure config load and compile;
   - local and remote preflight;
   - exact commit resolution;
   - control-artifact readiness;
   - gateway readiness;
   - repository-key readiness;
   - Environment readiness;
   - final readiness recheck;
   - dispatch and run correlation;
   - wait, inspect, and report.
2. Define idempotent checkpoints and compensating behavior for interrupted, pending, ready, failed, and completed steps.
3. Store only request ID, repository, target, commit SHA, manifest digest, setup-PR/run identifiers, and nonsecret readiness facts in the local operation record.
4. Implement `--dry-run` and `--no-wait` semantics at the state-machine level.
5. Make recovery depend on authoritative GitHub/VPS inspection; deletion of local operation state must not make recovery impossible.
6. Exercise the state machine only with fakes. Do not wire it into bare `deploykit deploy` yet.

Completion gate:

- Fake-adapter tests cover fresh success and interruption after every checkpoint.
- Reruns never duplicate an owned resource or dispatch.
- Dry-run performs zero mutations.
- The current user-visible CLI remains unchanged.

Delivered by: `src/orchestrator/deploy.ts` (the state machine, the local operation record, and `--dry-run`/`--no-wait` semantics), `src/orchestrator/planner.ts` (the desired state each externally reconciled resource is compared against, plus managed resource names, the gateway binding identity digest, and the ownership marker), `canonicalJson` in `src/orchestrator/canonical.ts`, `test/helpers/orchestrator-fakes.ts`, and `test/orchestrator-deploy.test.ts`.

The state machine treats the local operation record as a hint and GitHub and the VPS as the truth. Every step inspects the real resource, reconciles only when the inspection says it must, and re-reads control artifacts, the frozen SHA, the gateway binding, the repository key, and the Environment immediately before the one irreversible action. A dispatch is skipped whenever the GitHub boundary can correlate an existing run for the same deployment identity — request UUID *or* (target, commit SHA, manifest digest) — so deleting or corrupting the record costs nothing and a rerun cannot produce a second run. A record whose identity, shape, or target does not match is discarded with a `DK_OPERATION_STATE_INVALID` warning rather than trusted, and a recorded failure is retried under a fresh request UUID.

Three inputs later phases own are injected rather than invented here, so no placeholder ships: `renderWorkflow` (Phase 10 owns `.github/workflows/deploykit.yml`), `runtimeBundle` (Phase 8 owns the checksum-verified standalone bundle), and `gatewayAccess` (Phases 8 and 11 own gateway host facts and the gateway Environment secret). `src/orchestrator/` remains unexported from `src/index.ts`, and bare `deploykit deploy` still stops at `DK_UNSUPPORTED` after compiling.

### Phase 5 — Digest-bound server runtime foundation

Depends on: Phase 4 complete.

Goal: make the existing deployment engine safe to call from the future gateway.

Deliverables:

1. Version server state and bind it to target ID, full commit SHA, and compiled manifest digest.
2. Allow failed or interrupted recovery only for the same SHA and digest after acquiring the server-wide deployment lock.
3. Preserve failure history and contiguous checkpoints; refuse a different SHA/digest and refuse every reapply after successful completion.
4. Define safe handling for legacy state without a digest: preserve completed targets and require explicit migration or a clean target for failed/running state.
5. Extend the registry response so server-allocated loopback ports are stable across retry and available to generators and inspection.
6. Keep collision checks under the existing registry and server-wide locks.
7. Accept an explicit validated incoming project root while ensuring only `ProductionDeploymentDriver.stageSource` creates the immutable release during `source-staged`.
8. Add a structured, redacted inspection result containing target, SHA, digest, phase, domains, allocated ports, health, failure code, and recovery action.

Completion gate:

- State/apply/registry/secrets/driver tests cover same-identity retry and different-identity refusal.
- Crash recovery is tested after every durable phase and cannot mistake an actively locked deployment for an interrupted one.
- Auto ports remain stable across retries and conflicting projects receive different ports without partial registry writes.
- Existing ordered deployment phases remain unchanged.

Delivered by: `src/server/identity.ts` (the frozen deployment identity and manifest digest, plus mismatch reporting), the rewritten `src/server/state.ts` (version 2 state bound to that identity, pre-digest state handling, and persisted resources and health), `src/server/inspect.ts` (the structured redacted inspection result), `src/server/failures.ts` (the one `SERVER_*` to `DK_*` and recovery translation, now also used by `src/cli-errors.ts`), the identity-bound `DeploymentApplier` and validated incoming project root in `src/server/apply.ts`, `describe` and `portsByService` in `src/server/registry.ts`, and `test/server-identity.test.ts`.

State is version `2` and carries the `deploykit/deployment-identity/v1alpha1` triple, the reserved domains and loopback ports, and the health of each service, so inspection answers for a target whose manifest is not present. `begin` refuses a different SHA or digest before touching anything, refuses every apply after a successful completion, and treats a `running` record as interrupted only when the caller proves it holds the server-wide deployment lock. Pre-digest state is never guessed: a completed legacy target is preserved and still refuses another apply, and failed or running legacy state requires `migrateLegacyState` or a clean target.

Supporting changes to existing modules: `planDeployment` accepts the target id a root-owned gateway binding will supply instead of deriving it from the manifest; `runServerApply` gained optional `--manifest-digest` and `--target-id`, validates the incoming source root before validating the project *against* it, and derives a deterministic digest for a legacy `deploykit.yaml`; `deploykit server target-status` returns the inspection result; and `SERVER_DEPLOYMENT_REF_MISMATCH` was replaced by `SERVER_IDENTITY_MISMATCH`, joined by `SERVER_STATE_LEGACY`, `SERVER_SOURCE_ROOT_INVALID`, and `SERVER_RELEASE_CONFLICT`. The gateway is not installed anywhere; Phase 6 owns the protocol that will call this engine.

### Phase 6 — Restricted gateway protocol and server command

Depends on: Phase 5 complete.

Goal: implement the narrow server entrypoint before installing it on any host.

Deliverables:

1. Implement a versioned, canonical, length-bounded stdin protocol for operation, request UUID, ref, exact SHA, manifest bytes/digest, declared secret frames, and flags.
2. Recompute the digest from received canonical manifest bytes and reject a claimed digest mismatch before runtime state is touched.
3. Load repository, environment, and target identity from a root-owned binding; caller input may only confirm these values, never choose them.
4. Reject a nonempty `SSH_ORIGINAL_COMMAND`, PTY use, forwarding, malformed frames, duplicate keys, undeclared secrets, invalid IDs/SHAs/digests, unknown operations, oversized input/output, and protocol-version mismatch.
5. Use a minimal environment and argument arrays with `shell: false`.
6. Stream only bounded redacted progress/results and keep secret values out of exceptions and event details.
7. Expose only apply, retry, status/inspect, and non-mutating handshake operations needed by the orchestrator.
8. Add the restricted command to the standalone server bundle and narrow server CLI.

Completion gate:

- Protocol tests cover valid fragmentation and every malformed/oversized/hostile case.
- Binding substitution, arbitrary commands, interactive shell, PTY, and forwarding fail closed.
- Secret canaries are absent from stdout, stderr, errors, state, and events.
- The gateway is not installed remotely yet.

Delivered by: `src/gateway/protocol.ts` (the canonical JSON Lines codec, every frozen bound, and both the request and output stream parsers), `src/gateway/runtime-manifest.ts` (the strict `deploykit/runtime/v1alpha1` schema plus the canonical round-trip check), `src/gateway/binding.ts` (the `O_NOFOLLOW` root-owned binding read and confirm-only comparison), `src/gateway/invocation.ts` (the forced-command guard and minimal child environment), `src/gateway/session.ts` (one bounded, redacted session per request), `src/gateway/runtime.ts` (the production operations over the existing deployment engine), `src/gateway/command.ts` and the `deploykit gateway` command on the standalone server CLI, and `test/gateway-protocol.test.ts`.

The parser believes nothing. It recomputes the manifest digest from the received bytes, refuses a manifest whose canonical re-serialization is not byte-identical to what arrived, compares the declared frame counts and payload lengths with the frames that actually appeared, and checks every secret name against the names the manifest declares. Identity is never chosen by the caller: the root-owned binding supplies the repository, Environment, target name, and target ID, and a request or manifest that names anything else is refused as a binding mismatch rather than a protocol error. The forced command refuses a client-supplied command, arguments, a PTY, agent forwarding, and X11 forwarding *before* it reads a byte of stdin, and every deployment command it later spawns starts from a minimal environment with `shell: false`.

A session never throws: hostile input, an unconfirmed binding, a runtime refusal, and an unexpected exception all become a bounded failure result frame carrying a frozen `DK_*` code, its recovery action, and the matching process exit code. The result frame deliberately has no free-form message field, and every secret value received in the request is registered with a redactor — in both its raw and its JSON-escaped form — before any output is produced.

Source retrieval is injected because Phase 7 owns it. An installation without a verified source provider advertises only the non-mutating capabilities in its handshake and refuses `apply` and `retry` as an incomplete bootstrap, so no placeholder retrieval ships. Supporting changes to existing modules: `DeploymentEventLogger` and `DeploymentApplier` accept an optional observer so the runtime's own phase transitions become progress frames without reading back the log, and `ProcessCommandRunner` accepts an explicit base environment. The gateway is installed on no host; Phase 8 owns the binding, host facts, bundle, and forced-command entry it reads.

### Phase 7 — Exact-SHA private source provider

Depends on: Phase 6 complete.

Goal: retrieve only the bound private repository and prove the exact source identity without causing deployment mutations.

Deliverables:

1. Fetch into a root-owned incoming/cache area outside immutable releases, workload paths, and generated configuration paths.
2. Derive the SSH repository URL only from the root-owned binding.
3. Use a dedicated read-only repository identity and a packaged pinned GitHub `known_hosts` asset.
4. Run Git with a clean bounded environment: no credential prompt, no inherited system/global config, no hooks, filters, unsafe file protocols, submodules, recursive credentials, or arbitrary SSH command.
5. Fetch the requested ref, verify it still resolves to the GitHub-frozen full SHA, verify the object is a commit, and reject ref movement or repository mismatch.
6. Materialize a source tree without `.git`, validate paths and symlinks, and pass its explicit root to project validation/runtime.
7. Bound cache/staging reuse and cleanup by ownership and identity.

Completion gate:

- Tests cover wrong repository, moved ref, wrong SHA/object type, gitlinks/submodules, hooks, filters, hostile Git config, credential prompts, unsafe protocols, symlink/path escape, and `.git` exclusion.
- Source retrieval cannot create a release, reserve a port/domain, start a workload, write Nginx, issue TLS, or activate anything.
- Repeated retrieval of the same repository/SHA is deterministic and ownership-safe.

### Phase 8 — VPS bootstrap and crash-safe key lifecycle

Depends on: Phase 7 complete.

Goal: install the already-tested gateway/runtime and establish its trust material without a root Actions runner.

Deliverables:

1. Refactor local bootstrap to consume structured host, user, port, administrator identity, and pinned host-key fingerprint from config.
2. Replace Actions runner enrollment in `assets/bootstrap.sh` with:
   - a dedicated non-login gateway user;
   - root-owned repository/target binding files;
   - forced-command `authorized_keys` entries using `restrict` and explicit no-PTY/no-forwarding controls;
   - a minimal root helper or narrowly scoped sudoers entry;
   - the checksum-verified standalone bundle;
   - the pinned GitHub host-key asset;
   - a stable mode-`0600` VPS-to-GitHub repository private key.
3. Return only the repository public key and nonsecret gateway/runtime fingerprints to the local orchestrator.
4. Implement staged/active DeployKit-owned gateway-key entries so rotation can survive interruption without overwriting unrelated keys.
5. Preserve the active administrator SSH path while reconciling a custom SSH port or firewall.
6. Keep existing Ubuntu/architecture, package, Docker, Node, PM2, Nginx, Certbot, state-directory, public-IP, checksum, and file-mode checks.
7. Fix the package-name mismatch between the published package and bootstrap tarball validation and test a real packed artifact.
8. Add an administrator-side non-mutating gateway handshake and make same-binding bootstrap a no-op.

Completion gate:

- Bootstrap tests prove same-binding idempotency and fail closed on repository/target/key mismatch.
- The installed bundle version/checksum and gateway binding are verified by a real forced-command handshake.
- The gateway user has no shell, Docker membership, forwarding, PTY, or general sudo.
- Repository private-key mode and stability, public-key return, packaged host keys, and interrupted key rotation are tested.
- No Actions Runner package, token, hook, or service is installed on a fresh host.

### Phase 9 — Typed GitHub client primitives

Depends on: Phase 8 complete.

Goal: provide safe GitHub operations without yet dispatching a deployment.

Deliverables:

1. Keep `gh` as the authenticated local boundary; never extract or print its token.
2. Add typed, bounded operations for repository metadata, authenticated permissions, commits, contents, branches, pull requests, environments, variables, secrets, deploy keys, workflow dispatch, and workflow runs.
3. Implement pagination, retry/backoff for safe reads, rate-limit handling, response-size bounds, and typed current/desired-state results.
4. Send all secret material through stdin, never arguments or temporary files.
5. Preserve existing environment reviewers, wait timers, branch policies, and unrelated variables/secrets.
6. Define DeployKit ownership markers and refuse ambiguous existing branches, files, deploy keys, variables, or environments.
7. Implement deploy-key creation with `read_only: true`; treat rotation as delete/create only after ownership is proven.
8. Unit-test every method, but do not wire mutating operations or dispatch into bare deploy.

Completion gate:

- Tests cover partial permissions, plan/visibility limitations, pagination, rate limits, ownership conflicts, protected environments, stdin secret handling, and redaction.
- API calls use deterministic argument ordering and bounded parsing.
- No GitHub or VPS mutation is performed by the production CLI yet.

### Phase 10 — Secret-free control artifacts and setup pull request

Depends on: Phase 9 complete.

Goal: place reviewable deployment control code on the protected default branch before synchronizing secrets or dispatching.

Deliverables:

1. Generate deterministic owned files:
   - `.github/workflows/deploykit.yml`;
   - `.github/deploykit/manifest.yaml`;
   - `.github/deploykit/ownership.json`.
2. Generate the workflow against the finalized gateway protocol with `ubuntu-latest`, minimal permissions, target Environment/concurrency, pinned Actions SHAs, strict SSH verification, exact SHA/digest checks, bounded gateway client, and cleanup in `always()`.
3. Keep backend values, private keys, and credentials out of all generated bytes.
4. Compare exact default-branch bytes. When absent or different, create or reuse a deterministic DeployKit branch and a setup PR containing only owned files.
5. Refuse unrelated branch changes or user-owned conflicting files; never bypass protection, auto-approve, or merge for the operator.
6. Wait for merge by default, support resumable `--no-wait`, then re-read and verify exact bytes from the default branch.
7. Record `controlArtifactsReady` using the default-branch commit, workflow digest, runtime-manifest digest, and ownership digest.
8. Keep Environment secret synchronization and workflow dispatch disabled in this phase.

Why this phase exists: GitHub requires a manually dispatched workflow to exist on the default branch, and workflow-dispatch inputs have bounded count and payload size. The secret-free runtime manifest is therefore a committed control artifact instead of a large caller-supplied workflow input. See GitHub's [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and [manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Completion gate:

- Generated files are byte-stable and contain no secret canary.
- Setup-PR tests cover creation, reuse, drift, conflicts, review wait, interruption, merge, and exact default-branch re-verification.
- The workflow cannot dispatch through DeployKit yet.

### Phase 11 — Cross-plane keys and GitHub Environment

Depends on: Phase 10 complete.

Goal: establish and verify the GitHub↔VPS trust paths only after control artifacts and the gateway are ready.

Deliverables:

1. Require verified `controlArtifactsReady` and gateway handshake facts before any secret upload.
2. Register the VPS-generated repository public key on the bound GitHub repository with `read_only: true`.
3. From the VPS, prove that key can fetch the bound private repository through the pinned GitHub host keys and cannot substitute another repository.
4. Generate the workflow-to-VPS gateway key in a secure local temporary directory.
5. Install its public key as a DeployKit-owned pending forced-command entry, perform a local handshake with the private key, upload the private key to the target Environment through stdin, atomically activate the public entry, and remove only the previous owned entry.
6. If interrupted after temporary private-key deletion, rotate the proven pending owned entry; never assume an unreadable GitHub secret matches an unknown key.
7. Create or reconcile the target GitHub Environment without weakening existing reviewers, wait timers, or branch restrictions.
8. Reconcile DeployKit-owned public variables, backend secrets, generated-secret declarations, gateway settings, and nonsecret fingerprints; delete only stale resources previously marked as DeployKit-owned.
9. Calculate a nonsecret managed-resource digest and record `environmentReady` without persisting private keys or backend values locally.
10. Keep deployment dispatch disabled in this phase.

Completion gate:

- Source-key, gateway-key, Environment, variable, and secret reconciliation are idempotent and ownership-safe.
- Tests interrupt gateway-key rotation after every operation and prove one valid key remains.
- Environment protection settings are preserved.
- VPS fetch and gateway handshakes pass, but no deployment workflow has been dispatched.

### Phase 12 — Full orchestrator and dispatch integration

Depends on: Phase 11 complete.

Goal: connect every completed component and prove the full one-command flow internally.

Deliverables:

1. Wire the production GitHub, administrator SSH, gateway, operation-state, filesystem, and output adapters into the Phase 4 state machine.
2. On every run, execute or re-verify this exact order:
   1. secure-open, parse, partition, redact, validate, and compile config;
   2. preflight `gh`, repository identity, permissions, plan support, and administrator SSH;
   3. resolve and freeze the requested ref to a full commit SHA;
   4. reconcile setup PR and verify control artifacts on the default branch;
   5. bootstrap and handshake the bound gateway/runtime;
   6. register/test the read-only repository key;
   7. reconcile/test the gateway key and target Environment;
   8. re-read control artifacts and re-verify all digests, bindings, versions, readiness markers, and existence of the frozen SHA;
   9. dispatch only request UUID, exact SHA, manifest digest, and resume/dry-run flags;
   10. correlate the exact workflow run using the request UUID and verify workflow path, event, ref, SHA, actor, and target;
   11. wait through queued, approval, running, failure, and success states;
   12. inspect the VPS and report the redacted final result.
3. Do not trust local checkpoints alone before a mutation or dispatch; re-read authoritative GitHub/VPS state.
4. Normalize progress and stable `DK_*` errors across setup PR, approval wait, workflow, gateway, and server phases.
5. Avoid raw workflow logs by default; surface bounded redacted DeployKit results and a GitHub run URL.
6. Run a secret canary through config, GitHub secret upload, workflow, gateway, VPS secret storage, failure, inspection, and retry.
7. Exercise fresh, dry-run, no-wait, interrupted reconciliation, failed apply, and same-SHA/digest retry through a hermetic integration harness.
8. Keep the real path behind an internal test entrypoint until the next phase.

Completion gate:

- The complete state machine succeeds in hermetic end-to-end tests using one config and one command simulation.
- Every external mutation is idempotent, ownership-checked, and recoverable.
- Dispatch cannot occur until all external readiness facts have just been verified.
- Secret canaries are absent from artifacts, arguments, logs, errors, state, and checkpoints.
- Bare `deploykit deploy` has not yet been switched to an unaccepted path.

### Phase 13 — CLI cutover, legacy migration, and documentation

Depends on: Phase 12 complete.

Goal: expose the completed orchestrator as the default product behavior.

Deliverables:

1. Make bare `deploykit deploy` use the config-driven orchestrator and remove the temporary `DK_UNSUPPORTED` result.
2. Take the target from config; require no `--target` flag for the single-target contract.
3. Expose `--config`, `--dry-run`, and `--no-wait` with matching human/JSON output and stable exit codes.
4. Preserve documented legacy `deploykit.yaml` commands during migration and never rewrite application-owned files.
5. Detect a legacy root Actions runner. Install and smoke-test the replacement gateway first, request explicit approval inside the same deploy invocation, stop/unregister the old runner, retain its files for recovery, and verify GitHub no longer routes jobs to it. Never silently remove it.
6. Keep the fresh-install path free of any root runner.
7. Rewrite `README.md` around install → run → edit the generated config → confirm → review the setup PR → automatic completion.
8. Synchronize `AGENTS.md`, `docs/manifest.md`, `SECURITY.md`, `docs/acceptance.md`, CLI help, retry/status guidance, and npm PATH troubleshooting.
9. Clearly state the remaining first-deployment-only product boundary.

Completion gate:

- CLI parser/help/human/JSON/error tests match the documented contract.
- A documentation walkthrough requires no legacy bootstrap, secrets, runner, or dispatch commands.
- Fresh installs contain no root runner; legacy migration is approval-gated and recoverable.
- `deploykit deploy` is not advertised as complete until Phase 14 acceptance passes.

### Phase 14 — Package verification, disposable-VPS acceptance, and release

Depends on: Phase 13 complete.

Goal: prove the published artifact performs the real deployment safely.

Deliverables:

1. Run focused suites and the final `npm run check` gate.
2. Run `npm pack --dry-run --json` and inspect the package allowlist, bundled example, bootstrap asset, GitHub host keys, standalone server bundle, checksums, and executable bits.
3. Install the real tarball into an isolated prefix and verify CLI help, scaffolding, parsing, dry-run, server-bundle version, and bootstrap package-name handling.
4. Run the manual matrix only on disposable Ubuntu 22.04/24.04 amd64/arm64 hosts with staging DNS and Let's Encrypt staging.
5. Prove a fresh private application repository deploys after editing one generated config and invoking one `deploykit deploy` flow.
6. Interrupt and resume setup PR waiting, bootstrap, each key synchronization step, Environment reconciliation, dispatch correlation, source retrieval, secret write, workload start, proxy staging, TLS, and activation.
7. Deploy two different projects to one VPS and verify stable, non-conflicting loopback ports and domains under the global registry lock.
8. Exercise DNS mismatch, occupied ports, domain ownership conflict, unhealthy service, changed SHA/digest, undeclared secret, hostile source, and completed-target refusal.
9. Scan the repository diff, packed tarball, generated artifacts, mocked API/command arguments, workflow output, gateway output, server state/events, and CLI stdout/stderr for secret canaries.
10. Align package version, shrinkwrap, `src/version.ts`, server bundle, installer expectations, changelog, release notes, tarball, and checksum.

Completion gate:

- All automated, package, leak, and disposable-VPS tests pass.
- A fresh deployment needs no manually assembled workflow, runner, clone, service, Nginx file, port, or Certbot command.
- The deployed commit, manifest digest, domains, allocated ports, health, workflow URL, and recovery guidance are correct and redacted.
- No repository-controlled root runner is present on fresh hosts, and migrated hosts no longer route jobs to the legacy runner.
- Only after this gate may the config-driven orchestrator be described as production-ready.

## Phase tracker

| Order | Phase | Status |
| --- | --- | --- |
| 1 | Contracts and fixtures | Complete |
| 2 | Config scaffolding/loading/schema | Complete |
| 3 | Compiler and project validation | Complete |
| 4 | Orchestrator core with fakes | Complete |
| 5 | Server runtime foundation | Complete |
| 6 | Gateway protocol/server command | Complete |
| 7 | Exact-SHA source provider | Planned |
| 8 | VPS bootstrap/key lifecycle | Planned |
| 9 | GitHub client primitives | Planned |
| 10 | Control artifacts/setup PR | Planned |
| 11 | Cross-plane keys/Environment | Planned |
| 12 | Full orchestration/dispatch | Planned |
| 13 | CLI cutover/migration/docs | Planned |
| 14 | Package acceptance/release | Planned |

For each phase, follow the same closeout sequence:

1. Implement only that phase's deliverables.
2. Add and pass its focused tests.
3. Run `npm run check`.
4. Review security-sensitive changes and run the phase's secret-leak assertions.
5. Update relevant documentation and public API exports.
6. Mark the phase complete in this tracker.
7. Start the next phase.

## Persistent safety properties

- The local administrator key never leaves the operator's machine.
- Workflow-to-VPS and VPS-to-GitHub keys are separate and target/repository-bound.
- Secret values never enter Git, workflow inputs, process arguments, generated files, logs, errors, durable state, or local checkpoints.
- The gateway is a forced command, not a general SSH shell.
- The VPS derives repository/target identity from root-owned bindings and deploys only a GitHub-resolved full SHA.
- Direct DNS verification occurs before workload mutation.
- Ports are allocated and persisted under the existing global registry lock and bind only to loopback when host exposure is required.
- The existing deployment phases remain ordered exactly:

```text
manifest-validated
dns-verified
resources-reserved
source-staged
workloads-ready
migrations-complete
health-verified
proxy-staged
tls-issued
activated
complete
```

- A failed deployment may resume only the same target/SHA/digest; a successful first deployment refuses further applies.
- Nginx ownership, atomic staging, `nginx -t`, Certbot isolation, secret modes, immutable releases, bounded command execution, redaction, and failure retention remain authoritative.

## Definition of done

The full orchestrator is done only when:

- one local config contains the complete deployment input;
- bare `deploykit deploy` securely scaffolds it when missing and otherwise runs the full flow without a target flag;
- the hosted workflow and runtime manifest are reviewed through the setup PR and verified on the protected default branch;
- GitHub-hosted runners reach a forced-command gateway rather than a repository-controlled root runner;
- the VPS retrieves only the bound private repository at the exact resolved commit;
- DeployKit owns collision-free ports, workload/service setup, Nginx, DNS verification, TLS, health checks, secrets, activation, retry, and reporting;
- interrupted operations safely resume from authoritative external state;
- no secret values leak through any artifact or diagnostic channel;
- the entire automated and disposable-VPS acceptance matrix passes.

Until all fourteen phase gates pass, the config-driven VPS orchestrator remains incomplete.
