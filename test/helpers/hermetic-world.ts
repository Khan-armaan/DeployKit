import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodeGatewayFrames } from "../../src/gateway/protocol.js";
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_USER,
  type GatewayDeploymentResult,
  type GatewayHandshakeResult,
  type GatewayOutputFrame,
  type GatewayResultPayload,
  type GitCommitSha,
  type RequestId,
} from "../../src/orchestrator/contracts.js";
import type {
  AdministratorCommandRunner,
  AdministratorRunRequest,
  AdministratorRunResult,
} from "../../src/orchestrator/administrator-ssh.js";
import type {
  GatewayKeyPairGenerator,
  GeneratedGatewayKeyPair,
} from "../../src/orchestrator/gateway-keys.js";
import type {
  GitHubCommandRunner,
  GitHubRunRequest,
  GitHubRunResult,
} from "../../src/orchestrator/github.js";
import { VERSION } from "../../src/version.js";

/**
 * A hermetic "outside world" for the Phase 12 integration suite: one in-memory
 * GitHub behind the real `gh` argv boundary, and one in-memory Ubuntu host
 * behind the real `ssh`/`scp` argv boundary.
 *
 * Nothing here is a port double. The suite exercises the *production* adapters
 * — the bounded `gh` client, the three reconcilers, the administrator SSH port,
 * the gateway transport, the key rotator, the config filesystem, and the local
 * operation store — and only the two process boundaries at the very edge are
 * replaced. That is what makes the run end-to-end: every argv, every canonical
 * frame, every ownership check, and every digest is the real one.
 *
 * Both halves record every invocation, so a test can assert what crossed the
 * boundary as precisely as it asserts what came back. `secret set` is the only
 * channel a secret value may travel on, and it travels on stdin.
 */

export const CANARY_BACKEND_SECRET = "DK_CANARY_BACKEND_CERTBOT_EMAIL_44de07";
export const CANARY_GATEWAY_PRIVATE_KEY = "DK_CANARY_GATEWAY_PRIVATE_KEY_9f13ab";

export const OPERATOR_LOGIN = "fixture-operator";
export const APPLICATION_REF = "app-main";

/** Base64 material for a synthetic key; the fingerprint helpers require it. */
function keyMaterial(seed: string): string {
  return createHash("sha256").update(seed).digest("base64").replace(/=+$/u, "");
}

function sha40(seed: string): GitCommitSha {
  return createHash("sha256").update(seed).digest("hex").slice(0, 40) as GitCommitSha;
}

function blobSha(contents: string): string {
  return createHash("sha1").update(`blob ${String(Buffer.byteLength(contents))}\0${contents}`).digest("hex");
}

/** Raised by an injected fault so a test can interrupt a run mid-reconcile. */
export class InterruptedRun extends Error {
  constructor(readonly label: string) {
    super(`interrupted at ${label}`);
    this.name = "InterruptedRun";
  }
}

// -------------------------------------------------------------- GitHub ---

interface Branch {
  commitSha: GitCommitSha;
  files: Map<string, string>;
}

interface PullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  baseRef: string;
}

interface EnvironmentRecord {
  variables: Map<string, string>;
  secrets: Map<string, string>;
  reviewers: readonly string[];
  waitTimerMinutes: number;
}

interface DeployKeyRecord {
  id: number;
  title: string;
  key: string;
  readOnly: boolean;
}

interface WorkflowRunRecord {
  id: number;
  name: string;
  path: string;
  event: "workflow_dispatch";
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  headBranch: string;
  headSha: GitCommitSha;
  actor: string;
  inputs: Readonly<Record<string, string>>;
}

/** A repository-scoped self-hosted runner registration GitHub still lists. */
export interface SelfHostedRunnerRecord {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels: readonly string[];
}

export interface HermeticGitHubOptions {
  readonly repository: string;
  readonly defaultBranch?: string;
  /** Merge the setup pull request the first time DeployKit polls it. */
  readonly autoMergeSetup?: boolean;
  /** Conclusion the dispatched run reports once it completes. */
  readonly runConclusion?: string;
  readonly reviewers?: readonly string[];
  readonly waitTimerMinutes?: number;
}

/**
 * GitHub as `gh` presents it: one argv in, one JSON document out. Every request
 * the bounded client can make is served, and an unrouted request answers the
 * same `HTTP 404` the real CLI would, so a missing route is never mistaken for
 * a permission problem.
 */
export class HermeticGitHub implements GitHubCommandRunner {
  readonly calls: GitHubRunRequest[] = [];
  readonly branches = new Map<string, Branch>();
  readonly pulls: PullRequest[] = [];
  readonly deployKeys: DeployKeyRecord[] = [];
  readonly environments = new Map<string, EnvironmentRecord>();
  readonly runs: WorkflowRunRecord[] = [];
  /** Legacy self-hosted runners; empty on every host this release bootstrapped. */
  readonly selfHostedRunners: SelfHostedRunnerRecord[] = [];
  readonly repository: string;
  readonly defaultBranch: string;

