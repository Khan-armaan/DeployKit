import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ServerError } from "../src/server/errors.js";
import { InProcessLockProvider } from "../src/server/lock.js";
import { RegistryStore, type PortProbe } from "../src/server/registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore(probe?: PortProbe): Promise<RegistryStore> {
  const directory = await mkdtemp(join(tmpdir(), "deploykit-registry-"));
  temporaryDirectories.push(directory);
  return new RegistryStore({
    file: join(directory, "registry.json"),
    lockFile: join(directory, "registry.lock"),
    lock: new InProcessLockProvider(),
    portProbe: probe ?? { isAvailable: async () => true },
    portRange: { start: 34_000, end: 34_002 },
  });
}

describe("RegistryStore", () => {
  it("serializes concurrent allocations and gives each service a stable loopback port", async () => {
    const store = await createStore({
      isAvailable: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      },
    });

    const [first, second] = await Promise.all([
      store.reserve({
        targetId: "alpha-a123456789",
        domains: ["alpha.example.com"],
        ports: [{ serviceKey: "alpha-a123456789:api", targetId: "alpha-a123456789", service: "api" }],
      }),
      store.reserve({
        targetId: "beta-b123456789",
        domains: ["beta.example.com"],
        ports: [{ serviceKey: "beta-b123456789:api", targetId: "beta-b123456789", service: "api" }],
      }),
    ]);

    expect(first.ports[0]).toMatchObject({ address: "127.0.0.1", port: 34_000 });
    expect(second.ports[0]).toMatchObject({ address: "127.0.0.1", port: 34_001 });

    const retry = await store.reserve({
      targetId: "alpha-a123456789",
      domains: ["alpha.example.com"],
      ports: [{ serviceKey: "alpha-a123456789:api", targetId: "alpha-a123456789", service: "api" }],
    });
    expect(retry.ports[0]?.port).toBe(34_000);
  });

  it("refuses domain and explicit-port collisions without partially writing state", async () => {
    const store = await createStore();
    await store.reserve({
      targetId: "alpha-a123456789",
      domains: ["shared.example.com"],
      ports: [{
        serviceKey: "alpha-a123456789:api",
        targetId: "alpha-a123456789",
        service: "api",
        requestedPort: 34_001,
      }],
    });

    await expect(store.reserve({
      targetId: "beta-b123456789",
      domains: ["shared.example.com"],
      ports: [{ serviceKey: "beta-b123456789:api", targetId: "beta-b123456789", service: "api" }],
    })).rejects.toMatchObject({ code: "SERVER_DOMAIN_COLLISION" } satisfies Partial<ServerError>);

    await expect(store.reserve({
      targetId: "beta-b123456789",
      domains: ["beta.example.com"],
      ports: [{
        serviceKey: "beta-b123456789:api",
        targetId: "beta-b123456789",
        service: "api",
        requestedPort: 34_001,
      }],
    })).rejects.toMatchObject({ code: "SERVER_PORT_COLLISION" } satisfies Partial<ServerError>);

    const state = await store.read();
    expect(state.domains).toHaveLength(1);
    expect(state.ports).toHaveLength(1);
  });
});
