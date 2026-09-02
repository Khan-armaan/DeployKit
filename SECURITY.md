# Security policy

## Implementation status

The restricted-gateway model documented below is now installed and reachable. `assets/bootstrap.sh` no longer enrolls a GitHub Actions runner: a freshly bootstrapped host receives the non-login `deploykit-gateway` account, a root-owned binding, one forced-command entry, one no-argument sudo entry, the checksum-verified standalone runtime, the pinned GitHub host keys, and a stable read-only repository key. No Actions Runner package, registration token, job hook, or service is placed on a fresh host.

Every GitHub-side property below is implemented as well, and `deploykit deploy` now performs the whole flow: reviewed control artifacts, cross-plane key and Environment reconciliation, dispatch, run correlation, and the inspected result. The one remaining gate is the disposable-VPS acceptance matrix in [`docs/acceptance.md`](docs/acceptance.md). Until it passes, the model must not be described as production-ready.

## Hosts bootstrapped by DeployKit v0.1.x

A host enrolled by an earlier release still carries a repository-scoped GitHub Actions runner running as root. That is not a sandbox: a workflow accepted by the runner, a Docker build, or a host package script can obtain full control of the VPS.

`deploykit deploy` migrates such a host, and the order is the security property. The replacement gateway is installed and proven by a real forced-command handshake *before* the operator is asked anything; the operator is then asked explicitly, in that same invocation, and a non-interactive session counts as a refusal. Only after approval is the runner's systemd service stopped and disabled, and only then is its registration deleted and GitHub's own runner listing re-read to prove no job can still be routed there. A refusal removes nothing and dispatches nothing: DeployKit will not deploy beside a repository-controlled root runner, and it will not remove one without being told to.

Nothing under `/opt/actions-runner` is deleted, moved, or rewritten, so a migrated host stays recoverable. A runner registered against a different repository on the same host is never touched, and a runner whose GitHub registration DeployKit cannot identify is refused as an ownership conflict *before* its service is stopped — unregistering the wrong runner, or stopping one that stays registered, are both worse than stopping.

Until such a host is migrated:

1. Keep the application repository private and restrict write access.
2. Protect the default branch and `.github/workflows/deploykit.yml` with required review.
3. Protect the GitHub Environment with independent approval.
4. Never route pull-request or fork workflows to a DeployKit runner.
5. Enroll one separately labeled runner per trusted repository.
6. Rotate application credentials after suspected repository, runner, or Docker compromise.

Migration removes the persistent root runner; it does not change what a deployment may build. Application code from the selected ref is intentionally built on the VPS in both models. Trusted Dockerfiles and package scripts can therefore control the host even after the persistent root runner is gone; the gateway narrows who may *start* a deployment, not what a deployment is allowed to build.

## Restricted-gateway security contract

The one-file orchestrator replaces the persistent root runner with a GitHub-hosted runner and a forced-command SSH gateway. Every property below is enforced by shipped code — the gateway, the installer, the bootstrap boundary, the typed GitHub client, and the reconcilers `deploykit deploy` drives.

### Administrator SSH and bootstrap

- The VPS host key is pinned by fingerprint in `deploykit.config.yaml`. Every administrator connection scans the host, digests each offered key, and proceeds only with the key whose fingerprint matches; anything else raises `DK_SSH_HOST_KEY_MISMATCH` before data is sent.
- Every remote invocation is an argv array of validated arguments. No configured value becomes shell syntax on the far side.
- Bootstrap is idempotent for an identical binding and fails closed with `DK_GATEWAY_BINDING_MISMATCH` when a host is already bound to another repository, Environment, target, or binding id. It never repoints an existing host.
- The installer's claim is not trusted: the installed bundle version, checksum, and binding are re-verified by a real forced-command handshake before a bootstrap is reported as successful.
- The gateway account is created with `/usr/sbin/nologin`, a locked password, no Docker group membership, and a single sudoers entry naming one no-argument program. `env_reset` is in force; only `SSH_ORIGINAL_COMMAND`, `SSH_TTY`, `SSH_AUTH_SOCK`, `DISPLAY`, and `XAUTHORITY` are preserved, precisely so the forced command can still refuse a client-supplied command, a PTY, and forwarded channels.
- Only nonsecret facts leave the host: the repository *public* key, its fingerprint, the binding id, and the installed runtime version and checksum. The repository private key is generated on the VPS, kept at mode `0600`, reused across reruns, and never transmitted.
- Enabling the firewall allows the administrator's actual SSH port before `ufw --force enable`, so reconciling a host whose sshd moved off port 22 cannot lock the operator out.