  /** Fails the next call whose label matches, then clears itself. */
  failAt: string | null = null;
  /** Runs just before a labelled mutation, so a test can move the world. */
  beforeGate: ((label: string) => void) | null = null;
  autoMergeSetup: boolean;
  runConclusion: string;
  private nextPullNumber = 41;
  private nextKeyId = 7001;
  private nextRunId = 900_001;

  constructor(private readonly options: HermeticGitHubOptions) {
    this.repository = options.repository;
    this.defaultBranch = options.defaultBranch ?? "main";
    this.autoMergeSetup = options.autoMergeSetup ?? true;
    this.runConclusion = options.runConclusion ?? "success";
    this.branches.set(this.defaultBranch, { commitSha: sha40("default-branch"), files: new Map() });
    // A separate application branch, so merging the setup pull request into the
    // default branch does not move the ref the deployment froze.
    this.branches.set(APPLICATION_REF, { commitSha: sha40("application-head"), files: new Map() });
  }

  get applicationCommitSha(): GitCommitSha {
    return this.branches.get(APPLICATION_REF)?.commitSha ?? sha40("missing");
  }

  /** Every `gh api` endpoint requested, in order. */
  endpoints(): string[] {
    return this.calls
      .filter((call) => call.args[0] === "api")
      .map((call) => call.args[call.args.length - 1] ?? "");
  }

  /** Argv of every recorded call, flattened; never includes stdin. */
  arguments(): string[] {
    return this.calls.flatMap((call) => [...call.args]);
  }

  private gate(label: string): void {
    this.beforeGate?.(label);
    if (this.failAt !== label) return;
    this.failAt = null;
    throw new InterruptedRun(label);
  }

  private branch(name: string): Branch | undefined {
    return this.branches.get(name);
  }

  private advance(branch: Branch, seed: string): void {
    branch.commitSha = sha40(`${branch.commitSha}:${seed}`);
  }

  mergePullRequest(number: number): void {
    const pull = this.pulls.find((entry) => entry.number === number);
    if (pull === undefined || pull.merged) return;
    const head = this.branch(pull.headRef);
    const base = this.branch(pull.baseRef);
    if (head === undefined || base === undefined) return;
    for (const [path, contents] of head.files) base.files.set(path, contents);
    this.advance(base, `merge-${String(number)}`);
    pull.merged = true;
    pull.state = "closed";
  }

  /** Advances the single dispatched run one step, the way polling would. */
  advanceRuns(): void {
    for (const run of this.runs) {
      if (run.status === "queued") run.status = "in_progress";
      else if (run.status === "in_progress") {
        run.status = "completed";
        run.conclusion = this.runConclusion;
      }
    }
  }

  async run(request: GitHubRunRequest): Promise<GitHubRunResult> {
    this.calls.push(request);
    const args = request.args;
    if (args[0] !== "api") return this.runValueCommand(request);

    const methodIndex = args.indexOf("--method");
    const method = methodIndex < 0 ? "GET" : args[methodIndex + 1] ?? "GET";
    const endpoint = args[args.length - 1] ?? "";
    const [path, queryText] = endpoint.split("?", 2);
    const query = new URLSearchParams(queryText ?? "");
    const body: Record<string, unknown> =
      request.input === undefined ? {} : (JSON.parse(request.input) as Record<string, unknown>);

    try {
      const answer = this.route(method, path ?? "", query, body, args);
      if (answer === undefined) {
        return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
      }
      return { stdout: typeof answer === "string" ? answer : JSON.stringify(answer), stderr: "", exitCode: 0 };
    } catch (error) {
      if (error instanceof InterruptedRun) throw error;
      return { stdout: "", stderr: `gh: ${String(error)}`, exitCode: 1 };
    }
  }

