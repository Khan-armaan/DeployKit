# Infrastructure acceptance runbook

## Status and scope

The matrix in the next section is the **Phase 14 acceptance gate** for the one-file orchestrator and restricted gateway. Phases 1-8 have landed, so gateway installation, the root-owned binding, the staged/active key lifecycle, and exact-SHA source retrieval are real behavior a disposable host can now exercise; GitHub mutation and dispatch are not, because Phases 9-12 own them. The legacy instructions at the end of this file describe the v0.1 root-runner baseline and apply only to hosts enrolled by an earlier release.

## Planned Phase 14 disposable-VPS matrix

Run this matrix only with disposable hosts, private test repositories, staging DNS, and Let's Encrypt staging. Never enroll a test repository on a production VPS, reuse production credentials, or put a secret value in the evidence bundle.

### Environment axes

Every Ubuntu and architecture pair must be represented. The three topologies form a twelve-case host/topology core matrix. Rotate the install paths so each path is exercised on both architectures and both Ubuntu releases; additionally run the real packed-tarball smoke test on every host.

| Axis | Cases | Required coverage |
| --- | --- | --- |
| Host | Ubuntu 22.04 amd64; Ubuntu 22.04 arm64; Ubuntu 24.04 amd64; Ubuntu 24.04 arm64 | Every host/topology pair |
| Topology | Static frontend + Compose API/database; PM2 API/SSR/worker + Compose database; container frontend/API + external TLS database | Every topology on every host |
| Installation | Global npm install; `npx --yes`; real packed tarball in an isolated prefix | Each path on both architectures and releases; packed tarball on every host |
| Repository controls | Private repository; protected default branch; protected target Environment; setup PR review required | Every end-to-end case |
| Network | Direct A, direct AAAA where available, and dual-stack answers; no proxy or CNAME | At least one case of each supported direct-answer form per host family |
| TLS | Let's Encrypt staging and renewal dry run | Every end-to-end case |

Each topology fixture must be a complete `deploykit.config.yaml` input and must deploy without hand-editing generated workflow or runtime-manifest files. Backend fixture values use synthetic canaries only.

### Scenario and fault matrix

`Recovery` names refer to the stable recovery actions in [`orchestrator-contracts.md`](orchestrator-contracts.md). Unless a row explicitly requires administrator intervention, the only DeployKit command used for recovery is `deploykit deploy`.

