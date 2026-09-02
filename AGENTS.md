# DeployKit contributor guide

This file applies to the entire repository. DeployKit is security-sensitive deployment software. Prefer small, explicit changes, preserve deterministic output, and treat the security and user-experience requirements below as part of the public contract.

## Product outcome: one file, one command

DeployKit must feel like a deployment product, not a checklist of its internal stages.

The complete user workflow is:

1. Fill in one local file: `deploykit.config.yaml`.
2. Run one public command:

```bash
deploykit deploy
```

That command must take responsibility for setup, validation, GitHub integration, secret synchronization, VPS provisioning, source deployment, automatic ports, services, Nginx, TLS, health checks, status reporting, and safe resume after failure.

Do not require users to manually chain `init`, `validate`, `plan`, `server bootstrap`, `secrets set`, `secrets check`, `retry`, `status`, or `logs`. These may remain optional diagnostics or internal/testable primitives, but they are not the primary workflow. End-user documentation must lead with the one-file/one-command experience.

`deploykit deploy` now implements this contract end to end; the disposable-VPS acceptance matrix in `docs/acceptance.md` is the remaining gate before it may be called production-ready. The legacy `deploykit.yaml` commands stay reachable for projects already on that path and must keep working, but they are never the documented flow and must never be selected implicitly.

## How the user receives the configuration file

The example is a package asset, not a file users should hunt for in a global `node_modules` directory. Keep `assets/deploykit.config.example.yaml` in the npm tarball through the `files` allowlist in `package.json` and add a packed-artifact regression test for that exact path.

The first invocation from an application repository is still:

```bash
deploykit deploy
```

When `deploykit.config.yaml` does not exist, that command must first perform local setup:

1. Resolve the bundled example relative to the installed package, whether the CLI was installed globally, locally, or invoked through `npx`.
2. Atomically copy it to the application root as `deploykit.config.yaml` with create-exclusive behavior and mode `0600`.
3. Add the path to the repository-local Git exclude file resolved with Git (normally `.git/info/exclude`). Support worktrees where `.git` is a file. Do not modify the application's tracked `.gitignore` merely to scaffold DeployKit.
4. Verify that the resulting file is untracked, unstaged, regular, non-symlinked, user-owned, and not group/world-readable.
5. Before authentication, network access, secret reading, workflow changes, or VPS mutation, show the path and wait for the user to edit the file and confirm. Securely reopen and validate it, then continue the same deployment invocation.

Never overwrite an existing file. In a non-interactive environment, create the file and exit with one instruction to fill it and rerun the same command. A user browsing the source or npm package may copy the example manually, but that is a fallback, not the documented primary flow.

## Exact user deployment journey

The user must already control three external resources: a trusted application repository pushed to GitHub, an SSH-accessible supported Ubuntu VPS, and direct DNS A/AAAA records for the configured domains. GitHub CLI authentication and a trusted administrator SSH identity must also be available locally; DeployKit should detect missing prerequisites and explain them without partially deploying.

The documented flow is:

1. Install the CLI once with `npm install --global @deploykit001/deploykit`, or use `npx --yes @deploykit001/deploykit deploy` instead of a global installation.
2. From the pushed application repository, run `deploykit deploy`. On first use it creates the protected local configuration file and waits without making remote changes.
3. Edit only `deploykit.config.yaml`: set repository/ref, target/domain, VPS connection and pinned host key, workload/build details, routes, public frontend values, private backend values, and generated-secret names. Return to the waiting prompt to continue.
4. If protected-branch policy requires review of the generated workflow, approve the setup pull request while the command waits; the same invocation continues after merge.
5. Read the final HTTPS URL, deployed commit SHA, allocated ports, and health result from the command output.

There are no separate required DeployKit commands for validation, planning, bootstrap, secret upload, retry, status, or logs. If the initial process was non-interactive or interrupted, running the same `deploykit deploy` command continues from the local or remote checkpoint. Re-running it after a same-SHA failure resumes the durable deployment. The unavoidable configuration edit and any repository-policy approval are user decisions, not additional deployment commands.

## Single configuration file

`assets/deploykit.config.example.yaml` defines the intended next-version interface. The CLI materializes it as `deploykit.config.yaml`, and the operator supplies all deployment configuration there:

- GitHub repository and application ref;
- deployment target and protected GitHub Environment;
- VPS host, SSH user/port, local bootstrap identity, and verified host-key fingerprint;
- primary domain, aliases, and TLS contact;
- Compose, PM2, or static frontend workloads;
- build/start scripts, routes, and health checks;
- `hostPort: auto` for host-facing services;
- frontend variables in `environment.frontend`;
- backend/runtime values in `environment.backend`;
- server-generated names in `environment.generated`.

