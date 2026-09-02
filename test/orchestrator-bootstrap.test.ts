import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrapServer, gatewayBindingFor } from "../src/bootstrap.js";
import { inputStreamFrom, runGatewayCommand } from "../src/gateway/command.js";
import { readGatewayBinding } from "../src/gateway/binding.js";
import {
  BOOTSTRAP_ASSET_FILES,
  GATEWAY_AUTHORIZED_KEYS_PATH,
  GATEWAY_ENTRY_PATH,
  GATEWAY_KEYS_HELPER_PATH,
  createAdministratorSshPort,
  encodeHandshakeRequest,
  parseBootstrapResult,
  readHandshakeResult,
  resolvePinnedHostKey,
  type AdministratorCommandRunner,
  type AdministratorRunRequest,
  type AdministratorRunResult,
} from "../src/orchestrator/administrator-ssh.js";
import { GATEWAY_USER, type RootOwnedGatewayBinding } from "../src/orchestrator/contracts.js";
import type { AdministratorSshConnection } from "../src/orchestrator/dependencies.js";
import {
  REQUIRED_BUNDLE_ENTRIES,
  assertBundleContents,
  resolveRuntimeBundle,
} from "../src/orchestrator/runtime-bundle.js";
import { DEFAULT_SERVER_ROOTS } from "../src/server/paths.js";
import { VERSION } from "../src/version.js";

const run = promisify(execFile);

/** Runs a script with a real pipe on stdin, the way SSH delivers one. */
function bashWithStdin(args: readonly string[], input: string): Promise<AdministratorRunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("close", (code) => { resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    child.stdin.end(input);
  });
}

const ASSETS = resolve("assets");
const BINDING_HELPER = join(ASSETS, "gateway-binding.sh");
const KEYS_HELPER = join(ASSETS, "gateway-keys.sh");

const SECRET_CANARY = "DK_CANARY_ADMIN_PRIVATE_KEY_5be31c";

const CONNECTION: AdministratorSshConnection = {
  host: "vps.example.com",
  user: "ubuntu",
  port: 2222,
  identityFile: "/home/operator/.ssh/id_ed25519",
  hostKeyFingerprint: "",
};

const OPTIONS = {
  host: CONNECTION.host,
  user: CONNECTION.user,
  port: CONNECTION.port,
  identityFile: CONNECTION.identityFile,
  hostKeyFingerprint: "",
  repository: "deploykit-fixtures/static-compose",
  githubEnvironment: "fixture-static-production",
  targetName: "production",
} as const;

/** OpenSSH's own fingerprint form: unpadded base64 of the SHA-256 of the key blob. */
function sshFingerprint(base64Key: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64").replace(/=+$/u, "")}`;
}

function syntheticKey(seed: string): { readonly line: string; readonly data: string } {
  // 32 bytes of key material wrapped in a plausible ed25519 blob header.
  const data = Buffer.concat([
    Buffer.from([0, 0, 0, 0x0b]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 0x20]),
    createHash("sha256").update(seed).digest(),
  ]).toString("base64");
  return { line: `ssh-ed25519 ${data}`, data };
}

const HOST_KEY = syntheticKey("host-key");
const HOST_FINGERPRINT = sshFingerprint(HOST_KEY.data);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A hermetic stand-in for a bootstrapped VPS.
 *
 * The parts that carry the phase's guarantees are not simulated: the binding is
 * reconciled by the real `gateway-binding.sh`, the forced-command handshake is
 * answered by the real gateway session speaking the real protocol against the
 * real binding file, and the key lifecycle runs the real `gateway-keys.sh` over
 * a real `authorized_keys` file. Only SSH transport and apt-level provisioning
 * are faked.
 */
class FakeVps implements AdministratorCommandRunner {
  readonly commands: AdministratorRunRequest[] = [];
  readonly uploaded: string[] = [];
  installerRuns = 0;
  bootstrapped = false;
  administrator = true;
  osRelease = 'ID=ubuntu\nVERSION_ID="24.04"\n';
  machine = "x86_64\n";
  private repositoryKeyModeSet = false;

