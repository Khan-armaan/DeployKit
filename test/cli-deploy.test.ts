import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configDeploymentOptions,
  configureProgram,
  runCli,
  runConfigDeployment,
} from "../src/cli.js";
import { DeployKitError } from "../src/errors.js";
import { Reporter, clearRedactedValues } from "../src/output.js";
import { run as runProcess } from "../src/process.js";
import type { OrchestratorResult } from "../src/orchestrator/dependencies.js";
import {
  HermeticGitHub,
  HermeticHost,
  HermeticKeyPairs,
  createApplicationRepository,
  createRuntimeBundle,
  fingerprintOf,
  type LegacyRunnerState,
} from "./helpers/hermetic-world.js";

/**
 * Phase 13: `deploykit deploy` as an operator actually invokes it.
 *
 * `test/orchestrator-integration.test.ts` proves the orchestrator; this suite
 * proves the cutover — that the public command reaches it, that the three
 * documented flags mean what the documentation says, that the legacy
 * `deploykit.yaml` path is still selectable and never selected by accident, and
 * that a host carrying a v0.1.x root Actions runner is migrated only with the
 * operator's explicit consent inside this same invocation.
 */

const execFileAsync = promisify(execFile);

const REPOSITORY = "deploykit-fixtures/static-compose";
const ENVIRONMENT = "fixture-static-production";
const HOST = "vps.static.example.test";

/** The runner a DeployKit v0.1.x bootstrap would have left on this host. */
function legacyRunner(overrides: Partial<LegacyRunnerState> = {}): LegacyRunnerState {
  return {
    directory: "deploykit-fixtures-static-compose-vps-one",
    agentId: 55,
    agentName: "deploykit-vps-one",
    gitHubUrl: `https://github.com/${REPOSITORY}`,
    serviceUnit: "actions.runner.deploykit-fixtures-static-compose.deploykit-vps-one.service",
    serviceActive: true,
    serviceEnabled: true,
    ...overrides,
  };
}

class MemoryStream extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.text += String(chunk);
    done();
  }
}

interface Harness {
  readonly root: string;
  readonly applicationRoot: string;
  readonly github: HermeticGitHub;
  readonly host: HermeticHost;
  readonly stdout: MemoryStream;
  readonly stderr: MemoryStream;
  /** Drives exactly what `deploykit deploy <flags>` drives. */
  deploy(
    flags?: Parameters<typeof configDeploymentOptions>[0],
    overrides?: Record<string, unknown>,
  ): Promise<OrchestratorResult>;
}

let temporaryRoots: string[] = [];

async function harness(
  options: { readonly legacyRunner?: LegacyRunnerState; readonly json?: boolean } = {},
): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-cli-deploy-")));
  temporaryRoots.push(root);

  const applicationRoot = join(root, "app");
  await createApplicationRepository(applicationRoot, async (args) => {
    await runProcess("git", args, { cwd: root });
  });

  const runtimeBundle = await createRuntimeBundle(join(root, "bundle"));
  const github = new HermeticGitHub({ repository: REPOSITORY });
  const host = new HermeticHost({
    host: HOST,
    repository: REPOSITORY,
    ...(options.legacyRunner === undefined ? {} : { legacyRunner: options.legacyRunner }),
  });
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  // The fixture pins a placeholder fingerprint; make it the one this host will
  // actually present, so the preflight pin is a real comparison.
  const configPath = join(applicationRoot, "deploykit.config.yaml");
  const source = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    source.replace(
      /hostKeyFingerprint: .*/u,
      `hostKeyFingerprint: ${fingerprintOf(host.hostKeyLine.split(" ").slice(1).join(" "))}`,
    ),
  );

  return {
    root,
    applicationRoot,
    github,
    host,
    stdout,
    stderr,
    deploy(flags = {}, overrides: Record<string, unknown> = {}): Promise<OrchestratorResult> {
      return runConfigDeployment({
        reporter: new Reporter(options.json === true ? "json" : "human", false, stdout, stderr),
        cwd: applicationRoot,
        githubRunner: github,
        administratorRunner: host,
        keyPairs: new HermeticKeyPairs(),
        temporaryRoot: root,
        operationStateRoot: join(root, "state"),
        runtimeBundle,
        interactive: false,
        polling: { intervalMs: 0, correlationAttempts: 4, runAttempts: 8 },
        pollIntervalMs: 0,
        sleep: async () => undefined,
        ...configDeploymentOptions(flags),
        ...overrides,
      });
    },
  };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<DeployKitError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(DeployKitError);
  const failure = error as DeployKitError;
  expect(failure.code).toBe(code);
  return failure;
}

