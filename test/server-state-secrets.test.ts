import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ServerError } from "../src/server/errors.js";
import { InProcessLockProvider } from "../src/server/lock.js";
import { SecretRedactor, SecretsStore, parseSecretsEnv } from "../src/server/secrets.js";
import { DEPLOYMENT_PHASES, DeploymentStateStore } from "../src/server/state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("DeploymentStateStore", () => {
  it("persists ordered checkpoints, resumes a failed commit, and refuses a second first deployment", async () => {
    const directory = await temporaryDirectory("deploykit-state-");
    let tick = 0;
    const store = new DeploymentStateStore({
      file: join(directory, "deployment.json"),
      lockFile: join(directory, "state.lock"),
      targetId: "sample-prod-a123456789",
      lock: new InProcessLockProvider(),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const sha = "a".repeat(40);

    expect(await store.begin(sha)).toMatchObject({ resumed: false, state: { attempt: 1 } });
    await store.checkpoint("manifest-validated");
    await store.checkpoint("dns-verified");
    await expect(store.checkpoint("source-staged"))
      .rejects.toMatchObject({ code: "SERVER_CHECKPOINT_ORDER" } satisfies Partial<ServerError>);
    await store.fail("dns-verified", "TEST_FAILURE", "simulated failure");

    expect(await store.begin(sha)).toMatchObject({ resumed: true, state: { attempt: 2 } });
    for (const phase of DEPLOYMENT_PHASES.slice(2, -1)) await store.checkpoint(phase);
    const succeeded = await store.succeed();
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(DEPLOYMENT_PHASES);
    await expect(store.begin(sha))
      .rejects.toMatchObject({ code: "SERVER_DEPLOYMENT_EXISTS" } satisfies Partial<ServerError>);
  });
});

describe("SecretsStore", () => {
  it("parses stdin, fills generated values, validates names, and writes a 0600 file", async () => {
    const directory = await temporaryDirectory("deploykit-secrets-");
    const file = join(directory, "target", "secrets.env");
    const store = new SecretsStore({
      file,
      requirements: { required: ["API_TOKEN", "DATABASE_URL"], generated: ["SESSION_SECRET"] },
    });

    const check = await store.writeFromStdin("API_TOKEN='abc 123'\nDATABASE_URL=postgres://db/app # local\n");
    expect(check).toMatchObject({ valid: true, missing: [] });
    const values = await store.read();
    expect(values.API_TOKEN).toBe("abc 123");
    expect(values.DATABASE_URL).toBe("postgres://db/app");
    expect(values.SESSION_SECRET).toHaveLength(43);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain("undefined");

    await store.writeFromStdin("API_TOKEN=replaced\n");
    const updated = await store.read();
    expect(updated.API_TOKEN).toBe("replaced");
    expect(updated.SESSION_SECRET).toBe(values.SESSION_SECRET);
    expect(updated.DATABASE_URL).toBe(values.DATABASE_URL);
  });

  it("rejects duplicate or missing secrets and redacts values and sensitive keys", async () => {
    expect(() => parseSecretsEnv("TOKEN=one\nTOKEN=two\n"))
      .toThrowError(expect.objectContaining({ code: "SERVER_SECRET_INVALID" }));
    const directory = await temporaryDirectory("deploykit-secrets-");
    const store = new SecretsStore({
      file: join(directory, "secrets.env"),
      requirements: { required: ["API_TOKEN"] },
    });
    await expect(store.writeFromStdin("UNRELATED=value\n"))
      .rejects.toMatchObject({ code: "SERVER_SECRET_INVALID" } satisfies Partial<ServerError>);
    await expect(store.writeFromStdin(""))
      .rejects.toMatchObject({ code: "SERVER_SECRET_MISSING" } satisfies Partial<ServerError>);

    const redactor = new SecretRedactor(["very-secret"]);
    expect(redactor.redactText("token=very-secret")).toBe("token=[REDACTED]");
    expect(redactor.redact({ note: "very-secret", databaseUrl: "not-known" })).toEqual({
      note: "[REDACTED]",
      databaseUrl: "[REDACTED]",
    });
  });
});
