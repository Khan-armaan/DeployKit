# DeployKit contributor guide

This file applies to the entire repository. DeployKit is security-sensitive deployment software: prefer small, explicit changes, preserve deterministic output, and treat the safety properties below as part of the public contract.

## What this project is

DeployKit is a TypeScript library and CLI for deterministic, manifest-driven **first deployments** of trusted private repositories to shared Ubuntu VPS hosts. It supports Docker Compose services, Node workloads managed by PM2, static frontends, host Nginx, direct DNS checks, and Certbot.

There are three related products in this repository:

1. The package API exported from `src/index.ts`.
2. The local operator CLI in `src/cli.ts`, built as `dist/cli.js`.
3. The privileged, deliberately narrow VPS runtime in `src/server-cli.ts`, bundled with all dependencies as `dist/server-cli.cjs` through `src/server-bundle.ts`.

The optional AI advisor is a local manifest-proposal tool. It is not part of validation or deployment execution and is disabled in CI and in the server runtime. The deterministic schema, validators, planners, generators, and server driver always remain authoritative.

## End-to-end mental model

The normal path through the system is:

1. `deploykit init` inspects an application repository and writes only `deploykit.yaml` and `.github/workflows/deploykit.yml`. It may report remediation for existing application files, but it does not edit source, Dockerfiles, Compose files, or `package.json`.
2. Manifest loading uses the strict Zod schema in `src/manifest.ts`. Parsing materializes defaults and rejects unknown fields.
3. `src/validation.ts` performs cross-field semantic validation. `src/project-validation.ts` adds filesystem, package-script, package-manager, and effective Compose checks through `src/compose.ts`.
4. `deploykit plan` calls `createDeploymentPlan` in `src/plan.ts` to produce a rich, deterministic, non-mutating description of files, ports, processes, routes, TLS, secrets, and phases.
5. `deploykit server bootstrap` runs locally. It verifies the SSH host key and protected default branch, packs the current CLI, uploads it with `assets/bootstrap.sh`, and enrolls a repository-scoped root GitHub Actions runner. The installer verifies pinned artifacts before installing the standalone server bundle, and successful enrollment records the host and pinned host key through `src/local-config.ts` for later secrets/status/log operations.
6. `deploykit secrets set` sends declared values over SSH stdin. The VPS stores them outside the checkout in a mode-`0600` per-target file and generates declared missing values once.
7. `deploykit deploy` or `deploykit retry` dispatches the generated, commit-pinned workflow. That workflow must originate on the protected default branch, checks out the requested application ref, resolves its full commit SHA, and invokes `deploykit server apply` on the enrolled runner.
8. `src/server-runtime.ts` validates the project again, checks the manifest's required DeployKit version, requires root, loads enrolled-server configuration and secrets, then wires together locks, registry, DNS resolver, state store, command runner, and `ProductionDeploymentDriver`.
9. `DeploymentApplier` in `src/server/apply.ts` owns orchestration and durable checkpoints. `ProductionDeploymentDriver` in `src/server/production-driver.ts` owns the concrete mutations: immutable source staging, toolchains, builds, Compose/PM2, hooks, health checks, Nginx, Certbot, and activation.

Do not conflate the two planners:

- `createDeploymentPlan` in `src/plan.ts` is the public, descriptive plan used by the local `plan` command.
- `planDeployment` in `src/server/apply.ts` is the server execution plan used by `DeploymentApplier` and the production driver.

When deployment behavior changes, review both representations and their tests.

## How to deploy an application with DeployKit

The following is the operator runbook for the intended v0.1 first-deployment flow. Run local commands from the root of the application repository unless a step says otherwise.

> **Current checkout caveat:** `package.json` names the package `deploykit`, while `assets/bootstrap.sh` currently accepts only `@project/deploykit`. Resolve the known inconsistency documented at the end of this file before attempting real VPS enrollment; otherwise the bootstrap installer will reject the uploaded package.

### 1. Confirm the prerequisites

Prepare all of the following before starting:

