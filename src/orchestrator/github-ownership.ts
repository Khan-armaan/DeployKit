import type { DeployKitError } from "../errors.js";
import { compareCodePoints } from "./canonical.js";
import {
  GITHUB_OWNERSHIP_API_VERSION,
  MANAGED_GATEWAY_HOST_VARIABLE,
  MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE,
  MANAGED_GATEWAY_PORT_VARIABLE,
  MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
  MANAGED_GATEWAY_USER_VARIABLE,
  MANAGED_OWNERSHIP_PATH,
  MANAGED_REPOSITORY_KEY_TITLE_PREFIX,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_SETUP_BRANCH_PREFIX,
  MANAGED_SETUP_PULL_REQUEST_TITLE_PREFIX,
  MANAGED_TARGET_ID_VARIABLE,
  MANAGED_WORKFLOW_PATH,
  MANIFEST_DIGEST_API_VERSION,
  RUNTIME_MANIFEST_CANONICALIZATION,
  SHA256_HEX_PATTERN,
  type GitHubManagedResourceNames,
  type GitHubOwnershipMarker,
  type ManifestDigest,
  type Sha256Hex,
} from "./contracts.js";
import type { GitHubDeployKey, GitHubPullRequest } from "./github.js";
import { orchestratorError } from "./failures.js";

/**
 * Ownership: how DeployKit decides whether it is allowed to touch something
 * that already exists on GitHub.
 *
 * The rule is uniform and deliberately unforgiving. A resource is DeployKit's
 * only when it carries a DeployKit marker — the ownership document committed
 * beside the managed workflow, a managed name keyed by target ID, or the
 * reserved `DEPLOYKIT_` prefix that the config schema forbids operators from
 * using. Everything else belongs to somebody, and DeployKit refuses it rather
 * than overwriting it.
 *
 * Two codes come out of this module and they mean different things. A marker
 * that is somebody else's, that binds the managed files to another target, or
 * that claims a file outside the three managed paths is an ownership conflict:
 * a human has to decide. A marker that is unmistakably DeployKit's but no
 * longer describes what is on the branch — a digest that moved, a name list
 * that grew a value — is drift, and a rerun reconciles it.
 */

const VALUE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/u;
const RESERVED_VALUE_PREFIX = "DEPLOYKIT_";

export const MANAGED_FILE_PATHS: readonly [string, string, string] = Object.freeze([
  MANAGED_WORKFLOW_PATH,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_OWNERSHIP_PATH,
]);

const MANAGED_NAME_CONSTANTS: Readonly<Record<string, string>> = Object.freeze({
  workflowPath: MANAGED_WORKFLOW_PATH,
  runtimeManifestPath: MANAGED_RUNTIME_MANIFEST_PATH,
  ownershipPath: MANAGED_OWNERSHIP_PATH,
  gatewayPrivateKeySecret: MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
  gatewayHostVariable: MANAGED_GATEWAY_HOST_VARIABLE,
  gatewayPortVariable: MANAGED_GATEWAY_PORT_VARIABLE,
  gatewayUserVariable: MANAGED_GATEWAY_USER_VARIABLE,
  gatewayKnownHostsVariable: MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE,
  targetIdVariable: MANAGED_TARGET_ID_VARIABLE,
});

const MANAGED_NAME_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  setupBranch: MANAGED_SETUP_BRANCH_PREFIX,
  setupPullRequestTitle: MANAGED_SETUP_PULL_REQUEST_TITLE_PREFIX,
  repositoryDeployKeyTitle: MANAGED_REPOSITORY_KEY_TITLE_PREFIX,
});

const MARKER_KEYS: readonly string[] = Object.freeze([
  "apiVersion", "owner", "repository", "targetName", "targetId", "githubEnvironment",
  "managed", "workflowDigest", "runtimeManifestDigest",
]);

const MANAGED_KEYS: readonly string[] = Object.freeze([
  "names", "files", "frontendVariables", "backendSecrets", "generatedSecrets",
]);

function conflict(message: string, details: Record<string, unknown> = {}): DeployKitError {
  return orchestratorError("DK_OWNERSHIP_CONFLICT", message, { details });
}

function drifted(message: string, details: Record<string, unknown> = {}): DeployKitError {
  return orchestratorError("DK_CONTROL_ARTIFACTS_DRIFTED", message, { details });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(source: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  for (const key of allowed) {
    if (!Object.hasOwn(source, key)) throw drifted(`The ownership marker ${subject} is missing ${key}`);
  }
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw drifted(`The ownership marker ${subject} carries the unknown key ${key}`);
  }
}

