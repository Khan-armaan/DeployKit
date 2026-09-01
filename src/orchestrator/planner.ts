import { createHash } from "node:crypto";

import { canonicalJson, compareCodePoints, type CanonicalValue } from "./canonical.js";
import type { CompiledDeployment } from "./compile.js";
import type { EnvironmentPartition } from "./config-schema.js";
import {
  GATEWAY_BINDING_API_VERSION,
  GATEWAY_FORCED_COMMAND,
  GATEWAY_USER,
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
  type GitHubManagedResourceNames,
  type GitHubOwnershipMarker,
  type RootOwnedGatewayBinding,
  type Sha256Hex,
} from "./contracts.js";
import type {
  DesiredControlArtifacts,
  DesiredGitHubEnvironment,
  DesiredRepositoryDeployKey,
  ManagedArtifact,
} from "./dependencies.js";

/**
 * Phase 4 owns the *desired state* the orchestration state machine compares
 * authoritative GitHub and VPS state against. Everything here is a pure
 * function of the compiled deployment plus a small set of facts later phases
 * own, so a rerun computes byte-identical desired state and can therefore tell
 * "already reconciled" from "must reconcile".
 *
 * Two inputs are deliberately injected rather than invented here:
 *
 * - `renderWorkflow` produces `.github/workflows/deploykit.yml`. Phase 10 owns
 *   those bytes; Phase 4 only needs their digest, so no placeholder workflow is
 *   fabricated or shipped.
 * - `runtimeBundle` names the checksum-verified standalone server bundle. Phase
 *   8 owns building and uploading it.
 *
 * Nothing in this module performs I/O, and no secret *value* reaches any
 * returned digest or artifact. `DesiredGitHubEnvironment.secrets` is the single
 * secret-bearing value, and it exists only to be handed to `gh` on stdin.
 */

const MANAGED_RESOURCE_DIGEST_API_VERSION = "deploykit/managed-resources/v1alpha1" as const;
const GATEWAY_BINDING_ID_API_VERSION = "deploykit/gateway-binding-id/v1alpha1" as const;

/**
 * Set on an expected binding for fields only the VPS can know. The state
 * machine compares bindings through {@link gatewayBindingIdentityDigest}, which
 * excludes every host-owned field, so this sentinel never participates in a
 * decision.
 */
export const HOST_OWNED_BINDING_FIELD = "" as const;

function sha256Hex(value: string): Sha256Hex {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedNames(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function sortedRecord(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareCodePoints(left, right)),
  );
}

/** Checksum-verified standalone server bundle installed by the gateway host. */
export interface RuntimeBundleReference {
  readonly version: string;
  /** npm package name; the installer compares it with the name inside the tarball. */
  readonly packageName: string;
  readonly packageFile: string;
  readonly packageSha256: Sha256Hex;
}

/**
 * Everything the state machine knows about one deployment before it touches
 * GitHub or the VPS. It is secret-free apart from `environment.backendValues`,
 * which only {@link DesiredStatePlanner.environment} reads.
 */
export interface DeploymentContext {
  readonly compiled: CompiledDeployment;
  readonly environment: EnvironmentPartition;
  readonly repository: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly githubEnvironment: string;
  readonly primaryDomain: string;
  readonly applicationRef: string;
  readonly defaultBranch: string;
  readonly names: GitHubManagedResourceNames;
}

/** Nonsecret gateway access facts plus the secret Environment values it needs. */
export interface GatewayAccessFacts {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Pinned `known_hosts` content for the gateway host. Nonsecret. */
  readonly knownHosts: string;
  /**
   * Additional target-Environment secrets, keyed by name. Phase 11 supplies
   * {@link MANAGED_GATEWAY_PRIVATE_KEY_SECRET} here.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Local private-key path for a gateway exchange. Present only while the
   * orchestrator legitimately holds a gateway key; when absent the state
   * machine skips the final gateway inspection instead of inventing a key.
   */
  readonly identityFile?: string;
}