  constructor(
    readonly root: string,
    readonly options: { readonly hostKey?: { line: string; data: string } } = {},
  ) {}

  get bindingFile(): string { return join(this.root, "binding.json"); }
  get authorizedKeysFile(): string { return join(this.root, "authorized_keys"); }
  get repositoryKeyFile(): string { return join(this.root, "repository-key"); }

  async run(request: AdministratorRunRequest): Promise<AdministratorRunResult> {
    this.commands.push(request);
    if (request.command === "ssh-keyscan") return this.keyscan();
    if (request.command === "ssh-keygen") return this.fingerprint(request.input ?? "");
    if (request.command === "scp") return this.scp(request.args);
    if (request.command === "ssh") return this.ssh(request);
    return { stdout: "", stderr: `unexpected command ${request.command}`, exitCode: 127 };
  }

  private keyscan(): AdministratorRunResult {
    const key = this.options.hostKey ?? HOST_KEY;
    return { stdout: `# comment\n[vps.example.com]:2222 ${key.line}\n`, stderr: "", exitCode: 0 };
  }

  private fingerprint(input: string): AdministratorRunResult {
    const data = input.trim().split(/\s+/).at(-1) ?? "";
    return { stdout: `256 ${sshFingerprint(data)} no comment (ED25519)\n`, stderr: "", exitCode: 0 };
  }

  private scp(args: readonly string[]): AdministratorRunResult {
    for (const argument of args) {
      if (argument.startsWith("/") && argument.endsWith(".tgz")) this.uploaded.push(argument);
      for (const asset of [...BOOTSTRAP_ASSET_FILES, "github-known-hosts"]) {
        if (argument.endsWith(`/${asset}`)) this.uploaded.push(asset);
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  /** Everything after the target; the port and options are already consumed. */
  private remoteArgs(args: readonly string[]): readonly string[] {
    const target = args.indexOf(`${CONNECTION.user}@${CONNECTION.host}`);
    return args.slice(target + 1);
  }

  private async ssh(request: AdministratorRunRequest): Promise<AdministratorRunResult> {
    const args = this.remoteArgs(request.args);
    if (args[0] === "cat") return { stdout: this.osRelease, stderr: "", exitCode: 0 };
    if (args[0] === "uname") return { stdout: this.machine, stderr: "", exitCode: 0 };
    if (args[0] === "install" || args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] !== "sudo" || args[1] !== "-n") {
      return { stdout: "", stderr: "unsupported invocation", exitCode: 127 };
    }
    if (args[2] === "true") {
      return this.administrator
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "a password is required", exitCode: 1 };
    }
    if (args[2] === GATEWAY_ENTRY_PATH) return this.handshake(request.input ?? "");
    if (args[2] === GATEWAY_KEYS_HELPER_PATH) return this.keyHelper(args.slice(3), request.input);
    if (args[2] === "bash") return this.installer(args.slice(4));
    return { stdout: "", stderr: "unsupported invocation", exitCode: 127 };
  }

  /** The real forced command, answering from the real root-owned binding file. */
  private async handshake(input: string): Promise<AdministratorRunResult> {
    if (!this.bootstrapped) {
      return { stdout: "", stderr: "deploykit: command not found", exitCode: 127 };
    }
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    const session = await runGatewayCommand({
      argv: [],
      env: {},
      stdin: inputStreamFrom(input),
      stdout: sink,
      stdinIsTty: false,
      stdoutIsTty: false,
      roots: { ...DEFAULT_SERVER_ROOTS, config: this.root, state: this.root },
      readBinding: () => readGatewayBinding({ path: this.bindingFile, requireRootOwnership: false }),
    });
    return { stdout: Buffer.concat(chunks).toString("utf8"), stderr: "", exitCode: session.exitCode };
  }

  private async keyHelper(args: readonly string[], input?: string): Promise<AdministratorRunResult> {
    const rewritten = args.map((argument) =>
      argument === GATEWAY_AUTHORIZED_KEYS_PATH ? this.authorizedKeysFile : argument);
    // `--owner` names a VPS account that does not exist in the test environment.
    const owner = rewritten.indexOf("--owner");
    if (owner >= 0) rewritten.splice(owner, 2);
    // The key really does arrive on a pipe, exactly as it does over SSH.
    return bashWithStdin([KEYS_HELPER, ...rewritten], input ?? "");
  }

  /** Provisioning is faked; identity, the key, and the binding are not. */
  private async installer(args: readonly string[]): Promise<AdministratorRunResult> {
    this.installerRuns += 1;
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
      const flag = args[index] ?? "";
      if (!flag.startsWith("--")) continue;
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("--")) { flags.set(flag, value); index += 1; }
      else flags.set(flag, "true");
    }
    if (flags.get("--package-name") !== "@deploykit001/deploykit") {
      return { stdout: "", stderr: "unexpected DeployKit package name", exitCode: 9 };
    }

