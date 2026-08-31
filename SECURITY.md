# Security policy

## Root runner warning

DeployKit v0.1 installs a repository-scoped GitHub Actions runner as root. This is not a sandbox. A workflow accepted by the runner, a Docker build, or a host package script can obtain full control of the VPS.

Before using DeployKit in production:

1. Keep the application repository private and restrict write access.
2. Protect the default branch and `.github/workflows/deploykit.yml` with required review.
3. Protect the GitHub Environment with independent approval.
4. Never route pull-request or fork workflows to a DeployKit runner.
5. Enroll one separately labeled runner per trusted repository.
6. Rotate application credentials after suspected repository, runner, or Docker compromise.

The generated workflow pins third-party Actions by commit and checks that the workflow source is the default branch. The bootstrap runner hook is defense in depth, not a complete boundary: application code from the selected ref is intentionally built on the VPS.

## Secrets

- Do not commit `.env` files. DeployKit stores values under `/etc/deploykit` with mode `0600`.
- Static frontend variables are public and embedded in built assets.
- Secret values are never accepted in `deploykit.yaml`, command arguments, generated Nginx files, or deployment state.
- `deploykit advise` excludes common secret files and redacts detected values before a provider request.

## Reporting

Do not open a public issue containing a production host, runner token, log with credentials, or exploitable vulnerability. Contact the package maintainers privately through the security contact configured for the npm package/repository.
