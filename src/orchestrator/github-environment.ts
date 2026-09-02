import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { compareCodePoints } from "./canonical.js";
import type { Sha256Hex } from "./contracts.js";
import type {
  DesiredGitHubEnvironment,
  DesiredRepositoryDeployKey,
  GitHubEnvironmentState,
  RepositoryDeployKeyState,
} from "./dependencies.js";
import { orchestratorError } from "./failures.js";
import type { GitHubClient, GitHubVariable } from "./github.js";
import {
  assertNoEnvironmentConflicts,
  classifyEnvironmentNames,
  resolveDeployKeyOwnership,
} from "./github-ownership.js";

/**
 * Phase 11's GitHub half: the read-only repository deploy key and the target
 * Environment that will hold this deployment's values.
 *
 * Both reconcilers follow the same rule as every other DeployKit boundary —
 * *inspect first, and only touch what a DeployKit marker already claims*. A
 * deploy key is DeployKit's when it wears the managed title keyed by target ID;
 * an Environment value is DeployKit's when a previous run recorded it in the
 * reserved-prefix bookkeeping variables below, or when its own name carries the
 * `DEPLOYKIT_` prefix the config schema forbids operators from using. Anything
 * else is refused, never overwritten and never deleted.
 *
 * The bookkeeping variables are the whole ownership record, and they live on
 * GitHub rather than in the local operation record on purpose: a rerun from a
 * different machine, or after the local state was deleted, must reach the same
 * conclusion about which values are DeployKit's. They are also why deletion is
 * safe. A first run finds no record, so every desired name that already exists
 * is a conflict a human resolves; a later run finds the record and can tell a
 * value it wrote last time — now dropped from the config — from a value the
 * operator added.
 *
 * Protection is never touched. `ensureEnvironment` returns an existing
 * Environment untouched, so reviewers, wait timers, and branch policies survive
 * every reconciliation; this module has no call that could weaken them.
 *
 * One limitation is deliberate and worth naming. The managed-resource digest is
 * computed over variable values and secret *names* only — a secret value must
 * never reach a digest DeployKit may later log, persist, or compare in an error
 * message — so an Environment whose names and public values all match reads as
 * `current` even if an operator edited a backend secret's *value* in the config
 * since the last run. DeployKit is a first-deployment tool and writes those
 * values once; changing one is a rotation the operator performs on GitHub.
 */

// ------------------------------------------------------------- bookkeeping --

/**
 * DeployKit's own record of what it owns in the target Environment. Every name
 * carries the reserved prefix, so `isOwnedValueName` already treats them as
 * DeployKit's and they need no entry in the frozen managed-name contract.
 */
export const MANAGED_VARIABLES_VARIABLE = "DEPLOYKIT_MANAGED_VARIABLES" as const;
export const MANAGED_SECRETS_VARIABLE = "DEPLOYKIT_MANAGED_SECRETS" as const;
export const GENERATED_SECRETS_VARIABLE = "DEPLOYKIT_GENERATED_SECRETS" as const;
export const MANAGED_DIGEST_VARIABLE = "DEPLOYKIT_MANAGED_DIGEST" as const;

/** Bookkeeping is written by this module, never by the desired-state planner. */
export const BOOKKEEPING_VARIABLES: readonly string[] = Object.freeze([
  GENERATED_SECRETS_VARIABLE,
  MANAGED_DIGEST_VARIABLE,
  MANAGED_SECRETS_VARIABLE,
  MANAGED_VARIABLES_VARIABLE,
]);

const BOOKKEEPING_SET: ReadonlySet<string> = new Set(BOOKKEEPING_VARIABLES);

const UNPROTECTED = Object.freeze({
  reviewers: Object.freeze([]) as readonly string[],
  waitTimerMinutes: 0,
  protectedBranchesOnly: false,
});

