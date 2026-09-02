import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DeployKitError, exitCodeFor } from "../src/errors.js";
import { makeManagedResourceNames } from "../src/orchestrator/planner.js";
import {
  GITHUB_CLIENT_LIMITS,
  apiArguments,
  classifyGitHubFailure,
  createGitHubClient,
  type GitHubClient,
  type GitHubCommandRunner,
  type GitHubDeployKey,
  type GitHubPullRequest,
  type GitHubRunRequest,
  type GitHubRunResult,
} from "../src/orchestrator/github.js";
import {
  assertNoEnvironmentConflicts,
  classifyEnvironmentNames,
  isOwnedValueName,
  parseOwnershipMarker,
  resolveDeployKeyOwnership,
  resolveSetupPullRequestOwnership,
} from "../src/orchestrator/github-ownership.js";

const FIXTURE_ROOT = resolve("test", "fixtures", "orchestrator");
const REPOSITORY = "acme/app";
const COMMIT = "a".repeat(40);
const SECRET_CANARY = "DK_CANARY_BACKEND_VALUE_71b0ce";

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface CallContext {
  readonly verb: string;
  readonly method: string;
  readonly endpoint: string;
}

type Route = (request: GitHubRunRequest, context: CallContext) => Reply | undefined;

/** Records every argv and answers a routed reply; an unrouted call is a 404. */
class FakeGh implements GitHubCommandRunner {
  readonly calls: GitHubRunRequest[] = [];
  readonly sleeps: number[] = [];

  constructor(private readonly route: Route) {}

  async run(request: GitHubRunRequest): Promise<GitHubRunResult> {
    this.calls.push(request);
    const args = request.args;
    const verb = args[0] ?? "";
    const isApi = verb === "api";
    const methodIndex = args.indexOf("--method");
    const method = isApi && methodIndex >= 0 ? args[methodIndex + 1] ?? "GET" : "";
    const endpoint = isApi ? args[args.length - 1] ?? "" : args.slice(1).join(" ");
    const reply = this.route(request, { verb, method, endpoint });
    if (reply === undefined) return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
    return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", exitCode: reply.exitCode ?? 0 };
  }

  client(): GitHubClient {
    return createGitHubClient({
      runner: this,
      sleep: async (milliseconds) => {
        this.sleeps.push(milliseconds);
      },
    });
  }

  /** Every `gh api` endpoint requested, in order. */
  endpoints(): string[] {
    return this.calls
      .filter((call) => call.args[0] === "api")
      .map((call) => call.args[call.args.length - 1] ?? "");
  }
}

function json(value: unknown): Reply {
  return { stdout: JSON.stringify(value) };
}

const REPOSITORY_BODY = {
  full_name: REPOSITORY,
  default_branch: "main",
  private: true,
  visibility: "private",
  archived: false,
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  plan: { name: "team" },
};

const USER_HEADERS = [
  "HTTP/2.0 200 OK",
  "Content-Type: application/json",
  "X-OAuth-Scopes: repo, workflow, admin:public_key",
  "",
].join("\r\n");

function userReply(scopes = "repo, workflow, admin:public_key"): Reply {
  return {
    stdout: `HTTP/2.0 200 OK\r\nX-OAuth-Scopes: ${scopes}\r\n\r\n${JSON.stringify({ login: "operator" })}`,
  };
}

function pullBody(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: "DeployKit setup: 0123456789ab",
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
    draft: false,
    html_url: `https://github.com/${REPOSITORY}/pull/${String(number)}`,
    head: { ref: "deploykit/setup-0123456789ab", sha: COMMIT },
    base: { ref: "main" },
    ...overrides,
  };
}

function runBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    name: "deploykit production 0f9c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
    display_title: "DeployKit",
    path: ".github/workflows/deploykit.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: COMMIT,
    actor: { login: "operator" },
    run_attempt: 1,
    created_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/${REPOSITORY}/actions/runs/4242`,
    ...overrides,
  };
}

/** The routes every composite read needs. */
const BASE_ROUTE: Route = (request, context) => {
  if (context.endpoint === "user") return userReply();
  if (context.endpoint === `repos/${REPOSITORY}`) return json(REPOSITORY_BODY);
  if (context.endpoint === `repos/${REPOSITORY}/commits/main`) return json({ sha: COMMIT });
  return undefined;
};

function expectFailure(error: unknown, code: string): DeployKitError {
  expect(error).toBeInstanceOf(DeployKitError);
  const failure = error as DeployKitError;
  expect(failure.code).toBe(code);
  return failure;
}

async function captureFailure(body: () => Promise<unknown>): Promise<DeployKitError> {
  try {
    await body();
  } catch (error) {
    expect(error).toBeInstanceOf(DeployKitError);
    return error as DeployKitError;
  }
  throw new Error("the operation unexpectedly succeeded");
}

// ------------------------------------------------------------------ identity --

describe("authenticated identity and permissions", () => {
  it("reads the login and the classic token scopes without touching the token", async () => {
    const gh = new FakeGh(BASE_ROUTE);
    const identity = await gh.client().getTokenIdentity();
    expect(identity).toEqual({ login: "operator", scopes: ["admin:public_key", "repo", "workflow"] });
    expect(USER_HEADERS).toContain("X-OAuth-Scopes");
    for (const call of gh.calls) {
      expect(call.args).not.toContain("token");
      expect(call.args.join(" ")).not.toMatch(/auth\s+token/u);
    }
  });

  it("reports an unauthenticated CLI as the authentication failure", async () => {
    const gh = new FakeGh(() => ({ stderr: "gh: To get started with GitHub CLI, please run: gh auth login", exitCode: 4 }));
    const failure = await captureFailure(() => gh.client().getTokenIdentity());
    expect(failure.code).toBe("DK_GITHUB_AUTH_REQUIRED");
    expect(exitCodeFor(failure.code)).toBe(4);
  });

  it("maps a fine-grained token that discloses no scopes", async () => {
    const gh = new FakeGh((request, context) =>
      context.endpoint === "user"
        ? { stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ login: "bot" })}` }
        : BASE_ROUTE(request, context));
    expect(await gh.client().getTokenIdentity()).toEqual({ login: "bot", scopes: [] });
  });

  it("derives repository facts from metadata, scopes, and the default-branch head", async () => {
    const gh = new FakeGh(BASE_ROUTE);
    const facts = await gh.client().getRepositoryFacts(REPOSITORY);
    expect(facts).toEqual({
      repository: REPOSITORY,
      defaultBranch: "main",
      defaultBranchCommitSha: COMMIT,
      private: true,
      authenticatedActor: "operator",
      permissions: {
        read: true,
        contentsWrite: true,
        workflowsWrite: true,
        environmentsWrite: true,
        deployKeysWrite: true,
        pullRequestsWrite: true,
      },
    });
  });

  it("reports partial permissions instead of assuming them", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint === `repos/${REPOSITORY}`) {
        return json({
          ...REPOSITORY_BODY,
          permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
        });
      }
      return BASE_ROUTE(request, context);
    });
    const facts = await gh.client().getRepositoryFacts(REPOSITORY);
    expect(facts.permissions).toEqual({
      read: true,
      contentsWrite: true,
      workflowsWrite: true,
      environmentsWrite: false,
      deployKeysWrite: false,
      pullRequestsWrite: true,
    });
  });

  it("withholds workflow write from a classic token without the workflow scope", async () => {
    const gh = new FakeGh((request, context) =>
      context.endpoint === "user" ? userReply("repo") : BASE_ROUTE(request, context));
    const facts = await gh.client().getRepositoryFacts(REPOSITORY);
    expect(facts.permissions.contentsWrite).toBe(true);
    expect(facts.permissions.workflowsWrite).toBe(false);
  });

  it("treats an archived repository as writable by nobody", async () => {
    const gh = new FakeGh((request, context) =>
      context.endpoint === `repos/${REPOSITORY}`
        ? json({ ...REPOSITORY_BODY, archived: true })
        : BASE_ROUTE(request, context));
    const facts = await gh.client().getRepositoryFacts(REPOSITORY);
    expect(facts.permissions.read).toBe(true);
    expect(Object.values(facts.permissions).filter((allowed) => allowed)).toEqual([true]);
  });

  it("refuses to guess when GitHub reports no permissions block", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint !== `repos/${REPOSITORY}`) return BASE_ROUTE(request, context);
      const rest: Record<string, unknown> = { ...REPOSITORY_BODY };
      delete rest["permissions"];
      return json(rest);
    });
    const failure = await captureFailure(() => gh.client().getRepositoryMetadata(REPOSITORY));
    expect(failure.code).toBe("DK_GITHUB_PERMISSION_DENIED");
  });

  it("records the plan limitation that blocks Environment protection on private repositories", async () => {
    const free = new FakeGh((request, context) =>
      context.endpoint === `repos/${REPOSITORY}`
        ? json({ ...REPOSITORY_BODY, plan: { name: "free" } })
        : BASE_ROUTE(request, context));
    expect((await free.client().getRepositoryMetadata(REPOSITORY)).environmentProtectionAvailable).toBe(false);

    const undisclosed = new FakeGh((request, context) => {
      if (context.endpoint !== `repos/${REPOSITORY}`) return BASE_ROUTE(request, context);
      const rest: Record<string, unknown> = { ...REPOSITORY_BODY };
      delete rest["plan"];
      return json(rest);
    });
    const metadata = await undisclosed.client().getRepositoryMetadata(REPOSITORY);
    expect(metadata.planName).toBeNull();
    expect(metadata.environmentProtectionAvailable).toBe(true);

    const publicRepository = new FakeGh((request, context) =>
      context.endpoint === `repos/${REPOSITORY}`
        ? json({ ...REPOSITORY_BODY, private: false, visibility: "public", plan: { name: "free" } })
        : BASE_ROUTE(request, context));
    expect((await publicRepository.client().getRepositoryMetadata(REPOSITORY)).environmentProtectionAvailable).toBe(true);
  });
});

// ---------------------------------------------------------- commits and files --