### Trust zones and keys

- The local administrator SSH identity is used only for trusted provisioning and remains on the operator's machine. It is never uploaded to GitHub or installed as a deployment credential.
- A target-specific workflow-to-VPS key may invoke only the forced DeployKit gateway for its root-owned repository and target binding. The gateway account has no interactive login, PTY, forwarding, Docker membership, or general-purpose sudo.
- A separate stable VPS-to-GitHub deploy key is read-only and is bound to one repository. Its private half remains on the VPS with mode `0600`.
- Workflow and repository keys are not interchangeable. Rotation must use DeployKit-owned staged and active entries so interruption cannot remove the last verified key or overwrite an unrelated key.
- The forced command must reject a nonempty `SSH_ORIGINAL_COMMAND`, PTY allocation, forwarding, caller-selected repository or target identity, and protocol input that is malformed, oversized, duplicated, or uses an unsupported version.

### GitHub client boundary

- `gh` holds the GitHub credential. DeployKit never extracts, prints, or stores a token: it does not run `gh auth token`, does not read one from the environment, and does not place one in an argument, a file, or a diagnostic.
- Secret material reaches a child process on stdin alone. Environment secrets are written with `gh secret set`; no secret value is ever an argument, a temporary file, a URL, or part of a retried request.
- Safe reads retry with bounded backoff; mutations are attempted exactly once, because a failed write may still have landed and a repeat would create a second branch, pull request, or deploy key.
- Responses are size-bounded before parsing, fields are read through checked accessors, listings stop at a frozen page ceiling by failing closed rather than truncating, and neither a response body nor the CLI's stderr is attached to any reported failure.
- Repository deploy keys are created read-only, and a key that comes back with write access is refused rather than used.
- Self-hosted runner registrations are read and deleted, never created. DeployKit enrolls no runner on any host, and the only registration it ever deletes is the one a legacy host's own `.runner` file identifies for the repository being deployed.

### Configuration and control artifacts

- `deploykit.config.yaml` may contain credentials. Before reading values, DeployKit must verify that it is inside the application repository, ignored by Git, untracked, unstaged, regular, non-symlinked, owned by the current user, and mode `0600`.
- Backend values are partitioned and registered with the exact-value redactor before parse or validation diagnostics can expose them.
- The compiled runtime manifest, workflow, ownership record, deployment identity, operation record, and all generated plans are secret-free. They may contain backend and generated secret **names**, never their values.
- Managed workflow, runtime-manifest, and ownership files are reviewed on the protected default branch. DeployKit proves ownership before changing or deleting a branch, pull request, deploy key, Environment value, or managed file: a resource is DeployKit's only when the committed ownership marker claims it, a managed name keyed by target id matches it, or it uses the reserved `DEPLOYKIT_` prefix an operator config may not set. Duplicate, writable, impersonating, or redirected resources are ambiguous and fail closed.
- GitHub-hosted workflow dependencies are full-SHA pinned, checkout credentials are not persisted, permissions are minimal, and the protected target Environment remains subject to existing reviewers, wait timers, and branch restrictions. An Environment that already exists is read, never replaced, so its protection survives every rerun.

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
- Backend values travel as individual protected GitHub Environment secrets and bounded gateway secret frames. They must not appear in workflow YAML, workflow inputs, process arguments, job outputs, `$GITHUB_ENV`, generated artifacts, logs, errors, state, operation records, Nginx, PM2 configuration, systemd units, or release archives.
- `deploykit advise` excludes common secret files and redacts detected values before a provider request.

## Reporting

Do not open a public issue containing a production host, runner token, log with credentials, or exploitable vulnerability. Contact the package maintainers privately through the security contact configured for the npm package/repository.