- A local machine with Node.js 20.11 or newer, `git`, `ssh`, `scp`, and the GitHub CLI (`gh`) authenticated for the application repository. Node.js 22.18.0 matches this repository's CI and bootstrap pins.
- Docker Engine with Compose v2 locally if the application uses Compose. Validation evaluates the effective Compose configuration.
- A private, trusted GitHub repository with a protected default branch. Restrict write access because the enrolled Actions runner operates as root on the VPS.
- A protected GitHub Environment matching `targets.<target>.environment` in the manifest, normally `production`, with the desired approval rules.
- An Ubuntu 22.04 or 24.04 VPS on amd64 or arm64, reachable through SSH. Ports 80 and 443 must reach Nginx; preserve SSH access if enabling UFW.
- Direct DNS A and/or AAAA records for the primary domain and every alias. Do not use CNAMEs, CDN proxying, or provider-specific orange-cloud/proxy modes.
- Production-ready application assets. DeployKit validates existing Dockerfiles, Compose files, Node scripts, health endpoints, and build output; it does not create or repair them.

### 2. Install and verify the CLI

Install the released package on the local operator machine:

```bash
npm install --global deploykit
deploykit --version
deploykit --help
```

Keep the local CLI version compatible with `metadata.requiredVersion` in the application manifest and with the runtime that will be installed on the VPS.

### 3. Prepare the application repository

Before initialization:

- Remove existing Compose `ports`, `container_name`, `network_mode`, and unsupported scaling. DeployKit generates its own loopback-only Compose override.
- Ensure each Compose workload has an image or production Docker build and an appropriate health-check strategy.
- Ensure each PM2/static Node workload has the declared install, build, and start scripts. pnpm, Yarn, and Bun projects need an exact matching `packageManager` value in `package.json`.
- Ensure a Compose database uses and mounts a named volume.
- Decide the stable project name, target name, runner label, domains, logical routes, required secret names, and whether the frontend is static or a proxied service.

### 4. Initialize DeployKit

From the application repository root, run the guided initializer:

```bash
cd /path/to/application
deploykit init
```

It creates only:

```text
deploykit.yaml
.github/workflows/deploykit.yml
```

Review `deploykit.yaml` carefully. Logical service names in `services` are DeployKit names; a Compose service also points to its existing Compose service name through `service`. Ensure the target's `runnerLabel` is the exact label that will be used during bootstrap, and keep secret values out of the manifest. Use `docs/manifest.md` in this repository as the field reference.

Initialization can succeed while reporting application-owned remediation. That is expected: fix the referenced application or Compose files manually before continuing.

### 5. Validate and inspect the plan

Run full validation, including effective Compose inspection, until it succeeds:

```bash
deploykit validate
deploykit plan --target production --ref main
```

Replace `production` and `main` with the configured target and intended application ref. Review the plan's domains, stable loopback ports, processes, hooks, health checks, Nginx routes, public frontend values, secrets, files, and deployment phases.

`deploykit validate --skip-compose` is useful only for limited diagnostics; it is not a final deployment gate. The deploy command performs full validation again.

### 6. Commit and protect the deployment contract

Commit the normalized manifest and generated workflow on a feature branch:

```bash
git switch -c configure-deploykit
git add deploykit.yaml .github/workflows/deploykit.yml
git commit -m "Configure DeployKit deployment"
git push --set-upstream origin configure-deploykit
```

Land the change through the repository's normal reviewed pull-request process. Protect the default branch before enrollment, and ensure the generated workflow is present there before deployment. Require review for changes to `.github/workflows/deploykit.yml`, for example with CODEOWNERS. The workflow definition always comes from the protected default branch; its `ref` input selects only the application code to check out.

### 7. Enroll the VPS

Confirm the enrollment plan without network or server mutations first:

```bash
deploykit server bootstrap \
  --host ubuntu@vps.example.com \
  --repo owner/private-repository \
  --label production-vps \
  --accept-root-runner-risk \
  --dry-run
```

Then remove `--dry-run` to perform enrollment:

```bash
deploykit server bootstrap \
  --host ubuntu@vps.example.com \
  --repo owner/private-repository \
  --label production-vps \
  --accept-root-runner-risk
```

Inspect and approve the displayed ED25519 SSH host-key fingerprint. Use `--accept-host-key` only when the fingerprint was verified through a separate trusted channel and non-interactive enrollment is intentional. Add `--configure-firewall` only when DeployKit should configure UFW and the host's SSH access is already safe.

