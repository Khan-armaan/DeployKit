import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { assertPinnedGitHubKnownHosts } from "../src/gateway/github-known-hosts.js";

const run = promisify(execFile);

const INSTALLER = resolve("assets/bootstrap.sh");
const BINDING_HELPER = resolve("assets/gateway-binding.sh");
const KEYS_HELPER = resolve("assets/gateway-keys.sh");

const BINDING_ID = "13a5ce1e444db74a784f1c1e9c205703";
const TARGET_ID = "04809ce707a77a199e6b989440139ba0";
const BUNDLE_SHA = "4d6d152facae078ff01608c5deb012c4918c88f8b3c0cd67ffbeae780014069c";
const FINGERPRINT = "SHA256:WrWiDJlWe5pJXx4dzaaakNj+HDYZejeHxczLZ5HE4RM";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "deploykit-installer-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function bindingArgs(file: string, overrides: Record<string, string> = {}): string[] {
  const values: Record<string, string> = {
    "--file": file,
    "--repository": "deploykit-fixtures/static-compose",
    "--github-environment": "fixture-static-production",
    "--target-name": "production",
    "--target-id": TARGET_ID,
    "--binding-id": BINDING_ID,
    "--runtime-version": "0.1.3",
    "--runtime-bundle-sha256": BUNDLE_SHA,
    "--repository-key-id": `deploykit-repository-${TARGET_ID}`,
    "--repository-key-fingerprint": FINGERPRINT,
    ...overrides,
  };
  return Object.entries(values).flatMap(([flag, value]) => [flag, value]);
}

async function bash(script: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await run("bash", [script, ...args]);
    return { stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", exitCode: failure.code ?? 1 };
  }
}