beforeEach(() => {
  temporaryRoots = [];
});

afterEach(async () => {
  clearRedactedValues();
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ parser --

describe("deploy command contract", () => {
  const deploy = (): ReturnType<typeof configureProgram>["commands"][number] => {
    const found = configureProgram().commands.find((command) => command.name() === "deploy");
    if (found === undefined) throw new Error("deploy command is missing");
    return found;
  };

  it("exposes exactly the documented flags", () => {
    expect(deploy().options.map((option) => option.long)).toEqual([
      "--config",
      "--dry-run",
      "--no-wait",
      "--target",
      "--ref",
      "--repo",
    ]);
    expect(deploy().description()).toContain("deploykit.config.yaml");
  });

  it("prints the documented flags and the legacy commands in help", () => {
    const help = deploy().helpInformation();
    expect(help).toContain("--config <path>");
    expect(help).toContain("--dry-run");
    expect(help).toContain("--no-wait");

    // The legacy commands stay reachable, and stay labelled as legacy.
    const program = configureProgram().helpInformation();
    for (const command of ["init", "validate", "plan", "secrets", "retry", "status", "logs"]) {
      expect(program).toContain(command);
    }
  });

  it("maps flags onto orchestrator options and leaves absent flags absent", () => {
    expect(configDeploymentOptions({ wait: true })).toEqual({});
    expect(configDeploymentOptions({ wait: false })).toEqual({ noWait: true });
    expect(configDeploymentOptions({ dryRun: true, wait: true })).toEqual({ dryRun: true });
    expect(configDeploymentOptions({ config: "app/deploykit.config.yaml", wait: true })).toEqual({
      configPath: resolve("app/deploykit.config.yaml"),
    });
  });

  it("refuses to mix the config-driven flags with the legacy ones", async () => {
    const capture = new MemoryStream();
    const exitCode = await runCli(
      ["node", "deploykit", "deploy", "--config", "x/deploykit.config.yaml", "--target", "production", "--ref", "main", "--json"],
      capture,
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.text)).toMatchObject({ ok: false, code: "DK_USAGE" });
  });

  it("still requires both legacy flags when the legacy path is selected", async () => {
    const capture = new MemoryStream();
    const exitCode = await runCli(["node", "deploykit", "deploy", "--target", "production", "--json"], capture);
    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.text)).toMatchObject({
      ok: false,
      code: "DK_USAGE",
      message: expect.stringContaining("--ref"),
    });
  });
});

// ------------------------------------------------------------ exit codes --

describe("deploy exit codes and machine-readable output", () => {
  it("scaffolds the config and returns the stable waiting-for-input exit code", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-cli-scaffold-")));
    temporaryRoots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    const previous = process.cwd();
    const capture = new MemoryStream();
    // The scaffolding progress and result go to the real stdout; capture them
    // so one test's JSON never becomes another's noise.
    const write = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    try {
      process.chdir(root);
      const exitCode = await runCli(["node", "deploykit", "deploy", "--json"], capture);
      expect(exitCode).toBe(2);
      const envelope = JSON.parse(capture.text.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
      expect(envelope).toMatchObject({ ok: false, code: "DK_CONFIG_SCAFFOLDED" });
      expect(envelope["details"]).toMatchObject({ recovery: "edit-config-and-rerun" });
    } finally {
      write.mockRestore();
      process.chdir(previous);
    }
  });
});