  /** `gh secret set|delete` and `gh variable set|delete`. */
  private runValueCommand(request: GitHubRunRequest): GitHubRunResult {
    const [kind, verb, name] = request.args;
    const environmentIndex = request.args.indexOf("--env");
    const environment = environmentIndex < 0 ? "" : request.args[environmentIndex + 1] ?? "";
    const record = this.environments.get(environment);
    if (record === undefined || name === undefined) {
      return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
    }
    const store = kind === "secret" ? record.secrets : record.variables;
    if (verb === "set") {
      this.gate(`${kind}.set:${name}`);
      store.set(name, request.input ?? "");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (verb === "delete") {
      this.gate(`${kind}.delete:${name}`);
      store.delete(name);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "gh: unknown command", exitCode: 1 };
  }

  private route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: Record<string, unknown>,
    args: readonly string[],
  ): unknown {
    const repositoryPrefix = `repos/${this.repository}/`;

    if (path === "user" && args.includes("--include")) {
      return [
        "HTTP/2.0 200 OK",
        "X-OAuth-Scopes: repo, workflow, admin:public_key",
        "",
        JSON.stringify({ login: OPERATOR_LOGIN }),
      ].join("\r\n");
    }
    if (path === `repos/${this.repository}`) {
      return {
        full_name: this.repository,
        default_branch: this.defaultBranch,
        private: true,
        visibility: "private",
        archived: false,
        permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
        plan: { name: "team" },
      };
    }
    if (!path.startsWith(repositoryPrefix)) return undefined;
    const rest = path.slice(repositoryPrefix.length);

    if (rest.startsWith("commits/")) {
      const branch = this.branch(decodeURIComponent(rest.slice("commits/".length)));
      return branch === undefined ? undefined : { sha: branch.commitSha };
    }

    if (rest.startsWith("contents/")) {
      const file = decodeURIComponent(rest.slice("contents/".length));
      if (method === "GET") {
        const branch = this.branch(query.get("ref") ?? this.defaultBranch);
        const contents = branch?.files.get(file);
        if (contents === undefined) return undefined;
        return {
          path: file,
          sha: blobSha(contents),
          size: Buffer.byteLength(contents, "utf8"),
          type: "file",
          encoding: "base64",
          content: Buffer.from(contents, "utf8").toString("base64"),
        };
      }
      if (method === "PUT") {
        const branch = this.branch(String(body["branch"]));
        if (branch === undefined) return undefined;
        this.gate(`contents.write:${file}`);
        const contents = Buffer.from(String(body["content"]), "base64").toString("utf8");
        branch.files.set(file, contents);
        this.advance(branch, file);
        return { content: { path: file, sha: blobSha(contents) }, commit: { sha: branch.commitSha } };
      }
    }

    if (rest.startsWith("branches/")) {
      const name = decodeURIComponent(rest.slice("branches/".length));
      const branch = this.branch(name);
      return branch === undefined ? undefined : { name, commit: { sha: branch.commitSha }, protected: name === this.defaultBranch };
    }

    if (rest === "git/refs" && method === "POST") {
      const name = String(body["ref"]).replace("refs/heads/", "");
      const source = String(body["sha"]) as GitCommitSha;
      this.gate(`branch.create:${name}`);
      const base = [...this.branches.values()].find((entry) => entry.commitSha === source);
      this.branches.set(name, { commitSha: source, files: new Map(base?.files ?? []) });
      return { ref: `refs/heads/${name}`, object: { sha: source } };
    }

    if (rest.startsWith("compare/")) {
      const [base, head] = decodeURIComponent(rest.slice("compare/".length)).split("...");
      const left = this.branch(base ?? "");
      const right = this.branch(head ?? "");
      if (left === undefined || right === undefined) return undefined;
      const files: string[] = [];
      for (const [file, contents] of right.files) {
        if (left.files.get(file) !== contents) files.push(file);
      }
      return {
        status: files.length === 0 ? "identical" : "ahead",
        ahead_by: files.length,
        behind_by: 0,
        files: files.map((filename) => ({ filename })),
      };
    }

    if (rest === "pulls" && method === "GET") {
      const headRef = (query.get("head") ?? "").split(":").at(-1);
      return this.pulls
        .filter((pull) => headRef === undefined || headRef === "" || pull.headRef === headRef)
        .map((pull) => this.pullBody(pull, false));
    }
    if (rest === "pulls" && method === "POST") {
      this.gate("pull.create");
      const pull: PullRequest = {
        number: this.nextPullNumber++,
        title: String(body["title"]),
        state: "open",
        merged: false,
        headRef: String(body["head"]),
        baseRef: String(body["base"]),
      };
      this.pulls.push(pull);
      return this.pullBody(pull, true);
    }
    if (rest.startsWith("pulls/") && method === "GET") {
      const number = Number(rest.slice("pulls/".length));
      // Polling for the merge is where a reviewer would act, so the simulated
      // operator merges on the first poll unless a test says otherwise.
      if (this.autoMergeSetup) this.mergePullRequest(number);
      const pull = this.pulls.find((entry) => entry.number === number);
      return pull === undefined ? undefined : this.pullBody(pull, true);
    }

    if (rest.startsWith("environments/")) {
      const remainder = rest.slice("environments/".length);
      const [rawName, collection] = remainder.split("/", 2);
      const name = decodeURIComponent(rawName ?? "");
      if (collection === undefined) {
        if (method === "PUT") {
          this.gate(`environment.create:${name}`);
          if (!this.environments.has(name)) {
            this.environments.set(name, {
              variables: new Map(),
              secrets: new Map(),
              reviewers: this.options.reviewers ?? [],
              waitTimerMinutes: this.options.waitTimerMinutes ?? 0,
            });
          }
        }
        const record = this.environments.get(name);
        return record === undefined ? undefined : this.environmentBody(name, record);
      }
      const record = this.environments.get(name);
      if (record === undefined) return undefined;
      if (collection === "variables") {
        return {
          total_count: record.variables.size,
          variables: [...record.variables].map(([variable, value]) => ({ name: variable, value })),
        };
      }
      if (collection === "secrets") {
        return {
          total_count: record.secrets.size,
          secrets: [...record.secrets.keys()].map((secret) => ({ name: secret })),
        };
      }
      return undefined;
    }

    if (rest === "keys" && method === "GET") {
      return this.deployKeys.map((key) => ({
        id: key.id,
        title: key.title,
        key: key.key,
        read_only: key.readOnly,
      }));
    }
    if (rest === "keys" && method === "POST") {
      this.gate("deployKey.create");
      const created: DeployKeyRecord = {
        id: this.nextKeyId++,
        title: String(body["title"]),
        key: String(body["key"]),
        readOnly: body["read_only"] === true,
      };
      this.deployKeys.push(created);
      return { id: created.id, title: created.title, key: created.key, read_only: created.readOnly };
    }
    if (rest.startsWith("keys/") && method === "DELETE") {
      const id = Number(rest.slice("keys/".length));
      this.gate(`deployKey.delete:${String(id)}`);
      const index = this.deployKeys.findIndex((key) => key.id === id);
      if (index >= 0) this.deployKeys.splice(index, 1);
      return {};
    }

    if (rest.startsWith("actions/workflows/") && rest.endsWith("/dispatches") && method === "POST") {
      const file = rest.slice("actions/workflows/".length, -"/dispatches".length);
      this.gate("workflow.dispatch");
      const inputs = body["inputs"] as Record<string, string>;
      const head = this.branch(String(body["ref"]));
      const id = this.nextRunId++;
      this.runs.push({
        id,
        name: `DeployKit ${inputs["target"] ?? ""} ${inputs["request_id"] ?? ""}`,
        path: `.github/workflows/${file}`,
        event: "workflow_dispatch",
        status: "queued",
        conclusion: null,
        headBranch: String(body["ref"]),
        headSha: head?.commitSha ?? sha40("unknown"),
        actor: OPERATOR_LOGIN,
        inputs,
      });
      return {};
    }
    if (rest.startsWith("actions/workflows/") && rest.endsWith("/runs") && method === "GET") {
      const file = rest.slice("actions/workflows/".length, -"/runs".length);
      const matching = this.runs.filter((run) => run.path === `.github/workflows/${file}`);
      return { total_count: matching.length, workflow_runs: matching.map((run) => this.runBody(run)) };
    }
    if (rest === "actions/runners" && method === "GET") {
      return {
        total_count: this.selfHostedRunners.length,
        runners: this.selfHostedRunners.map((runner) => ({
          id: runner.id,
          name: runner.name,
          os: "linux",
          status: runner.status,
          busy: runner.busy,
          labels: runner.labels.map((name) => ({ id: 1, name, type: "custom" })),
        })),
      };
    }
    if (rest.startsWith("actions/runners/") && method === "DELETE") {
      this.gate("runner.delete");
      const id = Number(rest.slice("actions/runners/".length));
      const index = this.selfHostedRunners.findIndex((runner) => runner.id === id);
      if (index < 0) return undefined;
      this.selfHostedRunners.splice(index, 1);
      return {};
    }
    if (rest.startsWith("actions/runs/") && method === "GET") {
      const id = Number(rest.slice("actions/runs/".length));
      // Each read advances the run one step, so following it terminates.
      this.advanceRuns();
      const run = this.runs.find((entry) => entry.id === id);
      return run === undefined ? undefined : this.runBody(run);
    }

    return undefined;
  }