describe("Ubuntu gateway installer", () => {
  it("has valid Bash syntax", () => {
    for (const script of [INSTALLER, BINDING_HELPER, KEYS_HELPER]) {
      expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
    }
  });

  it("installs no Actions Runner package, token, hook, or service", async () => {
    const source = await readFile(INSTALLER, "utf8");

    for (const trace of [
      "actions-runner",
      "actions/runner",
      "RUNNER_ALLOW_RUNASROOT",
      "ACTIONS_RUNNER_HOOK_JOB_STARTED",
      "registration-token",
      "svc.sh",
      "config.sh",
      "--disableupdate",
    ]) {
      expect(source).not.toContain(trace);
    }
    expect(source).not.toContain("runner registration token is required on stdin");
  });

  it("keeps every retained provisioning and verification check", async () => {
    const source = await readFile(INSTALLER, "utf8");

    expect(source).toContain('DEPLOYKIT_MIN_COMPOSE_VERSION="2.24.4"');
    expect(source).toContain('dpkg --compare-versions "$DEPLOYKIT_COMPOSE_VERSION" ge "$DEPLOYKIT_MIN_COMPOSE_VERSION"');
    expect(source).toContain('DEPLOYKIT_NODE_VERSION="22.18.0"');
    expect(source).toContain('DEPLOYKIT_PM2_VERSION="6.0.8"');
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain("dist/server-cli.cjs");
    expect(source).toContain(".package-sha256");
    expect(source).toContain('DEPLOYKIT_PM2_ROOT="/opt/deploykit/pm2/${DEPLOYKIT_PM2_VERSION}"');
    expect(source).not.toContain('npm install --global "pm2@');
    expect(source).toContain("if ! nginx -t; then");
    expect(source).toContain("the previous configuration was restored");
    expect(source).toContain("systemctl enable --now certbot.timer");
    expect(source).toContain("could not discover a public server address");
    expect(source).toContain("install -d -m 0700 /etc/deploykit /etc/deploykit/targets /etc/deploykit/gateway");
  });

  it("compares the package name it was given with the name inside the tarball", async () => {
    const source = await readFile(INSTALLER, "utf8");

    expect(source).not.toContain("@project/deploykit");
    expect(source).toContain('[[ "$DEPLOYKIT_CLI_NAME" == "$DEPLOYKIT_PACKAGE_NAME" ]]');
  });

  it("gives the gateway account no shell, no docker membership, and one no-argument sudo entry", async () => {
    const source = await readFile(INSTALLER, "utf8");

    expect(source).toContain("--shell /usr/sbin/nologin");
    expect(source).toContain('passwd --lock "$DEPLOYKIT_GATEWAY_USER"');
    expect(source).toContain("must not be a member of the docker group");
    expect(source).not.toContain("usermod -aG docker");
    expect(source).toContain('${DEPLOYKIT_GATEWAY_USER} ALL=(root:root) NOPASSWD: ${DEPLOYKIT_GATEWAY_ENTRY} ""');
    expect(source).toContain('visudo -cqf "$DEPLOYKIT_SUDOERS_TMP"');
    // env_reset would strip the SSH_* variables the forced command inspects to
    // refuse a client command, a PTY, and forwarded channels.
    expect(source).toContain('env_keep += "SSH_ORIGINAL_COMMAND SSH_TTY SSH_AUTH_SOCK DISPLAY XAUTHORITY"');
    expect(source).toContain("exec /usr/local/bin/deploykit gateway");
  });

  it("keeps the repository private key owner-only and stable across reruns", async () => {
    const source = await readFile(INSTALLER, "utf8");

    expect(source).toContain('if [[ ! -f "$DEPLOYKIT_REPOSITORY_KEY" ]]; then');
    expect(source).toContain('ssh-keygen -q -t ed25519 -N "" -C "$DEPLOYKIT_REPOSITORY_KEY_ID"');
    expect(source).toContain('chmod 0600 "$DEPLOYKIT_REPOSITORY_KEY"');
    expect(source).toContain('install -m 0600 -o "$DEPLOYKIT_GATEWAY_USER"');
  });

  it("installs the packaged GitHub host keys rather than fetching them", async () => {
    const source = await readFile(INSTALLER, "utf8");

    expect(source).toContain('install -m 0644 -o root -g root "$DEPLOYKIT_CLI_ROOT/assets/github-known-hosts"');
    expect(source).toContain("does not contain the pinned GitHub host keys");
    await assertPinnedGitHubKnownHosts(await readFile("assets/github-known-hosts", "utf8"), "assets/github-known-hosts");
  });

  it("opens the administrator SSH port before enabling the firewall", async () => {
    const source = await readFile(INSTALLER, "utf8");
    const guard = source.indexOf('if [[ "$DEPLOYKIT_FIREWALL" -eq 1 ]]');
    const sshPort = source.indexOf('ufw allow "${DEPLOYKIT_SSH_PORT}/tcp"');
    const enable = source.indexOf("ufw --force enable");

    expect(guard).toBeGreaterThan(0);
    expect(sshPort).toBeGreaterThan(guard);
    expect(enable).toBeGreaterThan(sshPort);
  });

  it("reports only nonsecret facts on stdout", async () => {
    const source = await readFile(INSTALLER, "utf8");
    const result = source.slice(source.indexOf("--arg repositoryPublicKey"));

    expect(result).toContain("$DEPLOYKIT_REPOSITORY_PUBLIC_KEY");
    expect(result).toContain("DEPLOYKIT_BOOTSTRAP_RESULT");
    // Only the public half and its fingerprint are ever emitted.
    expect(result).not.toContain('"$DEPLOYKIT_REPOSITORY_KEY"');
    // Progress goes to stderr so it can never be mistaken for the result line.
    expect(source).toContain('log() { echo "[deploykit bootstrap] $*" >&2; }');
  });
});