Successful enrollment installs the verified runtime and repo-scoped runner, saves the server's public addresses and port range on the VPS, and records the host plus pinned host key in the local DeployKit configuration. Run later secrets/status/log commands from this operator machine, or provide the same protected local configuration through `DEPLOYKIT_CONFIG_PATH`.

### 8. Configure and verify direct DNS

Point the target's primary domain and all aliases directly at the enrolled VPS public address or addresses. Wait for DNS propagation before deploying. DeployKit rejects CNAMEs, empty answers, proxied records, an address belonging to another host, or any mixture where one returned A/AAAA address does not match the enrolled server.

DNS verification occurs before source staging or workload mutation.

### 9. Upload required secrets

Every required name must be declared in `secrets.required`; generated names belong in `secrets.generated`. `CERTBOT_EMAIL` is required for TLS. To enter required values using hidden interactive prompts, run:

```bash
deploykit secrets set --target production
```

Alternatively, provide a protected env file outside version control:

```bash
deploykit secrets set --target production --file /secure/path/production.env
```

The file uses one `NAME=value` entry per line, for example:

```dotenv
CERTBOT_EMAIL=ops@example.com
APP_SECRET=replace-with-the-real-value
```

`APP_SECRET` is only an example; every supplied name must be declared by the manifest. Do not supply generated values unless deliberately preserving an existing value. Never commit the env file.

Confirm that the target has every required and generated value:

```bash
deploykit secrets check --target production
```

### 10. Optionally exercise the server-side dry run

The local `plan` command does not contact the VPS. After the runner and workflow exist, a workflow dry run additionally exercises server-side validation and planning without creating deployment state or mutating workloads:

```bash
deploykit deploy --target production --ref main --dry-run
```

This still dispatches GitHub Actions and requires the self-hosted runner to be online. It returns before checking target secrets or DNS, so it does not replace `secrets check` or direct-DNS readiness. Review the workflow output before the real deployment.

### 11. Dispatch the first deployment

Deploy the selected application branch, tag, or full commit SHA. The selected ref must also be reviewed and trusted: its package scripts, Docker builds, and application code execute on a root-controlled runner and can take control of the VPS.

```bash
deploykit deploy --target production --ref main
```

If repository inference is unavailable, specify it explicitly:

```bash
deploykit deploy \
  --target production \
  --ref main \
  --repo owner/private-repository
```

The command dispatches the workflow; it does not wait locally for completion. GitHub Actions checks out the requested ref without persisted credentials, resolves the immutable commit SHA, and runs the deterministic server state machine.

### 12. Monitor and verify the result

Watch the GitHub Actions run and inspect server state and redacted logs from the enrolled operator machine:

```bash
deploykit status --target production
deploykit logs --target production --tail 200
```

A completed deployment has status `succeeded` and a final `complete` checkpoint. Also verify the HTTPS site, expected routes, application health, migration results, WebSocket/SSE or upload behavior where configured, and that host-facing workload/database sockets bind only to `127.0.0.1`.

### 13. Retry only a failed deployment

If the first deployment fails, fix only the external or runtime condition that caused the failure, then retry the exact commit recorded by the failed run:

```bash
deploykit retry \
  --target production \
  --ref 0123456789abcdef0123456789abcdef01234567
```

Prefer the full failed commit SHA rather than a moving branch name. Retry rechecks DNS and reservations, skips durable completed phases, and resumes retained state. A different commit is rejected.