describe("commits, contents, and branches", () => {
  it("resolves a ref to a full commit SHA", async () => {
    const gh = new FakeGh(BASE_ROUTE);
    expect(await gh.client().resolveCommit(REPOSITORY, "main")).toEqual({
      repository: REPOSITORY,
      ref: "main",
      commitSha: COMMIT,
    });
  });

  it("reports an unknown ref as the commit-resolution failure", async () => {
    const gh = new FakeGh(() => undefined);
    const failure = await captureFailure(() => gh.client().resolveCommit(REPOSITORY, "missing"));
    expect(failure.code).toBe("DK_REF_NOT_FOUND");
    expect((failure.details as { recovery: string }).recovery).toBe("edit-config-and-rerun");
  });

  it("refuses a traversing ref, path, or repository before any request", async () => {
    const gh = new FakeGh(BASE_ROUTE);
    const client = gh.client();
    const before = gh.calls.length;
    for (const attempt of [
      () => client.resolveCommit(REPOSITORY, "../../etc/passwd"),
      () => client.readFile(REPOSITORY, "a/../../secret", "main"),
      () => client.readFile("not-a-repository", ".github/workflows/deploykit.yml", "main"),
      () => client.getBranch(REPOSITORY, "-flag"),
    ]) {
      expectFailure(await captureFailure(attempt), "DK_GITHUB_API_FAILED");
    }
    expect(gh.calls.length).toBe(before);
  });

  it("decodes bounded file contents and answers undefined for an absent path", async () => {
    const contents = "name: deploykit\n";
    const gh = new FakeGh((request, context) =>
      context.endpoint.startsWith(`repos/${REPOSITORY}/contents/.github/workflows/deploykit.yml`)
        ? json({
            type: "file",
            path: ".github/workflows/deploykit.yml",
            sha: "b".repeat(40),
            size: contents.length,
            encoding: "base64",
            content: Buffer.from(contents, "utf8").toString("base64"),
          })
        : undefined);
    const client = gh.client();
    expect(await client.readFile(REPOSITORY, ".github/workflows/deploykit.yml", "main")).toEqual({
      path: ".github/workflows/deploykit.yml",
      blobSha: "b".repeat(40),
      byteLength: contents.length,
      contents,
    });
    expect(await client.readFile(REPOSITORY, ".github/deploykit/manifest.yaml", "main")).toBeUndefined();
    expect(gh.endpoints()[0]).toBe(`repos/${REPOSITORY}/contents/.github/workflows/deploykit.yml?ref=main`);
  });

  it("refuses a directory at a managed path and an oversized control artifact", async () => {
    const directory = new FakeGh(() => json({ type: "dir", path: ".github/deploykit" }));
    expectFailure(
      await captureFailure(() => directory.client().readFile(REPOSITORY, ".github/deploykit", "main")),
      "DK_OWNERSHIP_CONFLICT",
    );

    const oversized = new FakeGh(() => json({
      type: "file",
      path: ".github/workflows/deploykit.yml",
      sha: "b".repeat(40),
      size: GITHUB_CLIENT_LIMITS.maxFileBytes + 1,
      encoding: "base64",
      content: "",
    }));
    expectFailure(
      await captureFailure(() => oversized.client().readFile(REPOSITORY, ".github/workflows/deploykit.yml", "main")),
      "DK_GITHUB_API_FAILED",
    );
  });

  it("writes a file through a canonical stdin body and returns the commit", async () => {
    const gh = new FakeGh((request, context) =>
      context.method === "PUT" ? json({ content: { path: ".github/deploykit/ownership.json", sha: "c".repeat(40) }, commit: { sha: COMMIT } }) : undefined);
    const result = await gh.client().writeFile({
      repository: REPOSITORY,
      path: ".github/deploykit/ownership.json",
      branch: "deploykit/setup-0123456789ab",
      message: "DeployKit setup",
      contents: "{}\n",
    });
    expect(result).toEqual({ path: ".github/deploykit/ownership.json", blobSha: "c".repeat(40), commitSha: COMMIT });
    const call = gh.calls[0];
    expect(call?.args).toContain("--input");
    expect(JSON.parse(call?.input ?? "{}")).toEqual({
      branch: "deploykit/setup-0123456789ab",
      content: Buffer.from("{}\n", "utf8").toString("base64"),
      message: "DeployKit setup",
    });
  });

  it("reads and creates a branch", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint === `repos/${REPOSITORY}/branches/main`) {
        return json({ name: "main", commit: { sha: COMMIT }, protected: true });
      }
      if (context.endpoint === `repos/${REPOSITORY}/git/refs`) return json({ object: { sha: COMMIT } });
      return undefined;
    });
    const client = gh.client();
    expect(await client.getBranch(REPOSITORY, "main")).toEqual({ name: "main", commitSha: COMMIT, protected: true });
    expect(await client.getBranch(REPOSITORY, "deploykit/setup-0123456789ab")).toBeUndefined();
    expect(await client.createBranch(REPOSITORY, "deploykit/setup-0123456789ab", COMMIT)).toEqual({
      name: "deploykit/setup-0123456789ab",
      commitSha: COMMIT,
      protected: false,
    });
    expect(JSON.parse(gh.calls[2]?.input ?? "{}")).toEqual({
      ref: "refs/heads/deploykit/setup-0123456789ab",
      sha: COMMIT,
    });
  });
});

// -------------------------------------------------------------- pull requests --