describe("root-owned binding reconciliation", () => {
  it("writes the frozen contract shape once and reconciles it as a no-op", async () => {
    const directory = await workspace();
    const file = join(directory, "binding.json");

    expect(await bash(BINDING_HELPER, bindingArgs(file))).toMatchObject({ stdout: '{"changed":true}\n' });
    expect(await bash(BINDING_HELPER, bindingArgs(file))).toMatchObject({ stdout: '{"changed":false}\n' });

    const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual([
      "apiVersion", "bindingId", "repository", "githubEnvironment", "targetName", "targetId",
      "gatewayUser", "forcedCommand", "runtimeVersion", "runtimeBundleSha256",
      "repositoryKeyId", "repositoryKeyFingerprint", "activeGatewayKeyId", "pendingGatewayKeyId",
    ]);
    expect(document).toMatchObject({
      apiVersion: "deploykit/gateway-binding/v1alpha1",
      gatewayUser: "deploykit-gateway",
      forcedCommand: "deploykit gateway",
      activeGatewayKeyId: null,
      pendingGatewayKeyId: null,
    });
    expect((await stat(file)).mode & 0o022).toBe(0);
  });

  it("refuses to repoint an existing host and leaves the binding untouched", async () => {
    const directory = await workspace();
    const file = join(directory, "binding.json");
    await bash(BINDING_HELPER, bindingArgs(file));
    const before = await readFile(file, "utf8");

    const conflicts: Record<string, string>[] = [
      { "--repository": "someone-else/app" },
      { "--target-name": "staging" },
      { "--target-id": "f".repeat(32) },
      { "--github-environment": "other" },
      { "--binding-id": "e".repeat(32) },
    ];
    for (const conflict of conflicts) {
      // Exit 4 is the frozen DK_GATEWAY_BINDING_MISMATCH exit code.
      expect(await bash(BINDING_HELPER, bindingArgs(file, conflict))).toMatchObject({ exitCode: 4 });
    }
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("preserves host-owned key lifecycle state across a runtime upgrade", async () => {
    const directory = await workspace();
    const file = join(directory, "binding.json");
    await bash(BINDING_HELPER, bindingArgs(file));

    const document = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, `${JSON.stringify({ ...document, activeGatewayKeyId: "gw-2", pendingGatewayKeyId: "gw-3" }, null, 2)}\n`);
    await bash(BINDING_HELPER, bindingArgs(file, { "--runtime-version": "0.2.0" }));

    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      runtimeVersion: "0.2.0",
      activeGatewayKeyId: "gw-2",
      pendingGatewayKeyId: "gw-3",
    });
  });
});

