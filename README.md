# DeployKit

DeployKit is a TypeScript library and CLI for deterministic deployments of trusted private GitHub repositories to Ubuntu VPS hosts. The intended operator experience is one local configuration file and one public command:

```bash
deploykit deploy
```

DeployKit handles validation, GitHub Actions, protected variables and secrets, VPS provisioning, exact-commit source checkout, Docker Compose or PM2 services, static frontends, automatic ports, Nginx, TLS, health checks, and safe resume.

> [!IMPORTANT]
> The one-file workflow documented below is the required next-version interface. The current unreleased source securely creates, reads, and **fully validates** `deploykit.config.yaml`, reporting stable `DK_CONFIG_*` failures with resume instructions, but it does **not** yet compile that file into a runtime manifest or perform the GitHub/VPS orchestration below. Released v0.1.3 still requires the legacy flags and self-hosted-runner setup. The documentation is intentionally explicit about this gap so planned behavior is not mistaken for released behavior.

## What the user needs

Before deployment, the user must control these external resources:

- A trusted application repository whose deployable commit is pushed to GitHub.
- A protected default branch and an authenticated GitHub CLI session with permission to manage the repository, Actions, deploy keys, and the target Environment.
- An Ubuntu 22.04 or 24.04 amd64/arm64 VPS reachable with an administrator SSH identity.
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

### 3. Continue the same command

After saving the configuration, return to the waiting terminal and confirm. DeployKit securely reopens and validates the file, then continues the deployment in that same invocation.

If the terminal was closed or the first run was non-interactive, run the same command again:

```bash
deploykit deploy
```

No separate `init`, `validate`, `plan`, `server bootstrap`, `secrets set`, `retry`, `status`, or `logs` command is required for the normal path.

If branch protection requires review before the generated workflow can enter the default branch, DeployKit creates or updates one setup pull request and waits. After the user approves and merges it, the same invocation continues automatically.

On success, the command reports:

- the exact deployed commit SHA;
- the public HTTPS URL;
- the stable loopback ports allocated to host-facing services;
- workload and route health results.

If deployment fails, running `deploykit deploy` again for the same commit and compiled configuration resumes after the last durable checkpoint.

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

## How the library works

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

The initial one-command release targets first deployments to Ubuntu VPS hosts using Docker Compose, Node workloads managed by PM2, static frontends, host Nginx, direct DNS checks, and Certbot.

DNS-provider mutation, backups/restores, Kubernetes, cloud control planes, non-Ubuntu hosts, non-Node PM2 workloads, and unrestricted remote shell execution are outside this boundary.

Contributor implementation rules and the migration map are in [`AGENTS.md`](AGENTS.md). The deterministic runtime manifest reference remains in [`docs/manifest.md`](docs/manifest.md), and disposable-server acceptance coverage belongs in [`docs/acceptance.md`](docs/acceptance.md).
