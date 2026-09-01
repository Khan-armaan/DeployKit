import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const executed: { command: string; args: readonly string[] }[] = [];

// Records every child process the config boundary starts, without stubbing Git
// itself: the point is to prove *what* runs, not to fake the repository.
vi.mock("../src/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process.js")>();
  return {
    ...actual,
    run: (command: string, args: readonly string[] = [], options: Parameters<typeof actual.run>[2] = {}) => {
      executed.push({ command, args });
      return actual.run(command, args, options);
    },
  };
});

const { loadOperatorConfig, scaffoldOperatorConfig } = await import("../src/orchestrator/config.js");
const { clearRedactedValues } = await import("../src/output.js");

const execFileAsync = promisify(execFile);
const packageRoot = resolve(".");
const FIXTURE = resolve("test", "fixtures", "static-compose", "deploykit.config.fixture.yaml");

/** Git subcommands the config boundary is allowed to run. Reads only. */
const ALLOWED_GIT_SUBCOMMANDS = new Set(["rev-parse", "ls-files", "check-ignore", "diff"]);

afterEach(() => {
  executed.length = 0;
  clearRedactedValues();
  vi.restoreAllMocks();
});

describe("Phase 2 external isolation", () => {
  it("performs no network request and runs only read-only Git commands", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-isolation-")));
    await execFileAsync("git", ["init", "--quiet", root]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(loadOperatorConfig({ cwd: root, packageRoot, interactive: false })).rejects.toMatchObject({
      code: "DK_CONFIG_SCAFFOLDED",
    });

    const configPath = join(root, "deploykit.config.yaml");
    await writeFile(configPath, await readFile(FIXTURE, "utf8"), { mode: 0o600 });
    await chmod(configPath, 0o600);
    const loaded = await loadOperatorConfig({ cwd: root, packageRoot, interactive: false });
    expect(loaded.config.project.repository).toBe("deploykit-fixtures/static-compose");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(executed.length).toBeGreaterThan(0);
    for (const call of executed) {
      expect(call.command, `unexpected process '${call.command}'`).toBe("git");
      // Every invocation is scoped with `-C <root>` and names a read-only verb.
      expect(call.args[0]).toBe("-C");
      expect(ALLOWED_GIT_SUBCOMMANDS, call.args.join(" ")).toContain(call.args[2]);
    }
  });

  it("makes no external call at all when the configuration is already present", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "deploykit-isolation-")));
    await execFileAsync("git", ["init", "--quiet", root]);
    await scaffoldOperatorConfig({ cwd: root, packageRoot });
    executed.length = 0;

    await expect(scaffoldOperatorConfig({ cwd: root, packageRoot })).resolves.toMatchObject({ status: "existing" });
    expect(executed.every((call) => call.command === "git")).toBe(true);
  });
});