describe("pull requests", () => {
  it("paginates a listing and stops on a short page", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint.includes("&page=1&")) {
        return json(Array.from({ length: GITHUB_CLIENT_LIMITS.pageSize }, (_value, index) => pullBody(index + 1)));
      }
      if (context.endpoint.includes("&page=2&")) return json([pullBody(101, { state: "closed", merged_at: "2026-01-01T00:00:00Z" })]);
      return json([]);
    });
    const pulls = await gh.client().listPullRequests(REPOSITORY, { headRef: "deploykit/setup-0123456789ab", baseRef: "main" });
    expect(pulls.length).toBe(101);
    expect(pulls[100]?.merged).toBe(true);
    expect(gh.endpoints().length).toBe(2);
    // Query keys are emitted in code-point order so a rerun produces one argv.
    expect(gh.endpoints()[0]).toBe(
      `repos/${REPOSITORY}/pulls?base=main&head=acme%3Adeploykit%2Fsetup-0123456789ab&page=1&per_page=100&state=all`,
    );
  });

  it("reads one pull request and creates a non-modifiable one", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint === `repos/${REPOSITORY}/pulls/12`) return json(pullBody(12, { merged: false }));
      if (context.method === "POST") return json(pullBody(13));
      return undefined;
    });
    const client = gh.client();
    expect((await client.getPullRequest(REPOSITORY, 12))?.number).toBe(12);
    expect(await client.getPullRequest(REPOSITORY, 99)).toBeUndefined();
    const created = await client.createPullRequest({
      repository: REPOSITORY,
      headRef: "deploykit/setup-0123456789ab",
      baseRef: "main",
      title: "DeployKit setup: 0123456789ab",
      body: "Managed by DeployKit.",
    });
    expect(created.number).toBe(13);
    expect(JSON.parse(gh.calls[2]?.input ?? "{}")).toEqual({
      base: "main",
      body: "Managed by DeployKit.",
      draft: false,
      head: "deploykit/setup-0123456789ab",
      maintainer_can_modify: false,
      title: "DeployKit setup: 0123456789ab",
    });
  });
});

// --------------------------------------------------------------- environments --

const ENVIRONMENT = "production";
const ENVIRONMENT_BODY = {
  name: ENVIRONMENT,
  protection_rules: [
    { id: 1, type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "alice" } }, { type: "Team", reviewer: { slug: "platform" } }] },
    { id: 2, type: "wait_timer", wait_timer: 30 },
  ],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};

describe("environments, variables, and secrets", () => {
  it("reads protection rules without changing them", async () => {
    const gh = new FakeGh((request, context) =>
      context.endpoint === `repos/${REPOSITORY}/environments/${ENVIRONMENT}` ? json(ENVIRONMENT_BODY) : undefined);
    expect(await gh.client().getEnvironment(REPOSITORY, ENVIRONMENT)).toEqual({
      name: ENVIRONMENT,
      protection: {
        reviewers: ["user:alice", "team:platform"],
        waitTimerMinutes: 30,
        protectedBranchesOnly: true,
        customBranchPolicies: false,
      },
    });
  });

  it("never rewrites an existing Environment and creates an absent one", async () => {
    const existing = new FakeGh(() => json(ENVIRONMENT_BODY));
    const kept = await existing.client().ensureEnvironment(REPOSITORY, ENVIRONMENT);
    expect(kept.protection.reviewers).toEqual(["user:alice", "team:platform"]);
    expect(existing.calls.every((call) => !call.args.includes("PUT"))).toBe(true);

    const created = new FakeGh((request, context) =>
      context.method === "PUT" ? json({ name: ENVIRONMENT, protection_rules: [], deployment_branch_policy: null }) : undefined);
    const environment = await created.client().ensureEnvironment(REPOSITORY, ENVIRONMENT);
    expect(environment.protection).toEqual({
      reviewers: [],
      waitTimerMinutes: 0,
      protectedBranchesOnly: false,
      customBranchPolicies: false,
    });
    expect(created.calls[1]?.input).toBe("{}\n");
  });

  it("lists variables and secret names in a stable order", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint.includes("/variables")) {
        return json({ total_count: 2, variables: [{ name: "VITE_B", value: "2" }, { name: "VITE_A", value: "1" }] });
      }
      if (context.endpoint.includes("/secrets")) {
        return json({ total_count: 2, secrets: [{ name: "ZED" }, { name: "CERTBOT_EMAIL" }] });
      }
      return undefined;
    });
    const client = gh.client();
    expect(await client.listEnvironmentVariables(REPOSITORY, ENVIRONMENT)).toEqual([
      { name: "VITE_A", value: "1" },
      { name: "VITE_B", value: "2" },
    ]);
    expect(await client.listEnvironmentSecretNames(REPOSITORY, ENVIRONMENT)).toEqual(["CERTBOT_EMAIL", "ZED"]);
  });

  it("sends a secret value on stdin only, never in an argument", async () => {
    const gh = new FakeGh(() => ({ exitCode: 0 }));
    await gh.client().setEnvironmentSecret(REPOSITORY, ENVIRONMENT, "CERTBOT_EMAIL", `${SECRET_CANARY}\n`);
    const call = gh.calls[0];
    expect(call?.args).toEqual(["secret", "set", "CERTBOT_EMAIL", "--repo", REPOSITORY, "--env", ENVIRONMENT]);
    expect(call?.args.join(" ")).not.toContain(SECRET_CANARY);
    // Trailing newlines are stripped so the stored value cannot depend on how
    // the CLI treats them.
    expect(call?.input).toBe(SECRET_CANARY);
  });

  it("keeps a secret canary out of a failed write", async () => {
    const gh = new FakeGh(() => ({ stderr: `HTTP 403: forbidden while writing ${SECRET_CANARY}`, exitCode: 1 }));
    const failure = await captureFailure(() =>
      gh.client().setEnvironmentSecret(REPOSITORY, ENVIRONMENT, "CERTBOT_EMAIL", SECRET_CANARY));
    expect(failure.code).toBe("DK_GITHUB_PERMISSION_DENIED");
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(SECRET_CANARY);
  });

  it("refuses a value larger than GitHub accepts before sending it", async () => {
    const gh = new FakeGh(() => ({ exitCode: 0 }));
    const oversized = "x".repeat(GITHUB_CLIENT_LIMITS.maxSecretValueBytes + 1);
    expectFailure(
      await captureFailure(() => gh.client().setEnvironmentSecret(REPOSITORY, ENVIRONMENT, "BIG", oversized)),
      "DK_GITHUB_API_FAILED",
    );
    expect(gh.calls).toEqual([]);
  });

  it("writes a variable through the same stdin path and tolerates an absent deletion", async () => {
    const gh = new FakeGh((request, context) =>
      context.verb === "variable" && context.endpoint.startsWith("delete")
        ? { stderr: "HTTP 404: Not Found", exitCode: 1 }
        : { exitCode: 0 });
    const client = gh.client();
    await client.setEnvironmentVariable(REPOSITORY, ENVIRONMENT, "DEPLOYKIT_TARGET_ID", "0123456789ab");
    await client.deleteEnvironmentVariable(REPOSITORY, ENVIRONMENT, "DEPLOYKIT_TARGET_ID");
    await client.deleteEnvironmentSecret(REPOSITORY, ENVIRONMENT, "CERTBOT_EMAIL");
    expect(gh.calls[0]?.args).toEqual(["variable", "set", "DEPLOYKIT_TARGET_ID", "--repo", REPOSITORY, "--env", ENVIRONMENT]);
    expect(gh.calls[0]?.input).toBe("0123456789ab");
    expect(gh.calls[1]?.args).toEqual(["variable", "delete", "DEPLOYKIT_TARGET_ID", "--repo", REPOSITORY, "--env", ENVIRONMENT]);
  });

  it("refuses a name that is not an environment identifier", async () => {
    const gh = new FakeGh(() => ({ exitCode: 0 }));
    expectFailure(
      await captureFailure(() => gh.client().setEnvironmentVariable(REPOSITORY, ENVIRONMENT, "not a name", "1")),
      "DK_GITHUB_API_FAILED",
    );
    expect(gh.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- deploy keys --

describe("deploy keys", () => {
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForDeployKitTests";

  it("always registers a read-only key and refuses a writable one", async () => {
    const gh = new FakeGh((request, context) =>
      context.method === "POST" ? json({ id: 7, title: "DeployKit repository key: 0123456789ab", key: publicKey, read_only: true }) : undefined);
    const created = await gh.client().createDeployKey(REPOSITORY, "DeployKit repository key: 0123456789ab", publicKey);
    expect(created).toEqual({ id: 7, title: "DeployKit repository key: 0123456789ab", key: publicKey, readOnly: true });
    expect(JSON.parse(gh.calls[0]?.input ?? "{}")).toEqual({
      key: publicKey,
      read_only: true,
      title: "DeployKit repository key: 0123456789ab",
    });

    const writable = new FakeGh((request, context) =>
      context.method === "POST" ? json({ id: 8, title: "DeployKit repository key: 0123456789ab", key: publicKey, read_only: false }) : undefined);
    expectFailure(
      await captureFailure(() => writable.client().createDeployKey(REPOSITORY, "DeployKit repository key: 0123456789ab", publicKey)),
      "DK_OWNERSHIP_CONFLICT",
    );
  });

  it("refuses a key that is not an OpenSSH public key", async () => {
    const gh = new FakeGh(() => json({}));
    expectFailure(
      await captureFailure(() => gh.client().createDeployKey(REPOSITORY, "DeployKit repository key: 0123456789ab", "-----BEGIN PRIVATE KEY-----")),
      "DK_GITHUB_API_FAILED",
    );
    expect(gh.calls).toEqual([]);
  });

  it("lists keys by id and treats an absent deletion as done", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.method === "GET") {
        return json([
          { id: 9, title: "operator laptop", key: publicKey, read_only: false },
          { id: 7, title: "DeployKit repository key: 0123456789ab", key: publicKey, read_only: true },
        ]);
      }
      return { stderr: "HTTP 404: Not Found", exitCode: 1 };
    });
    const client = gh.client();
    expect((await client.listDeployKeys(REPOSITORY)).map((key) => key.id)).toEqual([7, 9]);
    await expect(client.deleteDeployKey(REPOSITORY, 7)).resolves.toBeUndefined();
  });
});

