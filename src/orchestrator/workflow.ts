import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stringify } from "yaml";

import { DeployKitError } from "../errors.js";
import { resolvePackageRoot } from "../package-root.js";
import {
  MANAGED_GATEWAY_HOST_VARIABLE,
  MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE,
  MANAGED_GATEWAY_PORT_VARIABLE,
  MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
  MANAGED_GATEWAY_USER_VARIABLE,
  MANAGED_OWNERSHIP_PATH,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_TARGET_ID_VARIABLE,
  MANAGED_WORKFLOW_PATH,
} from "./contracts.js";
import type { DeploymentContext } from "./planner.js";

/**
 * Phase 10 owns the bytes of `.github/workflows/deploykit.yml`.
 *
 * The workflow is the one piece of DeployKit that runs with the target
 * Environment's secrets attached, on a runner DeployKit does not control, from
 * a branch a human protected. Everything about it is therefore shaped by one
 * question: what can this file be trusted to do if somebody changes the
 * repository around it?
 *
 * It is *reviewable*. The whole client — verification, framing, transport, and
 * reporting — is embedded in the file rather than downloaded at run time, so
 * the diff an operator merges is the code that will hold their secrets. There
 * is no `npm install`, no `curl | sh`, and no mutable action tag; the single
 * third-party action is pinned to a commit SHA.
 *
 * It is *bound*. The repository, target, target ID, Environment, and
 * application ref are baked in at render time and re-checked at run time
 * against `github.repository`, the dispatch inputs, and the Environment's own
 * `DEPLOYKIT_TARGET_ID`. A workflow copied into another repository, dispatched
 * for another target, or run from a branch that is not the protected default
 * refuses before it reaches the credentials.
 *
 * It is *narrow*. `permissions` grants `contents: read` and nothing else, the
 * checkout does not persist credentials, concurrency is keyed by target ID, and
 * the private key and `known_hosts` live in a mode-0700 directory under
 * `RUNNER_TEMP` that is shredded in `always()`.
 *
 * It is *secret-free as bytes*. Nothing rendered here carries a value: the
 * gateway key arrives as an Environment secret, backend values arrive through
 * `toJSON(secrets)` in a step environment, and the client selects them by the
 * names the reviewed ownership marker declares.
 *
 * The rendered bytes are a pure function of the deployment context, so a rerun
 * that changes nothing produces the identical file and therefore no second
 * setup pull request.
 */

/** actions/checkout v5.0.0. A managed workflow never uses a mutable tag. */
export const MANAGED_CHECKOUT_ACTION_SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

export const MANAGED_WORKFLOW_ASSET = "assets/gateway-client.mjs";

/** Where the staged gateway credentials and the client live on the runner. */
const RUNNER_DIRECTORY = "${RUNNER_TEMP}/deploykit-gateway";
const RUNNER_DIRECTORY_EXPRESSION = "${{ runner.temp }}/deploykit-gateway";

const JOB_TIMEOUT_MINUTES = 60;

const HEREDOC_DELIMITER = "DEPLOYKIT_GATEWAY_CLIENT";

function modulePackageRoot(): string {
  return resolvePackageRoot({
    moduleUrl: import.meta.url,
    markers: [MANAGED_WORKFLOW_ASSET],
    subject: "managed workflow template",
  });
}

export function resolveBundledGatewayClientPath(packageRoot = modulePackageRoot()): string {
  return resolve(packageRoot, MANAGED_WORKFLOW_ASSET);
}

export function readBundledGatewayClient(packageRoot?: string): string {
  const path = resolveBundledGatewayClientPath(packageRoot);
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new DeployKitError(
      "DK_UNSUPPORTED",
      `The bundled gateway client could not be read from ${path}`,
      { cause },
    );
  }
}

/**
 * The client is embedded through a quoted heredoc, so no line of it is ever
 * expanded by the shell. A client that could close its own heredoc would let a
 * later line escape into the step, so the delimiter is verified rather than
 * assumed.
 */
function embedGatewayClient(script: string): string {
  if (script.includes(HEREDOC_DELIMITER)) {
    throw new DeployKitError(
      "DK_UNSUPPORTED",
      "The bundled gateway client contains the heredoc delimiter the workflow reserves",
    );
  }
  const body = script.endsWith("\n") ? script.slice(0, -1) : script;
  return [
    "set -Eeuo pipefail",
    "umask 077",
    `cat > "${RUNNER_DIRECTORY}/client.mjs" <<'${HEREDOC_DELIMITER}'`,
    body,
    HEREDOC_DELIMITER,
    `chmod 600 "${RUNNER_DIRECTORY}/client.mjs"`,
  ].join("\n");
}