  private pullBody(pull: PullRequest, detailed: boolean): Record<string, unknown> {
    const head = this.branch(pull.headRef);
    return {
      number: pull.number,
      title: pull.title,
      state: pull.state,
      draft: false,
      merged_at: pull.merged ? "2026-01-01T00:00:00Z" : null,
      ...(detailed ? { merged: pull.merged } : {}),
      merge_commit_sha: pull.merged ? this.branch(pull.baseRef)?.commitSha ?? null : null,
      head: { ref: pull.headRef, sha: head?.commitSha ?? sha40("head") },
      base: { ref: pull.baseRef },
      html_url: `https://github.com/${this.repository}/pull/${String(pull.number)}`,
    };
  }

  private environmentBody(name: string, record: EnvironmentRecord): Record<string, unknown> {
    const rules: Record<string, unknown>[] = [];
    if (record.waitTimerMinutes > 0) {
      rules.push({ type: "wait_timer", wait_timer: record.waitTimerMinutes });
    }
    if (record.reviewers.length > 0) {
      rules.push({
        type: "required_reviewers",
        reviewers: record.reviewers.map((reviewer) => ({
          type: "User",
          reviewer: { login: reviewer.replace(/^user:/u, "") },
        })),
      });
    }
    return {
      name,
      protection_rules: rules,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    };
  }

