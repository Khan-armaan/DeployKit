import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

import { DeployKitError } from "../src/errors.js";
import {
  encodeGatewayFrames,
  parseGatewayRequestStream,
} from "../src/gateway/protocol.js";
import { compileRuntimeManifest } from "../src/orchestrator/compile.js";
import { parseOperatorConfig, type EnvironmentPartition } from "../src/orchestrator/config-schema.js";
import {
  GATEWAY_PROTOCOL_VERSION,
  MANAGED_OWNERSHIP_PATH,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_WORKFLOW_PATH,
  type GatewayOutputFrame,
} from "../src/orchestrator/contracts.js";
import { createControlArtifactsReconciler } from "../src/orchestrator/control-artifacts.js";
import type {
  ControlArtifactsState,
  DesiredControlArtifacts,
} from "../src/orchestrator/dependencies.js";
import type {
  GitHubBranch,
  GitHubClient,
  GitHubComparison,
  GitHubFileContents,
  GitHubFileWriteRequest,
  GitHubFileWriteResult,
  GitHubPullRequest,
} from "../src/orchestrator/github.js";
import {
  createDesiredStatePlanner,
  makeManagedResourceNames,
  type DeploymentContext,
  type RuntimeBundleReference,
} from "../src/orchestrator/planner.js";
import {
  MANAGED_CHECKOUT_ACTION_SHA,
  MANAGED_WORKFLOW_ASSET,
  createManagedWorkflowRenderer,
  readBundledGatewayClient,
  renderManagedWorkflow,
  resolveBundledGatewayClientPath,
} from "../src/orchestrator/workflow.js";

const run = promisify(execFile);

const BACKEND_CANARY = "DK_CANARY_CERTBOT_EMAIL_5f3a1c";
const GATEWAY_KEY_CANARY = "DK_CANARY_GATEWAY_PRIVATE_KEY_9f13ab";
const UNRELATED_SECRET_CANARY = "DK_CANARY_UNDECLARED_TOKEN_7e11f0";

const DEFAULT_BRANCH = "main";
const DEFAULT_BRANCH_SHA = "2".repeat(39) + "b";
const COMMIT_SHA = "1".repeat(39) + "a";
const REQUEST_ID = "0f9c4f3a-1d2e-4b5c-8a7d-6e5f4a3b2c1d";

const RUNTIME_BUNDLE: RuntimeBundleReference = {
  version: "0.1.3",
  packageName: "@deploykit001/deploykit",
  packageFile: "/tmp/deploykit-server-bundle.tgz",
  packageSha256: "f".repeat(64),
};

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "deploykit-control-"));
  temporaryDirectories.push(path);
  return path;
}

// ------------------------------------------------------------- deployment --

async function deploymentContext(): Promise<DeploymentContext> {
  const source = await readFile(
    resolve("test", "fixtures", "static-compose", "deploykit.config.fixture.yaml"),
    "utf8",
  );
  const parsed = parseOperatorConfig(parseYaml(source));
  const compiled = compileRuntimeManifest(parsed);
  // A canary replaces the fixture's backend value so every "no secret reached
  // this artifact" assertion is testing a value that really is in memory.
  const environment: EnvironmentPartition = {
    ...parsed.environment,
    backendValues: Object.fromEntries(
      Object.keys(parsed.environment.backendValues).map((name) => [name, BACKEND_CANARY]),
    ),
  };
  return {
    compiled,
    environment,
    repository: parsed.config.project.repository,
    targetName: parsed.config.target.name,
    targetId: compiled.targetId,
    githubEnvironment: parsed.config.target.githubEnvironment,
    primaryDomain: parsed.config.target.primaryDomain,
    applicationRef: parsed.config.project.ref,
    defaultBranch: DEFAULT_BRANCH,
    names: makeManagedResourceNames(compiled.targetId),
  };
}

async function desiredArtifacts(
  context: DeploymentContext,
): Promise<DesiredControlArtifacts> {
  const planner = createDesiredStatePlanner({
    renderWorkflow: createManagedWorkflowRenderer(),
    runtimeBundle: RUNTIME_BUNDLE,
  });
  return planner.controlArtifacts(context);
}

// -------------------------------------------------------------- fake world --

interface FakeBranch {
  sha: string;
  protectedBranch: boolean;
  files: Map<string, string>;
}

interface FakePull {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  baseRef: string;
}

/**
 * One repository, in memory. Every method a later phase owns throws, so a test
 * that passes proves this phase reached neither Environment secrets nor
 * workflow dispatch.
 */