// ---------------------------------------------------------- the happy path --

describe("deploykit deploy", () => {
  it("deploys from one config and one command and reports the result as JSON", async () => {
    const fixture = await harness({ json: true });
    const result = await fixture.deploy();

    expect(result.outcome).toBe("succeeded");
    expect(result.httpsUrl).toBe("https://static.example.test/");
    expect(result.recovery).toBe("none");

    const envelope = JSON.parse(fixture.stdout.text.trim().split("\n").at(-1) ?? "") as {
      ok: boolean;
      code: string;
      data: OrchestratorResult;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.code).toBe("DK_DEPLOY_RESULT");
    expect(envelope.data.workflowRunUrl).toBe(result.workflowRunUrl);

    // Nothing about a fresh host involves an Actions runner.
    expect(fixture.github.selfHostedRunners).toEqual([]);
    expect(fixture.host.arguments()).not.toContain("actions-runner");
    expect(fixture.host.arguments().join(" ")).not.toContain("systemctl stop");
    expect(fixture.github.endpoints().some((endpoint) => endpoint.includes("actions/runners"))).toBe(false);
  });

  it("honours --dry-run by inspecting every boundary and mutating nothing", async () => {
    const fixture = await harness();
    const result = await fixture.deploy({ dryRun: true, wait: true });

    expect(result.outcome).toBe("dry-run");
    expect(fixture.host.binding).toBeNull();
    expect(fixture.github.pulls).toEqual([]);
    expect(fixture.github.environments.has(ENVIRONMENT)).toBe(false);
    expect(fixture.github.runs).toEqual([]);
    // Reads happened; writes did not.
    const methods = fixture.github.calls.flatMap((call) => {
      const index = call.args.indexOf("--method");
      return index < 0 ? [] : [call.args[index + 1] ?? ""];
    });
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("honours --no-wait by refusing to block on review and stopping at the run", async () => {
    const fixture = await harness();
    // `--no-wait` must not block on a human, so a pending setup pull request
    // stops the run resumably instead of waiting for the merge.
    const pending = await expectFailure(fixture.deploy({ wait: false }), "DK_SETUP_PR_REVIEW_REQUIRED");
    expect(pending.exitCode).toBe(9);
    fixture.github.mergePullRequest(fixture.github.pulls[0]?.number ?? 0);

    const result = await fixture.deploy({ wait: false });

    expect(result.outcome).toBe("dispatched");
    expect(result.workflowRunId).not.toBeNull();
    expect(result.healthy).toBeNull();
  });

  it("reads the config named by --config from outside the application repository", async () => {
    const fixture = await harness();
    const previous = process.cwd();
    try {
      // A different working directory entirely; only --config says where to go.
      process.chdir(fixture.root);
      const result = await fixture.deploy(
        { config: join(fixture.applicationRoot, "deploykit.config.yaml"), wait: true },
        { cwd: undefined },
      );
      expect(result.outcome).toBe("succeeded");
    } finally {
      process.chdir(previous);
    }
  });

  it("never packs a runtime bundle for a run that stops at the config", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-cli-lazy-")));
    temporaryRoots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);

    let packed = 0;
    const deploy = (): Promise<OrchestratorResult> =>
      runConfigDeployment({
        reporter: new Reporter("json", false, new MemoryStream(), new MemoryStream()),
        cwd: root,
        interactive: false,
        operationStateRoot: join(root, "state"),
        runtimeBundle: async () => {
          packed += 1;
          throw new Error("the runtime bundle must not be packed before the config is valid");
        },
      });

    // A first run creates the config and stops; a second refuses its
    // placeholders. Neither needs the bundle, and a slow `npm pack` here would
    // also report a packaging failure in place of the real config error.
    await expectFailure(deploy(), "DK_CONFIG_SCAFFOLDED");
    await expectFailure(deploy(), "DK_CONFIG_PLACEHOLDER");
    expect(packed).toBe(0);
  });

  it("refuses a --config that is not the application repository's own config", async () => {
    const fixture = await harness();
    await expectFailure(
      fixture.deploy({ config: join(fixture.applicationRoot, "deploykit.config.yml"), wait: true }),
      "DK_CONFIG_INSECURE",
    );
  });
});