const REQUIRE_PROTECTED_SOURCE = [
  "set -Eeuo pipefail",
  'if [ "$DEPLOYKIT_WORKFLOW_REF" != "refs/heads/$DEPLOYKIT_DEFAULT_BRANCH" ]; then',
  '  echo "::error::DeployKit: this workflow runs only from the protected default branch"',
  "  exit 1",
  "fi",
  'if [ "$DEPLOYKIT_REPOSITORY" != "$DEPLOYKIT_EXPECTED_REPOSITORY" ]; then',
  '  echo "::error::DeployKit: this workflow is bound to another repository"',
  "  exit 1",
  "fi",
].join("\n");

const STAGE_CREDENTIALS = [
  "set -Eeuo pipefail",
  "umask 077",
  `directory="${RUNNER_DIRECTORY}"`,
  'rm -rf "$directory"',
  'mkdir -p "$directory"',
  'chmod 700 "$directory"',
  `printf '%s\\n' "$${MANAGED_GATEWAY_PRIVATE_KEY_SECRET}" > "$directory/identity"`,
  `printf '%s\\n' "$${MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE}" > "$directory/known_hosts"`,
  'chmod 600 "$directory/identity" "$directory/known_hosts"',
  'if ! ssh-keygen -l -f "$directory/identity" > /dev/null 2>&1; then',
  `  echo "::error::DeployKit: ${MANAGED_GATEWAY_PRIVATE_KEY_SECRET} is not a usable OpenSSH private key"`,
  "  exit 1",
  "fi",
  // A pinned host entry is the whole point of the staged known_hosts: without a
  // matching line, strict checking would fail later, after the key is on disk.
  `if ! ssh-keygen -F "[$${MANAGED_GATEWAY_HOST_VARIABLE}]:$${MANAGED_GATEWAY_PORT_VARIABLE}" -f "$directory/known_hosts" > /dev/null 2>&1 \\`,
  `  && ! ssh-keygen -F "$${MANAGED_GATEWAY_HOST_VARIABLE}" -f "$directory/known_hosts" > /dev/null 2>&1; then`,
  `  echo "::error::DeployKit: ${MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE} does not pin the gateway host"`,
  "  exit 1",
  "fi",
].join("\n");

const REMOVE_CREDENTIALS = [
  "set -Eeuo pipefail",
  `directory="${RUNNER_DIRECTORY}"`,
  'if [ -d "$directory" ]; then',
  '  find "$directory" -type f -exec shred --force --zero --remove {} + 2>/dev/null || true',
  '  rm -rf "$directory"',
  "fi",
].join("\n");

const RUN_CLIENT = [
  "set -Eeuo pipefail",
  `node "${RUNNER_DIRECTORY}/client.mjs"`,
].join("\n");

interface WorkflowStep {
  readonly name: string;
  readonly if?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly shell?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly run?: string;
}

export interface ManagedWorkflowOptions {
  /** Root of the installed npm package holding `assets/gateway-client.mjs`. */
  readonly packageRoot?: string;
  /** The client bytes to embed. Supplied directly only by tests. */
  readonly gatewayClient?: string;
}

/**
 * Renders the managed workflow for one target. The result is byte-stable for a
 * given context and embedded client, which is what lets the setup pull request
 * be created once rather than on every run.
 */
