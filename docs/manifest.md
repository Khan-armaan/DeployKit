# DeployKit manifest reference

This file documents `deploykit.yaml`, the **legacy** hand-edited manifest. It is not the file a one-command deployment asks for.

`deploykit deploy` reads `deploykit.config.yaml` and compiles it into a secret-free runtime manifest whose shape and canonicalization are frozen in [`orchestrator-contracts.md`](orchestrator-contracts.md); the bundled `assets/deploykit.config.example.yaml` is the authoritative example of the file an operator actually writes. The semantics below still describe what the compiled result must satisfy, because the compiler validates through exactly these rules — so this remains the reference for what a service, frontend, route, database, or hook may say. Read it that way, and read it directly only when maintaining a project already initialized on the legacy path.

`deploykit.yaml` is parsed strictly. Unknown fields are errors so configuration mistakes cannot silently change production behavior.

## Top-level fields

- `apiVersion`: exactly `deploykit/v1alpha1`.
- `metadata.name`: stable lowercase project slug.
- `metadata.requiredVersion`: DeployKit version expected on the runner.
- `compose.files`: existing project-relative Compose files. Required when any service or database uses Compose.
- `services`: logical service map.
- `frontend`: optional static build or logical HTTP service.
- `routes`: ordered HTTP behavior; the generator sorts exact paths before longest prefixes.
- `database`: optional Compose or external database contract.
- `secrets`: required and generated names, never values.
- `targets`: named deployments, runner labels, domains, GitHub Environments, and safe overrides.

## Services

Compose services declare `type: compose`, the existing Compose `service`, an `internalPort`, optional fixed `hostPort`, and a non-process health check. DeployKit rejects `container_name` and existing Compose `ports`; it generates loopback bindings itself.

PM2 services declare `type: pm2`, `role: api|ssr|worker`, exact Node version, package manager, package scripts, working directory, and health check. API/SSR services require `portEnvironmentVariable`; workers must use process or command health checks. pnpm, Yarn, and Bun workloads also require an exact `packageManager` declaration in their existing `package.json`; this lets the server activate a deterministic adapter without changing the application file.

## Frontends

A static frontend declares its Node build adapter and output directory. `publicEnvironment` values are intentionally visible to browsers. The default API base path is `/api` so frontend and backend can share an origin.

A service frontend references a logical Compose or PM2 HTTP service and is proxied through Nginx.

## Routes

Routes support exact/prefix matching, explicit prefix preservation, WebSocket headers, SSE buffering behavior, request/response buffering, upload limits, and connect/send/read timeouts. WebSocket upgrade headers are emitted only for routes with `websocket: true`.

## Databases and hooks

Compose databases must use a named volume. They remain on the Compose network unless a PM2 consumer requires a loopback binding; that case requires `database.internalPort`. A derived connection string declares both `connectionStringSecret` and a template containing `{username}`, `{password}`, `{host}`, `{port}`, and `{database}`. External databases reference a connection-string secret and optional TLS CA secret.

Migration and seed commands are argument arrays executed as fatal hooks. DeployKit never appends `|| true` and never removes data volumes.

`CERTBOT_EMAIL` is always declared in `secrets.required`; DeployKit passes it to Certbot over stdin rather than exposing it in the process argument list.
