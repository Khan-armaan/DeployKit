import { stringify } from "yaml";

import type { ProjectManifest } from "../manifest.js";
import {
  assertSafeName,
  manifestRecord,
  namedEntries,
  optionalString,
  requiredString,
} from "./model.js";

/** actions/checkout v7.0.0. Generated workflows never use a mutable tag. */
export const CHECKOUT_ACTION_SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

export interface GitHubWorkflowOptions {
  /** Workflow display name. */
  name?: string;
  /** Relative path to the manifest in the checked-out application repository. */
  manifestPath?: string;
  /** Maximum duration for an individual target job. */
  timeoutMinutes?: number;
}

interface WorkflowTarget {
  name: string;
  runnerLabel: string;
  environment: string;
}

function workflowTargets(manifest: ProjectManifest): WorkflowTarget[] {
  const root = manifestRecord(manifest);
  return namedEntries(root.targets, "targets").map(({ name, value }) => ({
    name: assertSafeName(name, `targets.${name}`),
    runnerLabel: assertSafeName(
      requiredString(value, "runnerLabel", `targets.${name}`),
      `targets.${name}.runnerLabel`,
    ),
    environment:
      optionalString(value, "environment") ?? `deploykit-${assertSafeName(name, "target name")}`,
  }));
}

function jobIdentifier(target: string): string {
  return `deploy_${target.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function applyScript(manifestPath: string): string {
  return [
    "set -Eeuo pipefail",
    'commit_sha="$(git rev-parse HEAD)"',
    'args=(server apply --manifest "$DEPLOYKIT_MANIFEST" --target "$DEPLOYKIT_TARGET" --commit "$commit_sha")',
    'if [[ "$DEPLOYKIT_DRY_RUN" == "true" ]]; then args+=(--dry-run); fi',
    'if [[ "$DEPLOYKIT_RESUME" == "true" ]]; then args+=(--resume); fi',
    'deploykit "${args[@]}"',
  ].join("\n").replace("$DEPLOYKIT_MANIFEST", `$DEPLOYKIT_WORKSPACE/${manifestPath}`);
}

/**
 * Render the complete, pinned workflow installed by `deploykit init`.
 *
 * The workflow itself must be dispatched from the repository default branch;
 * `inputs.ref` controls only the immutable application checkout.
 */
export function generateGitHubWorkflow(
  manifest: ProjectManifest,
  options: GitHubWorkflowOptions = {},
): string {
  const targets = workflowTargets(manifest);
  if (targets.length === 0) {
    throw new Error("At least one deployment target is required to generate a workflow");
  }

  const manifestPath = options.manifestPath ?? "deploykit.yaml";
  if (
    manifestPath.startsWith("/") ||
    manifestPath.split("/").includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(manifestPath)
  ) {
    throw new Error("manifestPath must be a safe repository-relative path without '..'");
  }

  const timeoutMinutes = options.timeoutMinutes ?? 60;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 360) {
    throw new Error("timeoutMinutes must be an integer between 1 and 360");
  }

  const jobs = Object.fromEntries(
    targets.map((target) => [
      jobIdentifier(target.name),
      {
        name: `Deploy ${target.name}`,
        if: `\${{ inputs.target == '${target.name}' }}`,
        "runs-on": ["self-hosted", "deploykit", target.runnerLabel],
        environment: target.environment,
        "timeout-minutes": timeoutMinutes,
        steps: [
          {
            name: "Require protected workflow source",
            shell: "bash",
            env: {
              DEPLOYKIT_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
              DEPLOYKIT_WORKFLOW_REF: "${{ github.ref }}",
            },
            run: [
              "set -Eeuo pipefail",
              'expected="refs/heads/${DEPLOYKIT_DEFAULT_BRANCH}"',
              'if [[ "$DEPLOYKIT_WORKFLOW_REF" != "$expected" ]]; then',
              '  echo "::error::DeployKit workflows must run from the protected default branch"',
              "  exit 78",
              "fi",
            ].join("\n"),
          },
          {
            name: "Checkout requested application ref",
            uses: `actions/checkout@${CHECKOUT_ACTION_SHA}`,
            with: {
              ref: "${{ inputs.ref }}",
              "fetch-depth": 1,
              "persist-credentials": false,
            },
          },
          {
            name: "Apply deployment",
            shell: "bash",
            env: {
              DEPLOYKIT_TARGET: target.name,
              DEPLOYKIT_DRY_RUN: "${{ inputs.dry_run }}",
              DEPLOYKIT_RESUME: "${{ inputs.resume }}",
              DEPLOYKIT_WORKSPACE: "${{ github.workspace }}",
            },
            run: applyScript(manifestPath),
          },
        ],
      },
    ]),
  );

  const workflow = {
    name: options.name ?? "Deploy with DeployKit",
    on: {
      workflow_dispatch: {
        inputs: {
          target: {
            description: "Configured DeployKit target",
            required: true,
            type: "choice",
            options: targets.map((target) => target.name),
            default: targets[0]?.name,
          },
          ref: {
            description: "Application branch, tag, or commit to deploy",
            required: false,
            type: "string",
            default: "main",
          },
          dry_run: {
            description: "Plan without changing the server",
            required: false,
            type: "boolean",
            default: false,
          },
          resume: {
            description: "Resume a previously failed first deployment",
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
      group: "deploykit-${{ inputs.target }}",
      "cancel-in-progress": false,
    },
    jobs,
  };

  return [
    "# Generated by DeployKit. Do not add untrusted steps to this privileged workflow.",
    stringify(workflow, { lineWidth: 0 }),
  ].join("\n");
}
