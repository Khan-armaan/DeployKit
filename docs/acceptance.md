# Infrastructure acceptance runbook

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