export function renderManagedWorkflow(
  context: DeploymentContext,
  options: ManagedWorkflowOptions = {},
): string {
  const client = options.gatewayClient ?? readBundledGatewayClient(options.packageRoot);

  const steps: readonly WorkflowStep[] = [
    {
      name: "Require the protected default branch",
      shell: "bash",
      env: {
        DEPLOYKIT_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
        DEPLOYKIT_EXPECTED_REPOSITORY: context.repository,
        DEPLOYKIT_REPOSITORY: "${{ github.repository }}",
        DEPLOYKIT_WORKFLOW_REF: "${{ github.ref }}",
      },
      run: REQUIRE_PROTECTED_SOURCE,
    },
    {
      name: "Check out the reviewed control artifacts",
      uses: `actions/checkout@${MANAGED_CHECKOUT_ACTION_SHA}`,
      with: {
        ref: "${{ github.sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
      },
    },
    {
      name: "Stage the gateway credentials",
      shell: "bash",
      env: {
        [MANAGED_GATEWAY_HOST_VARIABLE]: `\${{ vars.${MANAGED_GATEWAY_HOST_VARIABLE} }}`,
        [MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE]: `\${{ vars.${MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE} }}`,
        [MANAGED_GATEWAY_PORT_VARIABLE]: `\${{ vars.${MANAGED_GATEWAY_PORT_VARIABLE} }}`,
        [MANAGED_GATEWAY_PRIVATE_KEY_SECRET]: `\${{ secrets.${MANAGED_GATEWAY_PRIVATE_KEY_SECRET} }}`,
      },
      run: STAGE_CREDENTIALS,
    },
    {
      name: "Install the bounded gateway client",
      shell: "bash",
      run: embedGatewayClient(client),
    },
    {
      name: "Deploy through the DeployKit gateway",
      shell: "bash",
      env: {
        DK_APPLICATION_REF: context.applicationRef,
        DK_COMMIT_SHA: "${{ inputs.commit_sha }}",
        DK_DRY_RUN: "${{ inputs.dry_run }}",
        DK_ENVIRONMENT: context.githubEnvironment,
        DK_ENVIRONMENT_TARGET_ID: `\${{ vars.${MANAGED_TARGET_ID_VARIABLE} }}`,
        DK_GATEWAY_HOST: `\${{ vars.${MANAGED_GATEWAY_HOST_VARIABLE} }}`,
        DK_GATEWAY_PORT: `\${{ vars.${MANAGED_GATEWAY_PORT_VARIABLE} }}`,
        DK_GATEWAY_USER: `\${{ vars.${MANAGED_GATEWAY_USER_VARIABLE} }}`,
        DK_IDENTITY_FILE: `${RUNNER_DIRECTORY_EXPRESSION}/identity`,
        DK_KNOWN_HOSTS_FILE: `${RUNNER_DIRECTORY_EXPRESSION}/known_hosts`,
        DK_MANIFEST_DIGEST: "${{ inputs.manifest_digest }}",
        DK_MANIFEST_FILE: MANAGED_RUNTIME_MANIFEST_PATH,
        DK_OWNERSHIP_FILE: MANAGED_OWNERSHIP_PATH,
        DK_REPOSITORY: context.repository,
        DK_REQUEST_ID: "${{ inputs.request_id }}",
        DK_RESUME: "${{ inputs.resume }}",
        // The whole bundle is injected and the client selects only the names
        // the reviewed ownership marker declares, so a secret the deployment
        // does not use is never framed, logged, or sent.
        DK_SECRETS_JSON: "${{ toJSON(secrets) }}",
        DK_TARGET_ID: context.targetId,
        DK_TARGET_INPUT: "${{ inputs.target }}",
        DK_TARGET_NAME: context.targetName,
        DK_WORKFLOW_FILE: MANAGED_WORKFLOW_PATH,
      },
      run: RUN_CLIENT,
    },
    {
      name: "Remove the staged gateway credentials",
      if: "always()",
      shell: "bash",
      run: REMOVE_CREDENTIALS,
    },
  ];

  const workflow = {
    name: `DeployKit ${context.targetName}`,
    "run-name": "DeployKit ${{ inputs.target }} ${{ inputs.request_id }}",
    on: {
      workflow_dispatch: {
        inputs: {
          request_id: {
            description: "DeployKit request UUID",
            required: true,
            type: "string",
          },
          target: {
            description: "DeployKit target name",
            required: true,
            type: "string",
          },
          commit_sha: {
            description: "Full 40-character application commit SHA",
            required: true,
            type: "string",
          },
          manifest_digest: {
            description: "SHA-256 digest of the reviewed runtime manifest",
            required: true,
            type: "string",
          },
          resume: {
            description: "Resume a failed first deployment",
            required: false,
            type: "boolean",
            default: false,
          },
          dry_run: {
            description: "Plan without changing the server",
            required: false,
            type: "boolean",
            default: false,
          },
        },
      },
    },
    permissions: {
      contents: "read",
    },
    concurrency: {
      group: `deploykit-${context.targetId}`,
      "cancel-in-progress": false,
    },
    jobs: {
      deploy: {
        name: `Deploy ${context.targetName}`,
        "runs-on": "ubuntu-latest",
        environment: context.githubEnvironment,
        "timeout-minutes": JOB_TIMEOUT_MINUTES,
        steps,
      },
    },
  };

  return [
    "# Generated by DeployKit. Reviewed through the DeployKit setup pull request.",
    "# Do not edit: DeployKit compares these exact bytes before every dispatch.",
    stringify(workflow, { lineWidth: 0 }),
  ].join("\n");
}

/** The `renderWorkflow` part the desired-state planner takes. */
export function createManagedWorkflowRenderer(
  options: ManagedWorkflowOptions = {},
): (context: DeploymentContext) => string {
  const client = options.gatewayClient ?? readBundledGatewayClient(options.packageRoot);
  return (context) => renderManagedWorkflow(context, { gatewayClient: client });
}