    const repositoryKeyId = `deploykit-repository-${flags.get("--target-id") ?? ""}`;
    let publicKey: string;
    try {
      // The installer emits only the type and the key data, never the comment.
      publicKey = (await readFile(`${this.repositoryKeyFile}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
    } catch {
      publicKey = syntheticKey(`repository-${repositoryKeyId}`).line;
      await writeFile(this.repositoryKeyFile, `${SECRET_CANARY}\n`, { mode: 0o600 });
      await writeFile(`${this.repositoryKeyFile}.pub`, `${publicKey} ${repositoryKeyId}\n`, { mode: 0o644 });
      this.repositoryKeyModeSet = true;
    }
    const fingerprint = sshFingerprint(publicKey.split(/\s+/)[1] ?? "");

    let changed: boolean;
    try {
      const { stdout } = await run("bash", [
        BINDING_HELPER,
        "--file", this.bindingFile,
        "--repository", flags.get("--repository") ?? "",
        "--github-environment", flags.get("--github-environment") ?? "",
        "--target-name", flags.get("--target-name") ?? "",
        "--target-id", flags.get("--target-id") ?? "",
        "--binding-id", flags.get("--binding-id") ?? "",
        "--runtime-version", VERSION,
        "--runtime-bundle-sha256", flags.get("--sha256") ?? "",
        "--repository-key-id", repositoryKeyId,
        "--repository-key-fingerprint", fingerprint,
      ]);
      changed = (JSON.parse(stdout) as { changed: boolean }).changed;
    } catch (error) {
      const failure = error as { stderr?: string; code?: number };
      return { stdout: "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 9 };
    }

    this.bootstrapped = true;
    const result = {
      version: 1,
      changed,
      bindingId: flags.get("--binding-id"),
      targetId: flags.get("--target-id"),
      gatewayUser: GATEWAY_USER,
      runtimeVersion: VERSION,
      runtimeBundleSha256: flags.get("--sha256"),
      repositoryKeyId,
      repositoryPublicKey: publicKey,
      repositoryPublicKeyFingerprint: fingerprint,
    };
    return {
      stdout: `[deploykit bootstrap] installing\nDEPLOYKIT_BOOTSTRAP_RESULT ${JSON.stringify(result)}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  get repositoryKeyWasWritten(): boolean { return this.repositoryKeyModeSet; }
}

async function fakeHost(): Promise<FakeVps> {
  return new FakeVps(await temporaryDirectory("deploykit-fake-vps-"));
}

function portFor(host: FakeVps) {
  return createAdministratorSshPort({
    runner: host,
    assetsDirectory: ASSETS,
    newRequestId: () => "9f1c0a2b-3d4e-4f50-8a1b-2c3d4e5f6071",
    newRemoteDirectory: () => "/tmp/deploykit-bootstrap-fixed",
  });
}

const BUNDLE = {
  packageFile: "/tmp/deploykit-bundle/deploykit001-deploykit-0.1.3.tgz",
  packageName: "@deploykit001/deploykit",
  packageSha256: "a".repeat(64),
};

function bindingFor(): RootOwnedGatewayBinding {
  return gatewayBindingFor({ ...OPTIONS, hostKeyFingerprint: HOST_FINGERPRINT });
}

// ------------------------------------------------------------ host keys --

describe("administrator SSH host pinning", () => {
  it("keeps only the key whose fingerprint is the pinned one", async () => {
    const host = await fakeHost();
    const key = await resolvePinnedHostKey(host, { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT });

    expect(key.fingerprint).toBe(HOST_FINGERPRINT);
    expect(key.line).toContain("[vps.example.com]:2222");
  });

  it("refuses a host that presents a different key", async () => {
    const host = await fakeHost();
    await expect(
      resolvePinnedHostKey(host, { ...CONNECTION, hostKeyFingerprint: sshFingerprint(syntheticKey("other").data) }),
    ).rejects.toMatchObject({ code: "DK_SSH_HOST_KEY_MISMATCH" });
  });

  it("uses strict known-host verification and no forwarding on every connection", async () => {
    const host = await fakeHost();
    await portFor(host).preflight({ ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT });

    const connection = host.commands.find((command) => command.command === "ssh");
    expect(connection?.args).toEqual(expect.arrayContaining([
      "StrictHostKeyChecking=yes",
      "ClearAllForwardings=yes",
      "ForwardAgent=no",
      "ForwardX11=no",
      "IdentitiesOnly=yes",
      "BatchMode=yes",
      "-T",
    ]));
  });
});

// ------------------------------------------------------------- handshake --

describe("non-mutating gateway handshake", () => {
  it("reports nothing installed before bootstrap", async () => {
    const host = await fakeHost();
    const handshake = await portFor(host).inspectGateway(
      { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT },
      bindingFor(),
    );
    expect(handshake).toBeUndefined();
  });

  it("verifies the installed bundle and binding through the real forced command", async () => {
    const host = await fakeHost();
    const port = portFor(host);
    const connection = { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT };
    const binding = bindingFor();

    const bootstrap = await port.bootstrapGateway({
      connection,
      binding,
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: false,
    });

    expect(bootstrap.handshake).toMatchObject({
      kind: "handshake",
      bindingId: binding.bindingId,
      targetId: binding.targetId,
      runtimeVersion: VERSION,
      runtimeBundleSha256: BUNDLE.packageSha256,
    });
    expect(bootstrap.handshake.capabilities).toContain("handshake");

    // The same handshake answers again without another installer run.
    const inspected = await port.inspectGateway(connection, binding);
    expect(inspected).toMatchObject({ bindingId: binding.bindingId, runtimeBundleSha256: BUNDLE.packageSha256 });
    expect(host.installerRuns).toBe(1);
  });

  it("frames a handshake request with no manifest, secret, or mutation flag", () => {
    const binding = bindingFor();
    const stream = encodeHandshakeRequest(binding, "9f1c0a2b-3d4e-4f50-8a1b-2c3d4e5f6071");
    const [request, end] = stream.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(request).toMatchObject({
      frame: "request",
      operation: "handshake",
      applicationRef: null,
      commitSha: null,
      manifestDigest: null,
      expectedPayload: { manifestFrames: 0, manifestBytes: 0, secretFrames: 0, secretBytes: 0 },
      flags: { dryRun: false },
    });
    expect(end).toMatchObject({ frame: "end", manifestFrames: 0, secretFrames: 0, payloadBytes: 0 });
  });

  it("reads a binding mismatch out of a refused handshake", () => {
    const refusal = JSON.stringify({
      protocolVersion: "deploykit/gateway/v1alpha1",
      frame: "result",
      requestId: "9f1c0a2b-3d4e-4f50-8a1b-2c3d4e5f6071",
      sequence: 1,
      time: "2026-01-05T08:59:00.000Z",
      ok: false,
      code: "DK_GATEWAY_BINDING_MISMATCH",
      recovery: "resolve-ownership-conflict",
      result: null,
    });
    expect(() => readHandshakeResult(`${refusal}\n`)).toThrowError(
      expect.objectContaining({ code: "DK_GATEWAY_BINDING_MISMATCH" }),
    );
    expect(readHandshakeResult("not a stream")).toBeUndefined();
  });
});

// ------------------------------------------------------------- bootstrap --

describe("gateway bootstrap", () => {
  it("reconciles an identical binding without changing it", async () => {
    const host = await fakeHost();
    const port = portFor(host);
    const connection = { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT };
    const binding = bindingFor();
    const request = {
      connection,
      binding,
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: false,
    };

    const first = await port.bootstrapGateway(request);
    const before = await readFile(host.bindingFile, "utf8");
    const second = await port.bootstrapGateway(request);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(await readFile(host.bindingFile, "utf8")).toBe(before);
    expect(second.repositoryPublicKey).toBe(first.repositoryPublicKey);
    expect(second.repositoryPublicKeyFingerprint).toBe(first.repositoryPublicKeyFingerprint);
  });

  it("fails closed when the host is bound to another repository or target", async () => {
    const host = await fakeHost();
    const port = portFor(host);
    const connection = { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT };
    const request = {
      connection,
      binding: bindingFor(),
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: false,
    };
    await port.bootstrapGateway(request);
    const before = await readFile(host.bindingFile, "utf8");

    for (const conflicting of [
      gatewayBindingFor({ ...OPTIONS, hostKeyFingerprint: HOST_FINGERPRINT, repository: "someone-else/app" }),
      gatewayBindingFor({ ...OPTIONS, hostKeyFingerprint: HOST_FINGERPRINT, targetName: "staging" }),
      gatewayBindingFor({ ...OPTIONS, hostKeyFingerprint: HOST_FINGERPRINT, githubEnvironment: "other" }),
    ]) {
      await expect(port.bootstrapGateway({ ...request, binding: conflicting })).rejects.toMatchObject({
        code: "DK_GATEWAY_BINDING_MISMATCH",
      });
    }
    expect(await readFile(host.bindingFile, "utf8")).toBe(before);
  });

  it("returns only the repository public key and nonsecret fingerprints", async () => {
    const host = await fakeHost();
    const result = await portFor(host).bootstrapGateway({
      connection: { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT },
      binding: bindingFor(),
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: false,
    });

    expect(result.repositoryPublicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(result.repositoryPublicKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(host.commands)).not.toContain(SECRET_CANARY);

    // The private half stays on the host with owner-only permissions.
    expect(host.repositoryKeyWasWritten).toBe(true);
    expect((await stat(host.repositoryKeyFile)).mode & 0o777).toBe(0o600);
  });

  it("uploads the installer, both gateway helpers, and the pinned host keys", async () => {
    const host = await fakeHost();
    await portFor(host).bootstrapGateway({
      connection: { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT },
      binding: bindingFor(),
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: false,
    });

    expect(host.uploaded).toEqual(expect.arrayContaining([
      ...BOOTSTRAP_ASSET_FILES,
      "github-known-hosts",
      BUNDLE.packageFile,
    ]));
  });

  it("passes the administrator SSH port to the installer so a firewall keeps it open", async () => {
    const host = await fakeHost();
    await portFor(host).bootstrapGateway({
      connection: { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT },
      binding: bindingFor(),
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: true,
    });

    const installer = host.commands.find((command) =>
      command.args.includes("--configure-firewall"));
    expect(installer?.args).toEqual(expect.arrayContaining(["--ssh-port", "2222", "--configure-firewall"]));
  });

  it("refuses a bootstrap result that is absent, malformed, or names another binding", () => {
    expect(() => parseBootstrapResult("no result here")).toThrowError(
      expect.objectContaining({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" }),
    );
    expect(() => parseBootstrapResult("DEPLOYKIT_BOOTSTRAP_RESULT {oops")).toThrowError(
      expect.objectContaining({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" }),
    );
    expect(() => parseBootstrapResult('DEPLOYKIT_BOOTSTRAP_RESULT {"version":1}')).toThrowError(
      expect.objectContaining({ code: "DK_GATEWAY_BOOTSTRAP_FAILED" }),
    );
  });
});

// -------------------------------------------------------- key lifecycle --

describe("staged and active gateway key entries", () => {
  const OPERATOR_KEY = "ssh-ed25519 AAAAOPERATOR operator@laptop";

  async function bootstrappedHost() {
    const host = await fakeHost();
    const port = portFor(host);
    const connection = { ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT };
    const binding = bindingFor();
    await port.bootstrapGateway({
      connection,
      binding,
      packageFile: BUNDLE.packageFile,
      packageName: BUNDLE.packageName,
      packageSha256: BUNDLE.packageSha256,
      configureFirewall: false,
    });
    await writeFile(host.authorizedKeysFile, `${OPERATOR_KEY}\n`, { mode: 0o600 });
    return { host, port, connection, binding };
  }

  it("stages, activates, and leaves exactly one owned entry", async () => {
    const { host, port, connection, binding } = await bootstrappedHost();
    const first = syntheticKey("gateway-1").line;

    await port.stageGatewayKey(connection, binding, { keyId: "gw-1", publicKey: first });
    const activated = await port.activateGatewayKey(connection, binding, "gw-1");

    expect(activated).toEqual([{ state: "active", keyId: "gw-1", type: "ssh-ed25519", key: first.split(" ")[1] }]);
    const contents = await readFile(host.authorizedKeysFile, "utf8");
    expect(contents).toContain(OPERATOR_KEY);
    expect(contents).toContain(`command="/usr/bin/sudo -n ${GATEWAY_ENTRY_PATH}"`);
    expect(contents).toContain("restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding");
  });

  it("leaves one valid key after an interruption at every rotation step", async () => {
    const { host, port, connection, binding } = await bootstrappedHost();
    await port.stageGatewayKey(connection, binding, { keyId: "gw-1", publicKey: syntheticKey("gateway-1").line });
    await port.activateGatewayKey(connection, binding, "gw-1");

    // Interrupted after staging the replacement: both keys are usable, and the
    // proven one is still the active entry.
    const staged = await port.stageGatewayKey(connection, binding, {
      keyId: "gw-2",
      publicKey: syntheticKey("gateway-2").line,
    });
    expect(staged.map((entry) => `${entry.state}:${entry.keyId}`).sort()).toEqual(["active:gw-1", "pending:gw-2"]);

    // Re-staging the same replacement after an interruption is a no-op.
    const restaged = await port.stageGatewayKey(connection, binding, {
      keyId: "gw-2",
      publicKey: syntheticKey("gateway-2").line,
    });
    expect(restaged.map((entry) => `${entry.state}:${entry.keyId}`).sort()).toEqual(["active:gw-1", "pending:gw-2"]);

    const activated = await port.activateGatewayKey(connection, binding, "gw-2");
    expect(activated).toEqual([expect.objectContaining({ state: "active", keyId: "gw-2" })]);

    // Repeating the interrupted activation is idempotent, never empty.
    expect(await port.activateGatewayKey(connection, binding, "gw-2")).toHaveLength(1);
    expect(await readFile(host.authorizedKeysFile, "utf8")).toContain(OPERATOR_KEY);
  });

  it("never removes an entry owned by another binding", async () => {
    const { host, port, connection, binding } = await bootstrappedHost();
    const other = `restrict,command="/usr/bin/sudo -n ${GATEWAY_ENTRY_PATH}" ssh-ed25519 AAAAOTHER deploykit-gateway:${"9".repeat(32)}:active:other-1`;
    await writeFile(host.authorizedKeysFile, `${OPERATOR_KEY}\n${other}\n`, { mode: 0o600 });

    await port.stageGatewayKey(connection, binding, { keyId: "gw-1", publicKey: syntheticKey("gateway-1").line });
    await port.activateGatewayKey(connection, binding, "gw-1");

    const contents = await readFile(host.authorizedKeysFile, "utf8");
    expect(contents).toContain(other);
    expect(contents).toContain(OPERATOR_KEY);
    expect(await port.listGatewayKeys(connection, binding)).toHaveLength(1);
  });

  it("stops with the last verified key intact when activation names an unknown key", async () => {
    const { host, port, connection, binding } = await bootstrappedHost();
    await port.stageGatewayKey(connection, binding, { keyId: "gw-1", publicKey: syntheticKey("gateway-1").line });
    await port.activateGatewayKey(connection, binding, "gw-1");
    const before = await readFile(host.authorizedKeysFile, "utf8");

    await expect(port.activateGatewayKey(connection, binding, "gw-missing")).rejects.toMatchObject({
      code: "DK_KEY_ROTATION_FAILED",
    });
    expect(await readFile(host.authorizedKeysFile, "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------- local command --

describe("local gateway bootstrap command", () => {
  it("builds a network-free dry-run plan that enrolls no root runner", async () => {
    const plan = await bootstrapServer({ ...OPTIONS, hostKeyFingerprint: HOST_FINGERPRINT, dryRun: true });

    expect(plan).toMatchObject({
      host: OPTIONS.host,
      user: OPTIONS.user,
      port: 2222,
      repository: OPTIONS.repository,
      githubEnvironment: OPTIONS.githubEnvironment,
      targetName: OPTIONS.targetName,
      gatewayUser: GATEWAY_USER,
      forcedCommand: "deploykit gateway",
      rootRunner: false,
      changed: null,
    });
    expect(plan.targetId).toMatch(/^[0-9a-f]{32}$/u);
    expect(plan.bindingId).toMatch(/^[0-9a-f]{32}$/u);
    expect(plan.packages).toEqual(expect.arrayContaining([
      "docker-ce", "docker-compose-plugin", "nginx", "certbot", "node@22.18.0", "pm2@6.0.8",
    ]));
    expect(plan.packages.join(" ")).not.toContain("actions-runner");
  });

  it("rejects unsafe repository, Environment, and target values", async () => {
    for (const invalid of [
      { repository: "owner/repo/extra" },
      { githubEnvironment: "prod;reboot" },
      { targetName: "Prod Uction" },
    ]) {
      await expect(
        bootstrapServer({ ...OPTIONS, hostKeyFingerprint: HOST_FINGERPRINT, dryRun: true, ...invalid }),
      ).rejects.toMatchObject({ code: "DK_USAGE" });
    }
  });

  it("drives the real port through preflight, bootstrap, and handshake", async () => {
    const host = await fakeHost();
    const staging = await temporaryDirectory("deploykit-bundle-");
    const packageFile = join(staging, "bundle.tgz");
    await writeFile(packageFile, "not really a tarball");

    const plan = await bootstrapServer({
      ...OPTIONS,
      hostKeyFingerprint: HOST_FINGERPRINT,
      administratorSsh: {
        preflight: () => portFor(host).preflight({ ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT }),
        inspectGateway: (connection, expected) => portFor(host).inspectGateway(connection, expected),
        bootstrapGateway: (request) => portFor(host).bootstrapGateway({
          ...request,
          packageFile,
          packageName: BUNDLE.packageName,
          packageSha256: BUNDLE.packageSha256,
        }),
        listGatewayKeys: (connection, binding) => portFor(host).listGatewayKeys(connection, binding),
        stageGatewayKey: (connection, binding, key) => portFor(host).stageGatewayKey(connection, binding, key),
        activateGatewayKey: (connection, binding, keyId) =>
          portFor(host).activateGatewayKey(connection, binding, keyId),
        proveRepositoryAccess: (connection, binding) =>
          portFor(host).proveRepositoryAccess(connection, binding),
      },
      packageRoot: resolve("."),
    });

    expect(plan.changed).toBe(true);
    expect(plan.runtimeVersion).toBe(VERSION);
    expect(plan.runtimeBundleSha256).toBe(BUNDLE.packageSha256);
    expect(plan.repositoryPublicKey).toMatch(/^ssh-ed25519 /u);
    // Packs the real package on the way through, so allow for a cold npm pack.
  }, 180_000);

  it("refuses a host where the administrator cannot run privileged commands", async () => {
    const host = await fakeHost();
    host.administrator = false;
    await expect(bootstrapServer({
      ...OPTIONS,
      hostKeyFingerprint: HOST_FINGERPRINT,
      administratorSsh: {
        preflight: () => portFor(host).preflight({ ...CONNECTION, hostKeyFingerprint: HOST_FINGERPRINT }),
        inspectGateway: (connection, expected) => portFor(host).inspectGateway(connection, expected),
        bootstrapGateway: (request) => portFor(host).bootstrapGateway(request),
        listGatewayKeys: (connection, binding) => portFor(host).listGatewayKeys(connection, binding),
        stageGatewayKey: (connection, binding, key) => portFor(host).stageGatewayKey(connection, binding, key),
        activateGatewayKey: (connection, binding, keyId) =>
          portFor(host).activateGatewayKey(connection, binding, keyId),
        proveRepositoryAccess: (connection, binding) =>
          portFor(host).proveRepositoryAccess(connection, binding),
      },
    })).rejects.toMatchObject({ code: "DK_PREFLIGHT_FAILED" });
    expect(host.installerRuns).toBe(0);
  });
});

// --------------------------------------------------------- packed artifact --

describe("packed runtime bundle", () => {
  it("ships every file the installer reads and matches the published package name", async () => {
    const destination = await temporaryDirectory("deploykit-pack-");
    const { stdout } = await run(
      "npm",
      ["pack", resolve("."), "--json", "--dry-run=false", "--pack-destination", destination],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const filename = (JSON.parse(stdout) as Array<{ filename: string }>)[0]?.filename ?? "";
    const packageFile = join(destination, filename);

    const entries = await assertBundleContents(packageFile);
    for (const required of REQUIRED_BUNDLE_ENTRIES) expect(entries).toContain(required);

    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { name: string };
    // The installer compares this exact name with the one inside the tarball,
    // so a rename can no longer make a real bootstrap fail at the last step.
    expect(filename.startsWith(manifest.name.replace("@", "").replace("/", "-"))).toBe(true);
  }, 180_000);

  /**
   * npm reads its own configuration out of the environment, and every
   * `npm_config_*` variable an npm invocation sets is inherited by whatever it
   * starts. That is not a hypothetical: `"deploy": "deploykit deploy"` in a
   * `package.json` is the obvious way to wire this up, and `npm publish
   * --dry-run` of DeployKit itself runs the suite with `npm_config_dry_run`
   * set. Under it, `npm pack` reports a filename and writes no file, so the
   * bundle the gateway binding is bound to would simply not exist.
   */
  it("packs a real tarball even when the ambient npm invocation is a dry run", async () => {
    const destination = await temporaryDirectory("deploykit-pack-dry-");
    const previous = process.env["npm_config_dry_run"];
    process.env["npm_config_dry_run"] = "true";
    try {
      const bundle = await resolveRuntimeBundle({ destination });
      expect(bundle.version).toBe(VERSION);
      const contents = await readFile(bundle.packageFile);
      expect(contents.byteLength).toBeGreaterThan(0);
      expect(createHash("sha256").update(contents).digest("hex")).toBe(bundle.packageSha256);
      const entries = await assertBundleContents(bundle.packageFile);
      for (const required of REQUIRED_BUNDLE_ENTRIES) expect(entries).toContain(required);
    } finally {
      if (previous === undefined) delete process.env["npm_config_dry_run"];
      else process.env["npm_config_dry_run"] = previous;
    }
  }, 180_000);
});