  private runBody(run: WorkflowRunRecord): Record<string, unknown> {
    return {
      id: run.id,
      name: run.name,
      display_title: run.name,
      path: run.path,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      head_branch: run.headBranch,
      head_sha: run.headSha,
      actor: { login: run.actor },
      run_attempt: 1,
      created_at: "2026-01-01T00:00:00Z",
      html_url: `https://github.com/${this.repository}/actions/runs/${String(run.id)}`,
    };
  }
}

// ---------------------------------------------------------------- host ---

export interface GatewayKeyEntryRecord {
  state: "pending" | "active";
  keyId: string;
  type: string;
  key: string;
}

export interface HostBinding {
  readonly repository: string;
  readonly githubEnvironment: string;
  readonly targetName: string;
  readonly targetId: string;
  readonly bindingId: string;
  readonly runtimeVersion: string;
  readonly runtimeBundleSha256: string;
}

/**
 * A DeployKit v0.1.x root Actions runner, as it actually sits on a host that an
 * earlier release enrolled: a directory under `/opt/actions-runner`, its own
 * `.runner` registration, and a systemd unit named by `.service`.
 */
export interface LegacyRunnerState {
  directory: string;
  agentId: number;
  agentName: string;
  gitHubUrl: string;
  serviceUnit: string;
  serviceActive: boolean;
  serviceEnabled: boolean;
  /** Set when the test wants the registration file to be unreadable JSON. */
  malformed?: boolean;
}

export interface HermeticHostOptions {
  readonly host: string;
  readonly repository: string;
  /** Absent on every host this release bootstrapped. */
  readonly legacyRunner?: LegacyRunnerState;
  /** The deployment result the gateway reports for an `inspect`. */
  readonly deployment?: Partial<GatewayDeploymentResult>;
}

/**
 * One Ubuntu host behind the real `ssh`, `scp`, `ssh-keyscan`, and `ssh-keygen`
 * argv. It answers the installer, the forced-command gateway, the key helper,
 * and the read-only source probe exactly as the production adapters expect, and
 * records every argv so a test can prove no secret value ever became one.
 */
export class HermeticHost implements AdministratorCommandRunner {
  readonly calls: AdministratorRunRequest[] = [];
  readonly keys: GatewayKeyEntryRecord[] = [];
  binding: HostBinding | null = null;
  bootstrapCount = 0;
  /** Fails the next call whose label matches, then clears itself. */
  failAt: string | null = null;
  /** Set to refuse the source probe with the frozen "wrong identity" status. */
  sourceProbeIdentity: string | null = null;
  /** Mutated in place by the retirement, exactly as systemctl would. */
  legacyRunner: LegacyRunnerState | null = null;

  readonly hostKeyLine: string;
  readonly repositoryPublicKey: string;

  constructor(private readonly options: HermeticHostOptions) {
    this.hostKeyLine = `${options.host} ssh-ed25519 ${keyMaterial(`host:${options.host}`)}`;
    this.repositoryPublicKey = `ssh-ed25519 ${keyMaterial(`repo:${options.repository}`)}`;
    this.legacyRunner = options.legacyRunner ?? null;
  }

  get repositoryPublicKeyFingerprint(): string {
    return fingerprintOf(this.repositoryPublicKey);
  }

  activeKeys(): readonly GatewayKeyEntryRecord[] {
    return this.keys.filter((entry) => entry.state === "active");
  }

  pendingKeys(): readonly GatewayKeyEntryRecord[] {
    return this.keys.filter((entry) => entry.state === "pending");
  }

  /** Argv of every recorded call, flattened; never includes stdin. */
  arguments(): string[] {
    return this.calls.flatMap((call) => [call.command, ...call.args]);
  }

  private gate(label: string): void {
    if (this.failAt !== label) return;
    this.failAt = null;
    throw new InterruptedRun(label);
  }

