import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generateComposeOverride, generateGitHubWorkflow, generateNginxConfig, generatePm2Ecosystem } from "../src/generators/index.js";
import { parseManifestYaml } from "../src/manifest.js";
import { createDeploymentPlan } from "../src/plan.js";
import { validateProject } from "../src/project-validation.js";

const fixtures = ["static-compose", "container-external", "pm2-compose-db"] as const;

describe.each(fixtures)("integration fixture %s", (name) => {
  it("validates and renders every deterministic artifact without mutating application files", async () => {
    const directory = resolve("test", "fixtures", name);
    const manifestPath = resolve(directory, "deploykit.yaml");
    const manifest = parseManifestYaml(await readFile(manifestPath, "utf8"), manifestPath);
    const validation = await validateProject(manifest, { manifestPath, inspectComposeConfig: false });

    expect(validation.errors, validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join("\n")).toEqual([]);
    const plan = createDeploymentPlan(manifest, "production", { commitSha: "a".repeat(40) });
    const ports = Object.fromEntries(plan.ports.map((entry, index) => [entry.service, 30_000 + index]));

    expect(generateGitHubWorkflow(manifest)).toContain("workflow_dispatch");
    expect(generateNginxConfig(manifest, {
      target: "production",
      ports,
      staticRoot: manifest.frontend?.type === "static" ? "/srv/deploykit/fixture/current/static" : undefined,
      tls: {},
    })).toContain("listen 443 ssl http2;");
    expect(generateComposeOverride(manifest, {
      target: "production",
      ports,
      envFile: "/etc/deploykit/targets/fixture/secrets.env",
      databaseInternalPort: manifest.database?.type === "compose" ? manifest.database.internalPort : undefined,
    })).toContain("services:");
    if (Object.values(manifest.services).some((service) => service.type === "pm2")) {
      expect(generatePm2Ecosystem(manifest, {
        target: "production",
        ports,
        releaseDirectory: "/srv/deploykit/fixture/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })).toContain("COREPACK_HOME");
    }
  });
});
