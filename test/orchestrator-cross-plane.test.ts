import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_USER,
  MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
  type GatewayInputFrame,
  type GatewayOutputFrame,
  type RequestId,
  type RootOwnedGatewayBinding,
  type Sha256Hex,
} from "../src/orchestrator/contracts.js";
import {
  createAdministratorSshPort,
  parseSourceProbeResult,
  type AdministratorRunRequest,
  type AdministratorRunResult,
  type GatewayKeyEntry,
  type GatewayKeyLifecyclePort,
} from "../src/orchestrator/administrator-ssh.js";
import type {
  AdministratorSshConnection,
  DesiredGitHubEnvironment,
  DesiredRepositoryDeployKey,
  GatewayExchange,
  GatewayTransportPort,
} from "../src/orchestrator/dependencies.js";
import {
  BOOKKEEPING_VARIABLES,
  GENERATED_SECRETS_VARIABLE,
  MANAGED_DIGEST_VARIABLE,
  MANAGED_SECRETS_VARIABLE,
  MANAGED_VARIABLES_VARIABLE,
  createEnvironmentReconciler,
  createRepositoryDeployKeyReconciler,
  publicKeyFingerprint,
} from "../src/orchestrator/github-environment.js";
import {
  createGatewayKeyRotator,
  inspectGatewayKeyState,
  type GatewayKeyPairGenerator,
} from "../src/orchestrator/gateway-keys.js";
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubRunRequest,
  type GitHubRunResult,
} from "../src/orchestrator/github.js";

const execFileAsync = promisify(execFile);

const PROBE = resolve("assets/gateway-source-probe.sh");
const REPOSITORY = "acme/app";
const ENVIRONMENT = "production";
const TARGET_ID = "04809ce707a77a199e6b989440139ba0";
const BINDING_ID = "13a5ce1e444db74a784f1c1e9c205703";
const KEY_TITLE = `DeployKit repository key: ${TARGET_ID}`;
const DIGEST = "a".repeat(64) as Sha256Hex;
const OTHER_DIGEST = "b".repeat(64) as Sha256Hex;

/** Every test asserts this string never reaches an argument, a file, or a log. */
const SECRET_CANARY = "DK_CANARY_BACKEND_VALUE_71b0ce";
const GATEWAY_KEY_CANARY = "DK_CANARY_GATEWAY_PRIVATE_KEY_9f13ab";

const BINDING: RootOwnedGatewayBinding = {
  apiVersion: "deploykit/gateway-binding/v1alpha1",
  bindingId: BINDING_ID,
  repository: REPOSITORY,
  githubEnvironment: ENVIRONMENT,
  targetName: "production",
  targetId: TARGET_ID,
  gatewayUser: GATEWAY_USER,
  forcedCommand: "deploykit gateway",
  runtimeVersion: "0.1.3",
  runtimeBundleSha256: "c".repeat(64) as Sha256Hex,
  repositoryKeyId: `deploykit-repository-${TARGET_ID}`,
  repositoryKeyFingerprint: "SHA256:WrWiDJlWe5pJXx4dzaaakNj+HDYZejeHxczLZ5HE4RM",
  activeGatewayKeyId: null,
  pendingGatewayKeyId: null,
};

const CONNECTION: AdministratorSshConnection = {
  host: "vps.example.com",
  user: "ubuntu",
  port: 22,
  identityFile: "/home/operator/.ssh/id_ed25519",
  hostKeyFingerprint: "SHA256:WrWiDJlWe5pJXx4dzaaakNj+HDYZejeHxczLZ5HE4RM",
};

const directories: string[] = [];

