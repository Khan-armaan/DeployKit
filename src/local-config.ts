import { homedir } from "node:os";
import { join } from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "./fs.js";

export interface ServerRecord {
  host: string;
  repository: string;
  label: string;
  fingerprint?: string;
  hostKey?: string;
  enrolledAt: string;
}

export interface LocalConfig {
  servers: Record<string, ServerRecord>;
}

export function localConfigPath(): string {
  return process.env.DEPLOYKIT_CONFIG_PATH ?? join(homedir(), ".config", "deploykit", "servers.json");
}

export async function loadLocalConfig(): Promise<LocalConfig> {
  const path = localConfigPath();
  if (!(await pathExists(path))) return { servers: {} };
  return readJsonFile<LocalConfig>(path);
}

export async function saveServer(record: ServerRecord): Promise<void> {
  const config = await loadLocalConfig();
  config.servers[record.label] = record;
  await writeJsonFile(localConfigPath(), config, 0o600);
}

export async function requireServer(label: string): Promise<ServerRecord> {
  const record = (await loadLocalConfig()).servers[label];
  if (!record) throw new Error(`Server '${label}' is not enrolled locally. Run deploykit server bootstrap first.`);
  return record;
}