After a target succeeds, v0.1 refuses another deployment to that target. Updates, rollback, and deletion are outside the current product boundary.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Curated package API. The package exposes only the root export, so intentional public additions must be re-exported here or from one of its barrel modules. |
| `src/cli.ts` | Full local command surface, orchestration, prompts, reporting, and GitHub/SSH entrypoints. |
| `src/server-cli.ts`, `src/server-bundle.ts` | Restricted privileged command surface and its self-contained CommonJS entrypoint. |
| `src/manifest.ts` | Canonical `deploykit/v1alpha1` schema, normalized defaults, YAML I/O, and inferred public types. |
| `src/validation.ts` | Schema and cross-field semantic issues. Keep errors aggregated and structured. |
| `src/project-validation.ts`, `src/compose.ts` | Repository-aware validation and effective `docker compose config --no-interpolate` inspection. |
| `src/init.ts` | Conservative project discovery and starter-manifest creation. |
| `src/plan.ts` | Public deterministic deployment plan. |
| `src/generators/` | Pure renderers for the GitHub workflow, Compose override, Nginx site, and PM2 ecosystem. |
| `src/bootstrap.ts`, `assets/bootstrap.sh` | Local enrollment orchestration and the actual Ubuntu installer. |
| `src/github.ts`, `src/local-config.ts`, `src/remote.ts`, `src/secrets-client.ts`, `src/server-inspect.ts` | Workflow dispatch, enrolled-host lookup, safe local-to-server transport, and remote inspection. |
| `src/advisor/` | Local-only, explicitly approved, redacted manifest patch proposals. |
| `src/server/` | Server state machine, locks, registry, secrets, release management, DNS, toolchains, commands, generators' execution, and production driver. |
| `test/*.test.ts` | Feature-level Vitest suites. |
| `test/fixtures/` | Three representative application topologies exercised end to end without infrastructure mutation. |
| `docs/manifest.md` | Human reference for the manifest contract. |
| `docs/acceptance.md` | Manual disposable-VPS acceptance matrix; not part of normal CI. |
| `SECURITY.md` | Root-runner threat model and operational security requirements. |
| `scripts/` | Build, standalone server-bundle, and release-package scripts. |

Two similarly named bootstrap modules serve different purposes: `src/bootstrap.ts` performs local remote enrollment, while `src/server/bootstrap.ts` contains testable Ubuntu facts and bootstrap planning primitives.

## Domain and runtime invariants

### Manifest and validation

- `src/manifest.ts` is the source of truth for structure. Its objects are strict, its unions are discriminated, and its defaults normalize the value used by downstream code. Keep `docs/manifest.md` synchronized.
- Validation is intentionally layered. A new safety rule usually belongs in schema/semantic or project validation as well as runtime defense; do not make a generator or production command the only place an invalid project is rejected.
- Return stable `ValidationIssue` objects with a code, path, severity, message, and useful remediation. Preserve aggregation and deterministic sorting so users can fix multiple issues in one pass.
- The manifest contains secret names, never secret values. Static `publicEnvironment` and target `publicOverrides` are browser-visible and must reject secret-like or declared-secret names.
- Compose files and application package files are owned by the application. DeployKit validates them and generates an overlay; it does not rewrite them.

### Workloads, routes, and generated artifacts

- Existing Compose `ports`, `container_name`, `network_mode`, and replica counts other than one are incompatible with DeployKit ownership. A Compose database must use and mount its declared named volume.
- Host-accessible services bind only to `127.0.0.1`. Private Compose services and databases stay on the Compose network unless routing or a PM2 consumer requires a reserved loopback port.
- PM2 API/SSR services have a port environment variable and use HTTP, TCP, or command health checks. PM2 workers have no upstream port and use process or command health checks.
- Node versions are exact. pnpm, Yarn, and Bun workloads require an exact, matching `packageManager` declaration in their application `package.json`; npm comes from the exact Node distribution and may also be pinned.
- Hooks and external commands are executable-plus-argv arrays, never shell command strings. Migrations run before seed, and both are fatal.
- Routes are target/domain-aware. Preserve that filtering when planning ports, generating Compose bindings, and rendering Nginx; a route belonging only to another target must not expose a service on the current target.
- Keep generated output deterministic. Sort maps, domains, ports, routes, and files where ordering is observable. Update the relevant generator and fixture tests whenever rendered output changes.

### Deployment state machine

The durable server phases are ordered exactly as follows:

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

Preserve these semantics:

- State is versioned, target-bound, full-commit-SHA-bound, atomically written, and has contiguous checkpoints.
- v0.1 allows one successful deployment per target. A running deployment cannot be started again; a failed deployment can resume only the same commit and only with explicit resume; a successful deployment refuses all further applies.
- Retry rechecks preconditions such as DNS, idempotently reconciles reservations, and skips already checkpointed mutating phases. It retains earlier failure history.
- Releases are immutable directories keyed by the full commit SHA and activated with an atomic `current` symlink.
- The deployment lock is server-wide, not per target, because Nginx validation/reload and host resources are global. The registry also has its own lock, preserves stable service ports, probes real loopback availability, and rejects domain or port collisions without partial writes.
- Failure records and logs are redacted. Failure cleanup may disable only the newly activated, ownership-verified Nginx link. Keep source, state, logs, secrets, reservations, workload state, containers, and database volumes for same-commit retry.
- Do not add implicit rollback, destructive cleanup, successful-target updates, or deletion to the v0.1 path.