| ID | Scenario or injected fault | Mutation boundary and expected outcome | Recovery | Required evidence |
| --- | --- | --- | --- | --- |
| PKG-01 | Pack, inspect, and install the real npm artifact | No external mutation; package allowlist contains the example config, bootstrap assets, host keys, standalone bundle, and checksums with expected executable modes | `not-resumable` on packaging failure | `npm pack --dry-run --json`, tarball file list/checksum, isolated CLI help/version/scaffold output |
| CFG-01 | First `deploykit deploy` with no local config | Creates only a mode-`0600`, repository-local, Git-ignored config and waits or exits; no authentication, network, secret read, workflow, or VPS mutation | `edit-config-and-rerun` | file metadata, Git exclude path/status, captured network/process fake showing zero external calls |
| CFG-02 | Symlink, wrong owner/mode, tracked/staged file, unknown key, non-string environment value, or secret-like frontend name | Reject before secret-bearing diagnostics or external mutation | `secure-config-and-rerun` or `edit-config-and-rerun` | exact `DK_*` error/recovery envelope and canary-negative stdout/stderr/snapshot |
| E2E-01 | Fresh private-repository deployment | One config and one `deploykit deploy` flow reaches `complete`; only the setup-PR review is a required user pause | `none` | setup PR, exact workflow run URL, commit SHA, manifest digest, HTTPS URL, stable ports, workload/route health |
| PR-01 | Interrupt before setup PR creation, while waiting, and after merge before local checkpoint | Only DeployKit-owned control files may change; default-branch bytes are re-read before continuation; no secret upload or dispatch before readiness | `review-setup-pull-request` or `rerun-same-command` | branch/PR contents and ownership marker, default-branch blob SHAs, absence of Environment/VPS mutations before merge |
| GATE-01 | Interrupt bootstrap and repeat an identical binding | Same binding reconciles idempotently; no Actions Runner is installed; unrelated SSH keys remain unchanged | `rerun-same-command` | host facts, bundle version/checksum, binding fingerprint, gateway handshake, account/sudoers/authorized-keys inspection |
| KEY-01 | Interrupt repository-key and gateway-key lifecycle after every staged/uploaded/activated step | One verified key path always survives; source key remains read-only; only owned stale entries may be removed | `rerun-same-command` | redacted key fingerprints, GitHub deploy-key read-only flag, staged/active ownership records, successful repository/gateway handshakes |
| ENV-01 | Interrupt Environment, variable, and secret reconciliation after each mutation | Existing reviewers, wait timers, branch restrictions, and unrelated values remain unchanged; no secret travels in argv or a temporary file | `rerun-same-command` | before/after policy metadata, managed-resource digest, mocked argv/stdin evidence, canary-negative logs |
| RUN-01 | Interrupt before dispatch, immediately after dispatch, and during run correlation | No dispatch occurs until all readiness facts are freshly verified; a rerun correlates the request UUID and does not dispatch a duplicate | `wait-and-rerun` or `rerun-same-command` | dispatch payload, request UUID, workflow path/event/ref/SHA/actor/target checks, unique run URL |
| SRC-01 | Exact-SHA private source retrieval and cache reuse | Retrieval creates no release or runtime mutation; staged tree excludes `.git`; repeated retrieval is deterministic | `rerun-same-command` | fetch argv/environment, object/ref verification, tree hash, cache ownership, zero registry/workload/Nginx/TLS writes |
| SRC-02 | Moved ref, wrong repository/SHA/object type, gitlink, hook/filter config, credential prompt, unsafe protocol, or escaping symlink | Reject before release creation or any deployment mutation | `not-resumable` until the source/configuration is corrected | exact error/recovery envelope, rejected Git invocation, mutation audit |
| RES-01 | Interrupt after every durable phase | Completed checkpoints are contiguous and retained; same SHA and digest resume skips completed work and finishes | `rerun-same-command` | redacted state/event history for every phase and attempt, unchanged identity, final health |
| ID-01 | Retry failed state with a different SHA or manifest digest | Reject before state, secret, registry, source, workload, Nginx, or TLS mutation | `restore-same-sha-and-digest` | prior/current identity, exact error, before/after filesystem and registry hashes |
| LEG-01 | Legacy state with no manifest digest | Preserve a completed target; failed/running state is not guessed or auto-migrated | `migrate-legacy-state` | legacy state copy, refusal result, proof no runtime mutation occurred |
| REG-01 | Two projects deploy concurrently to one VPS with overlapping automatic candidates | Global locking yields stable, distinct loopback ports and domain ownership without partial writes | `wait-and-rerun` on active lock contention | registry before/after, lock evidence, listeners on `127.0.0.1`, both HTTPS/health results |
| DNS-01 | Missing answer, CNAME, extra/wrong A or AAAA answer | Reject before resource reservation, source staging, workload, Nginx, or certificate mutation | `edit-config-and-rerun` after direct DNS is corrected | resolver evidence, error code, unchanged state/registry/runtime paths |
| OWN-01 | Occupied explicit port, reserved domain, unmanaged `server_name`, conflicting workflow/branch/key/Environment ownership | Never overwrite, bypass, bind, or delete the conflicting resource | `resolve-ownership-conflict` | conflict owner/current bytes, exact error/recovery, unchanged resource hashes |
| APP-01 | Migration, seed, workload, health, generated Nginx, or TLS failure | Later phases do not run; only a newly activated ownership-verified Nginx link may be disabled; source/state/logs/secrets/reservations/process and database data remain | `rerun-same-command` with identical identity after remediation | fatal phase, retained artifacts, service/volume status, active-site before/after, successful retry |
| PROTO-01 | Unsupported protocol version, malformed/noncanonical JSONL/base64, oversized/truncated frame, duplicate/undeclared secret, digest mismatch, trailing frame | Gateway fails closed before deployment state is touched and emits only a bounded redacted result | `not-resumable` for the rejected request; correct the client/control artifact | raw synthetic fixture, exact error/recovery, zero state/runtime mutation, canary-negative output |
| BIND-01 | Caller substitutes repository, target, Environment, target ID, or binding ownership | Root-owned binding wins and the request is rejected before source or deployment mutation | `resolve-ownership-conflict` | binding metadata/fingerprint, rejected confirmations, exact error, unchanged host paths |
| SSH-01 | Changed VPS host key, general command, PTY, agent/TCP/X11 forwarding | Local client or forced command refuses the connection/request; no privileged command runs | `not-resumable` until identity is verified or invocation corrected | strict-known-hosts failure and forced-command rejection checks, SSH daemon/auth logs with no secret data |
| DONE-01 | Reapply after successful first deployment | Reject with `DK_ALREADY_DEPLOYED`; completed source, state, ports, Nginx, TLS, and services remain untouched | `not-resumable` | exact result, hashes/status before and after |
| LEAK-01 | Synthetic canary crosses config, GitHub secret upload, workflow, gateway, VPS secret write, failure, inspection, and retry | Canary exists only in approved secret stores and transient stdin/payload buffers | `not-resumable` on any leak | scan of repository diff, tarball, generated artifacts, argv, stdout/stderr, workflow/gateway output, state/events/logs, releases |
| MIG-01 | Host contains a legacy root Actions Runner | Replacement gateway is installed and smoke-tested first; old runner removal requires explicit in-command approval and is recoverable; fresh hosts never install it | `rerun-same-command` or `not-resumable` when approval is denied | before/after services and GitHub runner routing, retained recovery files, approval record, gateway handshake |

