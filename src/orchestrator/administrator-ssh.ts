import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { DeployKitError } from "../errors.js";
import {
  canonicalFrameLine,
  parseGatewayOutputStream,
} from "../gateway/protocol.js";
import { run } from "../process.js";
import {
  CONTRACT_KEY_ORDER,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_USER,
  REQUEST_ID_PATTERN,
  type GatewayHandshakeResult,
  type RequestId,
  type RootOwnedGatewayBinding,
} from "./contracts.js";
import type {
  AdministratorSshConnection,
  AdministratorSshPort,
  AdministratorSshPreflight,
  GatewayBootstrapRequest,
  GatewayBootstrapResult,
} from "./dependencies.js";
import { orchestratorError } from "./failures.js";
import { localPackageRoot } from "./runtime-bundle.js";

/**
 * The administrator SSH boundary: the one place DeployKit connects to a VPS
 * with the operator's own key.
 *
 * Three properties matter more than convenience here.
 *
 * The host is pinned. `deploykit.config.yaml` carries a SHA-256 host-key
 * fingerprint, never a key, so every connection begins by scanning the host,
 * digesting each offered key, and keeping only the line whose fingerprint is
 * the pinned one. A host that presents anything else raises
 * `DK_SSH_HOST_KEY_MISMATCH` before a byte is sent, and the accepted line — not
 * the hostname — is what `StrictHostKeyChecking=yes` then verifies.
 *
 * Nothing is a shell string. Every remote invocation is an argv array whose
 * arguments are checked against a conservative pattern, so no configured value
 * can become shell syntax on the far side.
 *
 * The handshake is non-mutating. `inspectGateway` runs the same forced-command
 * program a GitHub-hosted runner would reach and speaks the frozen Phase 6
 * protocol to it, so "is this host already bound and installed?" is answered by
 * the gateway itself rather than by a local checkpoint.
 */

const SAFE_REMOTE_ARGUMENT = /^[A-Za-z0-9_.,:/=@+-]+$/u;
const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SSH_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const BOOTSTRAP_RESULT_PREFIX = "DEPLOYKIT_BOOTSTRAP_RESULT ";
const SOURCE_PROBE_RESULT_PREFIX = "DEPLOYKIT_SOURCE_PROBE ";

/** Where the installer places the one program a forced command may run. */
export const GATEWAY_ENTRY_PATH = "/usr/local/lib/deploykit/gateway-entry" as const;
export const GATEWAY_KEYS_HELPER_PATH = "/usr/local/lib/deploykit/gateway-keys" as const;
export const GATEWAY_SOURCE_PROBE_PATH = "/usr/local/lib/deploykit/gateway-source-probe" as const;
export const GATEWAY_AUTHORIZED_KEYS_PATH =
  "/var/lib/deploykit-gateway/.ssh/authorized_keys" as const;

/** Assets the installer needs beside the packed bundle. */
export const BOOTSTRAP_ASSET_FILES: readonly string[] = Object.freeze([
  "bootstrap.sh",
  "gateway-binding.sh",
  "gateway-keys.sh",
  "gateway-source-probe.sh",
]);

const BOOTSTRAP_TIMEOUT_MS = 30 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 2 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
const SOURCE_PROBE_TIMEOUT_MS = 2 * 60_000;

export interface AdministratorRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface AdministratorRunRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly timeoutMs?: number;
}

/** Injected so tests can drive the boundary without an SSH daemon. */
export interface AdministratorCommandRunner {
  run(request: AdministratorRunRequest): Promise<AdministratorRunResult>;
}