// ------------------------------------------------------- dispatch and run reads --

describe("workflow dispatch and runs", () => {
  it("sends sorted inputs and the protected workflow ref", async () => {
    const gh = new FakeGh(() => ({ exitCode: 0 }));
    await gh.client().dispatchWorkflow({
      repository: REPOSITORY,
      workflowPath: ".github/workflows/deploykit.yml",
      workflowRef: "main",
      inputs: { target: "production", commit_sha: COMMIT, request_id: "0f9c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c" },
    });
    const call = gh.calls[0];
    expect(call?.args[call.args.length - 1]).toBe(
      `repos/${REPOSITORY}/actions/workflows/deploykit.yml/dispatches`,
    );
    expect(call?.input).toBe(
      `${JSON.stringify({
        inputs: { commit_sha: COMMIT, request_id: "0f9c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c", target: "production" },
        ref: "main",
      })}\n`,
    );
  });

  it("refuses more inputs or a larger payload than workflow_dispatch accepts", async () => {
    const gh = new FakeGh(() => ({ exitCode: 0 }));
    const many = Object.fromEntries(
      Array.from({ length: GITHUB_CLIENT_LIMITS.maxDispatchInputs + 1 }, (_value, index) => [`INPUT_${String(index)}`, "1"]),
    );
    expectFailure(
      await captureFailure(() => gh.client().dispatchWorkflow({
        repository: REPOSITORY,
        workflowPath: ".github/workflows/deploykit.yml",
        workflowRef: "main",
        inputs: many,
      })),
      "DK_GITHUB_API_FAILED",
    );
    expectFailure(
      await captureFailure(() => gh.client().dispatchWorkflow({
        repository: REPOSITORY,
        workflowPath: ".github/workflows/deploykit.yml",
        workflowRef: "main",
        inputs: { payload: "y".repeat(GITHUB_CLIENT_LIMITS.maxDispatchInputBytes + 1) },
      })),
      "DK_GITHUB_API_FAILED",
    );
    expect(gh.calls).toEqual([]);
  });

  it("addresses the workflow by file name and refuses a path outside .github/workflows", async () => {
    const gh = new FakeGh(() => ({ exitCode: 0 }));
    for (const workflowPath of ["deploykit.yml", ".github/actions/deploykit.yml", ".github/workflows/deploykit.txt"]) {
      expectFailure(
        await captureFailure(() => gh.client().dispatchWorkflow({
          repository: REPOSITORY,
          workflowPath,
          workflowRef: "main",
          inputs: {},
        })),
        "DK_GITHUB_API_FAILED",
      );
    }
    expect(gh.calls).toEqual([]);
  });

  it("reads runs through the collection wrapper and bounds the listing", async () => {
    const gh = new FakeGh((request, context) => {
      if (context.endpoint.includes("/runs?")) {
        return json({ total_count: 2, workflow_runs: [runBody(), runBody({ id: 4243, status: "in_progress", conclusion: null })] });
      }
      if (context.endpoint === `repos/${REPOSITORY}/actions/runs/4242`) return json(runBody());
      return undefined;
    });
    const client = gh.client();
    const runs = await client.listWorkflowRuns({
      repository: REPOSITORY,
      workflowPath: ".github/workflows/deploykit.yml",
      branch: "main",
      maxRuns: 1,
    });
    expect(runs.length).toBe(1);
    expect(runs[0]?.name).toContain("0f9c2b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c");
    expect(runs[0]?.conclusion).toBe("success");
    expect(await client.getWorkflowRun(REPOSITORY, 4242)).toEqual(runs[0]);
    expect(await client.getWorkflowRun(REPOSITORY, 5000)).toBeUndefined();
  });

  it("refuses a run whose status or conclusion it does not recognize", async () => {
    const status = new FakeGh(() => json(runBody({ status: "teleporting" })));
    expectFailure(await captureFailure(() => status.client().getWorkflowRun(REPOSITORY, 4242)), "DK_GITHUB_API_FAILED");

    const conclusion = new FakeGh(() => json(runBody({ conclusion: "vibes" })));
    expectFailure(await captureFailure(() => conclusion.client().getWorkflowRun(REPOSITORY, 4242)), "DK_GITHUB_API_FAILED");
  });
});

