# DeployKit

DeployKit is a TypeScript library and CLI for deterministic deployments of trusted private GitHub repositories to Ubuntu VPS hosts. The intended operator experience is one local configuration file and one public command:

```bash
deploykit deploy
```

DeployKit handles validation, GitHub Actions, protected variables and secrets, VPS provisioning, exact-commit source checkout, Docker Compose or PM2 services, static frontends, automatic ports, Nginx, TLS, health checks, and safe resume.

> [!IMPORTANT]
> The one-file workflow below is what v0.1.4 does: `deploykit deploy` reads `deploykit.config.yaml`, compiles it, reconciles GitHub, provisions the VPS gateway, dispatches the workflow, and reports the result. It is **not yet accepted as production-ready**. The disposable-VPS acceptance matrix in [`docs/acceptance.md`](docs/acceptance.md) is the remaining gate — that document now names, per row, which automated suite proves the logic and exactly what is left for real hardware — and only after it passes may this be described as production-ready. v0.1.3 and earlier still require the legacy flags and self-hosted-runner setup; those commands remain available here for projects already on that path.

## Contents

- [What the user needs](#what-the-user-needs) · [Install](#install)
- [First deployment](#first-deployment) — the one-file, one-command path
- [Command reference](#command-reference) — every terminal command, flag, and exit code
- [Using DeployKit as a library](#using-deploykit-as-a-library) — the exported deployment contract
- [What `deploykit deploy` handles](#what-deploykit-deploy-handles) · [Automatic port allocation](#automatic-port-allocation) · [Environment and secret handling](#environment-and-secret-handling)
- [Migrating a host bootstrapped by v0.1.x](#migrating-a-host-bootstrapped-by-v01x) · [Legacy `deploykit.yaml` commands](#legacy-deploykityaml-commands)
- [Security model](#security-model) · [Product boundary](#product-boundary)

## What the user needs

Before deployment, the user must control these external resources:

- A trusted application repository whose deployable commit is pushed to GitHub.
- A protected default branch and an authenticated GitHub CLI session with permission to manage the repository, Actions, deploy keys, and the target Environment.
- An Ubuntu 22.04 or 24.04 amd64/arm64 VPS reachable with an administrator SSH identity.
- That administrator account must be able to run `sudo -n true` — root, or an account with passwordless sudo. DeployKit never opens an interactive prompt on the host.
- The administrator private key must have **no passphrase**, and `server.host`/`server.port` must be the real address rather than a `~/.ssh/config` alias. Every administrator connection runs with `-F /dev/null`, `BatchMode=yes`, `IdentityAgent=none`, and `PasswordAuthentication=no`, so your SSH config, your agent, and any password prompt are all deliberately out of reach: the only credential that can open the connection is the file named by `server.identityFile`.
- The VPS ED25519 host-key fingerprint verified through a trusted channel.
- Direct DNS A and/or AAAA records for every configured domain pointing to the VPS. CNAME and proxied/CDN records are not accepted.
- Production-ready application build inputs, such as Dockerfiles, Compose files, package scripts, health endpoints, and static build output settings.

These are infrastructure and application prerequisites. They do not introduce additional DeployKit setup commands.

## Install

Install the CLI once:

```bash
npm install --global @deploykit001/deploykit
```

Users who do not want a global installation can invoke the same binary with:

```bash
npx --yes @deploykit001/deploykit deploy
```

If `deploykit` is not found after a global install, npm's global `bin` directory is not on `PATH`. Print it and add it:

```bash
npm bin --global          # e.g. /usr/local/bin or ~/.npm-global/bin
export PATH="$(npm bin --global):$PATH"
```

Add that `export` line to `~/.zshrc` or `~/.bashrc` to make it permanent, or skip the global install entirely and use the `npx` form above. Do not install DeployKit with `sudo npm install --global`; a root-owned npm prefix is a common cause of a binary that exists but is not executable by the operator who deploys.

## First deployment

### 1. Run DeployKit from the application repository

```bash
cd /path/to/application
deploykit deploy
```

If `deploykit.config.yaml` is missing, DeployKit obtains the template automatically:

1. The npm package implementing this workflow contains `assets/deploykit.config.example.yaml`.
2. The CLI copies that bundled asset to `./deploykit.config.yaml` atomically without overwriting an existing file.
3. It creates the file with mode `0600` and adds it to the repository-local Git exclude file without changing the tracked `.gitignore`.
4. It verifies that the file is untracked, unstaged, non-symlinked, user-owned, and not readable by other users.
5. In an interactive terminal, it waits without making remote changes while the user fills in the file.
6. It then parses the file strictly, rejecting unknown fields, non-string environment values, reserved `DEPLOYKIT_*` names, secret-like public frontend names, overlapping names across partitions, ambiguous or unresolved routes, unsafe refs and paths, and any bundled example placeholder that was never replaced.

The user never needs to find a global npm directory or manually copy an asset. In a non-interactive environment, DeployKit creates the file and exits with an instruction to fill it and rerun the same command.

The source template can also be inspected at [`assets/deploykit.config.example.yaml`](assets/deploykit.config.example.yaml), but manual copying is only a fallback.

### 2. Fill in the single configuration file

Edit only `deploykit.config.yaml`. It contains the GitHub repository/ref, target, VPS connection, domains, services, frontend, routes, and all public and private environment values.

An abbreviated example is shown below; use the bundled template for the complete shape:

```yaml
apiVersion: deploykit/config/v1alpha1
kind: Deployment

project:
  name: example-app
  repository: owner/private-repository
  ref: main

target:
  name: production
  githubEnvironment: deploykit-production
  primaryDomain: app.example.com
  aliases:
    - www.app.example.com

server:
  host: vps.example.com
  user: ubuntu
  port: 22
  identityFile: /absolute/path/to/.ssh/example-production
  hostKeyFingerprint: SHA256:replace-with-verified-fingerprint

compose:
  files:
    - compose.yaml

services:
  backend:
    type: compose
    service: api
    internalPort: 3000
    hostPort: auto
    healthCheck:
      type: http
      path: /health

environment:
  frontend:
    VITE_API_BASE_URL: /api
  backend:
    NODE_ENV: production
    CERTBOT_EMAIL: ops@example.com
    DATABASE_URL: postgresql://replace-with-real-credentials
    SESSION_SECRET: replace-with-a-long-random-value
  generated:
    - INTERNAL_SIGNING_KEY
```

Important configuration rules:

- `environment.frontend` values are public and can be embedded in browser assets.
- `environment.backend` values are private server/runtime values. DeployKit treats every entry as protected and redacts its value.
- `environment.generated` contains names only; the VPS creates missing values once and preserves them across retry.
- `server.identityFile` is used locally for initial provisioning and is never uploaded to GitHub.
- `server.hostKeyFingerprint` pins the VPS identity; DeployKit must not silently trust a changed host key.
- `hostPort: auto` means the user supplies only the application's internal listening port.

### 3. Confirm at the waiting prompt

After saving the configuration, return to the waiting terminal and confirm. DeployKit securely reopens and validates the file, then continues the deployment in that same invocation.

If the terminal was closed or the first run was non-interactive, run the same command again:

```bash
deploykit deploy
```

No separate `init`, `validate`, `plan`, `server bootstrap`, `secrets set`, `retry`, `status`, or `logs` command is required for the normal path.

### 4. Review the setup pull request, if your branch protection asks for one

GitHub will not dispatch a workflow that is not already on the default branch. If branch protection requires review before the generated workflow can enter it, DeployKit creates or updates **one** setup pull request containing only three DeployKit-owned files and waits.

Approve and merge it. The same invocation continues automatically; if the process was interrupted, rerunning `deploykit deploy` picks up from GitHub's own state. DeployKit never merges, approves, or bypasses protection for you.

### 5. Everything else happens automatically

DeployKit provisions the VPS gateway, synchronizes the target GitHub Environment, dispatches the workflow for the exact commit, follows that specific run, and inspects the result. On success the command reports:

- the exact deployed commit SHA and runtime-manifest digest;
- the public HTTPS URL;
- the stable loopback ports allocated to host-facing services;
- workload and route health results;
- the GitHub run URL, so you never need to read raw workflow logs.

If deployment fails, running `deploykit deploy` again for the same commit and compiled configuration resumes after the last durable checkpoint. **There is no separate retry command for a `deploykit.config.yaml` deployment** — `deploykit retry`, `deploykit status`, and `deploykit logs` exist only for legacy `deploykit.yaml` projects. Every failure carries a stable `DK_*` code, an exit code, and a one-line resume instruction; the full catalog is in [`docs/orchestrator-contracts.md`](docs/orchestrator-contracts.md).

## Command reference

### `deploykit deploy`

The whole product. Everything else on this page is optional.

```text
deploykit deploy [--config <path>] [--dry-run] [--no-wait] [--json] [--verbose]
```

| Flag | Effect |
| --- | --- |
| `--config <path>` | Use the `deploykit.config.yaml` at another application repository's root instead of the current directory's. The path must be that repository's own root config; DeployKit will not read a deployment config from anywhere else. |
| `--dry-run` | Inspect every boundary — config, GitHub, the VPS — and mutate nothing, locally or remotely. Nothing is created, uploaded, rotated, dispatched, or persisted. |
| `--no-wait` | Dispatch, correlate the exact workflow run, and stop instead of following it to completion. It also refuses to block on a setup pull request review, stopping resumably instead. |
| `--json` | Emit one machine-readable JSON object per event and one final result envelope. |
| `--verbose` | Include diagnostic detail objects in output. |

```bash
deploykit deploy                     # the normal path
deploykit deploy --dry-run           # inspect everything, change nothing
deploykit deploy --no-wait --json    # dispatch and hand the run URL to a script
deploykit deploy --config ~/work/api/deploykit.config.yaml
```

### Global flags

| Flag | Effect |
| --- | --- |
| `-V`, `--version` | Print the installed DeployKit version. |
| `-h`, `--help` | Print help. `deploykit <command> --help` works for every command. |
| `--json` | Machine-readable output for any command. |
| `--verbose` | Include diagnostic detail objects. |
| `--manifest <path>` | Legacy `deploykit.yaml` path. Applies only to the legacy commands below. |

### Optional diagnostics

None of these are needed for a normal deployment, and none of them mutate a remote system. They read a legacy `deploykit.yaml` (`--manifest <path>` picks a different one); `deploykit deploy` runs the equivalent checks on the compiled result of your `deploykit.config.yaml` itself.

| Command | Purpose |
| --- | --- |
| `deploykit validate` | Validate a legacy `deploykit.yaml` against the schema, the repository files, and the effective Compose configuration. `--skip-compose` omits the `docker compose config` inspection. |
| `deploykit plan --target <name>` | Print the deterministic, non-mutating deployment plan for a legacy manifest. `--ref`, `--commit`, `--certbot-staging` refine it. |
| `deploykit advise --provider <openai\|anthropic> --model <id> --file <paths…>` | Ask a local-only, file-approved, redacted advisor for a validated manifest proposal. Proposal-only unless you pass `--write`. |

### Legacy manifest commands

Kept working for projects already initialized on the v0.1 path; see [Legacy `deploykit.yaml` commands](#legacy-deploykityaml-commands) below for when they apply.

| Command | Purpose |
| --- | --- |
| `deploykit init` | Create a `deploykit.yaml` and the pinned workflow by inspecting the repository. |
| `deploykit deploy --target <name> --ref <branch>` | Dispatch a legacy deployment. `--repo`, `--dry-run` refine it. |
| `deploykit retry --target <name> --ref <branch>` | Resume a failed legacy first deployment. |
| `deploykit status --target <name>` | Inspect deployment state on the target server. |
| `deploykit logs --target <name>` | Read redacted deployment logs. `--tail <lines>` bounds the output. |
| `deploykit secrets set --target <name>` | Transfer target secrets over SSH stdin. `--file <path>` reads them from a file. |
| `deploykit secrets check --target <name>` | Confirm every declared secret is present. |
| `deploykit server bootstrap …` | Install the restricted gateway on a VPS by hand. `deploykit deploy` does this for you. |

### Internal server commands

`deploykit server apply|secrets-write|secrets-check|target-status|target-logs` and the `deploykit gateway` forced command run **on the VPS**, inside the standalone runtime, and are invoked by DeployKit rather than by you. They are listed here so an operator reading a process list or an audit log knows what they are.

### Exit codes

Stable across every command, so a script can branch on them without parsing text.

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | A failure that a rerun may resolve — a transient API error, a moved ref, a failed workflow run, a failed deployment phase. |
| `2` | The config was just created and needs your values, or the command line was wrong. |
| `3` | Invalid input: an insecure, malformed, placeholder-bearing config or an invalid project. |
| `4` | A conflict, or an external system that is unreachable or refused you. |
| `5` | The target already completed its first deployment. |
| `6` | A declared secret was missing. |
| `7` | A security acknowledgement was required and refused. |
| `8` | Unsupported: a host, a protocol version, or a build that cannot do what was asked. |
| `9` | Waiting on a human, an Environment approval, a rate-limit window, or a run. |

Every failure also carries a stable `DK_*` code and a one-line resume instruction. In `--json` mode the final envelope is `{"ok": false, "code": "DK_…", "message": …, "details": {"recovery": …, "resume": …}}`; the full catalog is in [`docs/orchestrator-contracts.md`](docs/orchestrator-contracts.md).

## Using DeployKit as a library

```bash
npm install @deploykit001/deploykit
```

The package is ESM and ships its own type declarations. It exposes the **deployment contract** — the shapes, the canonical bytes, the digest, and the failure vocabulary — so you can validate a config, compile it, or interpret `deploykit deploy --json` output in your own tooling:

```ts
import {
  loadOperatorConfig,        // scaffold + securely read deploykit.config.yaml
  parseOperatorConfig,       // strict schema + semantic validation
  compileRuntimeManifest,    // → secret-free runtime manifest + digest
  canonicalRuntimeManifestBytes,
  computeManifestDigest,
  validateCompiledProject,   // filesystem, scripts, Compose, routes, health
  failureContract,           // DK_* → boundary, recovery, mutation boundary
  recoveryInstruction,
  VERSION,
  type OrchestratorResult,
  type CompiledRuntimeManifest,
} from "@deploykit001/deploykit";

const parsed = parseOperatorConfig(document);
const compiled = compileRuntimeManifest(parsed);

console.log(compiled.targetId, compiled.digest.value);
// Two configs that differ only in a backend secret *value* compile to
// identical bytes and the same digest. That is what makes a resume safe.
```

Also exported: the legacy manifest parser and validators (`parseManifest`, `assertValidManifest`, `validateProject`, `createDeploymentPlan`), the workflow/Compose/Nginx/PM2 generators, the package-manager adapters, the server runtime primitives, and the local-only advisor.

**Deliberately not exported:** the orchestrator's composition root, its GitHub/SSH/gateway adapters, and its operation store. Running a deployment is what the CLI is for — a half-wired orchestrator points at somebody's production host, and there is no safe way to hand that out as an API.

## What `deploykit deploy` handles

The single public command performs the following work internally:

1. Securely parses the local configuration and separates public frontend values from private backend values.
2. Validates package scripts, exact Node/package-manager versions, effective Compose configuration, health checks, routes, domains, and SSH settings.
3. Resolves the configured Git ref to an immutable 40-character commit SHA.
4. Generates a secret-free runtime manifest and a deterministic, full-SHA-pinned GitHub workflow.
5. Reconciles the protected GitHub Environment, public variables, encrypted backend secrets, deployment key, and read-only repository deploy key.
6. Provisions the supported VPS with a checksum-verified runtime and a restricted repository/target-bound SSH gateway.
7. Dispatches a GitHub-hosted `ubuntu-latest` workflow for the exact commit and follows that run to completion.
8. Connects to the VPS with strict host-key checking. The VPS clones only the requested full SHA using its read-only deploy key.
9. Reserves ports, installs exact toolchains, builds and starts Compose/PM2 workloads, runs migrations, and verifies health.
10. Generates owned Nginx configuration, validates it with `nginx -t`, issues TLS with Certbot webroot/certonly, activates the release atomically, and reports the result.

The workflow uses a restricted DeployKit gateway rather than a persistent root self-hosted GitHub runner or a general-purpose root SSH shell.

## Automatic port allocation

For `hostPort: auto`, the server owns allocation under a global lock:

- reuse the existing stable reservation for the same target and logical service;
- probe `127.0.0.1` before allocation;
- if a candidate is already bound or reserved, increment it until a free port is found within the configured range;
- persist the reservation atomically before starting the workload;
- expose Compose, PM2, and host-accessible database services only on `127.0.0.1`;
- render Nginx upstreams and health checks from the actual allocated port.

The SSH port and application ports are independent. An explicit application host port remains possible but receives the same collision checks.

## Environment and secret handling

The user enters every environment value once in `deploykit.config.yaml`:

- Public frontend values are synchronized as target GitHub Environment variables and passed only to the frontend build.
- Private backend values are synchronized as individual target GitHub Environment secrets and transported without placing values in process arguments.
- The VPS stores runtime values outside the checkout at `/etc/deploykit/targets/<target-id>/secrets.env` with mode `0600`.
- Generated values are created once on the VPS and remain stable during same-commit resume.

Backend values must never appear in generated manifests, workflow YAML, command arguments, job outputs, deployment state, logs, Nginx configuration, PM2 configuration, systemd units, or release archives.

## How a deployment works

DeployKit is split into three trust zones:

1. **Local CLI and package API:** parse the one local configuration, validate the application, compile a secret-free manifest, reconcile GitHub, and coordinate the deployment.
2. **GitHub-hosted workflow:** resolve the exact application SHA, enter the protected Environment, and send a narrowly structured deployment request over strict SSH.
3. **VPS runtime:** verify repository/target/SHA identity and execute the deterministic deployment state machine.

The durable server phases are:

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

Releases use immutable full-SHA directories and an atomic `current` symlink. Failures retain the source, state, logs, secrets, port reservations, processes, containers, and database volumes required for a safe same-commit resume.

## Migrating a host bootstrapped by v0.1.x

A VPS enrolled by DeployKit v0.1.x still carries a repository-scoped GitHub Actions runner running as root. Hosts this release bootstraps never install one.

When `deploykit deploy` finds that runner on the host it is deploying to, it does not remove it quietly and it does not deploy beside it. Inside the same invocation it:

1. installs the replacement gateway and proves it with a real forced-command handshake — the new path works before you are asked to give up the old one;
2. shows you the runner's path and asks for explicit approval;
3. stops and disables its systemd service, **retaining every file** under `/opt/actions-runner/…` so you can restore the old path if you need to;
4. unregisters it from the repository and re-reads GitHub's own runner listing to prove no job can still be routed to it.

Refusing is a complete answer. The deployment stops with `DK_SECURITY_ACK_REQUIRED` (exit code `7`), the runner is left exactly as it was, and nothing is dispatched. A non-interactive session — CI, a pipe, a script — counts as a refusal, so a migration can never be approved by omission.

A runner registered against a *different* repository on the same host is never touched, inspected further, or reported to GitHub.

Until such a host is migrated, keep the repository private, keep the default branch and the target Environment protected, and never route pull-request or fork workflows to it. [`SECURITY.md`](SECURITY.md) explains why that runner is not a sandbox.

## Legacy `deploykit.yaml` commands

Projects already initialized on the v0.1 path keep working unchanged. `deploykit init`, `validate`, `plan`, `secrets set|check`, `server bootstrap`, `status`, and `logs` are still available, and `deploykit deploy --target <name> --ref <branch>` plus `deploykit retry` still dispatch through a `deploykit.yaml` manifest.

These are selected only by their own flags. Bare `deploykit deploy` is always the `deploykit.config.yaml` deployment, and mixing `--config` with `--target`/`--ref` is a usage error rather than a silent choice between two different products. DeployKit never rewrites an application-owned file to migrate you: moving to the one-file path means writing a `deploykit.config.yaml`, not letting DeployKit edit your manifest.

## Security model

- Use DeployKit only with trusted private repositories; application builds and Docker workloads can control the VPS.
- Direct DNS verification happens before workload mutation, and every A/AAAA response must match the enrolled VPS.
- Generated workflow dependencies are pinned to full commit SHAs and receive minimal permissions.
- SSH uses a pinned host key and repository/target-bound forced command.
- Runtime commands are executable-plus-argument arrays with no shell interpolation.
- Nginx ownership markers prevent overwriting unmanaged sites, and every reload follows `nginx -t`.
- Certbot uses webroot/certonly and never edits DeployKit-managed Nginx configuration.
- Secret values are redacted from stdout, stderr, errors, state, and event logs.

Read [`SECURITY.md`](SECURITY.md) before using DeployKit with a real server.

## Product boundary

**DeployKit performs a target's *first* deployment.** That is the boundary, not a caveat about maturity: once a target reaches `complete`, DeployKit refuses every further apply to it with `DK_ALREADY_DEPLOYED`. It is not a continuous-delivery tool, and rerunning it after a success will not ship a new commit. Rerunning it after a *failure* resumes that same first deployment, bound to the same commit SHA and manifest digest.

Within that boundary, this release targets Ubuntu 22.04/24.04 amd64/arm64 hosts using Docker Compose, Node workloads managed by PM2, static frontends, host Nginx, direct DNS checks, and Certbot.

DNS-provider mutation, backups/restores, redeployment or rollback of an already-deployed target, Kubernetes, cloud control planes, non-Ubuntu hosts, non-Node PM2 workloads, and unrestricted remote shell execution are outside this boundary.

Contributor implementation rules and the migration map are in [`AGENTS.md`](AGENTS.md). The deterministic runtime manifest reference remains in [`docs/manifest.md`](docs/manifest.md), and disposable-server acceptance coverage belongs in [`docs/acceptance.md`](docs/acceptance.md).