export const processAdministratorCommandRunner: AdministratorCommandRunner = {
  async run(request: AdministratorRunRequest): Promise<AdministratorRunResult> {
    const result = await run(request.command, request.args, {
      reject: false,
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  },
};

// ------------------------------------------------------------- validation --

function unreachable(message: string, details: Record<string, unknown> = {}): DeployKitError {
  return orchestratorError("DK_SSH_UNREACHABLE", message, { details });
}

function bootstrapFailure(message: string, details: Record<string, unknown> = {}): DeployKitError {
  return orchestratorError("DK_GATEWAY_BOOTSTRAP_FAILED", message, { details });
}

export function assertAdministratorConnection(connection: AdministratorSshConnection): void {
  if (!SSH_HOST_PATTERN.test(connection.host)) {
    throw unreachable("The configured server host is not a DNS name or IPv4 address");
  }
  if (!SSH_USER_PATTERN.test(connection.user)) {
    throw unreachable("The configured server user is not a Linux account name");
  }
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) {
    throw unreachable("The configured server port is not a TCP port number");
  }
  if (!HOST_KEY_FINGERPRINT_PATTERN.test(connection.hostKeyFingerprint)) {
    throw orchestratorError(
      "DK_SSH_HOST_KEY_MISMATCH",
      "server.hostKeyFingerprint is not an OpenSSH SHA256 host-key fingerprint",
    );
  }
  if (connection.identityFile.length === 0 || !connection.identityFile.startsWith("/")) {
    throw unreachable("The configured administrator identity file is not an absolute path");
  }
}

function assertSafeRemoteArguments(args: readonly string[]): void {
  for (const argument of args) {
    if (!SAFE_REMOTE_ARGUMENT.test(argument)) {
      throw bootstrapFailure("A remote argument contains unsupported characters", {
        length: argument.length,
      });
    }
  }
}

// ------------------------------------------------------------- host keys --

/** The `known_hosts` entry name SSH uses; a non-default port is bracketed. */
export function knownHostsHostname(connection: AdministratorSshConnection): string {
  return connection.port === 22 ? connection.host : `[${connection.host}]:${String(connection.port)}`;
}

export interface PinnedHostKey {
  readonly line: string;
  readonly fingerprint: string;
}

/**
 * Scans the host and keeps only the key whose fingerprint is the pinned one.
 * A host that offers no matching key is reported as a mismatch rather than as
 * an unreachable host: the connection worked, the identity did not.
 */
export async function resolvePinnedHostKey(
  runner: AdministratorCommandRunner,
  connection: AdministratorSshConnection,
): Promise<PinnedHostKey> {
  const scan = await runner.run({
    command: "ssh-keyscan",
    args: ["-T", "10", "-p", String(connection.port), connection.host],
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  const lines = scan.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    throw unreachable(`${connection.host} returned no SSH host key`, { host: connection.host });
  }
  for (const line of lines) {
    const digest = await runner.run({
      command: "ssh-keygen",
      args: ["-lf", "-"],
      input: `${line}\n`,
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    const fingerprint = digest.stdout.trim().split(/\s+/)[1] ?? "";
    if (fingerprint === connection.hostKeyFingerprint) return { line, fingerprint };
  }
  throw orchestratorError(
    "DK_SSH_HOST_KEY_MISMATCH",
    `${connection.host} did not present the host key pinned in server.hostKeyFingerprint`,
    { details: { host: connection.host, offeredKeys: lines.length } },
  );
}

/** Deterministic, forwarding-free options shared by every administrator call. */
export function administratorSshOptions(
  connection: AdministratorSshConnection,
  knownHostsFile: string,
): readonly string[] {
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsFile}`,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ConnectTimeout=30",
    "-i", connection.identityFile,
  ];
}

// -------------------------------------------------------- handshake frames --

export function isRequestId(value: string): value is RequestId {
  return REQUEST_ID_PATTERN.test(value);
}

/** The exact bytes a non-mutating handshake request is made of. */
export function encodeHandshakeRequest(
  binding: Pick<RootOwnedGatewayBinding, "repository" | "githubEnvironment" | "targetName" | "targetId">,
  requestId: RequestId,
): string {
  const request = {
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
  };
  const end = {
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    frame: "end",
    requestId,
    manifestFrames: 0,
    secretFrames: 0,
    payloadBytes: 0,
  };
  return [
    canonicalFrameLine(request, CONTRACT_KEY_ORDER.gatewayRequestFrame),
    canonicalFrameLine(end, CONTRACT_KEY_ORDER.gatewayEndFrame),
  ].map((line) => `${line}\n`).join("");
}

/**
 * Reads a handshake out of a gateway output stream. An installation that is not
 * there yet, or that answers with something unparsable, is reported as absent
 * so the caller bootstraps; a gateway that answers with a binding mismatch is
 * reported as a mismatch, because installing over it would be wrong.
 */
export function readHandshakeResult(output: string): GatewayHandshakeResult | undefined {
  let frames;
  try {
    frames = parseGatewayOutputStream(output);
  } catch {
    return undefined;
  }
  const result = frames.find((frame) => frame.frame === "result");
  if (result === undefined || result.frame !== "result") return undefined;
  if (!result.ok) {
    if (result.code === "DK_GATEWAY_BINDING_MISMATCH") {
      throw orchestratorError(
        "DK_GATEWAY_BINDING_MISMATCH",
        "The VPS gateway is bound to a different repository, Environment, or target",
      );
    }
    return undefined;
  }
  return result.result.kind === "handshake" ? result.result : undefined;
}

// ------------------------------------------------------------------ port --

export interface AdministratorSshPortOptions {
  readonly runner?: AdministratorCommandRunner;
  /** Directory holding `bootstrap.sh` and the gateway helpers. */
  readonly assetsDirectory?: string;
  readonly newRequestId?: () => string;
  readonly newRemoteDirectory?: () => string;
}

/** DeployKit-owned forced-command entries, as the installer's helper reports them. */
export interface GatewayKeyEntry {
  readonly state: "pending" | "active";
  readonly keyId: string;
  readonly type: string;
  readonly key: string;
}

/**
 * The staged/active key operations Phase 11 drives. They are separated from the
 * frozen {@link AdministratorSshPort} because rotation is not part of a
 * bootstrap; the mechanism belongs here because the installer is what places
 * the helper that performs it.
 */
export interface GatewayKeyLifecyclePort {
  listGatewayKeys(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
  ): Promise<readonly GatewayKeyEntry[]>;
  stageGatewayKey(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
    key: { readonly keyId: string; readonly publicKey: string },
  ): Promise<readonly GatewayKeyEntry[]>;
  activateGatewayKey(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
    keyId: string,
  ): Promise<readonly GatewayKeyEntry[]>;
}

/**
 * What the VPS proved about its own read-only repository identity. `reachable`
 * is always true: a probe that could not reach the bound repository raises
 * instead of reporting a negative result, so no caller can mistake an
 * unanswered question for a passed one.
 */
export interface RepositoryAccessProof {
  readonly repository: string;
  /** The identity GitHub greeted the key as. Equal to `repository` or it raises. */
  readonly authenticatedAs: string;
  readonly keyFingerprint: string;
  readonly reachable: true;
}

/**
 * Phase 11 proves the repository key before the gateway is trusted to fetch
 * source with it. This is a read-only operation: it writes nothing on the host
 * and returns nothing secret.
 */
export interface RepositorySourceProbePort {
  proveRepositoryAccess(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
  ): Promise<RepositoryAccessProof>;
}

export type AdministratorSshBoundary = AdministratorSshPort &
  GatewayKeyLifecyclePort &
  RepositorySourceProbePort;

export function parseSourceProbeResult(stdout: string): RepositoryAccessProof {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(SOURCE_PROBE_RESULT_PREFIX));
  if (line === undefined) {
    throw bootstrapFailure("The repository access probe did not report a result");
  }
  let document: unknown;
  try {
    document = JSON.parse(line.slice(SOURCE_PROBE_RESULT_PREFIX.length));
  } catch (error) {
    throw bootstrapFailure("The repository access probe reported an unparsable result", {
      cause: String(error),
    });
  }
  const record = document as Partial<RepositoryAccessProof> & { version?: unknown };
  if (
    record.version !== 1 ||
    typeof record.repository !== "string" ||
    typeof record.authenticatedAs !== "string" ||
    typeof record.keyFingerprint !== "string" ||
    record.reachable !== true
  ) {
    throw bootstrapFailure("The repository access probe reported an incomplete result");
  }
  if (!HOST_KEY_FINGERPRINT_PATTERN.test(record.keyFingerprint)) {
    throw bootstrapFailure("The repository access probe reported a malformed key fingerprint");
  }
  return {
    repository: record.repository,
    authenticatedAs: record.authenticatedAs,
    keyFingerprint: record.keyFingerprint,
    reachable: true,
  };
}

interface BootstrapResultDocument {
  readonly version: 1;
  readonly changed: boolean;
  readonly bindingId: string;
  readonly targetId: string;
  readonly gatewayUser: string;
  readonly runtimeVersion: string;
  readonly runtimeBundleSha256: string;
  readonly repositoryKeyId: string;
  readonly repositoryPublicKey: string;
  readonly repositoryPublicKeyFingerprint: string;
}

export function parseBootstrapResult(stdout: string): BootstrapResultDocument {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(BOOTSTRAP_RESULT_PREFIX));
  if (line === undefined) {
    throw bootstrapFailure("The gateway installer did not report a bootstrap result");
  }
  let document: unknown;
  try {
    document = JSON.parse(line.slice(BOOTSTRAP_RESULT_PREFIX.length));
  } catch (error) {
    throw bootstrapFailure("The gateway installer reported an unparsable bootstrap result", {
      cause: String(error),
    });
  }
  const record = document as Partial<BootstrapResultDocument>;
  if (
    record.version !== 1 ||
    typeof record.changed !== "boolean" ||
    typeof record.bindingId !== "string" ||
    typeof record.targetId !== "string" ||
    typeof record.runtimeVersion !== "string" ||
    typeof record.runtimeBundleSha256 !== "string" ||
    typeof record.repositoryKeyId !== "string" ||
    typeof record.repositoryPublicKey !== "string" ||
    typeof record.repositoryPublicKeyFingerprint !== "string" ||
    record.gatewayUser !== GATEWAY_USER
  ) {
    throw bootstrapFailure("The gateway installer reported an incomplete bootstrap result");
  }
  if (!HOST_KEY_FINGERPRINT_PATTERN.test(record.repositoryPublicKeyFingerprint)) {
    throw bootstrapFailure("The gateway installer reported a malformed repository key fingerprint");
  }
  if (!/^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/u.test(record.repositoryPublicKey)) {
    throw bootstrapFailure("The gateway installer reported a malformed repository public key");
  }
  return record as BootstrapResultDocument;
}

export function createAdministratorSshPort(
  options: AdministratorSshPortOptions = {},
): AdministratorSshBoundary {
  const runner = options.runner ?? processAdministratorCommandRunner;
  const assetsDirectory = options.assetsDirectory ?? join(localPackageRoot(), "assets");
  const newRequestId = options.newRequestId ?? (() => randomUUID());
  const newRemoteDirectory = options.newRemoteDirectory ??
    (() => `/tmp/deploykit-bootstrap-${randomUUID().replace(/-/gu, "")}`);

  /** Runs one argv on the VPS with the pinned host key already resolved. */
  async function remote(
    connection: AdministratorSshConnection,
    knownHostsFile: string,
    args: readonly string[],
    request: { input?: string; timeoutMs?: number } = {},
  ): Promise<AdministratorRunResult> {
    assertSafeRemoteArguments(args);
    return runner.run({
      command: "ssh",
      args: [
        ...administratorSshOptions(connection, knownHostsFile),
        "-T",
        "-p", String(connection.port),
        `${connection.user}@${connection.host}`,
        ...args,
      ],
      ...(request.input === undefined ? {} : { input: request.input }),
      timeoutMs: request.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
    });
  }

  /** Materializes the pinned host key, runs `body`, and always removes it. */
  async function withPinnedHostKey<T>(
    connection: AdministratorSshConnection,
    body: (knownHostsFile: string, hostKey: PinnedHostKey) => Promise<T>,
  ): Promise<T> {
    assertAdministratorConnection(connection);
    const hostKey = await resolvePinnedHostKey(runner, connection);
    const directory = await mkdtemp(join(tmpdir(), "deploykit-known-hosts-"));
    try {
      const knownHostsFile = join(directory, "known_hosts");
      // ssh-keyscan already emits the bracketed `[host]:port` form when the
      // port is not 22, so the scanned line is written exactly as received.
      await writeFile(knownHostsFile, `${hostKey.line}\n`, { mode: 0o600 });
      return await body(knownHostsFile, hostKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function handshake(
    connection: AdministratorSshConnection,
    knownHostsFile: string,
    binding: RootOwnedGatewayBinding,
  ): Promise<GatewayHandshakeResult | undefined> {
    const requestId = newRequestId();
    if (!isRequestId(requestId)) throw bootstrapFailure("The generated request id is not a UUID");
    const result = await remote(
      connection,
      knownHostsFile,
      ["sudo", "-n", GATEWAY_ENTRY_PATH],
      { input: encodeHandshakeRequest(binding, requestId), timeoutMs: HANDSHAKE_TIMEOUT_MS },
    );
    return readHandshakeResult(result.stdout);
  }

  async function runKeyHelper(
    connection: AdministratorSshConnection,
    binding: RootOwnedGatewayBinding,
    args: readonly string[],
    input?: string,
  ): Promise<readonly GatewayKeyEntry[]> {
    return withPinnedHostKey(connection, async (knownHostsFile) => {
      const base = [
        "sudo", "-n", GATEWAY_KEYS_HELPER_PATH,
        "--authorized-keys", GATEWAY_AUTHORIZED_KEYS_PATH,
        "--binding-id", binding.bindingId,
        "--owner", `${GATEWAY_USER}:${GATEWAY_USER}`,
      ];
      const mutation = await remote(connection, knownHostsFile, [...base, ...args], {
        ...(input === undefined ? {} : { input }),
      });
      if (mutation.exitCode !== 0) {
        throw orchestratorError(
          "DK_KEY_ROTATION_FAILED",
          `The gateway key helper on ${connection.host} refused the request; the last verified key was left intact`,
          { details: { exitCode: mutation.exitCode } },
        );
      }
      const listing = await remote(connection, knownHostsFile, [...base, "list"]);
      if (listing.exitCode !== 0) {
        throw orchestratorError(
          "DK_KEY_ROTATION_FAILED",
          `The gateway key helper on ${connection.host} could not list the owned entries`,
        );
      }
      return parseGatewayKeyEntries(listing.stdout);
    });
  }

  return {
    async preflight(connection: AdministratorSshConnection): Promise<AdministratorSshPreflight> {
      return withPinnedHostKey(connection, async (knownHostsFile, hostKey) => {
        const release = await remote(connection, knownHostsFile, ["cat", "/etc/os-release"]);
        if (release.exitCode !== 0) {
          throw unreachable(`${connection.host} did not accept an administrator SSH connection`, {
            host: connection.host,
            exitCode: release.exitCode,
          });
        }
        const machine = await remote(connection, knownHostsFile, ["uname", "-m"]);
        const sudo = await remote(connection, knownHostsFile, ["sudo", "-n", "true"]);
        return {
          reachable: true,
          hostKeyFingerprint: hostKey.fingerprint,
          operatingSystem: readOperatingSystem(release.stdout),
          architecture: readArchitecture(machine.stdout),
          administrator: sudo.exitCode === 0,
        };
      });
    },

    async inspectGateway(
      connection: AdministratorSshConnection,
      expectedBinding: RootOwnedGatewayBinding,
    ): Promise<GatewayHandshakeResult | undefined> {
      return withPinnedHostKey(connection, (knownHostsFile) =>
        handshake(connection, knownHostsFile, expectedBinding));
    },

    async bootstrapGateway(request: GatewayBootstrapRequest): Promise<GatewayBootstrapResult> {
      const { connection, binding } = request;
      return withPinnedHostKey(connection, async (knownHostsFile) => {
        const remoteDirectory = newRemoteDirectory();
        assertSafeRemoteArguments([remoteDirectory, request.packageSha256, request.packageName]);
        const packageBase = basename(request.packageFile);
        assertSafeRemoteArguments([packageBase]);

        const created = await remote(connection, knownHostsFile, [
          "install", "-d", "-m", "0700", remoteDirectory,
        ]);
        if (created.exitCode !== 0) {
          throw unreachable(`${connection.host} did not accept an administrator SSH connection`, {
            host: connection.host,
            exitCode: created.exitCode,
          });
        }
        try {
          const uploads = [
            ...BOOTSTRAP_ASSET_FILES.map((asset) => join(assetsDirectory, asset)),
            join(assetsDirectory, "github-known-hosts"),
            request.packageFile,
          ];
          const copied = await runner.run({
            command: "scp",
            args: [
              ...administratorSshOptions(connection, knownHostsFile),
              "-P", String(connection.port),
              ...uploads,
              `${connection.user}@${connection.host}:${remoteDirectory}/`,
            ],
            timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          });
          if (copied.exitCode !== 0) {
            throw bootstrapFailure(`The gateway installer could not be uploaded to ${connection.host}`, {
              exitCode: copied.exitCode,
            });
          }

          const installerArgs = [
            "sudo", "-n", "bash", `${remoteDirectory}/bootstrap.sh`,
            "--repository", binding.repository,
            "--github-environment", binding.githubEnvironment,
            "--target-name", binding.targetName,
            "--target-id", binding.targetId,
            "--binding-id", binding.bindingId,
            "--package", `${remoteDirectory}/${packageBase}`,
            "--package-name", request.packageName,
            "--sha256", request.packageSha256,
            "--ssh-port", String(connection.port),
          ];
          if (request.configureFirewall) installerArgs.push("--configure-firewall");

          const installed = await remote(connection, knownHostsFile, installerArgs, {
            timeoutMs: BOOTSTRAP_TIMEOUT_MS,
          });
          if (installed.exitCode === 4) {
            throw orchestratorError(
              "DK_GATEWAY_BINDING_MISMATCH",
              `${connection.host} is already bound to a different repository, Environment, or target`,
              { details: { host: connection.host } },
            );
          }
          if (installed.exitCode !== 0) {
            throw bootstrapFailure(`The gateway installer failed on ${connection.host}`, {
              exitCode: installed.exitCode,
            });
          }
          const result = parseBootstrapResult(installed.stdout);
          if (result.bindingId !== binding.bindingId || result.targetId !== binding.targetId) {
            throw orchestratorError(
              "DK_GATEWAY_BINDING_MISMATCH",
              `${connection.host} reported a different gateway binding than the one requested`,
            );
          }
          if (result.runtimeBundleSha256 !== request.packageSha256) {
            throw bootstrapFailure(`${connection.host} installed a different runtime bundle than the one uploaded`);
          }

          // The installer's own word is not enough: the forced-command program
          // has to answer for the binding it will actually serve.
          const verified = await handshake(connection, knownHostsFile, binding);
          if (
            verified === undefined ||
            verified.bindingId !== binding.bindingId ||
            verified.targetId !== binding.targetId ||
            verified.runtimeBundleSha256 !== request.packageSha256
          ) {
            throw bootstrapFailure(
              `${connection.host} did not answer the gateway handshake with the expected binding`,
            );
          }

          return {
            changed: result.changed,
            binding: {
              ...binding,
              runtimeVersion: result.runtimeVersion,
              runtimeBundleSha256: result.runtimeBundleSha256,
              repositoryKeyId: result.repositoryKeyId,
              repositoryKeyFingerprint: result.repositoryPublicKeyFingerprint,
            },
            handshake: verified,
            repositoryPublicKey: result.repositoryPublicKey,
            repositoryPublicKeyFingerprint: result.repositoryPublicKeyFingerprint,
          };
        } finally {
          await remote(connection, knownHostsFile, ["rm", "-rf", remoteDirectory]).catch(() => undefined);
        }
      });
    },

    async listGatewayKeys(connection, binding): Promise<readonly GatewayKeyEntry[]> {
      return withPinnedHostKey(connection, async (knownHostsFile) => {
        const listing = await remote(connection, knownHostsFile, [
          "sudo", "-n", GATEWAY_KEYS_HELPER_PATH,
          "--authorized-keys", GATEWAY_AUTHORIZED_KEYS_PATH,
          "--binding-id", binding.bindingId,
          "list",
        ]);
        if (listing.exitCode !== 0) {
          throw orchestratorError(
            "DK_KEY_ROTATION_FAILED",
            `The gateway key helper on ${connection.host} could not list the owned entries`,
          );
        }
        return parseGatewayKeyEntries(listing.stdout);
      });
    },

    async stageGatewayKey(connection, binding, key): Promise<readonly GatewayKeyEntry[]> {
      if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key.keyId)) {
        throw orchestratorError("DK_KEY_ROTATION_FAILED", "The staged gateway key id is not a safe identifier");
      }
      return runKeyHelper(
        connection,
        binding,
        ["stage", "--key-id", key.keyId, "--public-key-file", "-"],
        `${key.publicKey.trim()}\n`,
      );
    },

    async activateGatewayKey(connection, binding, keyId): Promise<readonly GatewayKeyEntry[]> {
      if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(keyId)) {
        throw orchestratorError("DK_KEY_ROTATION_FAILED", "The activated gateway key id is not a safe identifier");
      }
      return runKeyHelper(connection, binding, ["activate", "--key-id", keyId]);
    },

    async proveRepositoryAccess(connection, binding): Promise<RepositoryAccessProof> {
      return withPinnedHostKey(connection, async (knownHostsFile) => {
        const probe = await remote(
          connection,
          knownHostsFile,
          ["sudo", "-n", GATEWAY_SOURCE_PROBE_PATH, "--repository", binding.repository],
          { timeoutMs: SOURCE_PROBE_TIMEOUT_MS },
        );
        // Exit 5 is the probe's frozen "authenticated as somebody else" status.
        // Registering a read-only key that in fact opens another repository is
        // an ownership question a human resolves, not a transient failure.
        if (probe.exitCode === 5) {
          throw orchestratorError(
            "DK_OWNERSHIP_CONFLICT",
            `The read-only repository key held by ${connection.host} does not authenticate as ${binding.repository}`,
            { details: { host: connection.host, repository: binding.repository } },
          );
        }
        if (probe.exitCode !== 0) {
          throw bootstrapFailure(
            `${connection.host} could not reach ${binding.repository} with its read-only repository identity`,
            { host: connection.host, repository: binding.repository, exitCode: probe.exitCode },
          );
        }
        const proof = parseSourceProbeResult(probe.stdout);
        // The probe already refuses a mismatch; re-checking here means a helper
        // that was replaced with a permissive one still cannot pass.
        if (proof.repository !== binding.repository || proof.authenticatedAs !== binding.repository) {
          throw orchestratorError(
            "DK_OWNERSHIP_CONFLICT",
            `The read-only repository key held by ${connection.host} does not authenticate as ${binding.repository}`,
            { details: { host: connection.host, repository: binding.repository } },
          );
        }
        return proof;
      });
    },
  };
}

// -------------------------------------------------------------- host facts --

function readOperatingSystem(osRelease: string): AdministratorSshPreflight["operatingSystem"] {
  const values = new Map<string, string>();
  for (const line of osRelease.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const value = line.slice(equals + 1).trim();
    values.set(line.slice(0, equals), value.replace(/^["']|["']$/gu, ""));
  }
  if (values.get("ID") !== "ubuntu") {
    throw bootstrapFailure(`DeployKit v0.1 requires Ubuntu (found ${values.get("ID") ?? "unknown"})`);
  }
  const version = values.get("VERSION_ID");
  if (version !== "22.04" && version !== "24.04") {
    throw bootstrapFailure(`DeployKit v0.1 requires Ubuntu 22.04 or 24.04 (found ${version ?? "unknown"})`);
  }
  return version === "22.04" ? "ubuntu-22.04" : "ubuntu-24.04";
}

function readArchitecture(machine: string): AdministratorSshPreflight["architecture"] {
  const value = machine.trim();
  if (value === "x86_64") return "amd64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  throw bootstrapFailure(`DeployKit v0.1 requires amd64 or arm64 (found ${value || "unknown"})`);
}

export function parseGatewayKeyEntries(stdout: string): readonly GatewayKeyEntry[] {
  const entries: GatewayKeyEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let document: unknown;
    try {
      document = JSON.parse(trimmed);
    } catch {
      throw orchestratorError("DK_KEY_ROTATION_FAILED", "The gateway key helper reported an unparsable entry");
    }
    const record = document as Partial<GatewayKeyEntry>;
    if (
      (record.state !== "pending" && record.state !== "active") ||
      typeof record.keyId !== "string" ||
      typeof record.type !== "string" ||
      typeof record.key !== "string"
    ) {
      throw orchestratorError("DK_KEY_ROTATION_FAILED", "The gateway key helper reported an incomplete entry");
    }
    entries.push({ state: record.state, keyId: record.keyId, type: record.type, key: record.key });
  }
  return entries;
}