describe("gateway authorized_keys helper", () => {
  const OPERATOR = "ssh-ed25519 AAAAOPERATORKEY operator@laptop";
  const KEY_ONE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGATEWAYONEKEYMATERIAL000000000000000";
  const KEY_TWO = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGATEWAYTWOKEYMATERIAL000000000000000";

  async function keysWorkspace() {
    const directory = await workspace();
    const authorized = join(directory, "authorized_keys");
    await writeFile(authorized, `${OPERATOR}\n`, { mode: 0o600 });
    const one = join(directory, "one.pub");
    const two = join(directory, "two.pub");
    await writeFile(one, `${KEY_ONE} gw-1\n`);
    await writeFile(two, `${KEY_TWO} gw-2\n`);
    return { authorized, one, two, base: ["--authorized-keys", authorized, "--binding-id", BINDING_ID] };
  }

  it("writes a restricted forced-command entry and nothing else", async () => {
    const { authorized, one, base } = await keysWorkspace();
    await bash(KEYS_HELPER, [...base, "stage", "--key-id", "gw-1", "--public-key-file", one]);
    await bash(KEYS_HELPER, [...base, "activate", "--key-id", "gw-1"]);

    const contents = await readFile(authorized, "utf8");
    const entry = contents.split("\n").find((line) => line.includes("deploykit-gateway:")) ?? "";
    expect(entry.startsWith("restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding,")).toBe(true);
    expect(entry).toContain('command="/usr/bin/sudo -n /usr/local/lib/deploykit/gateway-entry"');
    expect(entry.endsWith(`deploykit-gateway:${BINDING_ID}:active:gw-1`)).toBe(true);
    expect(contents).toContain(OPERATOR);
    expect((await stat(authorized)).mode & 0o777).toBe(0o600);
  });

  it("keeps one usable key through an interruption at every rotation step", async () => {
    const { authorized, one, two, base } = await keysWorkspace();
    const owned = async () => {
      const { stdout } = await bash(KEYS_HELPER, [...base, "list"]);
      return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { state: string; keyId: string });
    };

    await bash(KEYS_HELPER, [...base, "stage", "--key-id", "gw-1", "--public-key-file", one]);
    expect(await owned()).toEqual([{ state: "pending", keyId: "gw-1", type: "ssh-ed25519", key: KEY_ONE.split(" ")[1] }]);

    await bash(KEYS_HELPER, [...base, "activate", "--key-id", "gw-1"]);
    await bash(KEYS_HELPER, [...base, "stage", "--key-id", "gw-2", "--public-key-file", two]);
    // Interrupted mid-rotation: the proven key is still active and the
    // replacement is staged, so either side can be activated on the rerun.
    expect((await owned()).map((entry) => `${entry.state}:${entry.keyId}`).sort())
      .toEqual(["active:gw-1", "pending:gw-2"]);

    await bash(KEYS_HELPER, [...base, "activate", "--key-id", "gw-2"]);
    expect(await owned()).toEqual([expect.objectContaining({ state: "active", keyId: "gw-2" })]);
    expect(await readFile(authorized, "utf8")).toContain(OPERATOR);

    // A pruned rerun after a completed rotation cannot leave the host keyless.
    await bash(KEYS_HELPER, [...base, "prune"]);
    expect(await owned()).toEqual([expect.objectContaining({ state: "active", keyId: "gw-2" })]);
  });

  it("never rewrites an entry owned by another binding", async () => {
    const { authorized, one, base } = await keysWorkspace();
    const other = `restrict,command="x" ssh-ed25519 AAAAOTHER deploykit-gateway:${"9".repeat(32)}:active:other-1`;
    await writeFile(authorized, `${OPERATOR}\n${other}\n`, { mode: 0o600 });

    await bash(KEYS_HELPER, [...base, "stage", "--key-id", "gw-1", "--public-key-file", one]);
    await bash(KEYS_HELPER, [...base, "activate", "--key-id", "gw-1"]);

    const contents = await readFile(authorized, "utf8");
    expect(contents).toContain(other);
    expect(contents).toContain(OPERATOR);
  });

  it("stages a key delivered on stdin, which is a pipe it may read only once", async () => {
    const { authorized, base } = await keysWorkspace();
    const staged = await new Promise<number>((resolvePromise) => {
      const child = spawn("bash", [KEYS_HELPER, ...base, "stage", "--key-id", "gw-1", "--public-key-file", "-"]);
      child.once("close", (code) => { resolvePromise(code ?? 1); });
      child.stdin.end(`${KEY_ONE} gw-1\n`);
    });

    expect(staged).toBe(0);
    const contents = await readFile(authorized, "utf8");
    expect(contents).toContain(`${KEY_ONE} deploykit-gateway:${BINDING_ID}:pending:gw-1`);
    expect(contents).toContain(OPERATOR);
  });

  it("refuses an unknown key and a malformed public key without touching the file", async () => {
    const { authorized, one, base } = await keysWorkspace();
    await bash(KEYS_HELPER, [...base, "stage", "--key-id", "gw-1", "--public-key-file", one]);
    await bash(KEYS_HELPER, [...base, "activate", "--key-id", "gw-1"]);
    const before = await readFile(authorized, "utf8");

    expect(await bash(KEYS_HELPER, [...base, "activate", "--key-id", "gw-missing"])).toMatchObject({ exitCode: 9 });

    const hostile = join(resolve(authorized, ".."), "hostile.pub");
    await writeFile(hostile, "ssh-ed25519 not+valid+base64!! gw-9\n");
    expect(await bash(KEYS_HELPER, [...base, "stage", "--key-id", "gw-9", "--public-key-file", hostile]))
      .toMatchObject({ exitCode: 2 });
    expect(await readFile(authorized, "utf8")).toBe(before);
  });
});