/**
 * Secret *names*, never values. A sorted, duplicate-free list of environment
 * identifiers is the only shape allowed, so `NAME=value` — the shape a leak
 * would take — is refused by the same check that keeps the list deterministic.
 */
function readNameList(source: Record<string, unknown>, field: string): readonly string[] {
  const value = source[field];
  if (!Array.isArray(value)) throw drifted(`The ownership marker field ${field} is not an array`);
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VALUE_NAME_PATTERN.test(entry)) {
      throw drifted(`The ownership marker field ${field} carries something other than a value name`);
    }
    if (entry.startsWith(RESERVED_VALUE_PREFIX)) {
      throw drifted(`The ownership marker field ${field} claims the reserved ${RESERVED_VALUE_PREFIX} prefix`);
    }
    names.push(entry);
  }
  for (let index = 1; index < names.length; index += 1) {
    const previous = names[index - 1] ?? "";
    const current = names[index] ?? "";
    if (compareCodePoints(previous, current) >= 0) {
      throw drifted(`The ownership marker field ${field} is not sorted and duplicate-free`);
    }
  }
  return names;
}

function readManagedNames(source: unknown): GitHubManagedResourceNames {
  if (!isObject(source)) throw drifted("The ownership marker managed.names is not an object");
  const expected = [...Object.keys(MANAGED_NAME_CONSTANTS), ...Object.keys(MANAGED_NAME_PREFIXES)];
  assertExactKeys(source, expected, "managed.names");
  for (const [key, constant] of Object.entries(MANAGED_NAME_CONSTANTS)) {
    if (source[key] !== constant) {
      throw conflict(`The ownership marker binds ${key} to a path DeployKit does not manage`, { key });
    }
  }
  for (const [key, prefix] of Object.entries(MANAGED_NAME_PREFIXES)) {
    const value = source[key];
    if (typeof value !== "string" || !value.startsWith(prefix) || value.length === prefix.length) {
      throw conflict(`The ownership marker binds ${key} to a name DeployKit does not manage`, { key });
    }
  }
  return source as unknown as GitHubManagedResourceNames;
}

function readManifestDigest(source: unknown): ManifestDigest {
  if (!isObject(source)) throw drifted("The ownership marker runtimeManifestDigest is not an object");
  if (
    source["apiVersion"] !== MANIFEST_DIGEST_API_VERSION ||
    source["algorithm"] !== "sha256" ||
    source["encoding"] !== "hex" ||
    source["canonicalization"] !== RUNTIME_MANIFEST_CANONICALIZATION ||
    typeof source["value"] !== "string" ||
    !SHA256_HEX_PATTERN.test(source["value"])
  ) {
    throw drifted("The ownership marker runtimeManifestDigest is not a runtime-manifest digest");
  }
  return source as unknown as ManifestDigest;
}

/** Identity a marker may only confirm; it never selects what DeployKit manages. */
export interface OwnershipExpectation {
  readonly repository: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly githubEnvironment: string;
  /** Compared when the caller already knows the bytes it expects. */
  readonly workflowDigest?: Sha256Hex;
  readonly runtimeManifestDigest?: ManifestDigest;
}

/**
 * Parses the committed `ownership.json` and proves it describes *this*
 * deployment. Everything the marker asserts about identity is compared, never
 * adopted: a marker cannot tell DeployKit which target it belongs to.
 */
