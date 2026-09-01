import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectDeployment, type ServerInspectionResult } from "./server/inspect.js";
import { serverPaths } from "./server/paths.js";

/**
 * The structured, redacted answer for one target: identity, phase, domains,
 * allocated ports, health, failure code, and the recovery action to take. It is
 * built from durable state alone, so it answers for a target whose manifest is
 * not present.
 */
export async function inspectServerTarget(
  targetId: string,
  targetName?: string,
): Promise<ServerInspectionResult> {
  return await inspectDeployment({ targetId, ...(targetName === undefined ? {} : { targetName }) });
}

export async function readServerTargetLogs(targetId: string, tail = 200): Promise<{ targetId: string; lines: string[] }> {
  if (!Number.isInteger(tail) || tail < 1 || tail > 10_000) throw new Error("tail must be between 1 and 10000");
  const directory = serverPaths(targetId).logsDirectory;
  const deploymentLog = serverPaths(targetId).deploymentLogFile;
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".log")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  const lines: string[] = [];
  try {
    const content = await readFile(deploymentLog, "utf8");
    lines.push(...content.split(/\r?\n/).filter(Boolean).map((line) => `[deployment.log] ${line}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const content = await readFile(join(directory, name), "utf8");
    lines.push(...content.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
  }
  return { targetId, lines: lines.slice(-tail) };
}
