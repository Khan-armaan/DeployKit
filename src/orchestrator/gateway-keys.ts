import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../process.js";
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_USER,
  MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
  REQUEST_ID_PATTERN,
  type GatewayHandshakeResult,
  type GatewayInputFrame,
  type RequestId,
  type RootOwnedGatewayBinding,
} from "./contracts.js";
import type {
  AdministratorSshConnection,
  GatewayConnection,
  GatewayTransportPort,
} from "./dependencies.js";
import { orchestratorError } from "./failures.js";
import { publicKeyFingerprint } from "./github-environment.js";
import type { GatewayKeyEntry, GatewayKeyLifecyclePort } from "./administrator-ssh.js";
import type { GatewayAccessFacts } from "./planner.js";

/**
 * Phase 11's cross-plane half: the key a GitHub-hosted runner will use to reach
 * the VPS gateway, and nothing else.
 *
 * The whole design exists to answer one question safely — *after an
 * interruption, is there still exactly one key that works?* — so the sequence
 * is fixed and each step is only taken once the previous one has been proven:
 *
 * 1. generate the pair in a mode-0700 local temporary directory;
 * 2. stage the public key as a DeployKit-owned **pending** forced-command
 *    entry, which leaves the previously proven active entry in place;
 * 3. open a real gateway session with the new private key and read back the
 *    binding, so the key is known to work before anybody holds it;
 * 4. upload the private key to the target Environment (the caller's step, on
 *    stdin, never an argument or a file);
 * 5. atomically promote the pending entry to active, which drops this binding's
 *    other owned entries in the same rewrite;
 * 6. shred the local temporary directory.
 *
 * Every interruption lands somewhere recoverable. Before step 5 the old active
 * key still works and the new pending entry is inert; after step 5 the new key
 * works and the old entry is gone. There is no window in which neither key is
 * accepted.
 *
 * Recovery is rotation, never inference. GitHub Environment secrets cannot be
 * read back, so a run that is resumed after the local private key was deleted
 * has no way to learn whether the stored secret matches the pending entry on
 * the host — and guessing would either strand the workflow with a dead key or
 * keep an unproven key active. {@link GatewayKeyRotator.prepare} therefore
 * always generates a fresh pair; staging drops this binding's stale pending
 * entries as it appends the replacement, and the proven active entry is only
 * ever removed by the activation of a key that has just answered a handshake.
 *
 * Nothing here writes a private key anywhere but the temporary directory, and
 * `dispose` removes it whether the rotation succeeded or failed.
 */

const KEYGEN_TIMEOUT_MS = 60_000;

/** The private key never leaves this object except through the caller's upload. */
export interface GeneratedGatewayKeyPair {
  readonly privateKeyFile: string;
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface GatewayKeyPairGenerator {
  generate(directory: string, keyId: string): Promise<GeneratedGatewayKeyPair>;
}

function rotationFailure(message: string, details: Record<string, unknown> = {}): Error {
  return orchestratorError("DK_KEY_ROTATION_FAILED", message, { details });
}

/**
 * `ssh-keygen` with an empty passphrase into a directory only this process can
 * read. Ed25519 is the only type generated: it is the type the gateway's
 * `authorized_keys` helper accepts first and the shortest to carry as a secret.
 */
export const sshKeygenGatewayKeyPairGenerator: GatewayKeyPairGenerator = {
  async generate(directory: string, keyId: string): Promise<GeneratedGatewayKeyPair> {
    const privateKeyFile = join(directory, "gateway-key");
    const result = await run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", keyId, "-f", privateKeyFile],
      { reject: false, timeoutMs: KEYGEN_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw rotationFailure("A gateway key pair could not be generated locally");
    }
    await chmod(privateKeyFile, 0o600);
    const [privateKey, publicKey] = await Promise.all([
      readFile(privateKeyFile, "utf8"),
      readFile(`${privateKeyFile}.pub`, "utf8"),
    ]);
    return { privateKeyFile, privateKey, publicKey: publicKey.trim() };
  },
};

export interface GatewayKeyRotatorOptions {
  readonly administratorSsh: GatewayKeyLifecyclePort;
  readonly gateway: GatewayTransportPort;
  /** Pinned `known_hosts` content for the gateway host. Nonsecret. */
  readonly knownHosts: string;
  readonly keyPairs?: GatewayKeyPairGenerator;
  /** Parent directory for the mode-0700 working directory. Defaults to the OS temp dir. */
  readonly temporaryRoot?: string;
  readonly newKeyId?: () => string;
  readonly newRequestId?: () => RequestId;
}

/**
 * A gateway key that has been staged on the host and proven by a real session,
 * but is not yet the active entry. The caller uploads
 * {@link GatewayAccessFacts.secrets} before calling {@link activate}.
 */
export interface PreparedGatewayKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly handshake: GatewayHandshakeResult;
  /** Carries the private key value the target Environment must receive. */
  readonly access: GatewayAccessFacts;
  activate(): Promise<readonly GatewayKeyEntry[]>;
  dispose(): Promise<void>;
}