Changing phases requires coordinated edits to `src/server/state.ts`, `src/server/apply.ts`, `src/server/production-driver.ts`, the public plan if applicable, state/apply/driver tests, and `docs/acceptance.md`.

## Security properties to preserve

- The repository-scoped root runner is explicitly not a sandbox. Preserve the risk acknowledgement, protected-default-branch checks, GitHub Environment boundary, repo-scoped labels, pinned Action/tool versions, artifact checksums, and restricted server CLI.
- Direct DNS verification happens before workload mutation. CNAMEs are rejected; every A/AAAA answer must match an enrolled server address.
- Secrets live under `/etc/deploykit/targets/<target-id>/secrets.env`, not in a release. Accept only declared names, write atomically with mode `0600`, keep generated values stable, and redact values from stdout, stderr, errors, structured details, state, and event logs.
- Never put secrets into process arguments or generated Nginx, Compose, PM2, workflow, or systemd content. Certbot's email is passed through stdin.
- `ProcessCommandRunner` deliberately uses `spawn` with `shell: false`. Keep commands as argv arrays and preserve NUL/path/name validation, bounded output, timeouts, minimal environments, and redaction.
- PM2 workloads run as a per-target non-login Unix user with a clean environment and hardened systemd unit. Validate that working directories cannot escape the staged release.
- Nginx files need a DeployKit ownership marker. Refuse unmanaged files, symlinks, or `server_name` collisions; stage atomically; run `nginx -t` before every reload. Certbot uses webroot/certonly and never edits the managed Nginx configuration.
- Advisor inputs must be exact user-approved repository-relative files. Continue rejecting credential-like paths and symlink escapes, redacting known credential patterns and exact values, validating the proposed merge patch, and blocking advisor execution in CI/server contexts.
- Preserve stable public `DK_*` errors and detailed internal `SERVER_*` errors. User-visible failures should pass through `src/cli-errors.ts`/`src/output.ts`; do not leak sensitive details or replace contract errors with arbitrary prose.

Read `SECURITY.md` before modifying bootstrap, workflow generation, command execution, secrets, file ownership/modes, Nginx, DNS, advisor input, or server runtime code.

## Development workflow

Use Node.js 22.18.0 to match CI and the pinned bootstrap toolchain; the package engine minimum is Node.js 20.11. Install from the committed shrinkwrap:

```bash
npm ci
```

Useful commands are:

```bash
npm run lint
npm run typecheck
npm test
npm run test:watch
npm run build
npm run check
```

`npm run check` runs lint, typecheck, the full Vitest suite, and the build; it is the final local gate and the CI gate. During iteration, run the closest suite first, for example:

```bash
npm test -- test/manifest.test.ts
```

For packaging changes, also run `npm pack --dry-run --json`. `npm run release:pack` creates a real ignored tarball and checksum, so reserve it for release work.

The build does the following:

- `scripts/build.mjs` deletes and recreates ignored `dist/`, bundles `src/cli.ts` and `src/index.ts` as Node 20 ESM with external dependencies, emits declarations, and marks the CLI executable.
- `scripts/build-server-bundle.mjs` creates a self-contained executable CommonJS `dist/server-cli.cjs` and verifies that its reported version matches `package.json`.

Never hand-edit or commit generated `dist/`, `coverage/`, `.deploykit/`, `*.tgz`, or `*.tgz.sha256` content. Never commit `.env` files. Change generator source rather than generated application artifacts.

## Test strategy

- Add or extend the nearest `test/*.test.ts` suite. Tests import Vitest APIs explicitly and should remain deterministic, isolated, and network-free.
- Use temporary roots plus `RecordingCommandRunner`, in-process locks, fake resolvers/health clients/drivers, and dry-run modes for privileged/server behavior. Do not invoke real Docker, SSH, GitHub dispatch, systemd, Nginx, Certbot, or VPS enrollment from unit tests.
- `test/fixtures.test.ts` runs the static-plus-Compose, container-plus-external-database, and PM2-plus-Compose-database fixtures through parsing, validation, planning, and deterministic generation while checking that application files do not change. Add or update a fixture when a feature affects a complete topology.
- `test/bootstrap.test.ts` performs local plan checks and `bash -n` validation of `assets/bootstrap.sh`; the manual host matrix belongs in `docs/acceptance.md`.
- Real infrastructure checks require explicit scope, disposable Ubuntu 22.04/24.04 amd64/arm64 hosts, staging DNS, and Let's Encrypt staging. Never run the acceptance procedure against production as part of ordinary verification.

