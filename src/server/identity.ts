import {
  DEPLOYMENT_IDENTITY_API_VERSION,
  MANIFEST_DIGEST_API_VERSION,
  RUNTIME_MANIFEST_CANONICALIZATION,
  SHA256_HEX_PATTERN,
  type DeploymentStateIdentity,
  type ManifestDigest,
} from "../orchestrator/contracts.js";
import { ServerError } from "./errors.js";
import { assertCommitSha, assertSafeId } from "./ids.js";

/**
 * A deployment is identified by the triple (target ID, full commit SHA,
 * manifest digest) frozen in Phase 1. The runtime accepts nothing weaker: two
 * configs that differ only in a backend secret *value* compile to the same
 * digest, which is exactly what makes resuming a failed attempt safe, and any
 * other difference produces a new identity the server refuses to graft onto
 * existing state.
 */

export function assertManifestDigest(value: unknown): ManifestDigest {
  const digest = value as ManifestDigest | undefined;
  if (
    digest === undefined ||
    digest === null ||
    typeof digest !== "object" ||
    digest.apiVersion !== MANIFEST_DIGEST_API_VERSION ||
    digest.algorithm !== "sha256" ||
    digest.encoding !== "hex" ||
    digest.canonicalization !== RUNTIME_MANIFEST_CANONICALIZATION ||
    typeof digest.value !== "string" ||
    !SHA256_HEX_PATTERN.test(digest.value)
  ) {
    throw new ServerError("SERVER_STATE_INVALID", "manifest digest does not match the frozen digest contract", {
      apiVersion: MANIFEST_DIGEST_API_VERSION,
    });
  }
  return digest;
}

export function makeManifestDigest(hex: string): ManifestDigest {
  const value = hex.toLowerCase();
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new ServerError(
      "SERVER_STATE_INVALID",
      "manifest digest must be a lower-case 64-character SHA-256 hexadecimal value",
    );
  }
  return {
    apiVersion: MANIFEST_DIGEST_API_VERSION,
    algorithm: "sha256",
    encoding: "hex",
    canonicalization: RUNTIME_MANIFEST_CANONICALIZATION,
    value,
  };
}

export function makeDeploymentIdentity(
  targetId: string,
  commitSha: string,
  digest: ManifestDigest | string,
): DeploymentStateIdentity {
  return {
    apiVersion: DEPLOYMENT_IDENTITY_API_VERSION,
    targetId: assertSafeId(targetId, "target id"),
    commitSha: assertCommitSha(commitSha),
    manifestDigest: typeof digest === "string" ? makeManifestDigest(digest) : assertManifestDigest(digest),
  };
}

export function assertDeploymentIdentity(
  value: unknown,
  expectedTargetId: string,
): DeploymentStateIdentity {
  const identity = value as DeploymentStateIdentity | undefined;
  if (
    identity === undefined ||
    identity === null ||
    typeof identity !== "object" ||
    identity.apiVersion !== DEPLOYMENT_IDENTITY_API_VERSION ||
    identity.targetId !== expectedTargetId
  ) {
    throw new ServerError("SERVER_STATE_INVALID", "deployment identity does not match the frozen identity contract", {
      expectedTargetId,
    });
  }
  return makeDeploymentIdentity(identity.targetId, assertCommitSha(identity.commitSha), identity.manifestDigest);
}

export function sameDeploymentIdentity(
  left: DeploymentStateIdentity,
  right: DeploymentStateIdentity,
): boolean {
  return left.targetId === right.targetId &&
    left.commitSha === right.commitSha &&
    left.manifestDigest.value === right.manifestDigest.value;
}

/** Names only the fields that differ, so the refusal never guesses a cause. */
export function identityMismatchFields(
  recorded: DeploymentStateIdentity,
  requested: DeploymentStateIdentity,
): readonly ("targetId" | "commitSha" | "manifestDigest")[] {
  const fields: ("targetId" | "commitSha" | "manifestDigest")[] = [];
  if (recorded.targetId !== requested.targetId) fields.push("targetId");
  if (recorded.commitSha !== requested.commitSha) fields.push("commitSha");
  if (recorded.manifestDigest.value !== requested.manifestDigest.value) fields.push("manifestDigest");
  return fields;
}