class FakeRepository {
  readonly calls: string[] = [];
  readonly branches = new Map<string, FakeBranch>();
  readonly pulls: FakePull[] = [];
  private counter = 0;
  onPoll: (() => void) | null = null;

  constructor(readonly repository: string, defaultFiles: ReadonlyMap<string, string> = new Map()) {
    this.branches.set(DEFAULT_BRANCH, {
      sha: DEFAULT_BRANCH_SHA,
      protectedBranch: true,
      files: new Map(defaultFiles),
    });
  }

  branch(name: string): FakeBranch {
    const branch = this.branches.get(name);
    if (branch === undefined) throw new Error(`no branch ${name}`);
    return branch;
  }

  advance(branch: FakeBranch): void {
    this.counter += 1;
    branch.sha = this.counter.toString(16).padStart(40, "c");
  }

  /** What a human does after reviewing: merge the head branch into the base. */
  merge(number: number): void {
    const pull = this.pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new Error(`no pull request ${String(number)}`);
    const head = this.branch(pull.headRef);
    const base = this.branch(pull.baseRef);
    for (const [path, contents] of head.files) base.files.set(path, contents);
    this.advance(base);
    pull.merged = true;
    pull.state = "closed";
  }

  close(number: number): void {
    const pull = this.pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new Error(`no pull request ${String(number)}`);
    pull.state = "closed";
  }
}

function fakeClient(world: FakeRepository): GitHubClient {
  const forbidden = (name: string) => () => {
    throw new Error(`Phase 10 must not call ${name}`);
  };
  return {
    async getBranch(_repository: string, name: string): Promise<GitHubBranch | undefined> {
      world.calls.push(`getBranch ${name}`);
      const branch = world.branches.get(name);
      if (branch === undefined) return undefined;
      return { name, commitSha: branch.sha, protected: branch.protectedBranch };
    },
    async createBranch(_repository: string, name: string, sha: string): Promise<GitHubBranch> {
      world.calls.push(`createBranch ${name}`);
      if (world.branches.has(name)) throw new Error("branch exists");
      const source = [...world.branches.values()].find((entry) => entry.sha === sha);
      if (source === undefined) throw new Error("unknown base commit");
      world.branches.set(name, { sha, protectedBranch: false, files: new Map(source.files) });
      return { name, commitSha: sha, protected: false };
    },
    async readFile(
      _repository: string,
      path: string,
      ref: string,
    ): Promise<GitHubFileContents | undefined> {
      world.calls.push(`readFile ${ref} ${path}`);
      const contents = world.branches.get(ref)?.files.get(path);
      if (contents === undefined) return undefined;
      return {
        path,
        blobSha: `blob-${String(contents.length)}-${path}`,
        byteLength: Buffer.byteLength(contents, "utf8"),
        contents,
      };
    },
    async writeFile(request: GitHubFileWriteRequest): Promise<GitHubFileWriteResult> {
      world.calls.push(`writeFile ${request.branch} ${request.path}`);
      const branch = world.branch(request.branch);
      const existing = branch.files.get(request.path);
      if (existing === undefined && request.expectedBlobSha !== undefined) {
        throw new Error("blob sha supplied for a file that does not exist");
      }
      if (existing !== undefined && request.expectedBlobSha === undefined) {
        throw new Error("an existing file was overwritten without its blob sha");
      }
      branch.files.set(request.path, request.contents);
      world.advance(branch);
      return { path: request.path, blobSha: `blob-${request.path}`, commitSha: branch.sha };
    },
    async compareCommits(
      _repository: string,
      base: string,
      head: string,
    ): Promise<GitHubComparison | undefined> {
      world.calls.push(`compareCommits ${base}...${head}`);
      const left = world.branches.get(base);
      const right = world.branches.get(head);
      if (left === undefined || right === undefined) return undefined;
      const paths = new Set([...left.files.keys(), ...right.files.keys()]);
      const files = [...paths]
        .filter((path) => left.files.get(path) !== right.files.get(path))
        .sort();
      return { status: "diverged", aheadBy: files.length, behindBy: 0, files, truncated: false };
    },
    async listPullRequests(
      _repository: string,
      query: { readonly headRef?: string; readonly state?: "open" | "closed" | "all" },
    ): Promise<readonly GitHubPullRequest[]> {
      world.calls.push(`listPullRequests ${query.headRef ?? "*"}`);
      return world.pulls
        .filter((pull) => query.headRef === undefined || pull.headRef === query.headRef)
        .map((pull) => toPullRequest(world, pull));
    },
    async getPullRequest(_repository: string, number: number): Promise<GitHubPullRequest | undefined> {
      world.calls.push(`getPullRequest ${String(number)}`);
      const pull = world.pulls.find((entry) => entry.number === number);
      return pull === undefined ? undefined : toPullRequest(world, pull);
    },
    async createPullRequest(request: {
      readonly headRef: string;
      readonly baseRef: string;
      readonly title: string;
    }): Promise<GitHubPullRequest> {
      world.calls.push(`createPullRequest ${request.headRef}`);
      const pull: FakePull = {
        number: world.pulls.length + 1,
        title: request.title,
        state: "open",
        merged: false,
        headRef: request.headRef,
        baseRef: request.baseRef,
      };
      world.pulls.push(pull);
      return toPullRequest(world, pull);
    },
    getTokenIdentity: forbidden("getTokenIdentity"),
    getRepositoryMetadata: forbidden("getRepositoryMetadata"),
    getRepositoryFacts: forbidden("getRepositoryFacts"),
    resolveCommit: forbidden("resolveCommit"),
    getEnvironment: forbidden("getEnvironment"),
    ensureEnvironment: forbidden("ensureEnvironment"),
    listEnvironmentVariables: forbidden("listEnvironmentVariables"),
    setEnvironmentVariable: forbidden("setEnvironmentVariable"),
    deleteEnvironmentVariable: forbidden("deleteEnvironmentVariable"),
    listEnvironmentSecretNames: forbidden("listEnvironmentSecretNames"),
    setEnvironmentSecret: forbidden("setEnvironmentSecret"),
    deleteEnvironmentSecret: forbidden("deleteEnvironmentSecret"),
    listDeployKeys: forbidden("listDeployKeys"),
    createDeployKey: forbidden("createDeployKey"),
    deleteDeployKey: forbidden("deleteDeployKey"),
    dispatchWorkflow: forbidden("dispatchWorkflow"),
    listWorkflowRuns: forbidden("listWorkflowRuns"),
    getWorkflowRun: forbidden("getWorkflowRun"),
  } as unknown as GitHubClient;
}