function sortedNames(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

/** A comma-separated name list. Value names cannot contain a comma. */
function encodeNames(values: Iterable<string>): string {
  return sortedNames(values).join(",");
}

function decodeNames(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

// ------------------------------------------------------------- deploy keys --

/** The standard OpenSSH SHA-256 fingerprint of a public key line. */
export function publicKeyFingerprint(publicKey: string): string {
  const material = publicKey.trim().split(/\s+/u)[1] ?? "";
  const digest = createHash("sha256").update(Buffer.from(material, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/u, "")}`;
}

export interface RepositoryDeployKeyOptions {
  readonly client: GitHubClient;
}

export interface RepositoryDeployKeyReconciler {
  inspect(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState>;
  reconcile(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState>;
}

/**
 * Registers the VPS-generated public key as a read-only deploy key.
 *
 * Rotation is delete-then-create, and only after ownership is proven: the key
 * carrying our title has to be unambiguous — exactly one, read-only, and not
 * duplicated under somebody else's title — before DeployKit removes anything.
 * A repository that already answers those questions ambiguously is reported as
 * a conflict rather than reconciled, because a wrong guess here revokes an
 * access path somebody else depends on.
 */
export function createRepositoryDeployKeyReconciler(
  options: RepositoryDeployKeyOptions,
): RepositoryDeployKeyReconciler {
  const client = options.client;

  async function inspect(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState> {
    const keys = await client.listDeployKeys(desired.repository);
    const ownership = resolveDeployKeyOwnership(
      keys,
      { repositoryDeployKeyTitle: desired.title },
      desired.publicKey,
    );
    if (ownership.status === "conflict") {
      return {
        status: "conflict",
        keyId: ownership.key?.id ?? null,
        title: desired.title,
        publicKeyFingerprint: ownership.key === undefined || ownership.key === null
          ? null
          : publicKeyFingerprint(ownership.key.key),
        readOnly: ownership.key?.readOnly ?? null,
      };
    }
    if (ownership.status === "missing" || ownership.key === null) {
      return {
        status: "missing",
        keyId: null,
        title: desired.title,
        publicKeyFingerprint: null,
        readOnly: null,
      };
    }
    // An owned key whose material moved is reported with its *actual*
    // fingerprint. The caller compares fingerprints and asks for a rotation; a
    // status of "current" here would be a claim about identity, not about
    // ownership, and this reconciler only answers the ownership question.
    return {
      status: "current",
      keyId: ownership.key.id,
      title: desired.title,
      publicKeyFingerprint: publicKeyFingerprint(ownership.key.key),
      readOnly: ownership.key.readOnly,
    };
  }

  async function reconcile(desired: DesiredRepositoryDeployKey): Promise<RepositoryDeployKeyState> {
    const current = await inspect(desired);
    if (current.status === "conflict") {
      throw orchestratorError(
        "DK_OWNERSHIP_CONFLICT",
        `${desired.repository} carries a deploy key DeployKit cannot unambiguously claim as its own`,
        { details: { repository: desired.repository, title: desired.title } },
      );
    }
    if (current.status === "current" && current.publicKeyFingerprint === desired.publicKeyFingerprint) {
      if (current.readOnly !== true) {
        throw orchestratorError(
          "DK_OWNERSHIP_CONFLICT",
          `The DeployKit deploy key on ${desired.repository} is not read-only`,
          { details: { repository: desired.repository, title: desired.title } },
        );
      }
      return current;
    }
    if (current.status === "current" && current.keyId !== null) {
      // Proven ours, and holding the wrong material: remove it before adding
      // the replacement, so the repository never carries two keys with our
      // title and the next inspection can never be ambiguous.
      await client.deleteDeployKey(desired.repository, current.keyId);
    }

    // `createDeployKey` refuses a response that came back writable, so a
    // repository or plan that silently upgrades the key cannot pass here.
    const created = await client.createDeployKey(desired.repository, desired.title, desired.publicKey);
    const verified = await inspect(desired);
    if (
      verified.status !== "current" ||
      verified.keyId !== created.id ||
      verified.readOnly !== true ||
      verified.publicKeyFingerprint !== desired.publicKeyFingerprint
    ) {
      throw orchestratorError(
        "DK_KEY_ROTATION_FAILED",
        `${desired.repository} did not report the expected read-only deploy key after registration`,
        { details: { repository: desired.repository, title: desired.title } },
      );
    }
    return verified;
  }

  return { inspect, reconcile };
}

// ------------------------------------------------------------- environment --

export interface EnvironmentOptions {
  readonly client: GitHubClient;
}

export interface EnvironmentReconciler {
  inspect(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState>;
  reconcile(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState>;
}

interface EnvironmentSnapshot {
  readonly exists: boolean;
  readonly variables: ReadonlyMap<string, string>;
  readonly secretNames: readonly string[];
  readonly protection: GitHubEnvironmentState["protection"];
  /** Names a previous run recorded as DeployKit's. Empty on a first run. */
  readonly ownedVariables: readonly string[];
  readonly ownedSecrets: readonly string[];
  readonly generatedSecretNames: readonly string[];
  readonly managedResourceDigest: Sha256Hex | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function createEnvironmentReconciler(options: EnvironmentOptions): EnvironmentReconciler {
  const client = options.client;

  async function snapshot(desired: DesiredGitHubEnvironment): Promise<EnvironmentSnapshot> {
    const environment = await client.getEnvironment(desired.repository, desired.environment);
    if (environment === undefined) {
      return {
        exists: false,
        variables: new Map<string, string>(),
        secretNames: [],
        protection: UNPROTECTED,
        ownedVariables: [],
        ownedSecrets: [],
        generatedSecretNames: [],
        managedResourceDigest: null,
      };
    }
    const variables: readonly GitHubVariable[] = await client.listEnvironmentVariables(
      desired.repository,
      desired.environment,
    );
    const values = new Map(variables.map((variable) => [variable.name, variable.value]));
    const secretNames = await client.listEnvironmentSecretNames(desired.repository, desired.environment);
    const digest = values.get(MANAGED_DIGEST_VARIABLE);
    return {
      exists: true,
      variables: values,
      secretNames: sortedNames(secretNames),
      protection: {
        reviewers: environment.protection.reviewers,
        waitTimerMinutes: environment.protection.waitTimerMinutes,
        protectedBranchesOnly: environment.protection.protectedBranchesOnly,
      },
      ownedVariables: decodeNames(values.get(MANAGED_VARIABLES_VARIABLE)),
      ownedSecrets: decodeNames(values.get(MANAGED_SECRETS_VARIABLE)),
      generatedSecretNames: decodeNames(values.get(GENERATED_SECRETS_VARIABLE)),
      // A digest that is not a digest is treated as absent, never as a match.
      managedResourceDigest: digest !== undefined && SHA256_HEX.test(digest) ? digest : null,
    };
  }

  /** Every variable name this deployment writes, bookkeeping included. */
  function desiredVariableNames(desired: DesiredGitHubEnvironment): readonly string[] {
    return sortedNames([...Object.keys(desired.variables), ...BOOKKEEPING_VARIABLES]);
  }

  function classifications(desired: DesiredGitHubEnvironment, live: EnvironmentSnapshot) {
    return {
      variables: classifyEnvironmentNames({
        live: [...live.variables.keys()],
        desired: desiredVariableNames(desired),
        ownedByMarker: [...live.ownedVariables, ...BOOKKEEPING_VARIABLES],
      }),
      secrets: classifyEnvironmentNames({
        live: live.secretNames,
        desired: Object.keys(desired.secrets),
        ownedByMarker: live.ownedSecrets,
      }),
    };
  }

  function stateFrom(
    desired: DesiredGitHubEnvironment,
    live: EnvironmentSnapshot,
  ): GitHubEnvironmentState {
    const split = classifications(desired, live);
    const ownedVariableNames = sortedNames([
      ...split.variables.owned,
      ...split.variables.stale,
    ]);
    const ownedSecretNames = sortedNames([...split.secrets.owned, ...split.secrets.stale]);
    const conflicting =
      split.variables.conflicting.length > 0 || split.secrets.conflicting.length > 0;

    // "Current" compares bytes, not claims: every desired variable must hold
    // the exact desired value, every desired secret must exist, nothing owned
    // may be left over, and the recorded digest must be the one this
    // deployment computes.
    const variablesMatch = Object.entries(desired.variables).every(
      ([name, value]) => live.variables.get(name) === value,
    );
    const bookkeepingMatches =
      live.variables.get(MANAGED_VARIABLES_VARIABLE) === encodeNames(desiredVariableNames(desired)) &&
      live.variables.get(MANAGED_SECRETS_VARIABLE) === encodeNames(Object.keys(desired.secrets)) &&
      live.variables.get(GENERATED_SECRETS_VARIABLE) === encodeNames(desired.generatedSecretNames);
    const complete =
      split.variables.missing.length === 0 &&
      split.secrets.missing.length === 0 &&
      split.variables.stale.length === 0 &&
      split.secrets.stale.length === 0 &&
      variablesMatch &&
      bookkeepingMatches &&
      live.managedResourceDigest === desired.managedResourceDigest;

    const status: GitHubEnvironmentState["status"] = conflicting
      ? "conflict"
      : !live.exists
        ? "missing"
        : complete
          ? "current"
          : "drifted";

    return {
      status,
      environment: desired.environment,
      variableNames: ownedVariableNames,
      secretNames: ownedSecretNames,
      generatedSecretNames: sortedNames(live.generatedSecretNames),
      managedResourceDigest: live.managedResourceDigest,
      protection: live.protection,
    };
  }

  async function inspect(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState> {
    return stateFrom(desired, await snapshot(desired));
  }

  async function reconcile(desired: DesiredGitHubEnvironment): Promise<GitHubEnvironmentState> {
    // Returns an existing Environment untouched, so reviewers, the wait timer,
    // and branch policies are preserved rather than reasserted.
    await client.ensureEnvironment(desired.repository, desired.environment);
    const live = await snapshot(desired);
    const split = classifications(desired, live);
    assertNoEnvironmentConflicts(desired.environment, "variable", split.variables);
    assertNoEnvironmentConflicts(desired.environment, "secret", split.secrets);

    // The digest is dropped before anything moves and written after everything
    // has. An interruption anywhere in between therefore leaves an Environment
    // with no digest — which a rerun reads as drift and reconciles — and never
    // one whose digest claims a state it does not hold.
    if (live.variables.has(MANAGED_DIGEST_VARIABLE)) {
      await client.deleteEnvironmentVariable(desired.repository, desired.environment, MANAGED_DIGEST_VARIABLE);
    }

    for (const name of sortedNames(Object.keys(desired.variables))) {
      const value = desired.variables[name] ?? "";
      if (live.variables.get(name) === value) continue;
      await client.setEnvironmentVariable(desired.repository, desired.environment, name, value);
    }

    // Secret values reach `gh` on stdin and nowhere else; the client refuses to
    // put one in an argument or a file.
    for (const name of sortedNames(Object.keys(desired.secrets))) {
      await client.setEnvironmentSecret(desired.repository, desired.environment, name, desired.secrets[name] ?? "");
    }

    // Only names a previous run recorded as DeployKit's are ever removed, and
    // the bookkeeping variables themselves are never among them.
    for (const name of split.variables.stale) {
      if (BOOKKEEPING_SET.has(name)) continue;
      await client.deleteEnvironmentVariable(desired.repository, desired.environment, name);
    }
    for (const name of split.secrets.stale) {
      await client.deleteEnvironmentSecret(desired.repository, desired.environment, name);
    }

    const bookkeeping: readonly (readonly [string, string])[] = [
      [GENERATED_SECRETS_VARIABLE, encodeNames(desired.generatedSecretNames)],
      [MANAGED_SECRETS_VARIABLE, encodeNames(Object.keys(desired.secrets))],
      [MANAGED_VARIABLES_VARIABLE, encodeNames(desiredVariableNames(desired))],
    ];
    for (const [name, value] of bookkeeping) {
      await client.setEnvironmentVariable(desired.repository, desired.environment, name, value);
    }
    await client.setEnvironmentVariable(
      desired.repository,
      desired.environment,
      MANAGED_DIGEST_VARIABLE,
      desired.managedResourceDigest,
    );

    const verified = await inspect(desired);
    if (verified.status !== "current") {
      throw orchestratorError(
        "DK_GITHUB_API_FAILED",
        `The ${desired.environment} Environment did not report the expected managed resources after reconciliation`,
        { details: { environment: desired.environment, status: verified.status } },
      );
    }
    return verified;
  }

  return { inspect, reconcile };
}
