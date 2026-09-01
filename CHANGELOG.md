# Changelog

## 0.1.3

- Bare `deploykit deploy` now creates the bundled `deploykit.config.yaml` template securely instead of failing Commander validation for missing legacy `--target` and `--ref` flags.
- The scaffold is create-exclusive, mode `0600`, repository-locally ignored, and rejects tracked, staged, symlinked, foreign-owned, or group/world-readable configuration files.
- The full config parser and one-command GitHub/VPS orchestrator remain pending; existing v0.1 projects can temporarily use the explicitly labeled legacy flags.

## 0.1.2

- Documentation only; the shipped CLI behaviour is unchanged from 0.1.1.
- Rewrote the README and AGENTS.md around the one-file `deploykit.config.yaml` workflow.
- Clarified in `assets/deploykit.config.example.yaml` that the template ships with the npm package and that `deploykit deploy` will seed `deploykit.config.yaml` from it with mode 0600.

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
