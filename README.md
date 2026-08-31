# DeployKit

`deploykit` is a manifest-driven CLI for first-time deployments to shared Ubuntu VPS hosts. It combines a guided local setup flow with a deterministic server runtime executed by a repository-scoped GitHub Actions runner.

DeployKit does not put an LLM in the production control path. The optional advisor can propose a manifest locally; schema validation and the server runtime remain deterministic.

> [!WARNING]
> DeployKit v0.1 deliberately supports a root self-hosted runner because that is the selected operating model. Any repository code allowed onto that runner can potentially control the VPS, especially through host builds or Docker. Use only private trusted repositories, protect the generated workflow and GitHub Environment, and dedicate repo-scoped runners.

## Requirements

- Local Node.js 20.11 or newer, `git`, `ssh`, `scp`, and authenticated GitHub CLI (`gh`).
- Docker Engine with Docker Compose v2 when the repository declares Compose workloads; `init` and `validate` inspect the effective configuration locally.
- Existing production Dockerfiles/Compose files for Compose workloads. DeployKit validates but does not generate them.
- A fresh or shared Ubuntu 22.04/24.04 amd64/arm64 VPS reachable over SSH.
- Direct DNS A/AAAA records. DNS-provider mutation and proxied/CDN records are outside v0.1.

## Install

```bash
npm install --global deploykit
deploykit --help
```

## Quick start

From the application repository:

```bash
deploykit init
deploykit validate
deploykit plan --target production

deploykit server bootstrap \
  --host deploy@example-vps \
  --repo owner/private-repository \
  --label production-vps \
  --accept-root-runner-risk \
  --accept-host-key

deploykit secrets set --target production --file .env.production
deploykit deploy --target production --ref main
```

The generated GitHub workflow can also be dispatched in the Actions UI. A successful target is immutable in v0.1; `deploykit retry` is only for the same commit after a failed first deployment.

## Repository contract

`deploykit init` creates only:

- `deploykit.yaml`
- `.github/workflows/deploykit.yml`

It never edits application source, Dockerfiles, or Compose files. A typical manifest is:

If inspection finds fixed Compose ports, `container_name`, missing scripts, or another project-owned problem, initialization still writes the two new files and reports exact remediation. `deploykit validate` remains blocked until the application owner fixes those files.

```yaml
apiVersion: deploykit/v1alpha1
metadata:
  name: example
  requiredVersion: 0.1.0
compose:
  files:
    - compose.yaml
services:
  api:
    type: compose
    service: api
    internalPort: 3000
    healthCheck:
      type: http
      path: /health
  worker:
    type: pm2
    role: worker
    workingDirectory: worker
    nodeVersion: 22.18.0
    packageManager: npm
    startScript: start
    healthCheck:
      type: process
frontend:
  type: static
  workingDirectory: frontend
  nodeVersion: 22.18.0
  packageManager: npm
  buildScript: build
  outputDirectory: dist
  spaFallback: true
  apiBasePath: /api
  publicEnvironment:
    VITE_API_BASE_URL: /api
routes:
  - hostname: "@primary"
    path: /api/
    match: prefix
    target: api
    preservePrefix: true
    websocket: true
database:
  type: compose
  service: postgres
  internalPort: 5432
  consumers: [api]
  volume: postgres_data
  credentials:
    username: app
    database: app
    passwordSecret: POSTGRES_PASSWORD
    connectionStringSecret: DATABASE_URL
    connectionStringTemplate: postgresql://{username}:{password}@{host}:{port}/{database}
  migrations:
    service: api
    command: [npm, run, migrate]
secrets:
  required:
    - CERTBOT_EMAIL
    - OPENAI_API_KEY
  generated:
    - POSTGRES_PASSWORD
    - DATABASE_URL
targets:
  production:
    runnerLabel: production-vps
    primaryDomain: example.com
    aliases:
      - www.example.com
    environment: production
```

See [docs/manifest.md](docs/manifest.md) for the complete contract.

## Commands

| Command | Purpose |
|---|---|
| `init` | Inspect a repository and create the manifest and pinned workflow. |
| `validate` | Run schema, semantic, filesystem, and effective Compose checks. |
| `plan` | Produce a non-mutating deployment plan. |
| `advise` | Ask OpenAI or Anthropic for a local manifest patch after explicit file approval. |
| `server bootstrap` | Provision Ubuntu and enroll a repo-scoped runner over SSH. |
| `secrets set/check` | Manage per-target `0600` server environment files. |
| `deploy` | Dispatch the first-deployment workflow. |
| `retry` | Resume the same failed first deployment. |
| `status` / `logs` | Inspect checkpoint state and redacted deployment logs. |

Use `--json` on read/validation commands for automation.

For pnpm, Yarn, or Bun workloads, each workload's `package.json` must contain an exact declaration such as `"packageManager": "pnpm@10.6.2"`. DeployKit activates that exact adapter. npm comes from the exact Node.js distribution and may also be pinned with `packageManager` when the bundled version must match.

## Security model

- Runtime secrets are stored per target outside Git checkouts and written atomically with mode `0600`.
- Compose upstreams, PM2 APIs, and host-accessible databases bind to `127.0.0.1`; internal Compose services remain unpublished.
- Domains and ports are reserved under a server-wide lock shared by all repo runners.
- Nginx files are staged and validated with `nginx -t`; existing unmanaged domains are refused.
- Certbot uses webroot issuance, so it never rewrites DeployKit-managed Nginx configuration.
- Build-time frontend values are public. Validation rejects secret-like names in `publicEnvironment`.
- The optional advisor runs locally, reads only explicitly selected files, redacts likely credentials, and never executes a deployment.

Read [SECURITY.md](SECURITY.md) before enrolling a production server.

## v0.1 boundaries

Included: first deployment, same-commit failed retry, Docker Compose, Node PM2 API/SSR/workers, static Node frontends, host Nginx, WebSockets/SSE, external or Compose databases, direct DNS validation, and Certbot.

Not included: successful-target updates, rollback, deletion, DNS changes, backups/restores, Kubernetes, cloud control planes, non-Ubuntu hosts, non-Node PM2 workloads, or automatic server upgrades.

The infrastructure acceptance matrix and disposable-VPS dogfood procedure are documented in [docs/acceptance.md](docs/acceptance.md).