This is the only hand-edited deployment file. The generated runtime manifest and `.github/workflows/deploykit.yml` are owned artifacts, not additional user configuration.

### Local-file security

`deploykit.config.yaml` may contain credentials and must remain local:

- ensure it is ignored by Git before reading secret values;
- refuse a tracked, staged, symlinked, non-regular, or non-user-owned file;
- require mode `0600` and reject group/world-readable permissions;
- initialize the redactor from backend secret values before reporting parse or validation failures;
- never print, cache, archive, upload, or include the whole file in telemetry, plans, errors, or releases;
- compile it into a secret-free normalized server manifest and generated workflow.

Unknown keys must be errors. Model workload variants as strict discriminated unions. All environment values must be YAML strings so coercion cannot silently change credentials or build configuration.

## `deploykit deploy` orchestration contract

One invocation is idempotent and performs the following sequence internally:

1. Secure-open and strictly parse `deploykit.config.yaml`.
2. Validate application paths, package scripts, exact Node/package-manager versions, effective Compose configuration, service health checks, routes, domains, SSH fields, and frontend/backend environment separation.
3. Infer or verify the GitHub repository and resolve the configured ref to an immutable 40-character commit SHA.
4. Compile a normalized secret-free runtime manifest and generic pinned workflow, then run the existing manifest, semantic, project, and Compose validators against the compiled result.
5. Reconcile the generated workflow with the protected default branch. When review is required, create or update the setup pull request, wait for its approval in the same command, and continue after it merges. Never silently push to or bypass protection on a privileged workflow.
6. On first use, verify the administrator SSH host key and provision the supported Ubuntu VPS with the checksum-verified standalone runtime and a restricted repository/target-bound deployment gateway.
7. Create or reconcile the target GitHub Environment, transport identity, public frontend variables, and encrypted backend secrets.
8. Dispatch the GitHub-hosted workflow for the exact SHA and follow the specific run to completion by default.
9. On success, report the commit, HTTPS URL, allocated ports, and health status. On failure, report the failed phase and redacted evidence.
10. When the same SHA has failed state, re-running `deploykit deploy` must resume safely without requiring a separate retry command.

The public command exposes `--config`, `--dry-run`, `--no-wait`, `--json`, and `--verbose`; the defaults implement the complete path. Do not make internal server subcommands part of normal usage, and keep the flag-to-option translation a pure function so what a flag means is testable without a deployment.

A host carrying a DeployKit v0.1.x root Actions runner is migrated inside this same invocation, in this order and no other: install and handshake the replacement gateway, ask the operator explicitly, stop and disable the old service while retaining every one of its files, then delete the GitHub registration and re-read GitHub's listing to prove the routing is gone. A refusal — including a non-interactive session, which always refuses — removes nothing and dispatches nothing. Never remove a runner silently, never remove one registered against another repository, and never stop a service whose GitHub registration cannot first be identified.

## Generated workflow and GitHub constraint

GitHub requires a workflow file to exist on the default branch before `workflow_dispatch` can run. The small generated workflow therefore does not count as user-authored configuration, but it does require a protected repository change.

On first use:

- if the managed workflow is already current on the default branch, continue immediately;
- if direct installation is explicitly allowed, install the exact generated contents;
- if branch protection requires review, create or update a setup pull request, show one clear approval request, and keep waiting;
- after the pull request merges, the same invocation continues automatically. If the local process is interrupted, re-running the same command resumes safely.

Do not weaken branch protection to claim zero-touch onboarding. A future GitHub App/control plane may remove the setup-PR pause; the standalone CLI cannot safely bypass a required human review.

The generated workflow must:

- run on GitHub-hosted `ubuntu-latest`, not a persistent root self-hosted runner;
- use minimal `contents: read` permission and target-level concurrency;
- originate from the protected default branch while treating the requested application ref as separate input;
- use only full-SHA-pinned third-party Actions and disable persisted checkout credentials;
- select the target-scoped protected GitHub Environment;
- resolve and verify the exact application SHA before contacting the VPS;
- materialize the deployment key with mode `0600`, use pinned `known_hosts` with strict host-key checking, and remove temporary credentials in an `always()` cleanup step;
- connect only through the restricted DeployKit gateway;
- never expose a general root shell or pass untrusted configuration through shell interpolation.

## SSH and source acquisition

The local administrator SSH identity in `deploykit.config.yaml` is used only for the first trusted provisioning step. It must never be uploaded to GitHub.

