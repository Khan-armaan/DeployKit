# Changelog

## Unreleased

- Orchestrator Phase 2: bare `deploykit deploy` now scaffolds, securely reads, and strictly validates `deploykit.config.yaml` before doing anything else, and reports stable `DK_CONFIG_SCAFFOLDED`, `DK_CONFIG_INSECURE`, `DK_CONFIG_PLACEHOLDER`, and `DK_CONFIG_INVALID` failures with their frozen recovery instructions.
- Secure read opens the file with `O_NOFOLLOW` and validates the opened descriptor: regular file, current-user owned, mode `0600` exactly, size-bounded, and untracked, unstaged, and Git-ignored inside the repository. Linked Git worktrees share the main checkout's exclude file.
- Expanded `assets/deploykit.config.example.yaml` with Compose, PM2 (including a worker), static and service frontends, routing, health checks, automatic ports, a database block, and generated-secret names.
- Operator backend values are partitioned out immediately after parsing and registered with an exact-value redactor, so they cannot reach JSON output, error details, or logs.
- Orchestrator Phase 3: a validated `deploykit.config.yaml` now compiles to the secret-free `deploykit/runtime/v1alpha1` manifest, its canonical `deploykit/runtime-yaml-canonical/v1` bytes, and their SHA-256 digest. Bare `deploykit deploy` reports the compiled target id, manifest digest, and byte length.
- Equivalent configurations compile to byte-identical manifests regardless of YAML formatting or key order, and rotating a backend secret **value** changes neither the bytes nor the digest, which is what makes a resume safe. `hostPort: auto` compiles to no requested port so allocation stays server-owned.
- The compiled manifest is validated and planned through the existing schema, semantic, filesystem, package-script, package-manager, effective-Compose, route, and plan checks. `validateProject` accepts an explicit `sourceRoot`, so an application tree can be validated independently of where its manifest lives.
- Deployment plans now express gateway-managed targets: `runnerLabel` is `null` with `execution: "gateway"`, `source.manifestDigest` carries the identity digest, and `targetId` may be supplied so server state, ports, releases, and the Nginx site use the identity frozen by the manifest. PM2 network workloads may pin an explicit `hostPort`, and a service frontend may declare `publicEnvironment`.
- `ROUTE_STREAM_BUFFERING_ENABLED` now applies to server-sent-event routes only. Nginx stops buffering a WebSocket the moment it upgrades, and the generated site never emitted `proxy_buffering off` for `websocket` alone.
- Orchestrator Phase 4: an internal dependency-injected state machine now drives the whole deployment sequence — secure config load and compile, local and remote preflight, exact commit resolution, control-artifact, gateway, repository-key, and Environment readiness, a final readiness recheck, dispatch and run correlation, wait, inspect, and report — and is exercised only with fake adapters.
- Authoritative state lives in GitHub and on the VPS, never in the local operation record. Every step inspects the real resource before reconciling, and control artifacts, the frozen commit SHA, the gateway binding, the repository key, and the Environment are all re-read immediately before the single irreversible dispatch.
- A rerun cannot produce a second workflow run: a dispatch is skipped whenever an existing run correlates by request UUID or by deployment identity (target, commit SHA, manifest digest). Deleting or corrupting the local record is therefore harmless — it is discarded with a `DK_OPERATION_STATE_INVALID` warning and the run resumes from external state — and a recorded failure is retried under a fresh request UUID.
- `--dry-run` inspects every boundary and writes nothing, remotely or locally; `--no-wait` dispatches, correlates the run, and stops. Neither is exposed on the CLI yet.
- Managed branch, pull-request, and deploy-key names are keyed by target ID, so renaming a target in the config can never claim another target's resources, and gateway bindings are compared on identity alone so a key rotation is not mistaken for a binding mismatch.
- Orchestrator Phase 5: server deployment state is now versioned and bound to the deployment identity frozen in Phase 1 — target ID, full commit SHA, and compiled runtime-manifest digest. A failed or interrupted attempt resumes only under that exact identity, a different SHA or digest is refused with `SERVER_IDENTITY_MISMATCH` before any mutation, and a completed target still refuses every further apply.
- A `running` record is treated as interrupted only by a caller that already holds the server-wide deployment lock, so a live deployment can never be mistaken for a crashed one. Failure history and contiguous checkpoints survive every retry.
- Pre-digest state is preserved rather than guessed: a completed legacy target keeps refusing another apply, while failed or running legacy state raises `SERVER_STATE_LEGACY` until it is explicitly migrated to an identity or the target is cleared.
- The registry now publishes the stable loopback allocation for every service and can describe a target's reservations without reserving anything, so generators, retries, and inspection all read one allocation. Collision checks still run under the existing registry and server-wide locks, and a refusal never writes a partial reservation.
- The deployment engine accepts an explicit incoming project root and validates it before any phase runs: absolute, existing, a directory, and never overlapping the immutable releases, the activated release link, or the target's configuration and state directories. Only `ProductionDeploymentDriver.stageSource` may create the immutable release during `source-staged`.
- Added a structured, redacted inspection result carrying target, commit SHA, manifest digest, phase, domains, allocated ports, health, failure code, and recovery action. `deploykit server target-status` now reports it, built from durable state alone, and every runtime failure maps to the stable `DK_*` code and recovery action through one shared table.
- Orchestrator Phase 6: the restricted gateway protocol is implemented and exposed as `deploykit gateway` on the standalone server CLI — a forced command with no options, no arguments, and no subcommands that reads one bounded canonical JSON Lines request from stdin and writes only progress and result frames to stdout.
- The parser believes nothing it is told. It recomputes the manifest digest from the received bytes, refuses a runtime manifest whose canonical re-serialization is not byte-identical to what arrived, checks the declared frame counts and payload lengths against the frames that actually appeared, and rejects any secret name the manifest does not declare.
- Identity comes from the root-owned binding, never from the caller. The request and the manifest may only confirm the repository, Environment, target name, and target ID, and any disagreement is reported as `DK_GATEWAY_BINDING_MISMATCH` before a byte of runtime state is touched.
- The forced command refuses a client-supplied command, extra arguments, a PTY, agent forwarding, and X11 forwarding before it reads stdin, and every deployment command it later spawns starts from a minimal environment with an argv array and no shell.
- Every outcome is a bounded result frame carrying a frozen `DK_*` code, its recovery action, and the matching exit code; received secret values are registered with a redactor, in raw and JSON-escaped form, before any output is produced.
- Exact-SHA source retrieval was Phase 7's, so a gateway constructed without a verified source provider still advertises only its non-mutating capabilities and refuses `apply` and `retry` as an incomplete bootstrap.
- Orchestrator Phase 7: the VPS now retrieves application source itself. `deploykit gateway` fetches only the repository its root-owned binding names, at the exact frozen commit, into `/var/lib/deploykit/source/<target-id>/` — outside the immutable releases, the activated release link, and the target's configuration and state — and hands the deployment engine a plain directory with no `.git`.
- Git runs with an environment DeployKit constructs rather than inherits: no system, global, or injected `GIT_CONFIG_*` configuration, no hooks, no filters, no credential helper or askpass, no agent, proxy, or loader variables, no arbitrary SSH command, and exactly one permitted transport. The SSH URL is derived from the binding, so a caller can confirm the repository but never redirect the fetch.
- Identity is proven before anything is materialized: the ref must still resolve to the frozen commit (`DK_REF_NOT_FOUND`, `DK_REF_MOVED`), the object must be a commit, and the shallow fetch runs with object checking on. Gitlinks, submodule declarations, `.git` paths, escaping symlinks, and special files are refused as `DK_SOURCE_UNSAFE` before the tree is promoted.
- GitHub host keys are pinned. The `assets/github-known-hosts` package asset and the compiled-in pin are the same keys, the gateway rewrites them into its own root-owned area on every retrieval, and SSH runs with `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, and the read-only repository identity alone.
- Retrieval reserves no port or domain, creates no release, starts no workload, and writes no Nginx, certificate, or activation. Repeating the same repository and commit reuses the verified tree and prunes trees retrieved for other commits, so a retry is deterministic and cheap. The gateway is installed on no host yet.
- The config parser and one-command GitHub/VPS orchestrator remain incomplete past this boundary; existing v0.1 projects can still use the explicitly labeled legacy flags.

## 0.1.3

- Bare `deploykit deploy` now creates the bundled `deploykit.config.yaml` template securely instead of failing Commander validation for missing legacy `--target` and `--ref` flags.
- The scaffold is create-exclusive, mode `0600`, repository-locally ignored, and rejects tracked, staged, symlinked, foreign-owned, or group/world-readable configuration files.
- The full config parser and one-command GitHub/VPS orchestrator remain pending; existing v0.1 projects can temporarily use the explicitly labeled legacy flags.

## 0.1.2

- Documentation only; the shipped CLI behaviour is unchanged from 0.1.1.
- Rewrote the README and AGENTS.md around the one-file `deploykit.config.yaml` workflow.
- Clarified in `assets/deploykit.config.example.yaml` that the template ships with the npm package and that `deploykit deploy` will seed `deploykit.config.yaml` from it with mode 0600.

## 0.1.1

- No user-facing changes; package contents are identical to 0.1.0.
- Release workflow now skips build, publish, and upload when the tagged version is already on the registry, so re-triggering a release no longer fails with a 403.

## 0.1.0

- Initial versioned manifest and TypeScript CLI.
- Ubuntu bootstrap with repo-scoped GitHub Actions runners.
- Shared domain/port registry, checkpointed first deployment, and guided retry.
- Docker Compose and Node PM2 workload drivers.
- Exact, checksum-verified Node toolchains and version-pinned npm/pnpm/Yarn/Bun adapters.
- Static and service frontends, Nginx proxy generation, WebSocket/SSE settings, DNS checks, and Certbot webroot flow.
- Per-target secret storage and optional local OpenAI/Anthropic advisor.
- Standalone checksum-verified VPS bundle, structured redacted phase logs, and three topology fixtures.