### Evidence record

For every matrix run, record the case IDs, UTC time, DeployKit package and bundle versions/checksums, host OS/architecture, repository and target identifiers, exact commit SHA, runtime-manifest digest, nonsecret binding/ownership/managed-resource digests, setup PR and workflow URLs, allocated loopback ports, domains, health results, final phase, and recovery action. Redact host addresses when evidence leaves the private test workspace.

Evidence must also include a canary-negative scan of generated files, Git diff, package contents, mock/API requests, process arguments, workflow output, gateway output, server state/events/logs, Nginx/PM2/systemd files, and release archives. Never archive `deploykit.config.yaml`, private keys, GitHub tokens, secret frames, `secrets.env`, or raw provider responses.

The one-file orchestrator may be described as production-ready only when every automated Phase 1–13 gate and this disposable-infrastructure matrix pass.

## Current v0.1 legacy acceptance baseline

The repository test suite covers manifest unions, semantic and Compose safety checks, rendering, redaction, checkpoints, concurrent registry allocation, retry behavior, package-manager adapters, and three topology fixtures. The tests under `test/fixtures/` are:

- static Vite frontend + Compose API + private PostgreSQL + upload/WebSocket routes;
- container frontend + Compose API + external TLS database;
- PM2 API, SSR frontend, and worker + loopback-only Compose PostgreSQL.

The following checks require disposable infrastructure and are intentionally not run by normal CI.

## VM matrix

Run each case on clean amd64 and arm64 hosts for Ubuntu 22.04 and 24.04:

1. Point a staging A/AAAA record directly at the host.
2. Protect the repository default branch and a staging GitHub Environment.
3. Run `deploykit server bootstrap` with the root-runner acknowledgement and a non-production runner label.
4. Run the identical bootstrap command again. It must reconcile without creating a second runner or changing existing reservations.
5. Confirm Docker, Compose, Nginx, Certbot, the pinned PM2 version, the pinned Actions runner, and the standalone DeployKit bundle report the expected versions.

Never enroll a disposable test repository onto a production VPS.

## End-to-end first deployment

Use Let's Encrypt staging by setting `certbotStaging` in the server-driver test configuration or a purpose-built test package. Then:

1. Set `CERTBOT_EMAIL` and application secrets through `deploykit secrets set --file -`; inspect Actions and server logs to confirm the values never appear.
2. Dispatch from the protected default-branch workflow with a separate application branch as `ref`.
3. Verify the recorded immutable commit, loopback-only upstream sockets, private Compose database, migrations, seed, all health checks, HTTPS, SPA fallback, upload, API, WebSocket, and SSE behavior.
4. Run `certbot renew --dry-run` and confirm the validated reload hook executes `nginx -t` before reload.
5. Dispatch a second non-resume deployment and confirm `DK_ALREADY_DEPLOYED`.

## Failure and retry cases

Run each on a fresh target:

- DNS mismatch or a CNAME: no source staging, workload start, Nginx activation, or certificate mutation.
- Existing unmanaged `server_name`: no managed site overwrite.
- Deliberately invalid generated Nginx: `nginx -t` fails and the active configuration remains unchanged.
- Migration failure: seed, health, proxy, and TLS phases do not run.
- Health failure after proxy staging: the newly enabled managed site is disabled; source, state, logs, secrets, reservations, containers, PM2 data, and database volumes remain.
- Retry the same commit: completed checkpoints are skipped and the deployment can finish.
- Retry a different commit: the server rejects it.

## Xperience dogfood gate

Model Xperience as a new `deploykit.yaml` without changing its existing Dockerfiles or Compose files. Deploy it to a disposable VPS and staging domain, exercise static/SSR routing, `/api/`, transcription upload timeouts, WebSocket behavior if enabled, and certificate renewal. Record the manifest, redacted plan, host matrix, and test evidence in the release notes before publishing `0.1.0` as stable.