  async run(request: AdministratorRunRequest): Promise<AdministratorRunResult> {
    this.calls.push(request);
    if (request.command === "ssh-keyscan") return ok(`${this.hostKeyLine}\n`);
    if (request.command === "ssh-keygen") {
      const line = (request.input ?? "").trim();
      const material = line.split(/\s+/u).at(2) ?? "";
      return ok(`256 ${fingerprintOf(`ssh-ed25519 ${material}`)} host (ED25519)\n`);
    }
    if (request.command === "scp") return ok("");
    if (request.command !== "ssh") return { stdout: "", stderr: "unsupported command", exitCode: 127 };

    const remote = remoteArguments(request.args);
    if (remote.length === 0) return this.gatewaySession(request.input ?? "");
    return this.remoteCommand(remote, request.input);
  }

  private remoteCommand(argv: readonly string[], input?: string): AdministratorRunResult {
    const command = argv.join(" ");
    if (command === "cat /etc/os-release") {
      return ok('ID=ubuntu\nVERSION_ID="24.04"\n');
    }
    if (command === "uname -m") return ok("x86_64\n");
    if (command === "sudo -n true") return ok("");
    if (argv[0] === "install" || argv[0] === "rm") return ok("");

    if (command === "sudo -n /usr/local/lib/deploykit/gateway-entry") {
      return this.gatewaySession(input ?? "");
    }
    if (argv[0] === "sudo" && argv[2] === "bash") return this.bootstrap(argv);
    if (argv[0] === "sudo" && argv[2] === "/usr/local/lib/deploykit/gateway-keys") {
      return this.keyHelper(argv, input);
    }
    if (argv[0] === "sudo" && argv[2] === "/usr/local/lib/deploykit/gateway-source-probe") {
      return this.sourceProbe(argv);
    }
    if (argv[0] === "sudo" && (argv[2] === "ls" || argv[2] === "cat" || argv[2] === "systemctl")) {
      return this.legacyRunnerCommand(argv);
    }
    return { stdout: "", stderr: "command not found", exitCode: 127 };
  }

  /** `/opt/actions-runner` as a v0.1.x host actually presents it over ssh. */
  private legacyRunnerCommand(argv: readonly string[]): AdministratorRunResult {
    const runner = this.legacyRunner;
    const verb = argv[2];
    const operand = argv[argv.length - 1] ?? "";

    if (verb === "ls") {
      if (runner === null) return { stdout: "", stderr: "No such file or directory", exitCode: 2 };
      return ok(`${runner.directory}\n`);
    }
    if (verb === "cat") {
      if (runner === null) return { stdout: "", stderr: "No such file or directory", exitCode: 1 };
      const root = `/opt/actions-runner/${runner.directory}`;
      if (operand === `${root}/.runner`) {
        if (runner.malformed === true) return ok("{not json\n");
        return ok(`${JSON.stringify({
          agentId: runner.agentId,
          agentName: runner.agentName,
          poolId: 1,
          serverUrl: "https://pipelines.actions.githubusercontent.com/",
          gitHubUrl: runner.gitHubUrl,
          workFolder: "_work",
          disableUpdate: true,
        })}\n`);
      }
      if (operand === `${root}/.service`) return ok(`${runner.serviceUnit}\n`);
      return { stdout: "", stderr: "No such file or directory", exitCode: 1 };
    }

    const action = argv[3];
    if (runner === null || operand !== runner.serviceUnit) {
      return { stdout: "", stderr: "Unit not found", exitCode: 4 };
    }
    if (action === "is-active") {
      return runner.serviceActive ? ok("active\n") : { stdout: "inactive\n", stderr: "", exitCode: 3 };
    }
    if (action === "stop") {
      this.gate("legacy-runner.stop");
      runner.serviceActive = false;
      return ok("");
    }
    if (action === "disable") {
      runner.serviceEnabled = false;
      return ok("");
    }
    return { stdout: "", stderr: "unsupported systemctl verb", exitCode: 1 };
  }

  private bootstrap(argv: readonly string[]): AdministratorRunResult {
    this.gate("bootstrap");
    const flag = (name: string): string => {
      const index = argv.indexOf(name);
      return index < 0 ? "" : argv[index + 1] ?? "";
    };
    const requested: HostBinding = {
      repository: flag("--repository"),
      githubEnvironment: flag("--github-environment"),
      targetName: flag("--target-name"),
      targetId: flag("--target-id"),
      bindingId: flag("--binding-id"),
      // The installer just placed this release on the host.
      runtimeVersion: VERSION,
      runtimeBundleSha256: flag("--sha256"),
    };
    // Exit 4 is the installer's frozen "already bound to something else" status.
    if (this.binding !== null && this.binding.bindingId !== requested.bindingId) {
      return { stdout: "", stderr: "", exitCode: 4 };
    }
    const changed = this.binding === null;
    this.binding = requested;
    this.bootstrapCount += 1;
    return ok(
      `DEPLOYKIT_BOOTSTRAP_RESULT ${JSON.stringify({
        version: 1,
        changed,
        bindingId: requested.bindingId,
        targetId: requested.targetId,
        gatewayUser: GATEWAY_USER,
        runtimeVersion: requested.runtimeVersion,
        runtimeBundleSha256: requested.runtimeBundleSha256,
        repositoryKeyId: `repo-${requested.targetId}`,
        repositoryPublicKey: this.repositoryPublicKey,
        repositoryPublicKeyFingerprint: this.repositoryPublicKeyFingerprint,
      })}\n`,
    );
  }