export function makeManagedResourceNames(targetId: string): GitHubManagedResourceNames {
  return {
    workflowPath: MANAGED_WORKFLOW_PATH,
    runtimeManifestPath: MANAGED_RUNTIME_MANIFEST_PATH,
    ownershipPath: MANAGED_OWNERSHIP_PATH,
    // Every managed name is keyed by target ID rather than by the operator's
    // target name, so renaming a target in the config can never silently claim
    // another target's branch, pull request, or deploy key.
    setupBranch: `${MANAGED_SETUP_BRANCH_PREFIX}${targetId}`,
    setupPullRequestTitle: `${MANAGED_SETUP_PULL_REQUEST_TITLE_PREFIX}${targetId}`,
    repositoryDeployKeyTitle: `${MANAGED_REPOSITORY_KEY_TITLE_PREFIX}${targetId}`,
    gatewayPrivateKeySecret: MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
    gatewayHostVariable: MANAGED_GATEWAY_HOST_VARIABLE,
    gatewayPortVariable: MANAGED_GATEWAY_PORT_VARIABLE,
    gatewayUserVariable: MANAGED_GATEWAY_USER_VARIABLE,
    gatewayKnownHostsVariable: MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE,
    targetIdVariable: MANAGED_TARGET_ID_VARIABLE,
  };
}

/** A stable 128-bit identity for one root-owned gateway binding. */
export function makeGatewayBindingId(
  repository: string,
  githubEnvironment: string,
  targetName: string,
  targetId: string,
): string {
  return sha256Hex(
    canonicalJson({
      apiVersion: GATEWAY_BINDING_ID_API_VERSION,
      repository,
      githubEnvironment,
      targetName,
      targetId,
    }),
  ).slice(0, 32);
}

/**
 * The subset of a binding both sides can compute before any key exists. Key
 * identifiers and fingerprints are host-owned and deliberately excluded, so a
 * key rotation never reads as a binding mismatch.
 */
export function gatewayBindingIdentityDigest(binding: RootOwnedGatewayBinding): Sha256Hex {
  return sha256Hex(
    canonicalJson({
      apiVersion: binding.apiVersion,
      bindingId: binding.bindingId,
      repository: binding.repository,
      githubEnvironment: binding.githubEnvironment,
      targetName: binding.targetName,
      targetId: binding.targetId,
      gatewayUser: binding.gatewayUser,
      forcedCommand: binding.forcedCommand,
      runtimeVersion: binding.runtimeVersion,
      runtimeBundleSha256: binding.runtimeBundleSha256,
    }),
  );
}

export function buildOwnershipMarker(
  context: DeploymentContext,
  workflowDigest: Sha256Hex,
): GitHubOwnershipMarker {
  return {
    apiVersion: GITHUB_OWNERSHIP_API_VERSION,
    owner: "deploykit",
    repository: context.repository,
    targetName: context.targetName,
    targetId: context.targetId,
    githubEnvironment: context.githubEnvironment,
    managed: {
      names: context.names,
      files: [MANAGED_WORKFLOW_PATH, MANAGED_RUNTIME_MANIFEST_PATH, MANAGED_OWNERSHIP_PATH],
      frontendVariables: sortedNames(Object.keys(context.environment.publicValues)),
      backendSecrets: sortedNames(Object.keys(context.environment.backendValues)),
      generatedSecrets: sortedNames(context.environment.generatedNames),
    },
    workflowDigest,
    runtimeManifestDigest: context.compiled.digest,
  };
}

/** Deterministic committed bytes for the ownership marker. */
export function ownershipMarkerBytes(marker: GitHubOwnershipMarker): string {
  return `${canonicalJson(marker as unknown as CanonicalValue)}\n`;
}

function artifact(path: string, contents: string): ManagedArtifact {
  return { path, contents, sha256: sha256Hex(contents) };
}

/**
 * Builds the desired state for each externally reconciled resource. The state
 * machine never constructs these shapes itself, so a later phase can replace
 * one builder without touching orchestration control flow.
 */
export interface DesiredStatePlanner {
  controlArtifacts(context: DeploymentContext): DesiredControlArtifacts;
  gatewayBinding(context: DeploymentContext): RootOwnedGatewayBinding;
  repositoryDeployKey(
    context: DeploymentContext,
    key: { readonly publicKey: string; readonly publicKeyFingerprint: string },
  ): DesiredRepositoryDeployKey;
  environment(context: DeploymentContext, access: GatewayAccessFacts): DesiredGitHubEnvironment;
}

