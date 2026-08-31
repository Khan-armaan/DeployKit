import { DeployKitError } from "./errors.js";
import { run } from "./process.js";

export const DEPLOYKIT_WORKFLOW_PATH = ".github/workflows/deploykit.yml";

export async function inferGitHubRepository(cwd = process.cwd()): Promise<string> {
  try {
    const result = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd });
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.stdout)) return result.stdout;
  } catch {
    const remote = await run("git", ["remote", "get-url", "origin"], { cwd });
    const match = remote.stdout.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2]}`;
  }
  throw new DeployKitError("DK_PREFLIGHT_FAILED", "Unable to determine GitHub owner/repository; authenticate gh or configure origin");
}

export function validateApplicationRef(ref: string): void {
  const hasControlCharacter = [...ref].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (ref.length === 0 || ref.length > 255 || hasControlCharacter || ref.startsWith("-")) {
    throw new DeployKitError("DK_USAGE", "Invalid Git reference");
  }
}

export interface DispatchOptions {
  repository: string;
  target: string;
  applicationRef: string;
  resume?: boolean;
  dryRun?: boolean;
  workflowRef?: string;
}

export async function dispatchDeployment(options: DispatchOptions): Promise<{ repository: string; target: string; ref: string; resume: boolean }> {
  validateApplicationRef(options.applicationRef);
  const fields = [
    "-f", `target=${options.target}`,
    "-f", `ref=${options.applicationRef}`,
    "-f", `resume=${options.resume ? "true" : "false"}`,
    "-f", `dry_run=${options.dryRun ? "true" : "false"}`
  ];
  await run("gh", [
    "workflow",
    "run",
    DEPLOYKIT_WORKFLOW_PATH,
    "--repo",
    options.repository,
    ...(options.workflowRef ? ["--ref", options.workflowRef] : []),
    ...fields
  ]);
  return { repository: options.repository, target: options.target, ref: options.applicationRef, resume: Boolean(options.resume) };
}