  private keyHelper(argv: readonly string[], input?: string): AdministratorRunResult {
    const verb = argv.find((value) => value === "stage" || value === "activate" || value === "list");
    const keyIdIndex = argv.indexOf("--key-id");
    const keyId = keyIdIndex < 0 ? "" : argv[keyIdIndex + 1] ?? "";

    if (verb === "stage") {
      this.gate("key.stage");
      // Staging drops this binding's stale pending entries as it appends the
      // replacement, and never touches the proven active one.
      for (let index = this.keys.length - 1; index >= 0; index -= 1) {
        if (this.keys[index]?.state === "pending") this.keys.splice(index, 1);
      }
      const parts = (input ?? "").trim().split(/\s+/u);
      this.keys.push({ state: "pending", keyId, type: parts[0] ?? "", key: parts[1] ?? "" });
      return ok("");
    }
    if (verb === "activate") {
      this.gate("key.activate");
      const pending = this.keys.find((entry) => entry.state === "pending" && entry.keyId === keyId);
      if (pending === undefined) return { stdout: "", stderr: "no such pending key", exitCode: 1 };
      this.keys.length = 0;
      this.keys.push({ ...pending, state: "active" });
      return ok("");
    }
    if (verb === "list") {
      return ok(this.keys.map((entry) => JSON.stringify(entry)).join("\n"));
    }
    return { stdout: "", stderr: "unknown key helper verb", exitCode: 1 };
  }

  private sourceProbe(argv: readonly string[]): AdministratorRunResult {
    this.gate("source.probe");
    const index = argv.indexOf("--repository");
    const repository = index < 0 ? "" : argv[index + 1] ?? "";
    const identity = this.sourceProbeIdentity ?? repository;
    // Exit 5 is the probe's frozen "authenticated as somebody else" status.
    if (identity !== repository) return { stdout: "", stderr: "", exitCode: 5 };
    return ok(
      `DEPLOYKIT_SOURCE_PROBE ${JSON.stringify({
        version: 1,
        repository,
        authenticatedAs: identity,
        keyFingerprint: this.repositoryPublicKeyFingerprint,
        reachable: true,
      })}\n`,
    );
  }

  /** Answers one gateway request stream with a canonical output stream. */
  private gatewaySession(input: string): AdministratorRunResult {
    const first = input.split("\n").find((line) => line.trim() !== "");
    if (first === undefined) return { stdout: "", stderr: "", exitCode: 1 };
    const request = JSON.parse(first) as {
      requestId: RequestId;
      operation: string;
      repository: string;
      targetId: string;
      targetName: string;
      commitSha: GitCommitSha | null;
      manifestDigest: unknown;
    };
    const binding = this.binding;
    if (binding === null) return { stdout: "", stderr: "no gateway installed", exitCode: 127 };
    if (binding.repository !== request.repository || binding.targetId !== request.targetId) {
      return ok(encodeGatewayFrames(failureFrames(request.requestId)));
    }
    const payload: GatewayResultPayload =
      request.operation === "handshake"
        ? ({
            kind: "handshake",
            bindingId: binding.bindingId,
            targetId: binding.targetId,
            runtimeVersion: binding.runtimeVersion,
            runtimeBundleSha256: binding.runtimeBundleSha256 as GatewayHandshakeResult["runtimeBundleSha256"],
            capabilities: ["handshake", "apply", "retry", "inspect"],
          } satisfies GatewayHandshakeResult)
        : ({
            kind: "deployment",
            outcome: "succeeded",
            targetName: request.targetName,
            targetId: request.targetId,
            commitSha: request.commitSha,
            manifestDigest: request.manifestDigest as GatewayDeploymentResult["manifestDigest"],
            phase: "complete",
            domains: ["static.example.test", "www.static.example.test"],
            ports: [{ service: "api", address: "127.0.0.1", port: 41_101 }],
            health: [{ service: "api", healthy: true, check: "http" }],
            resumed: false,
            failureCode: null,
            ...this.options.deployment,
          } satisfies GatewayDeploymentResult);
    return ok(encodeGatewayFrames(successFrames(request.requestId, payload)));
  }
}

