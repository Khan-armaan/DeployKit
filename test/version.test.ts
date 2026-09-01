import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createStarterManifest, type InitAnswers } from "../src/init.js";
import { VERSION, isValidVersionRequirement, versionSatisfiesRequirement } from "../src/version.js";

describe("DeployKit version requirements", () => {
  it("supports exact and standard semantic-version ranges", () => {
    expect(versionSatisfiesRequirement("0.1.0", "0.1.0")).toBe(true);
    expect(versionSatisfiesRequirement("^0.1.0", "0.1.7")).toBe(true);
    expect(versionSatisfiesRequirement("^0.1.0", "0.2.0")).toBe(false);
    expect(isValidVersionRequirement("latest please")).toBe(false);
  });

  it("scaffolds a manifest the running CLI satisfies", async () => {
    const root = await mkdtemp(join(tmpdir(), "deploykit-init-"));
    const answers: InitAnswers = {
      projectName: "sample",
      targetName: "production",
      runnerLabel: "deploykit-production",
      primaryDomain: "example.com",
      frontendMode: "none",
      nodeVersion: "22.18.0",
      packageManager: "npm",
      outputDirectory: "dist",
    };

    const manifest = await createStarterManifest(root, answers);

    expect(isValidVersionRequirement(manifest.metadata.requiredVersion)).toBe(true);
    expect(versionSatisfiesRequirement(manifest.metadata.requiredVersion, VERSION)).toBe(true);
  });
});
