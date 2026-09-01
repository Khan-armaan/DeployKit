import { readFile } from "node:fs/promises";
import prompts from "prompts";
import { requireRunnerLabel, type ProjectManifest } from "./manifest.js";
import { makeTargetId } from "./server/ids.js";
import { secretRequirementsFromManifest } from "./server/secrets.js";
import { requireServer } from "./local-config.js";
import { runRemoteDeployKit } from "./remote.js";

function secretNames(manifest: ProjectManifest): { required: string[]; generated: string[] } {
  const requirements = secretRequirementsFromManifest(manifest);
  return {
    required: [...new Set(requirements.required)].sort(),
    generated: [...new Set(requirements.generated ?? [])].sort()
  };
}

function remoteSecretArgs(command: "write" | "check", targetId: string, required: string[], generated: string[]): string[] {
  return [
    "server",
    `secrets-${command}`,
    "--target-id",
    targetId,
    "--required",
    required.join(",") || "none",
    "--generated",
    generated.join(",") || "none"
  ];
}

async function interactiveSecrets(required: string[]): Promise<string> {
  const response = await prompts(required.map((name) => ({
    type: "password" as const,
    name,
    message: name,
    validate: (value: string) => value.length > 0 || `${name} is required`
  })), { onCancel: () => { throw new Error("Secret input cancelled"); } });
  return `${required.map((name) => `${name}=${JSON.stringify(String(response[name]))}`).join("\n")}\n`;
}

export async function setRemoteSecrets(
  manifest: ProjectManifest,
  targetName: string,
  options: { file?: string; stdin?: NodeJS.ReadableStream } = {}
): Promise<unknown> {
  const target = manifest.targets[targetName];
  if (!target) throw new Error(`Unknown target '${targetName}'`);
  const server = await requireServer(requireRunnerLabel(target, targetName));
  const names = secretNames(manifest);
  let contents: string;
  if (options.file && options.file !== "-") contents = await readFile(options.file, "utf8");
  else if (options.file === "-" || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    const input = options.stdin ?? process.stdin;
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    contents = Buffer.concat(chunks).toString("utf8");
  } else contents = await interactiveSecrets(names.required);
  const targetId = makeTargetId(manifest.metadata.name, targetName);
  const result = await runRemoteDeployKit(server.host, remoteSecretArgs("write", targetId, names.required, names.generated), { input: contents, hostKey: server.hostKey });
  return JSON.parse(result.stdout) as unknown;
}

export async function checkRemoteSecrets(manifest: ProjectManifest, targetName: string): Promise<unknown> {
  const target = manifest.targets[targetName];
  if (!target) throw new Error(`Unknown target '${targetName}'`);
  const server = await requireServer(requireRunnerLabel(target, targetName));
  const names = secretNames(manifest);
  const targetId = makeTargetId(manifest.metadata.name, targetName);
  const result = await runRemoteDeployKit(server.host, remoteSecretArgs("check", targetId, names.required, names.generated), { hostKey: server.hostKey });
  return JSON.parse(result.stdout) as unknown;
}