async function workspace(prefix = "deploykit-cross-plane-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// --------------------------------------------------------------- gh double --

interface DeployKeyRecord {
  readonly id: number;
  readonly title: string;
  readonly key: string;
  readonly readOnly: boolean;
}

/**
 * An in-memory GitHub driven through the *real* `gh` client, so every argv, the
 * stdin-only secret path, and the bounded pagination are exercised rather than
 * stubbed away.
 */
class FakeGitHubHost {
  readonly calls: GitHubRunRequest[] = [];
  environments = new Map<string, { reviewers: string[]; waitTimerMinutes: number; protectedBranchesOnly: boolean }>();
  variables = new Map<string, string>();
  secrets = new Map<string, string>();
  deployKeys: DeployKeyRecord[] = [];
  nextKeyId = 100;
  failNextSecretWrite: string | null = null;
  failNextVariableWrite: string | null = null;

  client(): GitHubClient {
    return createGitHubClient({
      runner: { run: (request) => this.run(request) },
      sleep: async () => undefined,
    });
  }

  /** Every argument and every stdin payload the client ever handed to `gh`. */
  arguments(): string[] {
    return this.calls.flatMap((call) => [...call.args]);
  }

  private json(value: unknown): GitHubRunResult {
    return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
  }

  private notFound(): GitHubRunResult {
    return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
  }

  private environmentBody(name: string): unknown {
    const protection = this.environments.get(name);
    if (protection === undefined) return undefined;
    return {
      name,
      protection_rules: [
        ...(protection.waitTimerMinutes > 0
          ? [{ type: "wait_timer", wait_timer: protection.waitTimerMinutes }]
          : []),
        ...(protection.reviewers.length > 0
          ? [{
              type: "required_reviewers",
              reviewers: protection.reviewers.map((entry) => ({
                type: entry.startsWith("team:") ? "Team" : "User",
                reviewer: entry.startsWith("team:")
                  ? { slug: entry.slice(5) }
                  : { login: entry.slice(5) },
              })),
            }]
          : []),
      ],
      deployment_branch_policy: protection.protectedBranchesOnly
        ? { protected_branches: true, custom_branch_policies: false }
        : null,
    };
  }

  async run(request: GitHubRunRequest): Promise<GitHubRunResult> {
    this.calls.push(request);
    const args = request.args;
    const verb = args[0] ?? "";

    if (verb === "variable" || verb === "secret") {
      const action = args[1] ?? "";
      const name = args[2] ?? "";
      const store = verb === "variable" ? this.variables : this.secrets;
      if (action === "set") {
        const failing = verb === "variable" ? this.failNextVariableWrite : this.failNextSecretWrite;
        if (failing === name) {
          if (verb === "variable") this.failNextVariableWrite = null;
          else this.failNextSecretWrite = null;
          return { stdout: "", stderr: "gh: Internal Server Error (HTTP 500)", exitCode: 1 };
        }
        store.set(name, request.input ?? "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (action === "delete") {
        if (!store.delete(name)) return this.notFound();
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return this.notFound();
    }

    if (verb !== "api") return this.notFound();
    const methodIndex = args.indexOf("--method");
    const method = methodIndex >= 0 ? args[methodIndex + 1] ?? "GET" : "GET";
    const endpoint = (args[args.length - 1] ?? "").split("?")[0] ?? "";
    const page = Number(/[?&]page=(\d+)/u.exec(args[args.length - 1] ?? "")?.[1] ?? "1");

    const environmentPath = `repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
    if (endpoint === environmentPath) {
      if (method === "GET") {
        const body = this.environmentBody(ENVIRONMENT);
        return body === undefined ? this.notFound() : this.json(body);
      }
      if (method === "PUT") {
        if (!this.environments.has(ENVIRONMENT)) {
          this.environments.set(ENVIRONMENT, { reviewers: [], waitTimerMinutes: 0, protectedBranchesOnly: false });
        }
        return this.json(this.environmentBody(ENVIRONMENT));
      }
    }
    if (endpoint === `${environmentPath}/variables` && method === "GET") {
      const variables = page > 1
        ? []
        : [...this.variables].map(([name, value]) => ({ name, value }));
      return this.json({ total_count: variables.length, variables });
    }
    if (endpoint === `${environmentPath}/secrets` && method === "GET") {
      const secrets = page > 1 ? [] : [...this.secrets.keys()].map((name) => ({ name }));
      return this.json({ total_count: secrets.length, secrets });
    }
    if (endpoint === `repos/${REPOSITORY}/keys`) {
      if (method === "GET") {
        return this.json(page > 1
          ? []
          : this.deployKeys.map((key) => ({ id: key.id, title: key.title, key: key.key, read_only: key.readOnly })));
      }
      if (method === "POST") {
        const body = JSON.parse(request.input ?? "{}") as { key: string; title: string; read_only: boolean };
        const created = { id: this.nextKeyId++, title: body.title, key: body.key, readOnly: body.read_only };
        this.deployKeys.push(created);
        return this.json({ id: created.id, title: created.title, key: created.key, read_only: created.readOnly });
      }
    }
    const keyMatch = new RegExp(`^repos/${REPOSITORY}/keys/(\\d+)$`, "u").exec(endpoint);
    if (keyMatch !== null && method === "DELETE") {
      const id = Number(keyMatch[1]);
      const before = this.deployKeys.length;
      this.deployKeys = this.deployKeys.filter((key) => key.id !== id);
      return before === this.deployKeys.length ? this.notFound() : this.json({});
    }
    return this.notFound();
  }
}

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJHEQ0BvWLBnpxPVjSTKhkbVFtu1gvGRCFAisSFxrKJt";
const OTHER_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEeZ8yYxSjKGDLAdKKgJb1AtRRnjLZE7tvY0pu4/T7hc";

function desiredKey(publicKey = PUBLIC_KEY): DesiredRepositoryDeployKey {
  return {
    repository: REPOSITORY,
    title: KEY_TITLE,
    publicKey,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    readOnly: true,
  };
}

function desiredEnvironment(overrides: Partial<DesiredGitHubEnvironment> = {}): DesiredGitHubEnvironment {
  return {
    repository: REPOSITORY,
    environment: ENVIRONMENT,
    targetId: TARGET_ID,
    variables: {
      DEPLOYKIT_GATEWAY_HOST: CONNECTION.host,
      DEPLOYKIT_GATEWAY_PORT: "22",
      DEPLOYKIT_GATEWAY_USER: GATEWAY_USER,
      DEPLOYKIT_GATEWAY_KNOWN_HOSTS: "vps.example.com ssh-ed25519 AAAA",
      DEPLOYKIT_TARGET_ID: TARGET_ID,
      NEXT_PUBLIC_API_URL: "https://app.example.com/api",
    },
    secrets: {
      CERTBOT_EMAIL: SECRET_CANARY,
      [MANAGED_GATEWAY_PRIVATE_KEY_SECRET]: GATEWAY_KEY_CANARY,
    },
    generatedSecretNames: ["POSTGRES_PASSWORD"],
    managedResourceDigest: DIGEST,
    ...overrides,
  };
}

// ------------------------------------------------------------- deploy keys --

describe("read-only repository deploy key", () => {
  it("registers the VPS public key read-only and is a no-op on rerun", async () => {
    const host = new FakeGitHubHost();
    const reconciler = createRepositoryDeployKeyReconciler({ client: host.client() });

    expect(await reconciler.inspect(desiredKey())).toMatchObject({ status: "missing", keyId: null });

    const created = await reconciler.reconcile(desiredKey());
    expect(created).toMatchObject({
      status: "current",
      readOnly: true,
      title: KEY_TITLE,
      publicKeyFingerprint: publicKeyFingerprint(PUBLIC_KEY),
    });
    expect(host.deployKeys).toHaveLength(1);
    // `read_only: true` is not negotiable; it travels in the creation body.
    expect(host.calls.some((call) => (call.input ?? "").includes('"read_only":true'))).toBe(true);

    const writes = host.calls.length;
    const again = await reconciler.reconcile(desiredKey());
    expect(again).toEqual(created);
    expect(host.deployKeys).toHaveLength(1);
    // A rerun reads; it must not create a second key.
    expect(host.calls.slice(writes).every((call) => call.args.includes("GET"))).toBe(true);
  });

  it("rotates a key it owns and never a key it does not", async () => {
    const host = new FakeGitHubHost();
    const reconciler = createRepositoryDeployKeyReconciler({ client: host.client() });
    host.deployKeys.push({ id: 7, title: KEY_TITLE, key: OTHER_PUBLIC_KEY, readOnly: true });
    host.deployKeys.push({ id: 8, title: "operator laptop", key: PUBLIC_KEY.replace("JHEQ", "ZZZZ"), readOnly: false });

    const rotated = await reconciler.reconcile(desiredKey());
    expect(rotated.publicKeyFingerprint).toBe(publicKeyFingerprint(PUBLIC_KEY));
    expect(host.deployKeys.map((key) => key.title)).toEqual(["operator laptop", KEY_TITLE]);
  });

  it("refuses every ambiguous claim rather than deleting a key", async () => {
    const cases: readonly (readonly DeployKeyRecord[])[] = [
      // Two keys wearing DeployKit's title.
      [
        { id: 1, title: KEY_TITLE, key: PUBLIC_KEY, readOnly: true },
        { id: 2, title: KEY_TITLE, key: OTHER_PUBLIC_KEY, readOnly: true },
      ],
      // A DeployKit key that somehow has write access.
      [{ id: 3, title: KEY_TITLE, key: PUBLIC_KEY, readOnly: false }],
      // A foreign key holding the material DeployKit is about to register.
      [{ id: 4, title: "someone else", key: PUBLIC_KEY, readOnly: true }],
    ];
    for (const keys of cases) {
      const host = new FakeGitHubHost();
      host.deployKeys = [...keys];
      const reconciler = createRepositoryDeployKeyReconciler({ client: host.client() });
      expect(await reconciler.inspect(desiredKey())).toMatchObject({ status: "conflict" });
      await expect(reconciler.reconcile(desiredKey())).rejects.toMatchObject({
        code: "DK_OWNERSHIP_CONFLICT",
      });
      expect(host.deployKeys).toEqual(keys);
    }
  });
});

// ------------------------------------------------------------- environment --

describe("target GitHub Environment", () => {
  it("creates the Environment, writes every managed value, and settles on current", async () => {
    const host = new FakeGitHubHost();
    const reconciler = createEnvironmentReconciler({ client: host.client() });
    const desired = desiredEnvironment();

    expect(await reconciler.inspect(desired)).toMatchObject({ status: "missing", managedResourceDigest: null });

    const state = await reconciler.reconcile(desired);
    expect(state.status).toBe("current");
    expect(state.managedResourceDigest).toBe(DIGEST);
    expect(state.generatedSecretNames).toEqual(["POSTGRES_PASSWORD"]);
    expect([...host.secrets.keys()].sort()).toEqual([
      MANAGED_GATEWAY_PRIVATE_KEY_SECRET,
      "CERTBOT_EMAIL",
    ].sort());
    for (const name of BOOKKEEPING_VARIABLES) expect(host.variables.has(name)).toBe(true);
    expect(host.variables.get(MANAGED_SECRETS_VARIABLE)).toBe(
      [MANAGED_GATEWAY_PRIVATE_KEY_SECRET, "CERTBOT_EMAIL"].sort().join(","),
    );
    expect(host.variables.get(GENERATED_SECRETS_VARIABLE)).toBe("POSTGRES_PASSWORD");
    expect(host.variables.get(MANAGED_VARIABLES_VARIABLE)?.split(",")).toContain("NEXT_PUBLIC_API_URL");

    const before = host.calls.length;
    expect(await reconciler.inspect(desired)).toMatchObject({ status: "current" });
    // Inspection reads and never writes.
    expect(host.calls.slice(before).every((call) => call.args[0] === "api")).toBe(true);
  });

  it("sends secret values on stdin and never in an argument", async () => {
    const host = new FakeGitHubHost();
    await createEnvironmentReconciler({ client: host.client() }).reconcile(desiredEnvironment());

    const argv = host.arguments().join(" ");
    expect(argv).not.toContain(SECRET_CANARY);
    expect(argv).not.toContain(GATEWAY_KEY_CANARY);
    // The values did arrive — on stdin, through `gh secret set`.
    expect(host.secrets.get("CERTBOT_EMAIL")).toBe(SECRET_CANARY);
    expect(host.secrets.get(MANAGED_GATEWAY_PRIVATE_KEY_SECRET)).toBe(GATEWAY_KEY_CANARY);
    const secretWrites = host.calls.filter((call) => call.args[0] === "secret" && call.args[1] === "set");
    expect(secretWrites).toHaveLength(2);
    expect(secretWrites.every((call) => call.input !== undefined)).toBe(true);
  });

  it("preserves reviewers, wait timers, and branch restrictions", async () => {
    const host = new FakeGitHubHost();
    host.environments.set(ENVIRONMENT, {
      reviewers: ["user:release-manager", "team:platform"],
      waitTimerMinutes: 30,
      protectedBranchesOnly: true,
    });
    const state = await createEnvironmentReconciler({ client: host.client() }).reconcile(desiredEnvironment());

    expect(state.protection).toEqual({
      reviewers: ["user:release-manager", "team:platform"],
      waitTimerMinutes: 30,
      protectedBranchesOnly: true,
    });
    expect(host.environments.get(ENVIRONMENT)).toEqual({
      reviewers: ["user:release-manager", "team:platform"],
      waitTimerMinutes: 30,
      protectedBranchesOnly: true,
    });
    // An existing Environment is read, never PUT: a PUT replaces protection.
    expect(host.calls.some((call) => call.args.includes("PUT"))).toBe(false);
  });

  it("deletes only what a previous run recorded as DeployKit's", async () => {
    const host = new FakeGitHubHost();
    const reconciler = createEnvironmentReconciler({ client: host.client() });
    await reconciler.reconcile(desiredEnvironment());

    host.variables.set("OPERATOR_DASHBOARD_URL", "https://status.example.com");
    host.secrets.set("OPERATOR_PAGERDUTY_KEY", "not-ours");

    const narrowed = desiredEnvironment({
      variables: {
        DEPLOYKIT_GATEWAY_HOST: CONNECTION.host,
        DEPLOYKIT_GATEWAY_PORT: "22",
        DEPLOYKIT_GATEWAY_USER: GATEWAY_USER,
        DEPLOYKIT_GATEWAY_KNOWN_HOSTS: "vps.example.com ssh-ed25519 AAAA",
        DEPLOYKIT_TARGET_ID: TARGET_ID,
      },
      secrets: { [MANAGED_GATEWAY_PRIVATE_KEY_SECRET]: GATEWAY_KEY_CANARY },
      managedResourceDigest: OTHER_DIGEST,
    });
    const state = await reconciler.reconcile(narrowed);

    expect(state.status).toBe("current");
    // Dropped from the config, previously recorded as ours: removed.
    expect(host.variables.has("NEXT_PUBLIC_API_URL")).toBe(false);
    expect(host.secrets.has("CERTBOT_EMAIL")).toBe(false);
    // Never ours: untouched.
    expect(host.variables.get("OPERATOR_DASHBOARD_URL")).toBe("https://status.example.com");
    expect(host.secrets.get("OPERATOR_PAGERDUTY_KEY")).toBe("not-ours");
  });

  it("refuses a desired name somebody else already set", async () => {
    const host = new FakeGitHubHost();
    host.environments.set(ENVIRONMENT, { reviewers: [], waitTimerMinutes: 0, protectedBranchesOnly: false });
    host.variables.set("NEXT_PUBLIC_API_URL", "https://squatted.example.com");
    const reconciler = createEnvironmentReconciler({ client: host.client() });

    expect(await reconciler.inspect(desiredEnvironment())).toMatchObject({ status: "conflict" });
    await expect(reconciler.reconcile(desiredEnvironment())).rejects.toMatchObject({
      code: "DK_ENVIRONMENT_CONFLICT",
    });
    expect(host.variables.get("NEXT_PUBLIC_API_URL")).toBe("https://squatted.example.com");
    expect(host.secrets.size).toBe(0);
  });

  it("never leaves a digest that claims a state the Environment does not hold", async () => {
    const host = new FakeGitHubHost();
    const reconciler = createEnvironmentReconciler({ client: host.client() });
    await reconciler.reconcile(desiredEnvironment());
    expect(host.variables.get(MANAGED_DIGEST_VARIABLE)).toBe(DIGEST);

    // Interrupt the next reconciliation partway through the secret writes.
    host.failNextSecretWrite = "CERTBOT_EMAIL";
    const moved = desiredEnvironment({ managedResourceDigest: OTHER_DIGEST });
    await expect(reconciler.reconcile(moved)).rejects.toMatchObject({ code: "DK_GITHUB_API_FAILED" });

    // The stale digest is gone rather than left standing over half-written state.
    expect(host.variables.has(MANAGED_DIGEST_VARIABLE)).toBe(false);
    expect(await reconciler.inspect(moved)).toMatchObject({ status: "drifted", managedResourceDigest: null });

    // A rerun finishes the job.
    expect(await reconciler.reconcile(moved)).toMatchObject({ status: "current" });
    expect(host.variables.get(MANAGED_DIGEST_VARIABLE)).toBe(OTHER_DIGEST);
  });

  it("reports drift when a managed variable is edited outside DeployKit", async () => {
    const host = new FakeGitHubHost();
    const reconciler = createEnvironmentReconciler({ client: host.client() });
    await reconciler.reconcile(desiredEnvironment());

    host.variables.set("NEXT_PUBLIC_API_URL", "https://edited.example.com");
    expect(await reconciler.inspect(desiredEnvironment())).toMatchObject({ status: "drifted" });
    expect(await reconciler.reconcile(desiredEnvironment())).toMatchObject({ status: "current" });
    expect(host.variables.get("NEXT_PUBLIC_API_URL")).toBe("https://app.example.com/api");
  });
});

// ------------------------------------------------------- gateway key cycle --

interface HostKeyState {
  entries: GatewayKeyEntry[];
  failStage: boolean;
  failActivate: boolean;
  interruptAfterStage: boolean;
}

function keyMaterial(publicKey: string): { type: string; key: string } {
  const parts = publicKey.trim().split(/\s+/u);
  return { type: parts[0] ?? "", key: parts[1] ?? "" };
}

/** The staged/active semantics `gateway-keys.sh` implements, in memory. */
class FakeGatewayKeyHost implements GatewayKeyLifecyclePort {
  readonly state: HostKeyState = {
    entries: [],
    failStage: false,
    failActivate: false,
    interruptAfterStage: false,
  };
  readonly operations: string[] = [];

  async listGatewayKeys(): Promise<readonly GatewayKeyEntry[]> {
    this.operations.push("list");
    return [...this.state.entries];
  }

  async stageGatewayKey(
    _connection: AdministratorSshConnection,
    _binding: RootOwnedGatewayBinding,
    key: { readonly keyId: string; readonly publicKey: string },
  ): Promise<readonly GatewayKeyEntry[]> {
    this.operations.push(`stage:${key.keyId}`);
    if (this.state.failStage) throw new Error("host refused the staging request");
    // Exactly `gateway-keys.sh`: this binding's pending entries are dropped and
    // the replacement appended; the active entry is left alone.
    this.state.entries = this.state.entries.filter((entry) => entry.state !== "pending");
    this.state.entries.push({ state: "pending", keyId: key.keyId, ...keyMaterial(key.publicKey) });
    if (this.state.interruptAfterStage) throw new Error("interrupted after staging");
    return [...this.state.entries];
  }

  async activateGatewayKey(
    _connection: AdministratorSshConnection,
    _binding: RootOwnedGatewayBinding,
    keyId: string,
  ): Promise<readonly GatewayKeyEntry[]> {
    this.operations.push(`activate:${keyId}`);
    if (this.state.failActivate) throw new Error("host refused the activation request");
    const target = this.state.entries.find((entry) => entry.keyId === keyId);
    if (target === undefined) throw new Error("no owned entry for that key id");
    this.state.entries = [{ ...target, state: "active" }];
    return [...this.state.entries];
  }
}

class FakeGatewayTransport implements GatewayTransportPort {
  readonly sessions: { identityFile: string; user: string; port: number }[] = [];
  handshakeBindingId = BINDING_ID;
  refuse: string | null = null;

  async *exchange(request: GatewayExchange): AsyncIterable<GatewayOutputFrame> {
    this.sessions.push({
      identityFile: request.connection.identityFile,
      user: request.connection.user,
      port: request.connection.port,
    });
    const frames: GatewayInputFrame[] = [];
    for await (const frame of request.frames) frames.push(frame);
    const first = frames[0];
    const requestId = (first?.requestId ?? randomUUID()) as RequestId;
    if (this.refuse !== null) {
      yield {
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        frame: "result",
        requestId,
        sequence: 1,
        time: "2026-01-01T00:00:00.000Z",
        ok: false,
        code: this.refuse as "DK_GATEWAY_BINDING_MISMATCH",
        recovery: "rerun-same-command",
        result: null,
      };
      return;
    }
    yield {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "result",
      requestId,
      sequence: 1,
      time: "2026-01-01T00:00:00.000Z",
      ok: true,
      code: "DK_GATEWAY_OK",
      recovery: "none",
      result: {
        kind: "handshake",
        bindingId: this.handshakeBindingId,
        targetId: TARGET_ID,
        runtimeVersion: BINDING.runtimeVersion,
        runtimeBundleSha256: BINDING.runtimeBundleSha256,
        capabilities: ["handshake", "inspect", "apply", "retry"],
      },
    };
  }
}

/** Deterministic key material so a test can assert exactly which key is where. */
function fakeKeyPairs(): GatewayKeyPairGenerator {
  let counter = 0;
  return {
    async generate(directory: string, keyId: string) {
      counter += 1;
      const material = createHash("sha256").update(keyId).digest("base64").replace(/=+$/u, "");
      const publicKey = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${material}AA ${keyId}`;
      const privateKeyFile = join(directory, "gateway-key");
      const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${GATEWAY_KEY_CANARY}-${counter}\n-----END OPENSSH PRIVATE KEY-----\n`;
      await writeFile(privateKeyFile, privateKey, { mode: 0o600 });
      await writeFile(`${privateKeyFile}.pub`, `${publicKey}\n`, { mode: 0o644 });
      return { privateKeyFile, privateKey, publicKey };
    },
  };
}

async function rotator(host: FakeGatewayKeyHost, transport: FakeGatewayTransport, root: string) {
  return createGatewayKeyRotator({
    administratorSsh: host,
    gateway: transport,
    knownHosts: "vps.example.com ssh-ed25519 AAAA",
    keyPairs: fakeKeyPairs(),
    temporaryRoot: root,
  });
}

describe("workflow-to-VPS gateway key", () => {
  it("stages, proves, and only then activates the replacement key", async () => {
    const host = new FakeGatewayKeyHost();
    const transport = new FakeGatewayTransport();
    const root = await workspace();
    const prepared = await (await rotator(host, transport, root)).prepare(CONNECTION, BINDING, {
      repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint,
    });

    // Proven before anybody holds it: one real session, with the staged key.
    expect(transport.sessions).toHaveLength(1);
    expect(transport.sessions[0]).toMatchObject({ user: GATEWAY_USER, port: 22 });
    expect(transport.sessions[0]?.identityFile).toBe(prepared.access.identityFile);
    expect(prepared.handshake.bindingId).toBe(BINDING_ID);
    // Still pending: the upload has not happened yet.
    expect(host.state.entries.map((entry) => entry.state)).toEqual(["pending"]);

    expect(prepared.access.secrets[MANAGED_GATEWAY_PRIVATE_KEY_SECRET]).toContain(GATEWAY_KEY_CANARY);
    expect(prepared.access.variables?.["DEPLOYKIT_GATEWAY_KEY_FINGERPRINT"]).toBe(prepared.fingerprint);
    expect(prepared.access.variables?.["DEPLOYKIT_REPOSITORY_KEY_FINGERPRINT"]).toBe(
      BINDING.repositoryKeyFingerprint,
    );

    const entries = await prepared.activate();
    expect(entries).toEqual([{ state: "active", keyId: prepared.keyId, ...keyMaterial(prepared.publicKey) }]);
    expect(host.operations).toEqual([`stage:${prepared.keyId}`, `activate:${prepared.keyId}`]);

    await prepared.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it("leaves one usable key after an interruption at every step", async () => {
    const root = await workspace();
    const active: GatewayKeyEntry = {
      state: "active",
      keyId: "gw-previous",
      type: "ssh-ed25519",
      key: "AAAAPREVIOUS",
    };

    // 1. Interrupted while staging: the proven key is still the only entry.
    {
      const host = new FakeGatewayKeyHost();
      host.state.entries = [{ ...active }];
      host.state.failStage = true;
      await expect(
        (await rotator(host, new FakeGatewayTransport(), root)).prepare(CONNECTION, BINDING, {
          repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint,
        }),
      ).rejects.toThrow();
      expect(host.state.entries).toEqual([active]);
      expect(await readdir(root)).toEqual([]);
    }

    // 2. Interrupted after staging: both keys are usable, the old one still works.
    {
      const host = new FakeGatewayKeyHost();
      host.state.entries = [{ ...active }];
      host.state.interruptAfterStage = true;
      await expect(
        (await rotator(host, new FakeGatewayTransport(), root)).prepare(CONNECTION, BINDING, {
          repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint,
        }),
      ).rejects.toThrow();
      const state = await inspectGatewayKeyState(host, CONNECTION, BINDING);
      expect(state.active).toEqual([active]);
      expect(state.pending).toHaveLength(1);

      // 3. The rerun rotates: it never assumes the stranded pending entry is one
      //    whose private key GitHub holds.
      host.state.interruptAfterStage = false;
      const prepared = await (await rotator(host, new FakeGatewayTransport(), root)).prepare(
        CONNECTION,
        BINDING,
        { repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint },
      );
      expect(prepared.keyId).not.toBe(state.pending[0]?.keyId);
      const after = await inspectGatewayKeyState(host, CONNECTION, BINDING);
      expect(after.active).toEqual([active]);
      expect(after.pending.map((entry) => entry.keyId)).toEqual([prepared.keyId]);

      // 4. Interrupted during activation: the previous key is still in place.
      host.state.failActivate = true;
      await expect(prepared.activate()).rejects.toThrow();
      expect((await inspectGatewayKeyState(host, CONNECTION, BINDING)).active).toEqual([active]);

      // 5. Completed activation leaves exactly one key, and it is the new one.
      host.state.failActivate = false;
      await prepared.activate();
      const final = await inspectGatewayKeyState(host, CONNECTION, BINDING);
      expect(final.pending).toEqual([]);
      expect(final.active.map((entry) => entry.keyId)).toEqual([prepared.keyId]);
      await prepared.dispose();
    }
  });

  it("refuses a gateway that answers the staged key with another binding", async () => {
    const host = new FakeGatewayKeyHost();
    const transport = new FakeGatewayTransport();
    transport.handshakeBindingId = "f".repeat(32);
    const root = await workspace();

    await expect(
      (await rotator(host, transport, root)).prepare(CONNECTION, BINDING, {
        repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint,
      }),
    ).rejects.toMatchObject({ code: "DK_GATEWAY_BINDING_MISMATCH" });
    // Nothing was activated, and no private key was left behind.
    expect(host.state.entries.every((entry) => entry.state === "pending")).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("stops with the last verified key intact when the staged key cannot open a session", async () => {
    const host = new FakeGatewayKeyHost();
    host.state.entries = [{ state: "active", keyId: "gw-previous", type: "ssh-ed25519", key: "AAAAPREVIOUS" }];
    const transport = new FakeGatewayTransport();
    transport.refuse = "DK_GATEWAY_PROTOCOL_INVALID";
    const root = await workspace();

    await expect(
      (await rotator(host, transport, root)).prepare(CONNECTION, BINDING, {
        repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint,
      }),
    ).rejects.toMatchObject({ code: "DK_KEY_ROTATION_FAILED" });
    expect(host.operations.some((operation) => operation.startsWith("activate:"))).toBe(false);
    expect((await inspectGatewayKeyState(host, CONNECTION, BINDING)).active).toHaveLength(1);
  });

  it("never writes a private key outside the temporary directory it removes", async () => {
    const host = new FakeGatewayKeyHost();
    const root = await workspace();
    const prepared = await (await rotator(host, new FakeGatewayTransport(), root)).prepare(
      CONNECTION,
      BINDING,
      { repositoryKeyFingerprint: BINDING.repositoryKeyFingerprint },
    );

    const identityFile = prepared.access.identityFile ?? "";
    expect(identityFile.startsWith(root)).toBe(true);
    expect(await readFile(identityFile, "utf8")).toContain(GATEWAY_KEY_CANARY);

    await prepared.dispose();
    expect(await readdir(root)).toEqual([]);
    // Repeated disposal is safe; the caller may not know whether it already ran.
    await prepared.dispose();
  });
});

// ------------------------------------------------------- source key probe --

interface ProbeStubs {
  readonly greeting: string;
  readonly lsRemoteExitCode: number;
}

/** Runs the real `gateway-source-probe.sh` against stub `ssh` and `git`. */
async function runProbe(
  repository: string,
  stubs: ProbeStubs,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const directory = await workspace("deploykit-probe-");
  const binaries = join(directory, "bin");
  await execFileAsync("mkdir", ["-p", binaries]);
  await writeFile(
    join(binaries, "ssh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(stubs.greeting)} >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(binaries, "git"),
    `#!/usr/bin/env bash\nexit ${String(stubs.lsRemoteExitCode)}\n`,
    { mode: 0o755 },
  );

  // A real key pair, so the probe's own fingerprint check is exercised.
  const key = join(directory, "repository-key");
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "probe", "-f", key]);
  await chmod(key, 0o600);
  const knownHosts = join(directory, "github-known-hosts");
  await writeFile(knownHosts, "github.com ssh-ed25519 AAAA\n");

  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [PROBE, "--repository", repository, "--key", key, "--known-hosts", knownHosts],
      { env: { ...process.env, PATH: `${binaries}:${process.env["PATH"] ?? ""}` } },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
  }
}