export interface DesiredStatePlannerParts {
  /** Phase 10 owns these bytes; Phase 4 only needs their digest. */
  readonly renderWorkflow: (context: DeploymentContext) => string;
  /** Phase 8 owns building and uploading the bundle this names. */
  readonly runtimeBundle: RuntimeBundleReference;
}

export function createDesiredStatePlanner(parts: DesiredStatePlannerParts): DesiredStatePlanner {
  return {
    controlArtifacts(context: DeploymentContext): DesiredControlArtifacts {
      const workflow = artifact(context.names.workflowPath, parts.renderWorkflow(context));
      const manifest = artifact(
        context.names.runtimeManifestPath,
        context.compiled.canonicalBytes.toString("utf8"),
      );
      const ownership = buildOwnershipMarker(context, workflow.sha256);
      return {
        repository: context.repository,
        defaultBranch: context.defaultBranch,
        targetId: context.targetId,
        names: context.names,
        // Frozen order: the setup pull request must diff identically on rerun.
        artifacts: [workflow, manifest, artifact(context.names.ownershipPath, ownershipMarkerBytes(ownership))],
        ownership,
      };
    },

    gatewayBinding(context: DeploymentContext): RootOwnedGatewayBinding {
      return {
        apiVersion: GATEWAY_BINDING_API_VERSION,
        bindingId: makeGatewayBindingId(
          context.repository,
          context.githubEnvironment,
          context.targetName,
          context.targetId,
        ),
        repository: context.repository,
        githubEnvironment: context.githubEnvironment,
        targetName: context.targetName,
        targetId: context.targetId,
        gatewayUser: GATEWAY_USER,
        forcedCommand: GATEWAY_FORCED_COMMAND,
        runtimeVersion: parts.runtimeBundle.version,
        runtimeBundleSha256: parts.runtimeBundle.packageSha256,
        // Host-owned: the VPS generates the keys and writes their identifiers
        // into the binding it returns.
        repositoryKeyId: HOST_OWNED_BINDING_FIELD,
        repositoryKeyFingerprint: HOST_OWNED_BINDING_FIELD,
        activeGatewayKeyId: null,
        pendingGatewayKeyId: null,
      };
    },

    repositoryDeployKey(context, key): DesiredRepositoryDeployKey {
      return {
        repository: context.repository,
        title: context.names.repositoryDeployKeyTitle,
        publicKey: key.publicKey,
        publicKeyFingerprint: key.publicKeyFingerprint,
        // The VPS only ever fetches with this key; write access would let a
        // compromised build rewrite the repository it deploys from.
        readOnly: true,
      };
    },

    environment(context, access): DesiredGitHubEnvironment {
      const variables = sortedRecord({
        ...context.environment.publicValues,
        [MANAGED_GATEWAY_HOST_VARIABLE]: access.host,
        [MANAGED_GATEWAY_PORT_VARIABLE]: String(access.port),
        [MANAGED_GATEWAY_USER_VARIABLE]: access.user,
        [MANAGED_GATEWAY_KNOWN_HOSTS_VARIABLE]: access.knownHosts,
        [MANAGED_TARGET_ID_VARIABLE]: context.targetId,
      });
      const secrets = { ...context.environment.backendValues, ...access.secrets };
      const generatedSecretNames = sortedNames(context.environment.generatedNames);

      // Secret *names* only. A secret value must never reach a digest input we
      // may later log, persist, or compare in an error message.
      const managedResourceDigest = sha256Hex(
        canonicalJson({
          apiVersion: MANAGED_RESOURCE_DIGEST_API_VERSION,
          repository: context.repository,
          githubEnvironment: context.githubEnvironment,
          targetId: context.targetId,
          variables,
          secretNames: sortedNames(Object.keys(secrets)),
          generatedSecretNames,
        }),
      );

      return {
        repository: context.repository,
        environment: context.githubEnvironment,
        targetId: context.targetId,
        variables,
        secrets,
        generatedSecretNames,
        managedResourceDigest,
      };
    },
  };
}
