import { Buffer } from "node:buffer";

import type { DeployKitError } from "../errors.js";
import { run } from "../process.js";
import { canonicalJson, compareCodePoints, type CanonicalValue } from "./canonical.js";
import { GIT_COMMIT_SHA_PATTERN, type GitCommitSha } from "./contracts.js";
import type { GitHubRepositoryFacts, GitHubResolvedCommit } from "./dependencies.js";
import { orchestratorError } from "./failures.js";

/**
 * The GitHub boundary: typed, bounded primitives over the authenticated
 * `gh` command line.
 *
 * Four properties shape everything below.
 *
 * **The token is never handled.** `gh` holds the credential and DeployKit never
 * runs `gh auth token`, reads a token out of the environment, or copies one
 * into an argument, a file, or a diagnostic. Authentication problems are
 * recognized from the CLI's own refusal and reported as
 * DK_GITHUB_AUTH_REQUIRED.
 *
 * **Secret material only travels on stdin.** Environment secrets are written
 * with `gh secret set`, whose value is piped to the child process; no secret is
 * ever an argv element, a temporary file, a URL, or part of a retryable request
 * body we might log. Request bodies that carry no secret are still sent through
 * `gh api --input -` so every mutation has one shape.
 *
 * **Every response is bounded before it is parsed.** A response larger than
 * {@link GITHUB_CLIENT_LIMITS.maxResponseBytes} is refused rather than parsed,
 * pagination stops at a fixed page count, and each field is read through a
 * checked accessor, so a surprising payload becomes a stable
 * DK_GITHUB_API_FAILED instead of an undefined field three layers up.
 *
 * **Only safe reads retry.** Backoff is applied to GET requests alone; a
 * mutation that fails is reported, never repeated, because `gh` cannot tell us
 * whether the write landed. Rate limiting that survives the read budget is
 * reported as DK_GITHUB_RATE_LIMITED so the operator waits rather than
 * hammering the API.
 *
 * Nothing here decides policy. Ownership rules live in `github-ownership.ts`,
 * desired state lives in `planner.ts`, and no production command path reaches
 * these mutations yet.
 */

// ------------------------------------------------------------------ limits --

export const GITHUB_CLIENT_LIMITS = Object.freeze({
  /** Any single `gh` response larger than this is refused unparsed. */
  maxResponseBytes: 4 * 1024 * 1024,
  /** Repository contents are control artifacts, not application payloads. */
  maxFileBytes: 1024 * 1024,
  maxPages: 20,
  pageSize: 100,
  /** GitHub's own Actions variable and secret ceiling. */
  maxVariableValueBytes: 48 * 1024,
  maxSecretValueBytes: 48 * 1024,
  /** `workflow_dispatch` accepts at most ten inputs. */
  maxDispatchInputs: 10,
  maxDispatchInputBytes: 65_535,
  readAttempts: 3,
  retryBaseMs: 500,
  requestTimeoutMs: 60_000,
} as const);

/** GitHub's own ceiling on the `files` array of a comparison response. */
export const GITHUB_COMPARISON_FILE_LIMIT = 300;

// -------------------------------------------------------------- validation --

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,254}$/u;
const VALUE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/u;
const PATH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/u;
const TITLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,254}$/u;
const WORKFLOW_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:yml|yaml)$/u;
const WORKFLOW_DIRECTORY = ".github/workflows/";

function apiFailure(message: string, details: Record<string, unknown> = {}): DeployKitError {
  return orchestratorError("DK_GITHUB_API_FAILED", message, { details });
}

/** A traversal or hidden segment in a path or ref is refused, never normalized. */
function assertSafeSegments(value: string, subject: string): void {
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.startsWith("-")) {
      throw apiFailure(`The ${subject} contains an unsafe path segment`);
    }
  }
}

export function assertRepository(repository: string): void {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw apiFailure("The repository is not a GitHub owner/name pair");
  }
}

export function assertEnvironmentName(environment: string): void {
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw apiFailure("The GitHub Environment name is not a supported Environment name");
  }
}

export function assertValueName(name: string): void {
  if (!VALUE_NAME_PATTERN.test(name)) {
    throw apiFailure("The Environment variable or secret name is not an environment identifier");
  }
}

/** Branches, refs, and repository file paths share one conservative shape. */
export function assertRepositoryPath(value: string, subject: string): void {
  if (!PATH_PATTERN.test(value)) throw apiFailure(`The ${subject} is not a supported GitHub ${subject}`);
  assertSafeSegments(value, subject);
}

/**
 * GitHub addresses a workflow by numeric id or by *file name*, not by the path
 * it lives at, so the managed path is validated and reduced to that name rather
 * than percent-encoded into the URL.
 */
export function workflowFileName(workflowPath: string): string {
  assertRepositoryPath(workflowPath, "path");
  if (!workflowPath.startsWith(WORKFLOW_DIRECTORY)) {
    throw apiFailure("The managed workflow is not under .github/workflows/");
  }
  const name = workflowPath.slice(WORKFLOW_DIRECTORY.length);
  if (!WORKFLOW_FILE_PATTERN.test(name)) throw apiFailure("The managed workflow is not a YAML workflow file");
  return name;
}

export function assertCommitSha(value: string): asserts value is GitCommitSha {
  if (!GIT_COMMIT_SHA_PATTERN.test(value)) {
    throw apiFailure("The commit SHA is not a full lower-case 40-character SHA");
  }
}

// ----------------------------------------------------------------- runner --