describe("VPS-side repository key proof", () => {
  it("passes when the key is greeted as the bound repository", async () => {
    const result = await runProbe(REPOSITORY, {
      greeting: `Hi ${REPOSITORY}! You've successfully authenticated, but GitHub does not provide shell access.`,
      lsRemoteExitCode: 0,
    });
    expect(result.exitCode).toBe(0);
    const proof = parseSourceProbeResult(result.stdout);
    expect(proof).toMatchObject({ repository: REPOSITORY, authenticatedAs: REPOSITORY, reachable: true });
    expect(proof.keyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);
  });

  it("refuses a key that authenticates as anything but the bound repository", async () => {
    for (const identity of ["acme/other-app", "some-user"]) {
      const result = await runProbe(REPOSITORY, {
        greeting: `Hi ${identity}! You've successfully authenticated, but GitHub does not provide shell access.`,
        lsRemoteExitCode: 0,
      });
      // 5 is the frozen "authenticated as somebody else" status.
      expect(result.exitCode).toBe(5);
      expect(result.stdout).not.toContain("DEPLOYKIT_SOURCE_PROBE");
    }
  });

  it("refuses a key GitHub does not accept, and one that cannot fetch", async () => {
    const rejected = await runProbe(REPOSITORY, {
      greeting: "git@github.com: Permission denied (publickey).",
      lsRemoteExitCode: 0,
    });
    expect(rejected.exitCode).toBe(9);

    const unreachable = await runProbe(REPOSITORY, {
      greeting: `Hi ${REPOSITORY}! You've successfully authenticated, but GitHub does not provide shell access.`,
      lsRemoteExitCode: 128,
    });
    expect(unreachable.exitCode).toBe(9);
    expect(unreachable.stdout).not.toContain("DEPLOYKIT_SOURCE_PROBE");
  });
});