export function parseOwnershipMarker(text: string, expected: OwnershipExpectation): GitHubOwnershipMarker {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw conflict("The file at the DeployKit ownership path is not a DeployKit ownership marker");
  }
  if (!isObject(document)) {
    throw conflict("The file at the DeployKit ownership path is not a DeployKit ownership marker");
  }
  if (document["apiVersion"] !== GITHUB_OWNERSHIP_API_VERSION || document["owner"] !== "deploykit") {
    throw conflict("The file at the DeployKit ownership path is owned by another tool");
  }
  assertExactKeys(document, MARKER_KEYS, "document");

  for (const field of ["repository", "targetName", "targetId", "githubEnvironment"] as const) {
    if (document[field] !== expected[field]) {
      throw conflict(`The ownership marker binds the managed files to a different ${field}`, { field });
    }
  }

  const managed = document["managed"];
  if (!isObject(managed)) throw drifted("The ownership marker managed block is not an object");
  assertExactKeys(managed, MANAGED_KEYS, "managed");

  const files = managed["files"];
  if (
    !Array.isArray(files) ||
    files.length !== MANAGED_FILE_PATHS.length ||
    files.some((entry, index) => entry !== MANAGED_FILE_PATHS[index])
  ) {
    throw conflict("The ownership marker claims a file outside the three DeployKit-managed paths");
  }

  const names = readManagedNames(managed["names"]);
  const frontendVariables = readNameList(managed, "frontendVariables");
  const backendSecrets = readNameList(managed, "backendSecrets");
  const generatedSecrets = readNameList(managed, "generatedSecrets");

  const workflowDigest = document["workflowDigest"];
  if (typeof workflowDigest !== "string" || !SHA256_HEX_PATTERN.test(workflowDigest)) {
    throw drifted("The ownership marker workflowDigest is not a SHA-256 digest");
  }
  if (expected.workflowDigest !== undefined && workflowDigest !== expected.workflowDigest) {
    throw drifted("The recorded workflow digest no longer matches the managed workflow bytes");
  }
  const runtimeManifestDigest = readManifestDigest(document["runtimeManifestDigest"]);
  if (
    expected.runtimeManifestDigest !== undefined &&
    runtimeManifestDigest.value !== expected.runtimeManifestDigest.value
  ) {
    throw drifted("The recorded runtime-manifest digest no longer matches the compiled manifest");
  }

  return {
    apiVersion: GITHUB_OWNERSHIP_API_VERSION,
    owner: "deploykit",
    repository: expected.repository,
    targetName: expected.targetName,
    targetId: expected.targetId,
    githubEnvironment: expected.githubEnvironment,
    managed: {
      names,
      files: MANAGED_FILE_PATHS as unknown as GitHubOwnershipMarker["managed"]["files"],
      frontendVariables,
      backendSecrets,
      generatedSecrets,
    },
    workflowDigest,
    runtimeManifestDigest,
  };
}

// ------------------------------------------------------------ managed names --

export function isManagedFilePath(path: string): boolean {
  return MANAGED_FILE_PATHS.includes(path);
}

export function isOwnedSetupBranch(branch: string, names: GitHubManagedResourceNames): boolean {
  return branch === names.setupBranch;
}

/** A value name is DeployKit's if the marker lists it or it uses the reserved prefix. */
export function isOwnedValueName(name: string, owned: Iterable<string>): boolean {
  if (name.startsWith(RESERVED_VALUE_PREFIX)) return true;
  for (const candidate of owned) if (candidate === name) return true;
  return false;
}

export type ResourceOwnership = "missing" | "owned" | "conflict";

// -------------------------------------------------------------- deploy keys --

export interface DeployKeyOwnership {
  readonly status: ResourceOwnership;
  readonly key: GitHubDeployKey | null;
  /** Only meaningful with an expected public key; false means rotate. */
  readonly matchesExpectedKey: boolean;
  readonly reason: string | null;
}

/** OpenSSH public keys compare on type and material, never on the comment. */
function keyMaterial(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/u);
  return parts.length >= 2 ? `${parts[0] ?? ""} ${parts[1] ?? ""}` : publicKey.trim();
}

/**
 * Finds this target's repository deploy key among everything the repository
 * already carries. Two keys wearing our title, a key of ours that somehow has
 * write access, and a foreign key holding our public material are all refused:
 * each one makes "which key is DeployKit's?" ambiguous, and rotation must never
 * guess.
 */
export function resolveDeployKeyOwnership(
  keys: readonly GitHubDeployKey[],
  names: Pick<GitHubManagedResourceNames, "repositoryDeployKeyTitle">,
  expectedPublicKey?: string,
): DeployKeyOwnership {
  const absent: DeployKeyOwnership = { status: "missing", key: null, matchesExpectedKey: false, reason: null };
  const mine = keys.filter((key) => key.title === names.repositoryDeployKeyTitle);
  const expected = expectedPublicKey === undefined ? undefined : keyMaterial(expectedPublicKey);
  if (expected !== undefined) {
    const impostor = keys.find((key) => key.title !== names.repositoryDeployKeyTitle && keyMaterial(key.key) === expected);
    if (impostor !== undefined) {
      return {
        status: "conflict",
        key: impostor,
        matchesExpectedKey: true,
        reason: "another deploy key already carries this repository public key",
      };
    }
  }
  if (mine.length === 0) return absent;
  if (mine.length > 1) {
    return {
      status: "conflict",
      key: mine[0] ?? null,
      matchesExpectedKey: false,
      reason: "more than one deploy key carries the DeployKit repository key title",
    };
  }
  const key = mine[0];
  if (key === undefined) return absent;
  if (!key.readOnly) {
    return {
      status: "conflict",
      key,
      matchesExpectedKey: false,
      reason: "the DeployKit repository key has write access",
    };
  }
  return {
    status: "owned",
    key,
    matchesExpectedKey: expected !== undefined && keyMaterial(key.key) === expected,
    reason: null,
  };
}