export interface GitHubRunRequest {
  readonly args: readonly string[];
  /** Secret material reaches the child process only here. */
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface GitHubRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Injected so tests drive the boundary without an authenticated `gh`. */
export interface GitHubCommandRunner {
  run(request: GitHubRunRequest): Promise<GitHubRunResult>;
}

export const processGitHubCommandRunner: GitHubCommandRunner = {
  async run(request: GitHubRunRequest): Promise<GitHubRunResult> {
    const result = await run("gh", request.args, {
      reject: false,
      ...(request.input === undefined ? {} : { input: request.input }),
      timeoutMs: request.timeoutMs ?? GITHUB_CLIENT_LIMITS.requestTimeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  },
};

// ------------------------------------------------------- failure taxonomy --

export type GitHubFailureKind = "auth" | "permission" | "rate-limit" | "not-found" | "failed";

const RATE_LIMIT_PATTERN = /rate limit|HTTP 429|abuse detection|secondary rate/iu;
const AUTH_PATTERN =
  /HTTP 401|bad credentials|gh auth login|not logged in|authentication token|requires authentication/iu;
const PERMISSION_PATTERN =
  /HTTP 403|resource not accessible|must have admin|must be an owner|insufficient|forbidden|integration not allowed/iu;
const NOT_FOUND_PATTERN = /HTTP 404|not found|could not resolve to a repository/iu;
const TRANSIENT_PATTERN =
  /HTTP 5\d\d|connection reset|connection refused|timeout|timed out|EOF|TLS handshake|temporary failure|no such host|network is unreachable/iu;

/**
 * Ordered deliberately: rate limiting also answers 403, so it is recognized
 * first, and a missing resource is only "not found" once we know the caller was
 * allowed to look.
 */
export function classifyGitHubFailure(stderr: string): GitHubFailureKind {
  if (RATE_LIMIT_PATTERN.test(stderr)) return "rate-limit";
  if (AUTH_PATTERN.test(stderr)) return "auth";
  if (PERMISSION_PATTERN.test(stderr)) return "permission";
  if (NOT_FOUND_PATTERN.test(stderr)) return "not-found";
  return "failed";
}

/**
 * Turns a `gh` refusal into a catalog failure. Neither the response body nor
 * the CLI's stderr is attached: a bounded, classified summary is enough to act
 * on, and a raw stream is exactly where a value we did not expect could ride
 * out.
 */
function failureFor(kind: GitHubFailureKind, message: string, details: Record<string, unknown>): DeployKitError {
  if (kind === "rate-limit") {
    return orchestratorError("DK_GITHUB_RATE_LIMITED", message, { details });
  }
  if (kind === "auth") {
    return orchestratorError("DK_GITHUB_AUTH_REQUIRED", message, { details });
  }
  if (kind === "permission") {
    return orchestratorError("DK_GITHUB_PERMISSION_DENIED", message, { details });
  }
  return orchestratorError("DK_GITHUB_API_FAILED", message, { details });
}

// --------------------------------------------------------- bounded parsing --

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObject(source: JsonObject, field: string): JsonObject {
  const value = source[field];
  if (!isJsonObject(value)) throw apiFailure(`The GitHub response field ${field} is not an object`);
  return value;
}

function readOptionalObject(source: JsonObject, field: string): JsonObject | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (!isJsonObject(value)) throw apiFailure(`The GitHub response field ${field} is not an object`);
  return value;
}

function readArray(source: JsonObject, field: string): readonly unknown[] {
  const value = source[field];
  if (!Array.isArray(value)) throw apiFailure(`The GitHub response field ${field} is not an array`);
  return value;
}

function readString(source: JsonObject, field: string): string {
  const value = source[field];
  if (typeof value !== "string") throw apiFailure(`The GitHub response field ${field} is not a string`);
  return value;
}

function readOptionalString(source: JsonObject, field: string): string | null {
  const value = source[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw apiFailure(`The GitHub response field ${field} is not a string`);
  return value;
}

function readNumber(source: JsonObject, field: string): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw apiFailure(`The GitHub response field ${field} is not a number`);
  }
  return value;
}

function readBoolean(source: JsonObject, field: string, fallback?: boolean): boolean {
  const value = source[field];
  if (typeof value === "boolean") return value;
  if (fallback !== undefined && (value === undefined || value === null)) return fallback;
  throw apiFailure(`The GitHub response field ${field} is not a boolean`);
}

function readEnum<T extends string>(
  source: JsonObject,
  field: string,
  allowed: ReadonlySet<string>,
): T {
  const value = readString(source, field);
  if (!allowed.has(value)) throw apiFailure(`The GitHub response field ${field} carries an unrecognized value`);
  return value as T;
}

// --------------------------------------------------------------- requests --

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface ApiRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Serialized canonically and delivered on stdin. */
  readonly body?: CanonicalValue;
  /** A 404 answers `undefined` instead of raising. */
  readonly absentOnNotFound?: boolean;
}