export interface GatewayKeyRotator {
  prepare(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
    facts: { readonly repositoryKeyFingerprint: string },
  ): Promise<PreparedGatewayKey>;
}

function handshakeFrames(binding: RootOwnedGatewayBinding, requestId: RequestId): GatewayInputFrame[] {
  return [
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "request",
      requestId,
      operation: "handshake",
      repository: binding.repository,
      githubEnvironment: binding.githubEnvironment,
      targetName: binding.targetName,
      targetId: binding.targetId,
      applicationRef: null,
      commitSha: null,
      manifestDigest: null,
      expectedPayload: { manifestFrames: 0, manifestBytes: 0, secretFrames: 0, secretBytes: 0 },
      flags: { dryRun: false },
    },
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "end",
      requestId,
      manifestFrames: 0,
      secretFrames: 0,
      payloadBytes: 0,
    },
  ];
}

export function createGatewayKeyRotator(options: GatewayKeyRotatorOptions): GatewayKeyRotator {
  const keyPairs = options.keyPairs ?? sshKeygenGatewayKeyPairGenerator;
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const newKeyId = options.newKeyId ?? (() => `gw-${randomUUID().replace(/-/gu, "").slice(0, 24)}`);
  const newRequestId = options.newRequestId ?? (() => randomUUID() as RequestId);

  /** Opens one gateway session with the staged key and reads the binding back. */
  async function proveKey(
    connection: GatewayConnection,
    binding: RootOwnedGatewayBinding,
  ): Promise<GatewayHandshakeResult> {
    const requestId = newRequestId();
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw rotationFailure("The generated gateway request id is not a UUID");
    }
    const frames = handshakeFrames(binding, requestId);
    let handshake: GatewayHandshakeResult | undefined;
    for await (const frame of options.gateway.exchange({
      connection,
      frames: (async function* emit(): AsyncIterable<GatewayInputFrame> {
        for (const value of frames) yield value;
      })(),
    })) {
      if (frame.frame !== "result") continue;
      if (!frame.ok) {
        throw orchestratorError(
          frame.code === "DK_GATEWAY_BINDING_MISMATCH" ? "DK_GATEWAY_BINDING_MISMATCH" : "DK_KEY_ROTATION_FAILED",
          `The gateway refused a session opened with the staged key`,
          { details: { code: frame.code } },
        );
      }
      if (frame.result.kind === "handshake") handshake = frame.result;
    }
    if (handshake === undefined) {
      throw rotationFailure("The gateway did not answer a session opened with the staged key");
    }
    if (
      handshake.bindingId !== binding.bindingId ||
      handshake.targetId !== binding.targetId
    ) {
      throw orchestratorError(
        "DK_GATEWAY_BINDING_MISMATCH",
        "The gateway answered the staged key with a different binding than the one requested",
      );
    }
    return handshake;
  }

  function ownedEntryFor(
    entries: readonly GatewayKeyEntry[],
    keyId: string,
    state: GatewayKeyEntry["state"],
  ): GatewayKeyEntry | undefined {
    return entries.find((entry) => entry.keyId === keyId && entry.state === state);
  }

  /** OpenSSH compares on type and material; the comment is not identity. */
  function materialOf(publicKey: string): string {
    const parts = publicKey.trim().split(/\s+/u);
    return `${parts[0] ?? ""} ${parts[1] ?? ""}`;
  }

  return {
    async prepare(connection, binding, facts): Promise<PreparedGatewayKey> {
      const keyId = newKeyId();
      const directory = await mkdtemp(join(temporaryRoot, "deploykit-gateway-key-"));
      await chmod(directory, 0o700);
      let disposed = false;
      const dispose = async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      };

      try {
        const pair = await keyPairs.generate(directory, keyId);
        const fingerprint = publicKeyFingerprint(pair.publicKey);

        // Staging drops this binding's stale pending entries and leaves the
        // proven active one alone, so an interrupted earlier rotation is
        // cleaned up by the act of replacing it.
        const staged = await options.administratorSsh.stageGatewayKey(connection, binding, {
          keyId,
          publicKey: pair.publicKey,
        });
        const pending = ownedEntryFor(staged, keyId, "pending");
        if (pending === undefined || materialOf(`${pending.type} ${pending.key}`) !== materialOf(pair.publicKey)) {
          throw rotationFailure(
            `${connection.host} did not stage the generated gateway key; the last verified key was left intact`,
            { host: connection.host },
          );
        }

        const gatewayConnection: GatewayConnection = {
          host: connection.host,
          user: GATEWAY_USER,
          port: connection.port,
          identityFile: pair.privateKeyFile,
          knownHosts: options.knownHosts,
        };
        const handshake = await proveKey(gatewayConnection, binding);

        const access: GatewayAccessFacts = {
          host: connection.host,
          port: connection.port,
          user: GATEWAY_USER,
          knownHosts: options.knownHosts,
          // The one secret this module produces. It reaches GitHub through the
          // caller's `gh secret set` on stdin and is never written anywhere but
          // the temporary directory `dispose` removes.
          secrets: { [MANAGED_GATEWAY_PRIVATE_KEY_SECRET]: pair.privateKey },
          // Nonsecret fingerprints, recorded so an operator can compare what
          // GitHub holds against what the host accepts without reading either.
          variables: {
            DEPLOYKIT_GATEWAY_KEY_FINGERPRINT: fingerprint,
            DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT: facts.repositoryKeyFingerprint,
          },
          identityFile: pair.privateKeyFile,
        };

        return {
          keyId,
          publicKey: pair.publicKey,
          fingerprint,
          handshake,
          access,
          async activate(): Promise<readonly GatewayKeyEntry[]> {
            const entries = await options.administratorSsh.activateGatewayKey(connection, binding, keyId);
            const active = entries.filter((entry) => entry.state === "active");
            if (active.length !== 1 || active[0]?.keyId !== keyId) {
              throw rotationFailure(
                `${connection.host} did not report exactly one active DeployKit gateway key after activation`,
                { host: connection.host, active: active.length },
              );
            }
            if (entries.some((entry) => entry.state === "pending")) {
              throw rotationFailure(
                `${connection.host} still carries a pending DeployKit gateway key after activation`,
                { host: connection.host },
              );
            }
            return entries;
          },
          dispose,
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
}

/**
 * Answers "does this host still accept exactly one DeployKit-owned key?" without
 * changing anything. Used to report a host left mid-rotation by an interrupted
 * run; the repair is always a fresh {@link GatewayKeyRotator.prepare}.
 */
export async function inspectGatewayKeyState(
  administratorSsh: GatewayKeyLifecyclePort,
  connection: AdministratorSshConnection,
  binding: RootOwnedGatewayBinding,
): Promise<{ readonly active: readonly GatewayKeyEntry[]; readonly pending: readonly GatewayKeyEntry[] }> {
  const entries = await administratorSsh.listGatewayKeys(connection, binding);
  return {
    active: entries.filter((entry) => entry.state === "active"),
    pending: entries.filter((entry) => entry.state === "pending"),
  };
}
