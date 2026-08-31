import { createHash } from "node:crypto";

import { ServerError } from "./errors.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SAFE_TARGET_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function assertSafeId(value: string, label = "identifier"): string {
  if (!SAFE_ID.test(value)) {
    throw new ServerError(
      "SERVER_INVALID_ID",
      `${label} must contain only lowercase letters, digits, and interior hyphens (maximum 63 characters)`,
      { label, value },
    );
  }
  return value;
}

export function assertTargetName(value: string): string {
  if (!SAFE_TARGET_NAME.test(value)) {
    throw new ServerError(
      "SERVER_INVALID_ID",
      "target name must contain only letters, digits, dots, underscores, and interior hyphens (maximum 64 characters)",
      { value },
    );
  }
  return value;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "app";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

/**
 * Creates a human-readable, collision-resistant server identifier. The digest is
 * always included so two names that normalize to the same slug cannot share
 * state, ports, Unix users, or Nginx files.
 */
export function makeTargetId(projectName: string, targetName: string): string {
  if (projectName.trim() === "") {
    throw new ServerError("SERVER_INVALID_ID", "project name cannot be empty");
  }
  assertTargetName(targetName);
  const raw = `${projectName}\0${targetName}`;
  const suffix = digest(raw);
  const readable = `${slug(projectName)}-${slug(targetName)}`;
  const prefix = readable.slice(0, 63 - suffix.length - 1).replace(/-+$/g, "");
  return assertSafeId(`${prefix || "app"}-${suffix}`, "target id");
}

export function makeServiceKey(targetId: string, serviceName: string): string {
  assertSafeId(targetId, "target id");
  if (serviceName.trim() === "" || serviceName.includes("\0")) {
    throw new ServerError("SERVER_INVALID_ID", "service name cannot be empty or contain NUL");
  }
  return `${targetId}:${serviceName}`;
}

export function assertCommitSha(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new ServerError(
      "SERVER_STATE_INVALID",
      "commit SHA must be the full 40-character hexadecimal object id",
      { value },
    );
  }
  return value.toLowerCase();
}