function toPullRequest(world: FakeRepository, pull: FakePull): GitHubPullRequest {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged,
    mergeCommitSha: pull.merged ? world.branch(pull.baseRef).sha : null,
    headRef: pull.headRef,
    headSha: world.branches.get(pull.headRef)?.sha ?? COMMIT_SHA,
    baseRef: pull.baseRef,
    draft: false,
    url: `https://github.com/${world.repository}/pull/${String(pull.number)}`,
  };
}

function reconciler(
  world: FakeRepository,
  overrides: { readonly waitForMerge?: boolean } = {},
) {
  return createControlArtifactsReconciler({
    client: fakeClient(world),
    pollIntervalMs: 1,
    maxWaitMs: 50,
    now: () => Date.now(),
    sleep: async () => {
      world.onPoll?.();
    },
    ...overrides,
  });
}

function fileMap(desired: DesiredControlArtifacts): Map<string, string> {
  return new Map(desired.artifacts.map((artifact) => [artifact.path, artifact.contents]));
}

// ------------------------------------------------------------------ tests --

describe("managed workflow bytes", () => {
  it("renders the same bytes for the same deployment", async () => {
    const context = await deploymentContext();
    const first = renderManagedWorkflow(context);
    const second = renderManagedWorkflow(context);
    expect(first).toBe(second);
    expect(createManagedWorkflowRenderer()(context)).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
  });

  it("is minimal, pinned, target-scoped, and cleans up in always()", async () => {
    const workflow = parseYaml(renderManagedWorkflow(await deploymentContext())) as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
    const context = await deploymentContext();

    expect(workflow["permissions"]).toEqual({ contents: "read" });
    expect(workflow["concurrency"]).toEqual({
      group: `deploykit-${context.targetId}`,
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow["on"])).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflow["on"].workflow_dispatch.inputs).sort()).toEqual([
      "commit_sha",
      "dry_run",
      "manifest_digest",
      "request_id",
      "resume",
      "target",
    ]);

    const job = workflow["jobs"].deploy;
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.environment).toBe(context.githubEnvironment);
    expect(job["timeout-minutes"]).toBeGreaterThan(0);

    const steps = job.steps as { name: string; uses?: string; if?: string; with?: Record<string, unknown> }[];
    const uses = steps.filter((step) => step.uses !== undefined).map((step) => step.uses ?? "");
    expect(uses).toEqual([`actions/checkout@${MANAGED_CHECKOUT_ACTION_SHA}`]);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/u);
    expect(steps.find((step) => step.uses !== undefined)?.with).toMatchObject({
      "persist-credentials": false,
    });
    const cleanup = steps.at(-1);
    expect(cleanup?.name).toContain("Remove");
    expect(cleanup?.if).toBe("always()");
  });

  it("pins the host, refuses interactivity, and never writes a credential to the workspace", async () => {
    const text = renderManagedWorkflow(await deploymentContext());
    expect(text).toContain("StrictHostKeyChecking=yes");
    expect(text).toContain("BatchMode=yes");
    expect(text).toContain("IdentitiesOnly=yes");
    expect(text).toContain("ClearAllForwardings=yes");
    expect(text).not.toContain("StrictHostKeyChecking=no");
    expect(text).not.toContain("ssh-keyscan");
    expect(text).toContain("${RUNNER_TEMP}/deploykit-gateway");
    expect(text).not.toContain("~/.ssh");
  });

  it("carries no secret value and no dispatch of its own", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    for (const artifact of desired.artifacts) {
      expect(artifact.contents).not.toContain(BACKEND_CANARY);
      expect(artifact.contents).not.toContain(GATEWAY_KEY_CANARY);
      expect(artifact.contents).not.toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(artifact.contents).not.toContain("gh auth token");
    }
    // The runtime manifest names the secrets; it never carries their values.
    const manifest = desired.artifacts.find(
      (artifact) => artifact.path === MANAGED_RUNTIME_MANIFEST_PATH,
    );
    expect(manifest?.contents).toContain("CERTBOT_EMAIL");
    expect(manifest?.contents).not.toContain(BACKEND_CANARY);
  });

  it("finds its bundled client from the installed package layout", async () => {
    expect(readBundledGatewayClient()).toContain("deploykit/gateway/v1alpha1");
    expect(resolveBundledGatewayClientPath()).toBe(resolve(MANAGED_WORKFLOW_ASSET));
    // A package root without the asset is a refusal, never a silent empty client.
    const empty = await scratch();
    expect(() => readBundledGatewayClient(empty)).toThrow(DeployKitError);
  });

  it("embeds the reviewed client so the runner reproduces it byte for byte", async () => {
    const directory = await scratch();
    const text = renderManagedWorkflow(await deploymentContext());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workflow = parseYaml(text) as any;
    const install = (workflow.jobs.deploy.steps as { name: string; run?: string }[]).find((step) =>
      step.name.includes("gateway client"),
    );
    expect(install?.run).toBeTypeOf("string");

    await mkdir(join(directory, "runner", "deploykit-gateway"), { recursive: true });
    const script = join(directory, "install.sh");
    await writeFile(script, `${install?.run ?? ""}\n`, "utf8");
    await run("bash", [script], { env: { ...process.env, RUNNER_TEMP: join(directory, "runner") } });

    const reproduced = await readFile(
      join(directory, "runner", "deploykit-gateway", "client.mjs"),
      "utf8",
    );
    expect(reproduced).toBe(readBundledGatewayClient());
  });
});