function ok(stdout: string): AdministratorRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/** The standard OpenSSH SHA-256 fingerprint of a public key line. */
export function fingerprintOf(publicKey: string): string {
  const material = publicKey.trim().split(/\s+/u)[1] ?? "";
  const digest = createHash("sha256").update(Buffer.from(material, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/u, "")}`;
}

/**
 * The remote argv of an `ssh` invocation: everything after `user@host`. An
 * empty result means the forced command decides, which is how the gateway
 * transport connects.
 */
export function remoteArguments(args: readonly string[]): readonly string[] {
  for (let index = args.length - 1; index >= 2; index -= 1) {
    if (args[index - 2] === "-p" && (args[index] ?? "").includes("@")) return args.slice(index + 1);
  }
  return [];
}

function successFrames(requestId: RequestId, result: GatewayResultPayload): GatewayOutputFrame[] {
  return [
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "progress",
      requestId,
      sequence: 1,
      time: "2026-01-01T00:00:05.000Z",
      level: "info",
      phase: "handshake",
      code: "DK_GATEWAY_OK",
      message: "the gateway accepted the request",
    },
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "result",
      requestId,
      sequence: 2,
      time: "2026-01-01T00:00:06.000Z",
      ok: true,
      code: "DK_GATEWAY_OK",
      recovery: "none",
      result,
    },
  ];
}

function failureFrames(requestId: RequestId): GatewayOutputFrame[] {
  return [
    {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      frame: "result",
      requestId,
      sequence: 1,
      time: "2026-01-01T00:00:06.000Z",
      ok: false,
      code: "DK_GATEWAY_BINDING_MISMATCH",
      recovery: "resolve-ownership-conflict",
      result: null,
    },
  ];
}

// ----------------------------------------------------------- key pairs ---

/**
 * A gateway key pair generator that never shells out. The private key carries a
 * canary, so every leak assertion in the suite is about a value the run really
 * held.
 */
export class HermeticKeyPairs implements GatewayKeyPairGenerator {
  readonly generated: string[] = [];

  async generate(directory: string, keyId: string): Promise<GeneratedGatewayKeyPair> {
    this.generated.push(keyId);
    const privateKeyFile = join(directory, "gateway-key");
    const privateKey = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      CANARY_GATEWAY_PRIVATE_KEY,
      keyMaterial(`private:${keyId}`),
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    const publicKey = `ssh-ed25519 ${keyMaterial(`public:${keyId}`)} ${keyId}`;
    await writeFile(privateKeyFile, privateKey, { mode: 0o600 });
    await writeFile(`${privateKeyFile}.pub`, `${publicKey}\n`, { mode: 0o600 });
    return { privateKeyFile, privateKey, publicKey };
  }
}

// ------------------------------------------------------ application repo ---

export const FIXTURE_ROOT = join("test", "fixtures", "static-compose");

async function copyTree(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyTree(source, destination);
      continue;
    }
    if (entry.name === "deploykit.config.fixture.yaml") continue;
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
}

export interface ApplicationRepository {
  readonly root: string;
  readonly configPath: string;
  readonly source: string;
}

/**
 * Materializes the static-compose fixture as a real Git repository with a real
 * mode-0600, Git-excluded `deploykit.config.yaml`. The production config
 * adapter refuses anything less, so the suite has to satisfy it for real.
 */
export async function createApplicationRepository(
  root: string,
  git: (args: readonly string[]) => Promise<void>,
  edit: (source: string) => string = (source) => source,
): Promise<ApplicationRepository> {
  await mkdir(root, { recursive: true });
  await git(["init", "--initial-branch=main", root]);
  await copyTree(FIXTURE_ROOT, root);

  const template = await readFile(join(FIXTURE_ROOT, "deploykit.config.fixture.yaml"), "utf8");
  const source = edit(
    template
      .replace('"static-fixture-ops@static.example.test"', `"${CANARY_BACKEND_SECRET}"`)
      .replace("\n  ref: main\n", `\n  ref: ${APPLICATION_REF}\n`),
  );
  const configPath = join(root, "deploykit.config.yaml");
  await writeFile(configPath, source, { mode: 0o600 });
  await chmod(configPath, 0o600);
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await writeFile(join(root, ".git", "info", "exclude"), "/deploykit.config.yaml\n");
  return { root, configPath, source };
}

/** A runtime bundle reference that names a real file without packing one. */
export async function createRuntimeBundle(directory: string): Promise<{
  readonly version: string;
  readonly packageName: string;
  readonly packageFile: string;
  readonly packageSha256: string;
}> {
  await mkdir(directory, { recursive: true });
  const packageFile = join(directory, `deploykit-${VERSION}.tgz`);
  const contents = `deploykit runtime bundle ${randomUUID()}`;
  await writeFile(packageFile, contents);
  return {
    version: VERSION,
    packageName: "@deploykit001/deploykit",
    packageFile,
    packageSha256: createHash("sha256").update(contents).digest("hex"),
  };
}