// ------------------------------------------------------ transport and boundaries --

describe("bounded transport", () => {
  it("classifies each refusal the CLI can report", () => {
    expect(classifyGitHubFailure("You have exceeded a secondary rate limit")).toBe("rate-limit");
    expect(classifyGitHubFailure("HTTP 403: API rate limit exceeded")).toBe("rate-limit");
    expect(classifyGitHubFailure("HTTP 401: Bad credentials")).toBe("auth");
    expect(classifyGitHubFailure("HTTP 403: Resource not accessible by integration")).toBe("permission");
    expect(classifyGitHubFailure("HTTP 404: Not Found")).toBe("not-found");
    expect(classifyGitHubFailure("HTTP 502: Bad gateway")).toBe("failed");
  });

  it("retries a safe read with deterministic backoff and then reports rate limiting", async () => {
    const gh = new FakeGh(() => ({ stderr: "HTTP 403: API rate limit exceeded", exitCode: 1 }));
    const failure = await captureFailure(() => gh.client().getBranch(REPOSITORY, "main"));
    expect(failure.code).toBe("DK_GITHUB_RATE_LIMITED");
    expect(exitCodeFor(failure.code)).toBe(9);
    expect(gh.calls.length).toBe(GITHUB_CLIENT_LIMITS.readAttempts);
    expect(gh.sleeps).toEqual([GITHUB_CLIENT_LIMITS.retryBaseMs, GITHUB_CLIENT_LIMITS.retryBaseMs * 2]);
  });

  it("recovers when a transient read failure clears", async () => {
    let attempt = 0;
    const gh = new FakeGh(() => {
      attempt += 1;
      if (attempt === 1) return { stderr: "HTTP 502: Bad gateway", exitCode: 1 };
      return json({ name: "main", commit: { sha: COMMIT }, protected: true });
    });
    expect((await gh.client().getBranch(REPOSITORY, "main"))?.commitSha).toBe(COMMIT);
    expect(gh.calls.length).toBe(2);
  });

  it("never repeats a mutation, because a failed write may still have landed", async () => {
    const gh = new FakeGh(() => ({ stderr: "HTTP 502: Bad gateway", exitCode: 1 }));
    const failure = await captureFailure(() => gh.client().createBranch(REPOSITORY, "deploykit/setup-0123456789ab", COMMIT));
    expect(failure.code).toBe("DK_GITHUB_API_FAILED");
    expect(gh.calls.length).toBe(1);
    expect(gh.sleeps).toEqual([]);
  });

  it("refuses an oversized or unparsable response instead of trusting it", async () => {
    const oversized = new FakeGh(() => ({ stdout: "x".repeat(GITHUB_CLIENT_LIMITS.maxResponseBytes + 1) }));
    expectFailure(await captureFailure(() => oversized.client().getBranch(REPOSITORY, "main")), "DK_GITHUB_API_FAILED");

    const garbage = new FakeGh(() => ({ stdout: "<html>rate limited</html>" }));
    expectFailure(await captureFailure(() => garbage.client().getBranch(REPOSITORY, "main")), "DK_GITHUB_API_FAILED");
  });

  it("stops a runaway listing at the bounded page count", async () => {
    const gh = new FakeGh(() => json(Array.from({ length: GITHUB_CLIENT_LIMITS.pageSize }, (_value, index) => ({
      id: index + 1,
      title: "operator",
      key: "ssh-ed25519 AAAA",
      read_only: false,
    }))));
    expectFailure(await captureFailure(() => gh.client().listDeployKeys(REPOSITORY)), "DK_GITHUB_API_FAILED");
    expect(gh.calls.length).toBe(GITHUB_CLIENT_LIMITS.maxPages);
  });

  it("builds one deterministic argv for one request", () => {
    const first = apiArguments({ method: "GET", path: "repos/acme/app/pulls", query: { state: "all", base: "main" } });
    const second = apiArguments({ method: "GET", path: "repos/acme/app/pulls", query: { base: "main", state: "all" } });
    expect(first).toEqual(second);
    expect(first).toEqual([
      "api",
      "--method", "GET",
      "--header", "Accept: application/vnd.github+json",
      "--header", "X-GitHub-Api-Version: 2022-11-28",
      "repos/acme/app/pulls?base=main&state=all",
    ]);
  });

  it("keeps the response body and the CLI's stderr out of every failure", async () => {
    const gh = new FakeGh(() => ({
      stdout: `{"token":"${SECRET_CANARY}"}`,
      stderr: `HTTP 500: ${SECRET_CANARY}`,
      exitCode: 1,
    }));
    const failure = await captureFailure(() => gh.client().getPullRequest(REPOSITORY, 12));
    const rendered = JSON.stringify({ message: failure.message, details: failure.details });
    expect(rendered).not.toContain(SECRET_CANARY);
    expect(failure.details).toEqual({
      boundary: "github-identity",
      recovery: "rerun-same-command",
      resume: expect.stringContaining("deploykit deploy"),
      mutation: "owned-only",
      path: `repos/${REPOSITORY}/pulls/12`,
      method: "GET",
      attempts: GITHUB_CLIENT_LIMITS.readAttempts,
      exitCode: 1,
    });
  });
});