Bootstrap creates a separate target-specific deployment key for the GitHub Environment and binds it server-side to a forced DeployKit gateway command for one repository and target. Treat that key as deployment/root-equivalent because application builds can control Docker and the host.

For application source, create a separate read-only repository deploy key on the VPS and register its public half with the configured GitHub repository. After the hosted runner enters through the restricted gateway, the VPS fetches and checks out only the requested full SHA with hooks and unsafe submodules disabled. The operator must not have to create or copy this key manually.

Never forward `GITHUB_TOKEN`, persist repository credentials in a release, or accept a branch name without independently verifying the resulting SHA.

## Environment handling

The user enters every environment value once, while DeployKit enforces the boundary internally:

- `environment.frontend` is public build-time configuration. Sync it as target Environment variables and reject secret-like names because values are embedded in browser assets.
- `environment.backend` is server-only. Sync each key as its own target-scoped GitHub Environment secret, passing values on stdin rather than argv. The remote runtime atomically writes them to `/etc/deploykit/targets/<target-id>/secrets.env` with mode `0600`.
- `environment.generated` contains names only. Generate each missing value once on the VPS and preserve it for idempotent resume.

Never put backend values in workflow YAML, generated manifests, command arguments, GitHub job outputs, `$GITHUB_ENV`, deployment state, logs, Nginx, PM2 configuration, or systemd unit contents. GitHub secrets are transport/control-plane copies; the VPS file is the runtime source of truth.

## Automatic port allocation

`hostPort: auto` is the default. The operator supplies only the internal/container port that the application actually listens on.

Allocation remains server-side under the global registry lock:

- key reservations by collision-resistant target ID and logical service;
- reuse an existing stable reservation for the same service;
- probe `127.0.0.1` before allocation;
- when a candidate is busy or reserved, increment within the configured range until a free port is found;
- atomically persist reservations before workload start;
- publish Compose, PM2, and host-accessible database ports only on `127.0.0.1`;
- pass PM2 ports through the configured environment variable;
- render Nginx upstreams and host health checks from the actual reservation.

Explicit host ports remain supported only when needed and must receive the same collision checks. Never confuse the server SSH port with an application port.

## Remote deployment engine

Preserve and reuse the existing deterministic server engine. A hosted workflow changes transport and orchestration, not the production safety gates.

The durable phases remain:

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

The remote runtime must:

- verify the gateway's fixed repository/target identity, exact SHA, and compiled-manifest digest;
- reject CNAMEs and require every direct A/AAAA answer to match the enrolled VPS before mutation;
- reserve domains and ports atomically under the server-wide lock;
- stage immutable full-SHA releases;
- install exact Node/package-manager toolchains;
- generate loopback-only Compose overrides and PM2/systemd services;
- run migration then seed hooks fatally;
- wait for all declared health checks;
- refuse unmanaged Nginx paths or `server_name` collisions;
- stage owned files atomically and run `nginx -t` before reload;
- use Certbot webroot/certonly so Certbot never rewrites managed Nginx configuration;
- retain source, state, logs, secrets, reservations, processes, and database volumes after failure;
- disable only a newly activated, ownership-verified Nginx link after failure;
- bind resume to the same commit SHA and compiled-manifest digest.

## Current architecture and migration map

| Path | Current responsibility / required direction |
| --- | --- |
| `src/index.ts` | Curated package API. The orchestrator's composition root, adapters, and operation store stay out of it: it is a product, not an API somebody can wire up halfway. |
| `src/cli.ts` | Done: bare `deploy` routes to `src/orchestrator/production.ts` and contributes only flags, a redacting reporter, and the two prompts a terminal can answer. Reach the orchestrator through that one composition root, never by assembling adapters here. |
| `src/manifest.ts`, `src/validation.ts`, `src/project-validation.ts` | Keep strict normalized validation; add compilation from the local config rather than accepting secret values in the runtime manifest. |
| `src/plan.ts` | Describe the hosted runner, restricted SSH transport, automatic ports, and compiled manifest. |
| `src/generators/github.ts` | Replace self-hosted jobs with the generic protected `ubuntu-latest` SSH workflow. |
| `src/bootstrap.ts`, `assets/bootstrap.sh` | Done: verified Ubuntu/runtime provisioning retained; Actions Runner enrollment replaced by the restricted SSH gateway, root-owned binding, and staged/active key lifecycle in `assets/gateway-binding.sh` and `assets/gateway-keys.sh`. |
| `src/github.ts` | Add Environment secret/variable reconciliation, managed-workflow setup PRs, exact-SHA resolution, dispatch, and run following. |
| `src/remote.ts` | Use structured host/user/port/key inputs, strict host keys, argv execution, and the restricted gateway protocol. |
| `src/server-cli.ts`, `src/server-runtime.ts` | Add the narrow receive/clone-and-apply gateway; never expose local bootstrap/advisor/general shell commands. |
| `src/server/apply.ts`, `src/server/state.ts`, `src/server/registry.ts` | Reuse locking/checkpoints/ports; bind state identity to commit plus compiled-manifest digest. |
| `src/server/production-driver.ts` | Reuse concrete source, Compose/PM2, migration, health, Nginx, TLS, and activation operations. |
| `src/server/secrets.ts` | Keep declared-name checks, stable generated values, atomic mode-`0600` storage, and redaction. |
| `test/fixtures/` | Continue exercising complete static/Compose/PM2/database topologies through compilation and deployment planning. |

