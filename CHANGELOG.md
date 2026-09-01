# Changelog

## 0.1.1

- No user-facing changes; package contents are identical to 0.1.0.
- Release workflow now skips build, publish, and upload when the tagged version is already on the registry, so re-triggering a release no longer fails with a 403.

## 0.1.0

- Initial versioned manifest and TypeScript CLI.
- Ubuntu bootstrap with repo-scoped GitHub Actions runners.
- Shared domain/port registry, checkpointed first deployment, and guided retry.
- Docker Compose and Node PM2 workload drivers.
- Exact, checksum-verified Node toolchains and version-pinned npm/pnpm/Yarn/Bun adapters.
- Static and service frontends, Nginx proxy generation, WebSocket/SSE settings, DNS checks, and Certbot webroot flow.
- Per-target secret storage and optional local OpenAI/Anthropic advisor.
- Standalone checksum-verified VPS bundle, structured redacted phase logs, and three topology fixtures.