// -------------------------------------------------------- legacy migration --

describe("legacy root Actions runner migration", () => {
  it("installs the gateway first, then retires the runner only after approval", async () => {
    const fixture = await harness({ legacyRunner: legacyRunner() });
    fixture.github.selfHostedRunners.push({
      id: 55,
      name: "deploykit-vps-one",
      status: "online",
      busy: false,
      labels: ["self-hosted", "deploykit", "vps-one"],
    });

    const asked: string[] = [];
    const result = await fixture.deploy({ wait: true }, {
      approveLegacyRunnerRemoval: async (request: { host: string; runnerRoot: string }) => {
        asked.push(request.runnerRoot);
        // The replacement is already installed and proven when the question is
        // asked: an operator is never asked to give up the old path first.
        expect(fixture.host.binding).not.toBeNull();
        return true;
      },
    });

    expect(result.outcome).toBe("succeeded");
    expect(asked).toEqual(["/opt/actions-runner/deploykit-fixtures-static-compose-vps-one"]);

    // The host's service is stopped and disabled...
    expect(fixture.host.legacyRunner?.serviceActive).toBe(false);
    expect(fixture.host.legacyRunner?.serviceEnabled).toBe(false);
    // ...and every file it owns is still there, so the host stays recoverable.
    expect(fixture.host.legacyRunner?.directory).toBe("deploykit-fixtures-static-compose-vps-one");
    // The only argv naming the runner root are the reads and the two
    // systemctl verbs; nothing deletes, moves, or truncates anything there.
    const touching = fixture.host.calls
      .map((call) => call.args)
      .filter((args) => args.some((argument) => argument.startsWith("/opt/actions-runner")));
    expect(touching.every((args) => args.includes("ls") || args.includes("cat"))).toBe(true);
    expect(fixture.host.arguments().join(" ")).not.toContain("rm -rf /opt/actions-runner");

    // GitHub no longer routes a job to it, proved by re-reading the listing.
    expect(fixture.github.selfHostedRunners).toEqual([]);
    const runnerEndpoints = fixture.github.endpoints().filter((endpoint) => endpoint.includes("actions/runners"));
    expect(runnerEndpoints.length).toBeGreaterThanOrEqual(3);
    expect(runnerEndpoints.at(-1)).toContain("actions/runners?");
  });

  it("never removes the runner when approval is refused, and refuses to deploy beside it", async () => {
    const fixture = await harness({ legacyRunner: legacyRunner() });
    fixture.github.selfHostedRunners.push({
      id: 55,
      name: "deploykit-vps-one",
      status: "online",
      busy: false,
      labels: ["self-hosted"],
    });

    // A non-interactive session answers no; nothing has to be passed for that.
    const failure = await expectFailure(fixture.deploy(), "DK_SECURITY_ACK_REQUIRED");
    expect(failure.exitCode).toBe(7);
    expect(failure.details).toMatchObject({ recovery: "not-resumable" });

    expect(fixture.host.legacyRunner?.serviceActive).toBe(true);
    expect(fixture.host.legacyRunner?.serviceEnabled).toBe(true);
    expect(fixture.github.selfHostedRunners).toHaveLength(1);
    // Nothing was dispatched, so no deployment ran beside the root runner.
    expect(fixture.github.runs).toEqual([]);
  });

  it("leaves another repository's runner on the same host completely alone", async () => {
    const fixture = await harness({
      legacyRunner: legacyRunner({ gitHubUrl: "https://github.com/somebody/else" }),
    });

    const result = await fixture.deploy({ wait: true }, {
      approveLegacyRunnerRemoval: async () => {
        throw new Error("approval must not be requested for another repository's runner");
      },
    });

    expect(result.outcome).toBe("succeeded");
    expect(fixture.host.legacyRunner?.serviceActive).toBe(true);
    expect(fixture.github.endpoints().some((endpoint) => endpoint.includes("actions/runners"))).toBe(false);
  });

  it("reports a dry run's pending migration without asking for approval", async () => {
    const fixture = await harness({ legacyRunner: legacyRunner() });
    const result = await fixture.deploy({ dryRun: true, wait: true }, {
      approveLegacyRunnerRemoval: async () => {
        throw new Error("a dry run must not ask to remove anything");
      },
    });

    expect(result.outcome).toBe("dry-run");
    expect(fixture.stdout.text).toContain("DK_LEGACY_RUNNER_DETECTED");
    expect(fixture.host.legacyRunner?.serviceActive).toBe(true);
  });

  it("refuses to touch a runner whose GitHub registration it cannot identify", async () => {
    const fixture = await harness({ legacyRunner: legacyRunner({ agentId: 0, agentName: "" }) });

    const failure = await expectFailure(
      fixture.deploy({ wait: true }, { approveLegacyRunnerRemoval: async () => true }),
      "DK_OWNERSHIP_CONFLICT",
    );
    expect(failure.details).toMatchObject({ recovery: "resolve-ownership-conflict" });
    expect(fixture.host.legacyRunner?.serviceActive).toBe(true);
  });
});