describe("administrator-side repository key proof", () => {
  class ProbeRunner {
    readonly requests: AdministratorRunRequest[] = [];
    constructor(private readonly reply: (request: AdministratorRunRequest) => AdministratorRunResult) {}
    async run(request: AdministratorRunRequest): Promise<AdministratorRunResult> {
      this.requests.push(request);
      if (request.command === "ssh-keyscan") {
        return { stdout: `${CONNECTION.host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA\n`, stderr: "", exitCode: 0 };
      }
      if (request.command === "ssh-keygen") {
        return { stdout: `256 ${CONNECTION.hostKeyFingerprint} ${CONNECTION.host} (ED25519)\n`, stderr: "", exitCode: 0 };
      }
      return this.reply(request);
    }
  }

  const proof = `DEPLOYKIT_SOURCE_PROBE {"version":1,"repository":"${REPOSITORY}","authenticatedAs":"${REPOSITORY}","keyFingerprint":"${BINDING.repositoryKeyFingerprint}","reachable":true}`;

  it("asks the host for the proof and returns only nonsecret facts", async () => {
    const runner = new ProbeRunner(() => ({ stdout: `${proof}\n`, stderr: "", exitCode: 0 }));
    const port = createAdministratorSshPort({ runner });
    const result = await port.proveRepositoryAccess(CONNECTION, BINDING);

    expect(result).toEqual({
      repository: REPOSITORY,
      authenticatedAs: REPOSITORY,
      keyFingerprint: BINDING.repositoryKeyFingerprint,
      reachable: true,
    });
    const invocation = runner.requests.find((request) => request.args.includes("--repository"));
    expect(invocation?.args).toEqual(
      expect.arrayContaining(["sudo", "-n", "/usr/local/lib/deploykit/gateway-source-probe", "--repository", REPOSITORY]),
    );
  });

  it("maps a mismatched identity to an ownership conflict and a failure to reach the repository to bootstrap", async () => {
    const mismatch = createAdministratorSshPort({
      runner: new ProbeRunner(() => ({ stdout: "", stderr: "", exitCode: 5 })),
    });
    await expect(mismatch.proveRepositoryAccess(CONNECTION, BINDING)).rejects.toMatchObject({
      code: "DK_OWNERSHIP_CONFLICT",
    });

    const unreachable = createAdministratorSshPort({
      runner: new ProbeRunner(() => ({ stdout: "", stderr: "", exitCode: 9 })),
    });
    await expect(unreachable.proveRepositoryAccess(CONNECTION, BINDING)).rejects.toMatchObject({
      code: "DK_GATEWAY_BOOTSTRAP_FAILED",
    });
  });

  it("refuses a helper that reports success for the wrong repository", async () => {
    const lying = `DEPLOYKIT_SOURCE_PROBE {"version":1,"repository":"${REPOSITORY}","authenticatedAs":"acme/other","keyFingerprint":"${BINDING.repositoryKeyFingerprint}","reachable":true}`;
    const port = createAdministratorSshPort({
      runner: new ProbeRunner(() => ({ stdout: `${lying}\n`, stderr: "", exitCode: 0 })),
    });
    await expect(port.proveRepositoryAccess(CONNECTION, BINDING)).rejects.toMatchObject({
      code: "DK_OWNERSHIP_CONFLICT",
    });

    for (const malformed of ["", "DEPLOYKIT_SOURCE_PROBE not json", 'DEPLOYKIT_SOURCE_PROBE {"version":1}']) {
      expect(() => parseSourceProbeResult(malformed)).toThrow();
    }
  });
});
