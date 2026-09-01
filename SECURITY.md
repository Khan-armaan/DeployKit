# Security policy

## Implementation status

The released v0.1 architecture installs a repository-scoped GitHub Actions runner as root. The restricted-gateway model documented below is a **Phase 1 design contract**, not current production behavior. Until the gateway, bootstrap migration, hosted workflow, and disposable-VPS acceptance phases are complete, operators must follow the root-runner warning and controls in this document.

The gateway protocol and its exact-SHA source retrieval are now implemented in the shipped code and covered by tests, but no bootstrap installs them: nothing in this package places a gateway user, binding, forced command, or repository key on a host yet. The pinned GitHub host keys those paths will use ship as the `assets/github-known-hosts` asset.

## Current v0.1 root-runner warning

DeployKit v0.1 installs a repository-scoped GitHub Actions runner as root. This is not a sandbox. A workflow accepted by the runner, a Docker build, or a host package script can obtain full control of the VPS.

Before using DeployKit in production:

1. Keep the application repository private and restrict write access.
2. Protect the default branch and `.github/workflows/deploykit.yml` with required review.
3. Protect the GitHub Environment with independent approval.
4. Never route pull-request or fork workflows to a DeployKit runner.
5. Enroll one separately labeled runner per trusted repository.
6. Rotate application credentials after suspected repository, runner, or Docker compromise.

The generated v0.1 workflow pins third-party Actions by commit and checks that the workflow source is the default branch. The bootstrap runner hook is defense in depth, not a complete boundary: application code from the selected ref is intentionally built on the VPS.

## Planned restricted-gateway security contract

The future one-file orchestrator replaces the persistent root runner with a GitHub-hosted runner and a forced-command SSH gateway. This section freezes the intended security boundary for later implementation phases; it does not assert that the current CLI or bootstrap script enforces it.

### Trust zones and keys

- The local administrator SSH identity is used only for trusted provisioning and remains on the operator's machine. It is never uploaded to GitHub or installed as a deployment credential.
- A target-specific workflow-to-VPS key may invoke only the forced DeployKit gateway for its root-owned repository and target binding. The gateway account has no interactive login, PTY, forwarding, Docker membership, or general-purpose sudo.
- A separate stable VPS-to-GitHub deploy key is read-only and is bound to one repository. Its private half remains on the VPS with mode `0600`.
- Workflow and repository keys are not interchangeable. Rotation must use DeployKit-owned staged and active entries so interruption cannot remove the last verified key or overwrite an unrelated key.
- The forced command must reject a nonempty `SSH_ORIGINAL_COMMAND`, PTY allocation, forwarding, caller-selected repository or target identity, and protocol input that is malformed, oversized, duplicated, or uses an unsupported version.

### Configuration and control artifacts

- `deploykit.config.yaml` may contain credentials. Before reading values, DeployKit must verify that it is inside the application repository, ignored by Git, untracked, unstaged, regular, non-symlinked, owned by the current user, and mode `0600`.
- Backend values are partitioned and registered with the exact-value redactor before parse or validation diagnostics can expose them.
- The compiled runtime manifest, workflow, ownership record, deployment identity, operation record, and all generated plans are secret-free. They may contain backend and generated secret **names**, never their values.
- Managed workflow, runtime-manifest, and ownership files are reviewed on the protected default branch. DeployKit must prove ownership before changing or deleting a branch, pull request, deploy key, Environment value, or managed file; ambiguous ownership fails closed.
- GitHub-hosted workflow dependencies are full-SHA pinned, checkout credentials are not persisted, permissions are minimal, and the protected target Environment remains subject to existing reviewers, wait timers, and branch restrictions.

### Gateway identity and protocol

- The root-owned gateway binding is authoritative for repository, target, Environment, and derived target identity. Caller fields only confirm the binding and cannot select or replace it.
- Every mutating request is bound to a request UUID, a lower-case 40-character Git commit SHA, and the SHA-256 digest of the exact canonical secret-free runtime-manifest bytes.
- The gateway recomputes and compares the manifest digest, validates the binding, validates the complete request and all declared secret frames, and rejects failure before deployment state is touched.
- Protocol control, payload, progress, and result records are length-bounded canonical UTF-8 JSON Lines. Binary-safe manifest and secret payloads use canonical base64 fields; decoders reject noncanonical encodings, excess input, duplicate frames, undeclared secrets, and trailing records.
- Secret values are accepted only in secret payload frames, are never copied into an error or event, and are never persisted in a request, result, operation record, manifest, digest record, or deployment state.

### Source and privileged runtime

- The VPS derives the GitHub SSH URL from its root-owned binding and retrieves only the requested full commit. Git runs with a clean bounded environment, pinned GitHub host keys, prompts disabled, hooks and filters disabled, unsafe protocols disabled, and submodules/gitlinks rejected.
- Incoming source is outside immutable releases and managed configuration paths. Source retrieval alone cannot reserve a port or domain, start a workload, write Nginx, issue a certificate, or activate a release.
- A failed deployment may resume only with the same target, repository, commit SHA, and manifest digest. A completed first deployment is not resumable. Malformed or legacy ambiguous state requires explicit administrative resolution rather than automatic repair.
- Direct DNS checks, global registry locking, loopback-only host ports, Nginx ownership checks, atomic staging, `nginx -t`, Certbot webroot/certonly, and ordered checkpoints remain mandatory runtime gates.
- The restricted gateway removes a persistent repository-controlled root runner, but it does not sandbox trusted application code. Docker builds, Compose workloads, migrations, package scripts, and generated services can still obtain effective control of the VPS. Repository write access and workflow approval therefore remain privileged.

## Secrets

- Do not commit `.env` files or `deploykit.config.yaml`. DeployKit stores runtime values under `/etc/deploykit` with mode `0600`.
- Static frontend variables are public and embedded in built assets.
- Current v0.1 secret values are never accepted in `deploykit.yaml`, command arguments, generated Nginx files, or deployment state.
- In the planned orchestrator, backend values travel as individual protected GitHub Environment secrets and bounded gateway secret frames. They must not appear in workflow YAML, workflow inputs, process arguments, job outputs, `$GITHUB_ENV`, generated artifacts, logs, errors, state, operation records, Nginx, PM2 configuration, systemd units, or release archives.
- `deploykit advise` excludes common secret files and redacts detected values before a provider request.

## Reporting

Do not open a public issue containing a production host, runner token, log with credentials, or exploitable vulnerability. Contact the package maintainers privately through the security contact configured for the npm package/repository.