// ------------------------------------------------------------ pull requests --

export interface SetupPullRequestOwnership {
  readonly status: ResourceOwnership;
  readonly pullRequest: GitHubPullRequest | null;
  readonly reason: string | null;
}

/**
 * Picks the setup pull request DeployKit may reuse. A pull request on our
 * branch with a title that is not ours means somebody redirected the review, so
 * it is refused rather than reused.
 */
export function resolveSetupPullRequestOwnership(
  pullRequests: readonly GitHubPullRequest[],
  names: GitHubManagedResourceNames,
): SetupPullRequestOwnership {
  const mine = pullRequests.filter((pull) => pull.headRef === names.setupBranch);
  if (mine.length === 0) return { status: "missing", pullRequest: null, reason: null };
  const foreign = mine.find((pull) => pull.title !== names.setupPullRequestTitle);
  if (foreign !== undefined) {
    return {
      status: "conflict",
      pullRequest: foreign,
      reason: "a pull request DeployKit does not own already targets the setup branch",
    };
  }
  const open = mine.filter((pull) => pull.state === "open");
  if (open.length > 1) {
    return {
      status: "conflict",
      pullRequest: open[0] ?? null,
      reason: "more than one open setup pull request exists for this target",
    };
  }
  const chosen = open[0] ?? [...mine].sort((left, right) => right.number - left.number)[0] ?? null;
  return { status: "owned", pullRequest: chosen, reason: null };
}

// ---------------------------------------------------- Environment reconcile --

export interface EnvironmentNameClassification {
  /** Desired and absent. */
  readonly missing: readonly string[];
  /** Desired and present under DeployKit ownership. */
  readonly owned: readonly string[];
  /** DeployKit-owned, no longer desired: the only names safe to delete. */
  readonly stale: readonly string[];
  /** Present, not desired, not ours: left alone. */
  readonly foreign: readonly string[];
  /** Desired but already held by someone else: refused, never overwritten. */
  readonly conflicting: readonly string[];
}

export interface EnvironmentNameRequest {
  /** Names the Environment currently holds. */
  readonly live: readonly string[];
  /** Names this deployment wants. */
  readonly desired: readonly string[];
  /** Names a previously merged ownership marker recorded as DeployKit's. */
  readonly ownedByMarker: readonly string[];
}

/**
 * Splits the Environment's variable or secret names into what to write, what to
 * delete, and what to keep hands off. Only a name a merged marker already
 * claimed — or one under the reserved prefix an operator config cannot use — is
 * ever a deletion candidate.
 */
export function classifyEnvironmentNames(request: EnvironmentNameRequest): EnvironmentNameClassification {
  const desired = new Set(request.desired);
  const live = new Set(request.live);
  const missing: string[] = [];
  const owned: string[] = [];
  const stale: string[] = [];
  const foreign: string[] = [];
  const conflicting: string[] = [];

  for (const name of [...desired].sort(compareCodePoints)) {
    if (!live.has(name)) {
      missing.push(name);
      continue;
    }
    if (isOwnedValueName(name, request.ownedByMarker)) owned.push(name);
    else conflicting.push(name);
  }
  for (const name of [...live].sort(compareCodePoints)) {
    if (desired.has(name)) continue;
    if (isOwnedValueName(name, request.ownedByMarker)) stale.push(name);
    else foreign.push(name);
  }
  return { missing, owned, stale, foreign, conflicting };
}

/** Raises the Environment conflict for every desired name DeployKit does not own. */
export function assertNoEnvironmentConflicts(
  environment: string,
  kind: "variable" | "secret",
  classification: EnvironmentNameClassification,
): void {
  if (classification.conflicting.length === 0) return;
  throw orchestratorError(
    "DK_ENVIRONMENT_CONFLICT",
    `The ${environment} Environment already holds ${kind}s DeployKit does not own`,
    { details: { environment, kind, names: [...classification.conflicting] } },
  );
}