// ------------------------------------------------------------------ ownership --

interface ExpectationCase {
  readonly fixture: string;
  readonly code: string;
  readonly recovery: string;
}

const OWNERSHIP_IDENTITY = {
  repository: "deploykit-fixtures/static-compose",
  targetName: "production",
  targetId: "04809ce707a77a199e6b989440139ba0",
  githubEnvironment: "fixture-static-production",
} as const;

const VALID_WORKFLOW_DIGEST = "0881126d63a65c66db9de012e02ef6965c6fec3ddd03a408f8015bb0b71641ff";

describe("ownership markers", () => {
  it("accepts the frozen valid marker and reports only names", async () => {
    const text = await readFile(join(FIXTURE_ROOT, "ownership", "valid", "marker.json"), "utf8");
    const marker = parseOwnershipMarker(text, { ...OWNERSHIP_IDENTITY, workflowDigest: VALID_WORKFLOW_DIGEST });
    expect(marker.owner).toBe("deploykit");
    expect(marker.managed.backendSecrets).toEqual(["CERTBOT_EMAIL"]);
    expect(marker.managed.generatedSecrets).toEqual(["DATABASE_URL", "POSTGRES_PASSWORD"]);
    expect(JSON.stringify(marker)).not.toContain("DK_CANARY_");
  });

  it("refuses every hostile marker with exactly the frozen code and recovery", async () => {
    const expectations = JSON.parse(await readFile(join(FIXTURE_ROOT, "expectations.json"), "utf8")) as {
      readonly cases: readonly ExpectationCase[];
    };
    const cases = expectations.cases.filter((entry) => entry.fixture.startsWith("ownership/invalid/"));
    expect(cases.length).toBe(5);
    for (const entry of cases) {
      const text = await readFile(join(FIXTURE_ROOT, entry.fixture), "utf8");
      const failure = await captureFailure(async () =>
        parseOwnershipMarker(text, { ...OWNERSHIP_IDENTITY, workflowDigest: VALID_WORKFLOW_DIGEST }));
      expect(failure.code, entry.fixture).toBe(entry.code);
      expect((failure.details as { recovery: string }).recovery, entry.fixture).toBe(entry.recovery);
      expect(JSON.stringify(failure.details), entry.fixture).not.toContain("DK_CANARY_");
    }
  });

  it("refuses a file at the ownership path that is not a marker at all", async () => {
    for (const text of ["not json", "[]", JSON.stringify({ apiVersion: "other/v1", owner: "deploykit" })]) {
      const failure = await captureFailure(async () => parseOwnershipMarker(text, OWNERSHIP_IDENTITY));
      expect(failure.code).toBe("DK_OWNERSHIP_CONFLICT");
    }
  });

  it("refuses an unsorted, duplicated, or reserved name list as drift", async () => {
    const base = JSON.parse(await readFile(join(FIXTURE_ROOT, "ownership", "valid", "marker.json"), "utf8")) as {
      managed: { generatedSecrets: string[] };
    };
    for (const names of [["POSTGRES_PASSWORD", "DATABASE_URL"], ["DATABASE_URL", "DATABASE_URL"], ["DEPLOYKIT_TARGET_ID"]]) {
      const document = { ...base, managed: { ...base.managed, generatedSecrets: names } };
      const failure = await captureFailure(async () => parseOwnershipMarker(JSON.stringify(document), OWNERSHIP_IDENTITY));
      expect(failure.code).toBe("DK_CONTROL_ARTIFACTS_DRIFTED");
    }
  });
});

