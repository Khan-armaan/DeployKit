import { DeployKitError } from "./errors.js";
import { run, type RunResult } from "./process.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SAFE_REMOTE_ARGUMENT = /^[A-Za-z0-9_.,:/=@+-]+$/;

export async function runRemoteDeployKit(
  host: string,
  args: readonly string[],
  options: { input?: string; timeoutMs?: number; inherit?: boolean; hostKey?: string } = {}
): Promise<RunResult> {
  for (const argument of args) {
    if (!SAFE_REMOTE_ARGUMENT.test(argument)) {
      throw new DeployKitError("DK_USAGE", `Unsafe remote argument rejected: ${argument}`);
    }
  }
  const temporary = options.hostKey ? await mkdtemp(join(tmpdir(), "deploykit-known-host-")) : undefined;
  try {
    const security: string[] = [];
    if (temporary && options.hostKey) {
      const knownHosts = join(temporary, "known_hosts");
      await writeFile(knownHosts, `${options.hostKey}\n`, { mode: 0o600 });
      security.push("-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes");
    }
    return await run("ssh", [...security, host, "sudo", "deploykit", ...args], {
      input: options.input,
      timeoutMs: options.timeoutMs,
      stdio: options.inherit ? "inherit" : "pipe"
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