/** Encodes each segment but keeps `/` literal, the way GitHub paths expect. */
function encodePath(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function encodeQuery(query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query).sort(([left], [right]) => compareCodePoints(left, right));
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`;
}

/** Frozen argument order so an identical request always produces one argv. */
export function apiArguments(request: Pick<ApiRequest, "method" | "path" | "query" | "body">): readonly string[] {
  const args = [
    "api",
    "--method", request.method,
    "--header", "Accept: application/vnd.github+json",
    "--header", "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (request.body !== undefined) args.push("--input", "-");
  args.push(`${request.path}${encodeQuery(request.query ?? {})}`);
  return args;
}

export interface GitHubClientOptions {
  readonly runner?: GitHubCommandRunner;
  /** Injected so retry backoff is instant under test. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface GitHubTokenIdentity {
  readonly login: string;
  /** Empty for a fine-grained token or `GITHUB_TOKEN`, which report no scopes. */
  readonly scopes: readonly string[];
}

export interface GitHubRepositoryPermissions {
  readonly admin: boolean;
  readonly maintain: boolean;
  readonly push: boolean;
  readonly triage: boolean;
  readonly pull: boolean;
}

export interface GitHubRepositoryMetadata {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly visibility: string;
  readonly archived: boolean;
  readonly permissions: GitHubRepositoryPermissions;
  /** Absent for accounts whose plan the API does not disclose. */
  readonly planName: string | null;
  /**
   * Deployment protection rules on a private repository require a paid plan.
   * An undisclosed plan is treated as capable, because refusing an enterprise
   * repository that simply does not report a plan would be worse than letting
   * GitHub answer for itself.
   */
  readonly environmentProtectionAvailable: boolean;
}

export interface GitHubFileContents {
  readonly path: string;
  readonly blobSha: string;
  readonly byteLength: number;
  readonly contents: string;
}

export interface GitHubFileWriteRequest {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  readonly message: string;
  readonly contents: string;
  /** Required to replace an existing file; omitted creates one. */
  readonly expectedBlobSha?: string;
}

export interface GitHubFileWriteResult {
  readonly path: string;
  readonly blobSha: string;
  readonly commitSha: GitCommitSha;
}

export interface GitHubBranch {
  readonly name: string;
  readonly commitSha: GitCommitSha;
  readonly protected: boolean;
}

/**
 * A bounded two-dot comparison. GitHub caps the file list, so `truncated` is
 * reported rather than hidden: a caller that must prove a branch changed
 * *nothing* outside a known set has to fail closed when the list is capped.
 */
export interface GitHubComparison {
  readonly status: "identical" | "ahead" | "behind" | "diverged";
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly files: readonly string[];
  readonly truncated: boolean;
}

export type GitHubPullRequestState = "open" | "closed";

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: GitHubPullRequestState;
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly headRef: string;
  readonly headSha: GitCommitSha;
  readonly baseRef: string;
  readonly draft: boolean;
  readonly url: string;
}

export interface GitHubEnvironmentProtection {
  /** `user:<login>` and `team:<slug>` entries, in the order GitHub reports. */
  readonly reviewers: readonly string[];
  readonly waitTimerMinutes: number;
  readonly protectedBranchesOnly: boolean;
  readonly customBranchPolicies: boolean;
}

export interface GitHubEnvironment {
  readonly name: string;
  readonly protection: GitHubEnvironmentProtection;
}

export interface GitHubVariable {
  readonly name: string;
  readonly value: string;
}

export interface GitHubDeployKey {
  readonly id: number;
  readonly title: string;
  readonly key: string;
  readonly readOnly: boolean;
}

export const WORKFLOW_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued", "in_progress", "completed", "waiting", "requested", "pending",
]);

export const WORKFLOW_RUN_CONCLUSIONS: ReadonlySet<string> = new Set([
  "success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure",
]);

export type GitHubWorkflowRunStatus =
  | "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";

export type GitHubWorkflowRunConclusion =
  | "success" | "failure" | "cancelled" | "timed_out" | "action_required"
  | "neutral" | "skipped" | "stale" | "startup_failure";

export interface GitHubWorkflowRun {
  readonly id: number;
  /** The workflow's `run-name`, which is where a request UUID is correlated. */
  readonly name: string;
  readonly displayTitle: string;
  readonly path: string;
  readonly event: string;
  readonly status: GitHubWorkflowRunStatus;
  readonly conclusion: GitHubWorkflowRunConclusion | null;
  readonly headBranch: string;
  readonly headSha: GitCommitSha;
  readonly actorLogin: string;
  readonly runAttempt: number;
  readonly createdAt: string;
  readonly url: string;
}

export interface GitHubWorkflowDispatch {
  readonly repository: string;
  readonly workflowPath: string;
  /** The protected branch the managed workflow is read from. */
  readonly workflowRef: string;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface GitHubWorkflowRunQuery {
  readonly repository: string;
  readonly workflowPath: string;
  readonly event?: string;
  readonly branch?: string;
  readonly maxRuns?: number;
}

/**
 * Every GitHub operation the orchestrator is allowed to perform. Reads answer
 * `undefined` for an absent resource rather than raising, so a caller can tell
 * "not there yet" from "refused".
 */
export interface GitHubClient {
  getTokenIdentity(): Promise<GitHubTokenIdentity>;
  getRepositoryMetadata(repository: string): Promise<GitHubRepositoryMetadata>;
  getRepositoryFacts(repository: string): Promise<GitHubRepositoryFacts>;

  resolveCommit(repository: string, ref: string): Promise<GitHubResolvedCommit>;
  readFile(repository: string, path: string, ref: string): Promise<GitHubFileContents | undefined>;
  writeFile(request: GitHubFileWriteRequest): Promise<GitHubFileWriteResult>;

  getBranch(repository: string, branch: string): Promise<GitHubBranch | undefined>;
  createBranch(repository: string, branch: string, commitSha: GitCommitSha): Promise<GitHubBranch>;
  /** Two-dot comparison of `head` against `base`; absent when either ref is gone. */
  compareCommits(repository: string, base: string, head: string): Promise<GitHubComparison | undefined>;

  listPullRequests(
    repository: string,
    query: { readonly headRef?: string; readonly baseRef?: string; readonly state?: "open" | "closed" | "all" },
  ): Promise<readonly GitHubPullRequest[]>;
  getPullRequest(repository: string, number: number): Promise<GitHubPullRequest | undefined>;
  createPullRequest(request: {
    readonly repository: string;
    readonly headRef: string;
    readonly baseRef: string;
    readonly title: string;
    readonly body: string;
  }): Promise<GitHubPullRequest>;

  getEnvironment(repository: string, environment: string): Promise<GitHubEnvironment | undefined>;
  /** Creates the Environment only when it is absent; never rewrites protection. */
  ensureEnvironment(repository: string, environment: string): Promise<GitHubEnvironment>;

  listEnvironmentVariables(repository: string, environment: string): Promise<readonly GitHubVariable[]>;
  setEnvironmentVariable(repository: string, environment: string, name: string, value: string): Promise<void>;
  deleteEnvironmentVariable(repository: string, environment: string, name: string): Promise<void>;

  listEnvironmentSecretNames(repository: string, environment: string): Promise<readonly string[]>;
  setEnvironmentSecret(repository: string, environment: string, name: string, value: string): Promise<void>;
  deleteEnvironmentSecret(repository: string, environment: string, name: string): Promise<void>;

  listDeployKeys(repository: string): Promise<readonly GitHubDeployKey[]>;
  createDeployKey(repository: string, title: string, publicKey: string): Promise<GitHubDeployKey>;
  deleteDeployKey(repository: string, keyId: number): Promise<void>;

  dispatchWorkflow(request: GitHubWorkflowDispatch): Promise<void>;
  listWorkflowRuns(query: GitHubWorkflowRunQuery): Promise<readonly GitHubWorkflowRun[]>;
  getWorkflowRun(repository: string, runId: number): Promise<GitHubWorkflowRun | undefined>;
}

const OAUTH_SCOPE_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/u;

function parseScopes(header: string): readonly string[] {
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => OAUTH_SCOPE_PATTERN.test(scope))
    .sort(compareCodePoints);
}

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const runner = options.runner ?? processGitHubCommandRunner;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  function assertResponseBounds(stdout: string, path: string): void {
    const byteLength = Buffer.byteLength(stdout, "utf8");
    if (byteLength > GITHUB_CLIENT_LIMITS.maxResponseBytes) {
      throw apiFailure("A GitHub response exceeded the bounded response size", { path, byteLength });
    }
  }

  /** One `gh api` call; no retry, no interpretation of the payload. */
  async function callOnce(request: ApiRequest): Promise<GitHubRunResult> {
    const body = request.body === undefined ? undefined : `${canonicalJson(request.body)}\n`;
    return runner.run({
      args: apiArguments(request),
      ...(body === undefined ? {} : { input: body }),
      timeoutMs: GITHUB_CLIENT_LIMITS.requestTimeoutMs,
    });
  }

  /**
   * Safe reads retry with deterministic backoff; a mutation is attempted once,
   * because a failed write may still have landed and repeating it could create
   * a second branch, pull request, or deploy key.
   */
  async function call(request: ApiRequest): Promise<unknown> {
    const attempts = request.method === "GET" ? GITHUB_CLIENT_LIMITS.readAttempts : 1;
    let last: GitHubRunResult | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(GITHUB_CLIENT_LIMITS.retryBaseMs * 2 ** (attempt - 1));
      const result = await callOnce(request);
      last = result;
      if (result.exitCode === 0) {
        assertResponseBounds(result.stdout, request.path);
        const text = result.stdout.trim();
        if (text === "") return undefined;
        try {
          return JSON.parse(text);
        } catch {
          throw apiFailure("A GitHub response was not parsable JSON", { path: request.path });
        }
      }
      const kind = classifyGitHubFailure(result.stderr);
      if (kind === "not-found" && request.absentOnNotFound === true) return undefined;
      const retryable = kind === "rate-limit" || (kind === "failed" && TRANSIENT_PATTERN.test(result.stderr));
      if (!retryable) {
        throw failureFor(kind, `The GitHub request ${request.method} ${request.path} was refused`, {
          path: request.path,
          method: request.method,
          exitCode: result.exitCode,
        });
      }
    }
    const kind = classifyGitHubFailure(last?.stderr ?? "");
    throw failureFor(kind, `The GitHub request ${request.method} ${request.path} did not succeed`, {
      path: request.path,
      method: request.method,
      attempts,
      exitCode: last?.exitCode ?? 1,
    });
  }

  async function callObject(request: ApiRequest): Promise<JsonObject | undefined> {
    const value = await call(request);
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) throw apiFailure(`The GitHub response for ${request.path} is not an object`);
    return value;
  }

  /**
   * Page-by-page rather than `gh --paginate`, so the page size, the page
   * ceiling, and the stopping rule are DeployKit's and do not vary with the
   * installed CLI.
   */
  async function paginate(
    path: string,
    request: { readonly query?: Readonly<Record<string, string>>; readonly collection?: string; readonly maxItems?: number },
  ): Promise<readonly JsonObject[]> {
    const items: JsonObject[] = [];
    // Only a caller that deliberately asked for the newest N truncates. A
    // listing that runs past the page ceiling fails closed, because an unseen
    // deploy key or pull request is exactly how a duplicate gets created.
    const maxItems = request.maxItems ?? Number.POSITIVE_INFINITY;
    for (let page = 1; page <= GITHUB_CLIENT_LIMITS.maxPages; page += 1) {
      const value = await call({
        method: "GET",
        path,
        query: {
          ...request.query,
          per_page: String(GITHUB_CLIENT_LIMITS.pageSize),
          page: String(page),
        },
      });
      let batch: readonly unknown[];
      if (request.collection === undefined) {
        if (!Array.isArray(value)) throw apiFailure(`The GitHub response for ${path} is not an array`);
        batch = value;
      } else {
        if (!isJsonObject(value)) throw apiFailure(`The GitHub response for ${path} is not an object`);
        batch = readArray(value, request.collection);
      }
      for (const entry of batch) {
        if (!isJsonObject(entry)) throw apiFailure(`The GitHub response for ${path} carries a non-object entry`);
        items.push(entry);
        if (items.length >= maxItems) return items;
      }
      if (batch.length < GITHUB_CLIENT_LIMITS.pageSize) return items;
    }
    throw apiFailure("A GitHub listing exceeded the bounded page count", {
      path,
      maxPages: GITHUB_CLIENT_LIMITS.maxPages,
    });
  }

  /** `gh secret set` and `gh variable set` own encryption and upsert semantics. */
  async function setEnvironmentValue(
    kind: "secret" | "variable",
    repository: string,
    environment: string,
    name: string,
    value: string,
  ): Promise<void> {
    assertRepository(repository);
    assertEnvironmentName(environment);
    assertValueName(name);
    const limit = kind === "secret"
      ? GITHUB_CLIENT_LIMITS.maxSecretValueBytes
      : GITHUB_CLIENT_LIMITS.maxVariableValueBytes;
    if (Buffer.byteLength(value, "utf8") > limit) {
      throw apiFailure(`The Environment ${kind} ${name} exceeds the GitHub value size limit`, { name, limit });
    }
    // Trailing newlines are stripped so the stored value is the same whether or
    // not the CLI trims them. Consumers that need a terminating newline — an
    // SSH private key materialized on a runner, for example — append it there.
    const result = await runner.run({
      args: [kind, "set", name, "--repo", repository, "--env", environment],
      input: value.replace(/[\r\n]+$/u, ""),
      timeoutMs: GITHUB_CLIENT_LIMITS.requestTimeoutMs,
    });
    if (result.exitCode !== 0) {
      throw failureFor(classifyGitHubFailure(result.stderr), `The Environment ${kind} ${name} could not be written`, {
        name,
        environment,
        exitCode: result.exitCode,
      });
    }
  }

  async function deleteEnvironmentValue(
    kind: "secret" | "variable",
    repository: string,
    environment: string,
    name: string,
  ): Promise<void> {
    assertRepository(repository);
    assertEnvironmentName(environment);
    assertValueName(name);
    const result = await runner.run({
      args: [kind, "delete", name, "--repo", repository, "--env", environment],
      timeoutMs: GITHUB_CLIENT_LIMITS.requestTimeoutMs,
    });
    if (result.exitCode === 0) return;
    const failure = classifyGitHubFailure(result.stderr);
    if (failure === "not-found") return;
    throw failureFor(failure, `The Environment ${kind} ${name} could not be removed`, {
      name,
      environment,
      exitCode: result.exitCode,
    });
  }

  function toPullRequest(source: JsonObject): GitHubPullRequest {
    const head = readObject(source, "head");
    const base = readObject(source, "base");
    const headSha = readString(head, "sha");
    assertCommitSha(headSha);
    return {
      number: readNumber(source, "number"),
      title: readString(source, "title"),
      state: readEnum<GitHubPullRequestState>(source, "state", new Set(["open", "closed"])),
      // A listing reports `merged_at` only; a single pull request reports both.
      merged: source["merged"] === true || readOptionalString(source, "merged_at") !== null,
      mergeCommitSha: readOptionalString(source, "merge_commit_sha"),
      headRef: readString(head, "ref"),
      headSha,
      baseRef: readString(base, "ref"),
      draft: readBoolean(source, "draft", false),
      url: readString(source, "html_url"),
    };
  }

  function toEnvironment(source: JsonObject): GitHubEnvironment {
    const reviewers: string[] = [];
    let waitTimerMinutes = 0;
    for (const entry of readArray(source, "protection_rules")) {
      if (!isJsonObject(entry)) throw apiFailure("A GitHub Environment protection rule is not an object");
      const type = readString(entry, "type");
      if (type === "wait_timer") waitTimerMinutes = readNumber(entry, "wait_timer");
      if (type !== "required_reviewers") continue;
      for (const candidate of readArray(entry, "reviewers")) {
        if (!isJsonObject(candidate)) throw apiFailure("A GitHub Environment reviewer is not an object");
        const reviewer = readObject(candidate, "reviewer");
        const kind = readString(candidate, "type");
        const name = kind === "Team" ? readString(reviewer, "slug") : readString(reviewer, "login");
        reviewers.push(`${kind === "Team" ? "team" : "user"}:${name}`);
      }
    }
    const policy = readOptionalObject(source, "deployment_branch_policy");
    return {
      name: readString(source, "name"),
      protection: {
        reviewers,
        waitTimerMinutes,
        protectedBranchesOnly: policy === undefined ? false : readBoolean(policy, "protected_branches", false),
        customBranchPolicies: policy === undefined ? false : readBoolean(policy, "custom_branch_policies", false),
      },
    };
  }

  function toDeployKey(source: JsonObject): GitHubDeployKey {
    return {
      id: readNumber(source, "id"),
      title: readOptionalString(source, "title") ?? "",
      key: readString(source, "key"),
      readOnly: readBoolean(source, "read_only"),
    };
  }

  function toWorkflowRun(source: JsonObject): GitHubWorkflowRun {
    const headSha = readString(source, "head_sha");
    assertCommitSha(headSha);
    const conclusion = readOptionalString(source, "conclusion");
    if (conclusion !== null && !WORKFLOW_RUN_CONCLUSIONS.has(conclusion)) {
      throw apiFailure("A workflow run reported an unrecognized conclusion");
    }
    const actor = readOptionalObject(source, "actor");
    return {
      id: readNumber(source, "id"),
      name: readOptionalString(source, "name") ?? "",
      displayTitle: readOptionalString(source, "display_title") ?? "",
      path: readString(source, "path"),
      event: readString(source, "event"),
      status: readEnum<GitHubWorkflowRunStatus>(source, "status", WORKFLOW_RUN_STATUSES),
      conclusion: conclusion as GitHubWorkflowRunConclusion | null,
      headBranch: readOptionalString(source, "head_branch") ?? "",
      headSha,
      actorLogin: actor === undefined ? "" : readString(actor, "login"),
      runAttempt: typeof source["run_attempt"] === "number" ? readNumber(source, "run_attempt") : 1,
      createdAt: readString(source, "created_at"),
      url: readString(source, "html_url"),
    };
  }

  const client: GitHubClient = {
    async getTokenIdentity(): Promise<GitHubTokenIdentity> {
      // `--include` prints the response headers, which is the only place a
      // classic token's scopes are disclosed. The token itself is never echoed.
      const result = await runner.run({
        args: ["api", "--method", "GET", "--include", "--header", "Accept: application/vnd.github+json", "user"],
        timeoutMs: GITHUB_CLIENT_LIMITS.requestTimeoutMs,
      });
      if (result.exitCode !== 0) {
        const kind = classifyGitHubFailure(result.stderr);
        throw failureFor(kind === "not-found" ? "auth" : kind, "The GitHub CLI is not authenticated", {
          exitCode: result.exitCode,
        });
      }
      assertResponseBounds(result.stdout, "user");
      const separator = result.stdout.search(/\r?\n\r?\n/u);
      const headerText = separator < 0 ? "" : result.stdout.slice(0, separator);
      const bodyText = separator < 0 ? result.stdout : result.stdout.slice(separator).trim();
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw apiFailure("The authenticated GitHub identity was not parsable JSON");
      }
      if (!isJsonObject(body)) throw apiFailure("The authenticated GitHub identity is not an object");
      const scopeHeader = headerText
        .split(/\r?\n/u)
        .find((line) => line.toLowerCase().startsWith("x-oauth-scopes:"));
      return {
        login: readString(body, "login"),
        scopes: scopeHeader === undefined ? [] : parseScopes(scopeHeader.slice(scopeHeader.indexOf(":") + 1)),
      };
    },

    async getRepositoryMetadata(repository: string): Promise<GitHubRepositoryMetadata> {
      assertRepository(repository);
      const source = await callObject({ method: "GET", path: `repos/${encodePath(repository)}` });
      if (source === undefined) throw apiFailure("The repository metadata response was empty", { repository });
      const permissions = readOptionalObject(source, "permissions");
      if (permissions === undefined) {
        // Without a permissions block the caller's rights are unknown, and
        // guessing them is how a run discovers a missing right mid-reconcile.
        throw orchestratorError(
          "DK_GITHUB_PERMISSION_DENIED",
          `GitHub did not report the authenticated actor's permissions on ${repository}`,
          { details: { repository } },
        );
      }
      const plan = readOptionalObject(source, "plan");
      const planName = plan === undefined ? null : readOptionalString(plan, "name");
      const isPrivate = readBoolean(source, "private");
      return {
        repository: readString(source, "full_name"),
        defaultBranch: readString(source, "default_branch"),
        private: isPrivate,
        visibility: readOptionalString(source, "visibility") ?? (isPrivate ? "private" : "public"),
        archived: readBoolean(source, "archived", false),
        permissions: {
          admin: readBoolean(permissions, "admin", false),
          maintain: readBoolean(permissions, "maintain", false),
          push: readBoolean(permissions, "push", false),
          triage: readBoolean(permissions, "triage", false),
          pull: readBoolean(permissions, "pull", false),
        },
        planName,
        environmentProtectionAvailable: !isPrivate || planName !== "free",
      };
    },

    async getRepositoryFacts(repository: string): Promise<GitHubRepositoryFacts> {
      const identity = await client.getTokenIdentity();
      const metadata = await client.getRepositoryMetadata(repository);
      const head = await client.resolveCommit(metadata.repository, metadata.defaultBranch);
      const { admin, push, pull } = metadata.permissions;
      // A classic token must additionally carry `workflow` to change a workflow
      // file; a token that discloses no scopes is not assumed to lack it.
      const workflowScope = identity.scopes.length === 0 || identity.scopes.includes("workflow");
      return {
        repository: metadata.repository,
        defaultBranch: metadata.defaultBranch,
        defaultBranchCommitSha: head.commitSha,
        private: metadata.private,
        authenticatedActor: identity.login,
        permissions: {
          read: pull,
          contentsWrite: push && !metadata.archived,
          workflowsWrite: push && workflowScope && !metadata.archived,
          environmentsWrite: admin && !metadata.archived,
          deployKeysWrite: admin && !metadata.archived,
          pullRequestsWrite: push && !metadata.archived,
        },
      };
    },

    async resolveCommit(repository: string, ref: string): Promise<GitHubResolvedCommit> {
      assertRepository(repository);
      assertRepositoryPath(ref, "ref");
      const source = await callObject({
        method: "GET",
        path: `repos/${encodePath(repository)}/commits/${encodePath(ref)}`,
        absentOnNotFound: true,
      });
      if (source === undefined) {
        throw orchestratorError(
          "DK_REF_NOT_FOUND",
          `${ref} does not resolve to a commit in ${repository}`,
          { details: { repository, ref } },
        );
      }
      const commitSha = readString(source, "sha");
      assertCommitSha(commitSha);
      return { repository, ref, commitSha };
    },

    async readFile(repository: string, path: string, ref: string): Promise<GitHubFileContents | undefined> {
      assertRepository(repository);
      assertRepositoryPath(path, "path");
      assertRepositoryPath(ref, "ref");
      const source = await callObject({
        method: "GET",
        path: `repos/${encodePath(repository)}/contents/${encodePath(path)}`,
        query: { ref },
        absentOnNotFound: true,
      });
      if (source === undefined) return undefined;
      if (readOptionalString(source, "type") !== "file") {
        throw orchestratorError(
          "DK_OWNERSHIP_CONFLICT",
          `${path} in ${repository} is not a regular file`,
          { details: { repository, path } },
        );
      }
      const byteLength = readNumber(source, "size");
      if (byteLength > GITHUB_CLIENT_LIMITS.maxFileBytes) {
        throw apiFailure(`${path} exceeds the bounded control-artifact size`, { path, byteLength });
      }
      if (readString(source, "encoding") !== "base64") {
        throw apiFailure(`${path} was returned in an unsupported encoding`, { path });
      }
      const decoded = Buffer.from(readString(source, "content"), "base64");
      return {
        path: readString(source, "path"),
        blobSha: readString(source, "sha"),
        byteLength: decoded.byteLength,
        contents: decoded.toString("utf8"),
      };
    },

    async writeFile(request: GitHubFileWriteRequest): Promise<GitHubFileWriteResult> {
      assertRepository(request.repository);
      assertRepositoryPath(request.path, "path");
      assertRepositoryPath(request.branch, "branch");
      const contents = Buffer.from(request.contents, "utf8");
      if (contents.byteLength > GITHUB_CLIENT_LIMITS.maxFileBytes) {
        throw apiFailure(`${request.path} exceeds the bounded control-artifact size`, {
          path: request.path,
          byteLength: contents.byteLength,
        });
      }
      const body: Record<string, CanonicalValue> = {
        branch: request.branch,
        content: contents.toString("base64"),
        message: request.message,
      };
      if (request.expectedBlobSha !== undefined) body["sha"] = request.expectedBlobSha;
      const source = await callObject({
        method: "PUT",
        path: `repos/${encodePath(request.repository)}/contents/${encodePath(request.path)}`,
        body,
      });
      if (source === undefined) throw apiFailure("The content write response was empty", { path: request.path });
      const content = readObject(source, "content");
      const commit = readObject(source, "commit");
      const commitSha = readString(commit, "sha");
      assertCommitSha(commitSha);
      return { path: readString(content, "path"), blobSha: readString(content, "sha"), commitSha };
    },

    async getBranch(repository: string, branch: string): Promise<GitHubBranch | undefined> {
      assertRepository(repository);
      assertRepositoryPath(branch, "branch");
      const source = await callObject({
        method: "GET",
        path: `repos/${encodePath(repository)}/branches/${encodePath(branch)}`,
        absentOnNotFound: true,
      });
      if (source === undefined) return undefined;
      const commitSha = readString(readObject(source, "commit"), "sha");
      assertCommitSha(commitSha);
      return {
        name: readString(source, "name"),
        commitSha,
        protected: readBoolean(source, "protected", false),
      };
    },

    async createBranch(repository: string, branch: string, commitSha: GitCommitSha): Promise<GitHubBranch> {
      assertRepository(repository);
      assertRepositoryPath(branch, "branch");
      assertCommitSha(commitSha);
      const source = await callObject({
        method: "POST",
        path: `repos/${encodePath(repository)}/git/refs`,
        body: { ref: `refs/heads/${branch}`, sha: commitSha },
      });
      if (source === undefined) throw apiFailure("The branch creation response was empty", { branch });
      const created = readString(readObject(source, "object"), "sha");
      assertCommitSha(created);
      return { name: branch, commitSha: created, protected: false };
    },

    async compareCommits(repository, base, head): Promise<GitHubComparison | undefined> {
      assertRepository(repository);
      assertRepositoryPath(base, "branch");
      assertRepositoryPath(head, "branch");
      const source = await callObject({
        method: "GET",
        // The comparison range is one path segment; `encodePath` keeps the
        // separators inside a branch name literal, which is what GitHub expects.
        path: `repos/${encodePath(repository)}/compare/${encodePath(`${base}...${head}`)}`,
        absentOnNotFound: true,
      });
      if (source === undefined) return undefined;
      const files: string[] = [];
      for (const entry of readArray(source, "files")) {
        if (!isJsonObject(entry)) throw apiFailure("A GitHub comparison file entry is not an object");
        files.push(readString(entry, "filename"));
        const previous = readOptionalString(entry, "previous_filename");
        if (previous !== null) files.push(previous);
      }
      return {
        status: readEnum<GitHubComparison["status"]>(
          source,
          "status",
          new Set(["identical", "ahead", "behind", "diverged"]),
        ),
        aheadBy: readNumber(source, "ahead_by"),
        behindBy: readNumber(source, "behind_by"),
        files: [...new Set(files)].sort(compareCodePoints),
        // GitHub returns at most 300 entries and does not say so; a full page is
        // therefore treated as possibly incomplete rather than as the whole diff.
        truncated: files.length >= GITHUB_COMPARISON_FILE_LIMIT,
      };
    },

    async listPullRequests(repository, query): Promise<readonly GitHubPullRequest[]> {
      assertRepository(repository);
      const owner = repository.slice(0, repository.indexOf("/"));
      const search: Record<string, string> = { state: query.state ?? "all" };
      if (query.headRef !== undefined) {
        assertRepositoryPath(query.headRef, "branch");
        search["head"] = `${owner}:${query.headRef}`;
      }
      if (query.baseRef !== undefined) {
        assertRepositoryPath(query.baseRef, "branch");
        search["base"] = query.baseRef;
      }
      const items = await paginate(`repos/${encodePath(repository)}/pulls`, { query: search });
      return items.map(toPullRequest);
    },

    async getPullRequest(repository: string, number: number): Promise<GitHubPullRequest | undefined> {
      assertRepository(repository);
      if (!Number.isInteger(number) || number < 1) throw apiFailure("The pull request number is not a positive integer");
      const source = await callObject({
        method: "GET",
        path: `repos/${encodePath(repository)}/pulls/${String(number)}`,
        absentOnNotFound: true,
      });
      return source === undefined ? undefined : toPullRequest(source);
    },

    async createPullRequest(request): Promise<GitHubPullRequest> {
      assertRepository(request.repository);
      assertRepositoryPath(request.headRef, "branch");
      assertRepositoryPath(request.baseRef, "branch");
      if (!TITLE_PATTERN.test(request.title)) throw apiFailure("The pull request title is not a supported title");
      const source = await callObject({
        method: "POST",
        path: `repos/${encodePath(request.repository)}/pulls`,
        body: {
          base: request.baseRef,
          body: request.body,
          draft: false,
          head: request.headRef,
          // DeployKit never lets a base-repository maintainer rewrite the
          // branch the setup review is taken from.
          maintainer_can_modify: false,
          title: request.title,
        },
      });
      if (source === undefined) throw apiFailure("The pull request creation response was empty");
      return toPullRequest(source);
    },

    async getEnvironment(repository: string, environment: string): Promise<GitHubEnvironment | undefined> {
      assertRepository(repository);
      assertEnvironmentName(environment);
      const source = await callObject({
        method: "GET",
        path: `repos/${encodePath(repository)}/environments/${encodeURIComponent(environment)}`,
        absentOnNotFound: true,
      });
      return source === undefined ? undefined : toEnvironment(source);
    },

    async ensureEnvironment(repository: string, environment: string): Promise<GitHubEnvironment> {
      const existing = await client.getEnvironment(repository, environment);
      // A PUT replaces protection wholesale, so an Environment that already
      // exists is returned untouched and its reviewers, wait timer, and branch
      // policy survive every rerun.
      if (existing !== undefined) return existing;
      const created = await callObject({
        method: "PUT",
        path: `repos/${encodePath(repository)}/environments/${encodeURIComponent(environment)}`,
        body: {},
      });
      if (created === undefined) throw apiFailure("The Environment creation response was empty", { environment });
      return toEnvironment(created);
    },

    async listEnvironmentVariables(repository: string, environment: string): Promise<readonly GitHubVariable[]> {
      assertRepository(repository);
      assertEnvironmentName(environment);
      const items = await paginate(
        `repos/${encodePath(repository)}/environments/${encodeURIComponent(environment)}/variables`,
        { collection: "variables" },
      );
      return items
        .map((entry) => ({ name: readString(entry, "name"), value: readString(entry, "value") }))
        .sort((left, right) => compareCodePoints(left.name, right.name));
    },

    setEnvironmentVariable(repository, environment, name, value): Promise<void> {
      return setEnvironmentValue("variable", repository, environment, name, value);
    },

    deleteEnvironmentVariable(repository, environment, name): Promise<void> {
      return deleteEnvironmentValue("variable", repository, environment, name);
    },

    async listEnvironmentSecretNames(repository: string, environment: string): Promise<readonly string[]> {
      assertRepository(repository);
      assertEnvironmentName(environment);
      const items = await paginate(
        `repos/${encodePath(repository)}/environments/${encodeURIComponent(environment)}/secrets`,
        { collection: "secrets" },
      );
      return items.map((entry) => readString(entry, "name")).sort(compareCodePoints);
    },

    setEnvironmentSecret(repository, environment, name, value): Promise<void> {
      return setEnvironmentValue("secret", repository, environment, name, value);
    },

    deleteEnvironmentSecret(repository, environment, name): Promise<void> {
      return deleteEnvironmentValue("secret", repository, environment, name);
    },

    async listDeployKeys(repository: string): Promise<readonly GitHubDeployKey[]> {
      assertRepository(repository);
      const items = await paginate(`repos/${encodePath(repository)}/keys`, {});
      return items.map(toDeployKey).sort((left, right) => left.id - right.id);
    },

    async createDeployKey(repository: string, title: string, publicKey: string): Promise<GitHubDeployKey> {
      assertRepository(repository);
      if (!TITLE_PATTERN.test(title)) throw apiFailure("The deploy key title is not a supported title");
      const key = publicKey.trim();
      if (!/^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}(?: \S+)?$/u.test(key)) {
        throw apiFailure("The deploy key is not an OpenSSH public key");
      }
      const source = await callObject({
        method: "POST",
        path: `repos/${encodePath(repository)}/keys`,
        // Never negotiable: the VPS fetches with this key, and write access
        // would let a compromised build rewrite the repository it deploys from.
        body: { key, read_only: true, title },
      });
      if (source === undefined) throw apiFailure("The deploy key creation response was empty");
      const created = toDeployKey(source);
      if (!created.readOnly) {
        throw orchestratorError(
          "DK_OWNERSHIP_CONFLICT",
          `${repository} registered the DeployKit repository key with write access`,
          { details: { repository, keyId: created.id } },
        );
      }
      return created;
    },

    async deleteDeployKey(repository: string, keyId: number): Promise<void> {
      assertRepository(repository);
      if (!Number.isInteger(keyId) || keyId < 1) throw apiFailure("The deploy key id is not a positive integer");
      await call({
        method: "DELETE",
        path: `repos/${encodePath(repository)}/keys/${String(keyId)}`,
        absentOnNotFound: true,
      });
    },

    async dispatchWorkflow(request: GitHubWorkflowDispatch): Promise<void> {
      assertRepository(request.repository);
      const workflow = workflowFileName(request.workflowPath);
      assertRepositoryPath(request.workflowRef, "ref");
      const names = Object.keys(request.inputs).sort(compareCodePoints);
      if (names.length > GITHUB_CLIENT_LIMITS.maxDispatchInputs) {
        throw apiFailure("The workflow dispatch declares more inputs than GitHub accepts", {
          inputs: names.length,
          limit: GITHUB_CLIENT_LIMITS.maxDispatchInputs,
        });
      }
      const inputs: Record<string, CanonicalValue> = {};
      let payloadBytes = 0;
      for (const name of names) {
        const value = request.inputs[name];
        if (value === undefined) continue;
        assertValueName(name);
        payloadBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
        inputs[name] = value;
      }
      if (payloadBytes > GITHUB_CLIENT_LIMITS.maxDispatchInputBytes) {
        throw apiFailure("The workflow dispatch inputs exceed the bounded payload size", { payloadBytes });
      }
      await call({
        method: "POST",
        path: `repos/${encodePath(request.repository)}/actions/workflows/${encodePath(workflow)}/dispatches`,
        body: { inputs, ref: request.workflowRef },
      });
    },

    async listWorkflowRuns(query: GitHubWorkflowRunQuery): Promise<readonly GitHubWorkflowRun[]> {
      assertRepository(query.repository);
      const workflow = workflowFileName(query.workflowPath);
      const search: Record<string, string> = { event: query.event ?? "workflow_dispatch" };
      if (query.branch !== undefined) {
        assertRepositoryPath(query.branch, "branch");
        search["branch"] = query.branch;
      }
      const items = await paginate(
        `repos/${encodePath(query.repository)}/actions/workflows/${encodePath(workflow)}/runs`,
        {
          query: search,
          collection: "workflow_runs",
          ...(query.maxRuns === undefined ? {} : { maxItems: query.maxRuns }),
        },
      );
      return items.map(toWorkflowRun);
    },

    async getWorkflowRun(repository: string, runId: number): Promise<GitHubWorkflowRun | undefined> {
      assertRepository(repository);
      if (!Number.isInteger(runId) || runId < 1) throw apiFailure("The workflow run id is not a positive integer");
      const source = await callObject({
        method: "GET",
        path: `repos/${encodePath(repository)}/actions/runs/${String(runId)}`,
        absentOnNotFound: true,
      });
      return source === undefined ? undefined : toWorkflowRun(source);
    },
  };

  return client;
}