// --------------------------------------------------------- documentation --

describe("documented walkthrough", () => {
  it("takes an operator from install to a deployed commit with one command", async () => {
    const readme = await readFile("README.md", "utf8");
    const start = readme.indexOf("## First deployment");
    const end = readme.indexOf("## Command reference");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const walkthrough = readme.slice(start, end);

    // The walkthrough is install, run, edit, confirm, review, done.
    for (const step of [
      "cd /path/to/application\ndeploykit deploy",
      "deploykit.config.yaml",
      "Review the setup pull request",
    ]) {
      expect(walkthrough).toContain(step);
    }

    // Every command the walkthrough actually asks the operator to run is the
    // bare one. Prose may name `deploykit retry` to say it is *not* needed;
    // a fenced command block may not.
    const commands = [...walkthrough.matchAll(/```bash\n([\s\S]*?)```/gu)]
      .flatMap((block) => (block[1] ?? "").split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("deploykit"));
    expect(commands.length).toBeGreaterThan(0);
    expect(new Set(commands)).toEqual(new Set(["deploykit deploy"]));

    // And no legacy bootstrap, secret upload, runner enrollment, or dispatch
    // step is required anywhere in it.
    for (const forbidden of [
      "server bootstrap --",
      "secrets set --",
      "--target",
      "--ref",
      "actions-runner",
      "runner registration",
      "runner label",
    ]) {
      expect(walkthrough, `the walkthrough should not require ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("documents the flags, the migration, and the first-deployment-only boundary", async () => {
    const readme = await readFile("README.md", "utf8");
    for (const flag of ["`--config <path>`", "`--dry-run`", "`--no-wait`", "`--json`"]) {
      expect(readme).toContain(flag);
    }
    // Recovery guidance says to rerun the same command, not to reach for retry.
    expect(readme).toContain("There is no separate retry command");
    // Migration is approval-gated and recoverable, and fresh hosts never get one.
    expect(readme).toContain("Hosts this release bootstraps never install one.");
    expect(readme).toContain("DK_SECURITY_ACK_REQUIRED");
    expect(readme).toContain("retaining every file");
    // The product boundary is stated, not implied.
    expect(readme).toContain("DeployKit performs a target's *first* deployment.");
    expect(readme).toContain("DK_ALREADY_DEPLOYED");
    // And the release is not advertised as complete before acceptance passes.
    expect(readme).toContain("not yet accepted as production-ready");
  });
});