High-value suites by area:

| Change | Minimum focused coverage |
| --- | --- |
| Manifest/schema/defaults | `test/manifest.test.ts`, `test/validation.test.ts` |
| Filesystem/Compose validation | `test/validation.test.ts`, `test/compose.test.ts`, `test/fixtures.test.ts` |
| Public planning | `test/plan.test.ts` |
| Generated workflow/Nginx/PM2/Compose | `test/generators.test.ts`, `test/fixtures.test.ts` |
| CLI or error contract | `test/cli.test.ts`, and `test/server-cli.test.ts` for privileged commands |
| Advisor | `test/advisor.test.ts` |
| State, retry, locks, registry, secrets | `test/server-state-secrets.test.ts`, `test/server-apply.test.ts`, `test/server-registry.test.ts`, `test/server-primitives.test.ts` |
| Production mutations/toolchains | `test/production-driver.test.ts`, `test/package-manager.test.ts` |
| Bootstrap/installer | `test/bootstrap.test.ts` plus explicitly scoped acceptance tests |

## Code conventions

- The project is strict ESM TypeScript (`NodeNext`, `strict`, and `noUncheckedIndexedAccess`). Use `node:` imports for built-ins and explicit `.js` suffixes for relative imports, including from `.ts` files.
- Follow the existing style: named exports, `import type` for type-only dependencies, immutable public shapes with `readonly`, two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs.
- Keep pure parsing, validation, planning, and rendering separate from side effects. Side-effecting server code should remain dependency-injected through interfaces such as command runners, locks, registries, DNS resolvers, health clients, toolchain providers, and deployment drivers.
- Validate at trust boundaries: manifest input, YAML/JSON, paths, identifiers, domains, refs, environment names, package-manager declarations, remote arguments, generated ownership markers, and persisted state.
- Use atomic write helpers and explicit modes for managed state/configuration. Do not introduce direct writes where a server or local atomic helper already exists.
- Do not use shell interpolation for external commands. Preserve argument arrays in implementation and tests.
- Public behavior changes need stable errors, human and `--json` output consideration, documentation updates, and public re-exports where appropriate.

## Coordinated change checklist

Before declaring a change complete, follow the relevant dependency chain:

- A manifest field usually requires schema/types, defaults, semantic validation, project validation where applicable, public planning, server planning/runtime, generators, docs, unit tests, and at least one topology fixture.
- A CLI command requires help/parse/error tests. A command needed on the VPS also requires an explicit decision about the narrow `src/server-cli.ts` surface; do not expose local bootstrap, advisor, GitHub, or arbitrary utility commands there.
- A generated-artifact change requires deterministic generator tests and a fixture pass. Keep generated GitHub Actions pinned to full commit SHAs.
- A server path, package, tool version, or checksum change may be duplicated across `src/version.ts`, `src/server/paths.ts`, `src/bootstrap.ts`, `assets/bootstrap.sh`, build/release workflows, docs, and tests. Search the repository for every old value before editing.
- A package version change must keep `package.json`, `npm-shrinkwrap.json`, `src/version.ts`, changelog/release material, tests, and the standalone bundle version check aligned.
- Dependency changes must retain exact versions in `package.json` and update `npm-shrinkwrap.json`.

The current product boundary intentionally excludes successful-target updates, rollback, deletion, DNS-provider mutation, backups/restores, Kubernetes, cloud control planes, non-Ubuntu hosts, non-Node PM2 workloads, and automatic server upgrades. Do not silently broaden that boundary while implementing an adjacent change.

## Known repository inconsistency

The current package metadata names the npm package `deploykit`, but `assets/bootstrap.sh` accepts only `@project/deploykit` when it inspects the uploaded tarball. As written, a real bootstrap will reject the package even though the unit suite and build pass. Treat this as an existing defect, not an intended package-name rule; align the package and installer expectations and add an installer regression test before relying on real enrollment.