describe("embedded gateway client", () => {
  interface ClientRun {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly request: string;
    readonly sshArguments: readonly string[];
  }

  async function runClient(
    overrides: Readonly<Record<string, string>> = {},
    response?: string,
  ): Promise<ClientRun> {
    const directory = await scratch();
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    for (const artifact of desired.artifacts) {
      await mkdir(join(directory, artifact.path, ".."), { recursive: true });
      await writeFile(join(directory, artifact.path), artifact.contents, "utf8");
    }

    const capture = join(directory, "request.jsonl");
    const argumentsFile = join(directory, "ssh-args");
    const responseFile = join(directory, "response.jsonl");
    await writeFile(responseFile, response ?? successResponse(), "utf8");
    const binaries = join(directory, "bin");
    await mkdir(binaries, { recursive: true });
    await writeFile(
      join(binaries, "ssh"),
      ['#!/bin/sh', 'printf "%s\\n" "$@" > "$DK_TEST_ARGS"', 'cat > "$DK_TEST_CAPTURE"', 'cat "$DK_TEST_RESPONSE"', "exit 0"].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    await writeFile(join(directory, "identity"), "not-a-real-key\n", "utf8");
    await writeFile(join(directory, "known_hosts"), "gateway.example.test ssh-ed25519 AAAA\n", "utf8");

    const environment: Record<string, string> = {
      PATH: `${binaries}:${process.env["PATH"] ?? ""}`,
      DK_TEST_CAPTURE: capture,
      DK_TEST_ARGS: argumentsFile,
      DK_TEST_RESPONSE: responseFile,
      DK_REPOSITORY: context.repository,
      DK_TARGET_NAME: context.targetName,
      DK_TARGET_ID: context.targetId,
      DK_ENVIRONMENT: context.githubEnvironment,
      DK_ENVIRONMENT_TARGET_ID: context.targetId,
      DK_APPLICATION_REF: context.applicationRef,
      DK_REQUEST_ID: REQUEST_ID,
      DK_TARGET_INPUT: context.targetName,
      DK_COMMIT_SHA: COMMIT_SHA,
      DK_MANIFEST_DIGEST: context.compiled.digest.value,
      DK_RESUME: "false",
      DK_DRY_RUN: "false",
      DK_WORKFLOW_FILE: MANAGED_WORKFLOW_PATH,
      DK_MANIFEST_FILE: MANAGED_RUNTIME_MANIFEST_PATH,
      DK_OWNERSHIP_FILE: MANAGED_OWNERSHIP_PATH,
      DK_GATEWAY_HOST: "gateway.example.test",
      DK_GATEWAY_PORT: "22",
      DK_GATEWAY_USER: "deploykit-gateway",
      DK_IDENTITY_FILE: join(directory, "identity"),
      DK_KNOWN_HOSTS_FILE: join(directory, "known_hosts"),
      DK_SECRETS_JSON: JSON.stringify({
        CERTBOT_EMAIL: BACKEND_CANARY,
        DEPLOYKIT_GATEWAY_PRIVATE_KEY: GATEWAY_KEY_CANARY,
        GITHUB_TOKEN: UNRELATED_SECRET_CANARY,
      }),
      ...overrides,
    };

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const result = await run("node", [resolve("assets", "gateway-client.mjs")], {
        cwd: directory,
        env: environment,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? "";
      exitCode = failure.code ?? 1;
    }
    const request = await readFile(capture, "utf8").catch(() => "");
    const sshArguments = await readFile(argumentsFile, "utf8")
      .then((text) => text.split("\n").filter((entry) => entry !== ""))
      .catch(() => [] as string[]);
    return { stdout, stderr, exitCode, request, sshArguments };
  }

  function successResponse(): string {
    const frames: GatewayOutputFrame[] = [
      {
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        frame: "progress",
        requestId: REQUEST_ID,
        sequence: 1,
        time: "2026-01-01T00:00:00.000Z",
        level: "info",
        phase: "manifest-validated",
        code: "DK_PHASE_STARTED",
        message: "validated the runtime manifest",
      },
      {
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        frame: "result",
        requestId: REQUEST_ID,
        sequence: 2,
        time: "2026-01-01T00:00:05.000Z",
        ok: true,
        code: "DK_GATEWAY_OK",
        recovery: "none",
        result: {
          kind: "deployment",
          outcome: "succeeded",
          targetName: "production",
          targetId: "0".repeat(32),
          commitSha: COMMIT_SHA,
          manifestDigest: null,
          phase: "complete",
          domains: ["static.example.test"],
          ports: [{ service: "api", address: "127.0.0.1", port: 41000 }],
          health: [{ service: "api", healthy: true, check: "http" }],
          resumed: false,
          failureCode: null,
        },
      },
    ];
    return encodeGatewayFrames(frames);
  }

  it("produces a request stream the finalized gateway protocol accepts", async () => {
    const context = await deploymentContext();
    const result = await runClient();
    expect(result.exitCode).toBe(0);

    const stream = parseGatewayRequestStream(result.request);
    expect(stream.operation).toBe("apply");
    expect(stream.requestId).toBe(REQUEST_ID);
    expect(stream.request.commitSha).toBe(COMMIT_SHA);
    expect(stream.manifestDigest?.value).toBe(context.compiled.digest.value);
    expect(stream.manifestBytes?.toString("utf8")).toBe(
      context.compiled.canonicalBytes.toString("utf8"),
    );
    expect(stream.dryRun).toBe(false);
    // Only the secrets the reviewed ownership marker declares are framed.
    expect([...stream.secrets.keys()]).toEqual(["CERTBOT_EMAIL"]);
    expect(stream.secrets.get("CERTBOT_EMAIL")).toBe(BACKEND_CANARY);
  });

  it("sends a retry when the dispatch asks to resume", async () => {
    const result = await runClient({ DK_RESUME: "true" });
    expect(result.exitCode).toBe(0);
    expect(parseGatewayRequestStream(result.request).operation).toBe("retry");
  });

  it("connects with a pinned host key, no agent, and no interactivity", async () => {
    const result = await runClient();
    const args = result.sshArguments.join(" ");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("PasswordAuthentication=no");
    expect(result.sshArguments).toContain("-T");
    expect(result.sshArguments).toContain("-a");
    // No secret is ever an argument.
    expect(args).not.toContain(BACKEND_CANARY);
    expect(args).not.toContain(GATEWAY_KEY_CANARY);
  });

  it("leaks no secret through its own output", async () => {
    const result = await runClient();
    for (const canary of [BACKEND_CANARY, GATEWAY_KEY_CANARY, UNRELATED_SECRET_CANARY]) {
      expect(result.stdout).not.toContain(canary);
      expect(result.stderr).not.toContain(canary);
    }
    expect(result.stdout).toContain("manifest-validated");
    expect(result.stdout).toContain("succeeded");
  });

  it("refuses a dispatch whose digest does not match the reviewed manifest", async () => {
    const result = await runClient({ DK_MANIFEST_DIGEST: "a".repeat(64) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not hash to the dispatched manifest digest");
    expect(result.request).toBe("");
  });

  it("refuses a dispatch aimed at another target", async () => {
    const result = await runClient({ DK_TARGET_INPUT: "staging" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not the target this workflow deploys");
    expect(result.request).toBe("");
  });

  it("refuses an Environment bound to another target id", async () => {
    const result = await runClient({ DK_ENVIRONMENT_TARGET_ID: "0".repeat(32) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not the target id this workflow deploys");
    expect(result.request).toBe("");
  });

  it("refuses to deploy when a declared secret is missing from the Environment", async () => {
    const result = await runClient({ DK_SECRETS_JSON: JSON.stringify({ UNRELATED: "x" }) });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CERTBOT_EMAIL");
    expect(result.request).toBe("");
  });

  it("reports a failing gateway result as a failing job", async () => {
    const response = encodeGatewayFrames([
      {
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        frame: "result",
        requestId: REQUEST_ID,
        sequence: 1,
        time: "2026-01-01T00:00:05.000Z",
        ok: false,
        code: "DK_DEPLOYMENT_FAILED",
        recovery: "rerun-same-command",
        result: null,
      },
    ]);
    const result = await runClient({}, response);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("DK_DEPLOYMENT_FAILED");
    expect(result.stderr).toContain("rerun-same-command");
  });

  it("refuses a result frame belonging to another request", async () => {
    const response = encodeGatewayFrames([
      {
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        frame: "result",
        requestId: "11111111-2222-4333-8444-555555555555",
        sequence: 1,
        time: "2026-01-01T00:00:05.000Z",
        ok: true,
        code: "DK_GATEWAY_OK",
        recovery: "none",
        result: {
          kind: "handshake",
          bindingId: "b".repeat(32),
          targetId: "0".repeat(32),
          runtimeVersion: "0.1.3",
          runtimeBundleSha256: "f".repeat(64),
          capabilities: ["apply"],
        },
      },
    ]);
    const result = await runClient({}, response);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("belongs to another request");
  });
});

describe("setup pull request", () => {
  it("creates the branch, writes only the managed files, and opens one pull request", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    const state = await reconciler(world, { waitForMerge: false }).reconcile(desired);

    expect(state.status).toBe("setup-pull-request");
    expect(state.setupPullRequestNumber).toBe(1);
    expect(state.setupPullRequestState).toBe("open");
    expect(world.pulls).toHaveLength(1);
    expect(world.pulls[0]?.baseRef).toBe(DEFAULT_BRANCH);
    expect(world.pulls[0]?.headRef).toBe(desired.names.setupBranch);
    expect([...world.branch(desired.names.setupBranch).files.keys()].sort()).toEqual(
      [MANAGED_OWNERSHIP_PATH, MANAGED_RUNTIME_MANIFEST_PATH, MANAGED_WORKFLOW_PATH].sort(),
    );
    // Nothing on the protected branch changed.
    expect(world.branch(DEFAULT_BRANCH).files.size).toBe(0);
    expect(world.branch(DEFAULT_BRANCH).sha).toBe(DEFAULT_BRANCH_SHA);
  });

  it("never merges, approves, or bypasses protection for the operator", async () => {
    const context = await deploymentContext();
    const world = new FakeRepository(context.repository);
    await reconciler(world, { waitForMerge: false }).reconcile(await desiredArtifacts(context));
    expect(world.calls.join(" ")).not.toMatch(/merge|approve|review|protection/iu);
    expect(world.pulls.every((pull) => !pull.merged)).toBe(true);
  });

  it("reuses the open pull request and writes nothing on a rerun", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    const machine = reconciler(world, { waitForMerge: false });

    await machine.reconcile(desired);
    const branchSha = world.branch(desired.names.setupBranch).sha;
    world.calls.length = 0;

    const second = await machine.reconcile(desired);
    expect(second.setupPullRequestNumber).toBe(1);
    expect(world.pulls).toHaveLength(1);
    expect(world.branch(desired.names.setupBranch).sha).toBe(branchSha);
    expect(world.calls.filter((call) => call.startsWith("writeFile"))).toHaveLength(0);
    expect(world.calls.filter((call) => call.startsWith("createPullRequest"))).toHaveLength(0);
  });

  it("verifies the exact default-branch bytes once the review is merged", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    world.onPoll = () => {
      if (!world.pulls[0]?.merged) world.merge(1);
    };

    const state = await reconciler(world).reconcile(desired);
    expect(state.status).toBe("current");
    expect(state.setupPullRequestState).toBe("merged");
    expect(state.defaultBranchCommitSha).not.toBe(DEFAULT_BRANCH_SHA);
    const workflow = desired.artifacts.find((artifact) => artifact.path === MANAGED_WORKFLOW_PATH);
    const ownership = desired.artifacts.find((artifact) => artifact.path === MANAGED_OWNERSHIP_PATH);
    expect(state.workflowDigest).toBe(workflow?.sha256);
    expect(state.ownershipDigest).toBe(ownership?.sha256);
    expect(state.runtimeManifestDigest?.value).toBe(context.compiled.digest.value);
  });

  it("is already reconciled when the merged bytes are still on the default branch", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository, fileMap(desired));
    world.calls.length = 0;

    const state = await reconciler(world).reconcile(desired);
    expect(state.status).toBe("current");
    expect(world.pulls).toHaveLength(0);
    expect(world.calls.filter((call) => call.startsWith("writeFile"))).toHaveLength(0);
    expect(world.calls.filter((call) => call.startsWith("createBranch"))).toHaveLength(0);
  });

  it("reports drift when the merged control artifacts were edited afterwards", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const merged = fileMap(desired);
    merged.set(MANAGED_WORKFLOW_PATH, `${merged.get(MANAGED_WORKFLOW_PATH) ?? ""}# edited\n`);
    const world = new FakeRepository(context.repository, merged);

    expect(await reconciler(world, { waitForMerge: false }).inspect(desired)).toMatchObject({
      status: "drifted",
    });
    world.onPoll = () => {
      // The reviewer merges, but the edited workflow survives on the branch.
      if (!world.pulls[0]?.merged) {
        world.branch(DEFAULT_BRANCH).files.set(
          MANAGED_WORKFLOW_PATH,
          merged.get(MANAGED_WORKFLOW_PATH) ?? "",
        );
        world.merge(1);
        world.branch(DEFAULT_BRANCH).files.set(
          MANAGED_WORKFLOW_PATH,
          `${merged.get(MANAGED_WORKFLOW_PATH) ?? ""}# edited again\n`,
        );
      }
    };
    const state = await reconciler(world).reconcile(desired);
    expect(state.status).toBe("drifted");
    expect(state.setupPullRequestState).toBe("merged");
  });

  it("stops resumably without waiting when the review is left open", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    const first = await reconciler(world, { waitForMerge: false }).reconcile(desired);
    expect(first.status).toBe("setup-pull-request");
    expect(world.calls.filter((call) => call.startsWith("getPullRequest"))).toHaveLength(0);

    // Resuming after the operator merges reaches `current` without a new review.
    world.merge(1);
    const second = await reconciler(world, { waitForMerge: false }).reconcile(desired);
    expect(second.status).toBe("current");
    expect(world.pulls).toHaveLength(1);
  });

  it("resumes an interrupted reconcile without duplicating the branch or the review", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);

    // Interrupt after the branch and the first file exist but before the review.
    world.branches.set(desired.names.setupBranch, {
      sha: DEFAULT_BRANCH_SHA,
      protectedBranch: false,
      files: new Map([[MANAGED_WORKFLOW_PATH, fileMap(desired).get(MANAGED_WORKFLOW_PATH) ?? ""]]),
    });

    const state = await reconciler(world, { waitForMerge: false }).reconcile(desired);
    expect(state.status).toBe("setup-pull-request");
    expect(world.pulls).toHaveLength(1);
    expect(world.branches.size).toBe(2);
    expect([...world.branch(desired.names.setupBranch).files.keys()].sort()).toEqual(
      [MANAGED_OWNERSHIP_PATH, MANAGED_RUNTIME_MANIFEST_PATH, MANAGED_WORKFLOW_PATH].sort(),
    );
  });

  it("opens a fresh review when the previous one was closed unmerged", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    const machine = reconciler(world, { waitForMerge: false });
    await machine.reconcile(desired);
    world.close(1);

    const state = await machine.reconcile(desired);
    expect(world.pulls).toHaveLength(2);
    expect(state.setupPullRequestNumber).toBe(2);
    expect(state.setupPullRequestState).toBe("open");
  });

  it("refuses a managed path the operator owns", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(
      context.repository,
      new Map([[MANAGED_WORKFLOW_PATH, "name: my own deploy workflow\n"]]),
    );
    const error = await reconciler(world).inspect(desired).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DeployKitError);
    expect((error as DeployKitError).code).toBe("DK_OWNERSHIP_CONFLICT");
    expect(world.calls.filter((call) => call.startsWith("writeFile"))).toHaveLength(0);
  });

  it("refuses an ownership marker that binds the managed files to another target", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const foreign = fileMap(desired);
    const marker = JSON.parse(foreign.get(MANAGED_OWNERSHIP_PATH) ?? "{}") as Record<string, unknown>;
    marker["targetId"] = "9".repeat(32);
    foreign.set(MANAGED_OWNERSHIP_PATH, `${JSON.stringify(marker)}\n`);
    const world = new FakeRepository(context.repository, foreign);

    const error = await reconciler(world).inspect(desired).catch((cause: unknown) => cause);
    expect((error as DeployKitError).code).toBe("DK_OWNERSHIP_CONFLICT");
  });

  it("refuses a setup branch that carries unrelated changes", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    world.branches.set(desired.names.setupBranch, {
      sha: DEFAULT_BRANCH_SHA,
      protectedBranch: false,
      files: new Map([["src/index.ts", "export const backdoor = true;\n"]]),
    });

    const error = await reconciler(world).reconcile(desired).catch((cause: unknown) => cause);
    expect((error as DeployKitError).code).toBe("DK_OWNERSHIP_CONFLICT");
    expect(String((error as DeployKitError).message)).toContain("outside the DeployKit-managed files");
    expect(world.pulls).toHaveLength(0);
  });

  it("refuses a pull request somebody redirected onto the setup branch", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    world.pulls.push({
      number: 7,
      title: "Please review my change",
      state: "open",
      merged: false,
      headRef: desired.names.setupBranch,
      baseRef: DEFAULT_BRANCH,
    });

    const error = await reconciler(world).inspect(desired).catch((cause: unknown) => cause);
    expect((error as DeployKitError).code).toBe("DK_OWNERSHIP_CONFLICT");
  });

  it("refuses a setup pull request retargeted away from the default branch", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    world.pulls.push({
      number: 4,
      title: desired.names.setupPullRequestTitle,
      state: "open",
      merged: false,
      headRef: desired.names.setupBranch,
      baseRef: "release",
    });
    world.branches.set(desired.names.setupBranch, {
      sha: DEFAULT_BRANCH_SHA,
      protectedBranch: false,
      files: new Map(),
    });

    const error = await reconciler(world).inspect(desired).catch((cause: unknown) => cause);
    expect((error as DeployKitError).code).toBe("DK_OWNERSHIP_CONFLICT");
  });

  it("reaches no Environment secret and dispatches no workflow", async () => {
    const context = await deploymentContext();
    const desired = await desiredArtifacts(context);
    const world = new FakeRepository(context.repository);
    world.onPoll = () => {
      if (!world.pulls[0]?.merged) world.merge(1);
    };
    const state: ControlArtifactsState = await reconciler(world).reconcile(desired);
    expect(state.status).toBe("current");
    // Every Environment, deploy-key, and dispatch method on the client throws;
    // reaching `current` proves none of them was called.
    expect(world.calls.some((call) => call.includes("Environment"))).toBe(false);
    expect(world.calls.some((call) => call.includes("dispatch"))).toBe(false);
  });
});
