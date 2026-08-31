import type { ProjectManifest } from "../manifest.js";

export type ManifestRecord = Record<string, unknown>;

export interface NamedManifestEntry {
  name: string;
  value: ManifestRecord;
}

export function asRecord(value: unknown, label: string): ManifestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ManifestRecord;
}

export function manifestRecord(manifest: ProjectManifest): ManifestRecord {
  return manifest as unknown as ManifestRecord;
}

export function namedEntries(value: unknown, label: string): NamedManifestEntry[] {
  const record = asRecord(value, label);
  return Object.entries(record)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({ name, value: asRecord(entry, `${label}.${name}`) }));
}

export function requiredString(
  value: ManifestRecord,
  key: string,
  label: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return result;
}

export function optionalString(value: ManifestRecord, key: string): string | undefined {
  const result = value[key];
  return typeof result === "string" && result.length > 0 ? result : undefined;
}

export function optionalBoolean(
  value: ManifestRecord,
  key: string,
  fallback: boolean,
): boolean {
  const result = value[key];
  return typeof result === "boolean" ? result : fallback;
}

export function optionalNumber(value: ManifestRecord, key: string): number | undefined {
  const result = value[key];
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}

export function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value].sort((left, right) => left.localeCompare(right));
}

export function assertSafeName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export function assertPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}