Add a testable `src/deploy.ts` orchestrator and a strict local-config schema/compiler instead of continuing to expand the Commander actions in `src/cli.ts`.

## Security invariants

- Execute external programs as executable-plus-argv arrays with `shell: false`; never construct shell command strings from config.
- Keep secret values out of manifests, generated artifacts, process arguments, state, logs, error details, and plans.
- Validate every path, identifier, domain, ref, environment name, SSH field, persisted state object, ownership marker, and archive entry at its trust boundary.
- Use atomic write helpers, explicit modes, file/directory fsync, and the existing global/per-state/per-registry locks.
- Keep generated output deterministic and sort observable maps, routes, domains, ports, and files.
- Keep the optional AI advisor local-only, explicitly file-approved, redacted, proposal-only, and disabled in CI/server runtimes.
- Treat trusted application Docker builds and package scripts as able to control the VPS even after the persistent root runner is removed.
- Read and update `SECURITY.md` whenever changing workflow trust, SSH, keys, secrets, command execution, Nginx, DNS, or bootstrap behavior.

## Development workflow

Use Node.js 22.18.0 to match CI; the package engine minimum is Node.js 20.11. Install from the committed shrinkwrap:

```bash
npm ci
```

During iteration, run the closest test file, then finish with:

```bash
npm run check
```

`npm run check` runs lint, strict typecheck, the build, and then all Vitest suites. The build comes before the tests on purpose: `test/package.test.ts` packs and installs the real tarball, so it must see this commit's `dist/`, and a suite that rebuilt mid-run would delete `dist/` underneath the other suites that pack the package. Use `npm test -- test/<feature>.test.ts` for focused runs.

Source-tree tests do not prove the published artifact. A module sits at `src/<area>/` under test and at `dist/` or `dist/chunks/` once bundled, so never locate a package-relative file by a fixed depth — use `resolvePackageRoot` from `src/package-root.ts`, which walks up to markers only the root has. `test/package.test.ts` installs the tarball into an isolated prefix and drives the installed binary; keep it that way.

Do not hand-edit or commit `dist/`, `coverage/`, `.deploykit/`, `*.tgz`, `*.tgz.sha256`, `.env*`, or `deploykit.config.yaml`. Change generators and source templates instead.

Tests for the one-command migration must cover:

- secure local-config permissions, Git tracking refusal, strict schema, and early redaction;
- config-to-manifest compilation with no secret value leakage;
- managed workflow drift/setup PR behavior without branch-protection bypass;
- GitHub Environment variable/secret synchronization through stdin;
- exact-SHA dispatch and following the correct workflow run;
- strict known-host SSH and forced gateway identity;
- safe exact-SHA clone with hooks and unsafe submodules disabled;
- stable automatic port increment/reuse under concurrency;
- service/Nginx/TLS/health orchestration and redacted failure evidence;
- same-SHA plus manifest-digest resume;
- packed-artifact bootstrap smoke coverage;
- CLI parser, help, human/JSON output, and stable exit codes for every documented flag;
- approval-gated, recoverable legacy-runner migration, and its absence on fresh hosts;
- the packed allowlist, executable bits, installed-binary behavior, canary-free tarball, and version alignment.

Existing high-value suites are `test/cli-deploy.test.ts`, `test/orchestrator-integration.test.ts`, `test/manifest.test.ts`, `test/validation.test.ts`, `test/plan.test.ts`, `test/generators.test.ts`, `test/fixtures.test.ts`, `test/server-state-secrets.test.ts`, `test/server-apply.test.ts`, `test/server-registry.test.ts`, `test/server-primitives.test.ts`, `test/production-driver.test.ts`, `test/bootstrap.test.ts`, `test/orchestrator-bootstrap.test.ts`, and `test/server-cli.test.ts`.