describe("ambiguous existing resources", () => {
  const names = makeManagedResourceNames("0123456789abcdef0123456789abcdef");
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForDeployKitTests";

  function deployKey(overrides: Partial<GitHubDeployKey> = {}): GitHubDeployKey {
    return { id: 1, title: names.repositoryDeployKeyTitle, key: publicKey, readOnly: true, ...overrides };
  }

  it("recognizes its own read-only deploy key and ignores an operator's", () => {
    const resolved = resolveDeployKeyOwnership(
      [deployKey({ id: 2 }), { id: 3, title: "operator laptop", key: "ssh-ed25519 AAAAOther", readOnly: false }],
      names,
      `${publicKey} deploykit@vps`,
    );
    expect(resolved.status).toBe("owned");
    expect(resolved.key?.id).toBe(2);
    expect(resolved.matchesExpectedKey).toBe(true);
  });

  it("refuses duplicated, writable, or impersonating keys", () => {
    expect(resolveDeployKeyOwnership([deployKey(), deployKey({ id: 2 })], names).status).toBe("conflict");
    expect(resolveDeployKeyOwnership([deployKey({ readOnly: false })], names).status).toBe("conflict");
    const impostor = resolveDeployKeyOwnership(
      [{ id: 5, title: "someone else", key: publicKey, readOnly: true }],
      names,
      publicKey,
    );
    expect(impostor.status).toBe("conflict");
    expect(impostor.reason).toContain("already carries this repository public key");
  });

  it("reports a missing deploy key rather than inventing one", () => {
    expect(resolveDeployKeyOwnership([], names)).toEqual({
      status: "missing",
      key: null,
      matchesExpectedKey: false,
      reason: null,
    });
  });

  function pull(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
    return {
      number: 1,
      title: names.setupPullRequestTitle,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      headRef: names.setupBranch,
      headSha: COMMIT,
      baseRef: "main",
      draft: false,
      url: "https://github.com/acme/app/pull/1",
      ...overrides,
    };
  }

  it("reuses its own setup pull request and refuses a redirected one", () => {
    expect(resolveSetupPullRequestOwnership([pull()], names).status).toBe("owned");
    expect(resolveSetupPullRequestOwnership([], names).status).toBe("missing");
    expect(resolveSetupPullRequestOwnership([pull({ title: "Fix the build" })], names).status).toBe("conflict");
    expect(resolveSetupPullRequestOwnership([pull(), pull({ number: 2 })], names).status).toBe("conflict");
    // A merged pull request on our branch is still ours; the newest one wins.
    const closed = resolveSetupPullRequestOwnership(
      [pull({ number: 1, state: "closed" }), pull({ number: 4, state: "closed", merged: true })],
      names,
    );
    expect(closed.status).toBe("owned");
    expect(closed.pullRequest?.number).toBe(4);
    // A pull request on somebody else's branch is not this target's business.
    expect(resolveSetupPullRequestOwnership([pull({ headRef: "feature" })], names).status).toBe("missing");
  });

  it("only ever deletes an Environment value a marker or the reserved prefix claims", () => {
    const classification = classifyEnvironmentNames({
      live: ["CERTBOT_EMAIL", "DEPLOYKIT_GATEWAY_HOST", "OPERATOR_ONLY", "STALE_ONE"],
      desired: ["CERTBOT_EMAIL", "DEPLOYKIT_GATEWAY_HOST", "NEW_ONE"],
      ownedByMarker: ["CERTBOT_EMAIL", "STALE_ONE"],
    });
    expect(classification).toEqual({
      missing: ["NEW_ONE"],
      owned: ["CERTBOT_EMAIL", "DEPLOYKIT_GATEWAY_HOST"],
      stale: ["STALE_ONE"],
      foreign: ["OPERATOR_ONLY"],
      conflicting: [],
    });
    expect(isOwnedValueName("DEPLOYKIT_TARGET_ID", [])).toBe(true);
    expect(isOwnedValueName("OPERATOR_ONLY", [])).toBe(false);
  });

  it("refuses to overwrite a desired value somebody else already set", () => {
    const classification = classifyEnvironmentNames({
      live: ["CERTBOT_EMAIL"],
      desired: ["CERTBOT_EMAIL"],
      ownedByMarker: [],
    });
    expect(classification.conflicting).toEqual(["CERTBOT_EMAIL"]);
    const failure = expectFailure(
      (() => {
        try {
          assertNoEnvironmentConflicts("production", "secret", classification);
        } catch (error) {
          return error;
        }
        return undefined;
      })(),
      "DK_ENVIRONMENT_CONFLICT",
    );
    expect((failure.details as { names: string[] }).names).toEqual(["CERTBOT_EMAIL"]);
  });
});

// ------------------------------------------------------------- phase boundary --

describe("phase boundary", () => {
  it("keeps the GitHub client out of the package API and the production CLI", async () => {
    const index = await readFile(resolve("src", "index.ts"), "utf8");
    const cli = await readFile(resolve("src", "cli.ts"), "utf8");
    expect(index).not.toContain("orchestrator/github");
    expect(cli).not.toContain("orchestrator/github");
    expect(cli).not.toContain("createGitHubClient");
  });
});
