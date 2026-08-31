import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { bootstrapServer } from "../src/bootstrap.js";

const validOptions = {
  host: "ubuntu@vps.example.com",
  repository: "thinkingstone/deploykit-example",
  label: "production-1",
  acceptRootRunnerRisk: true,
  dryRun: true,
} as const;

describe("local server bootstrap", () => {
  it("builds a network-free dry-run plan", async () => {
    const plan = await bootstrapServer(validOptions);

    expect(plan).toMatchObject({
      host: validOptions.host,
      repository: validOptions.repository,
      label: validOptions.label,
      fingerprint: "checked during apply",
      rootRunner: true,
      configureFirewall: false,
    });
    expect(plan.remoteDirectory).toBe("/tmp/deploykit-bootstrap-<random>");
    expect(plan.packages).toEqual(expect.arrayContaining([
      "docker-ce",
      "docker-compose-plugin",
      "nginx",
      "certbot",
      "node@22.18.0",
      "pm2@6.0.8",
      "actions-runner@2.337.0",
    ]));
  });

  it("requires an explicit root-runner risk acknowledgement", async () => {
    await expect(bootstrapServer({ ...validOptions, acceptRootRunnerRisk: false })).rejects.toMatchObject({
      code: "DK_SECURITY_ACK_REQUIRED",
    });
  });

  it.each([
    "-oProxyCommand=malicious",
    "ubuntu@host example.com",
    "ubuntu@@example.com",
    "root@example.com:2222",
    "root@[2001:db8::1]",
    "root@bad_host.example",
  ])("rejects an SSH option or unsupported target: %s", async (host) => {
    await expect(bootstrapServer({ ...validOptions, host })).rejects.toMatchObject({ code: "DK_USAGE" });
  });

  it("rejects unsafe repository and runner label values", async () => {
    await expect(bootstrapServer({ ...validOptions, repository: "owner/repo/extra" })).rejects.toMatchObject({ code: "DK_USAGE" });
    await expect(bootstrapServer({ ...validOptions, label: "prod;reboot" })).rejects.toMatchObject({ code: "DK_USAGE" });
  });
});

describe("Ubuntu installer", () => {
  const installer = resolve("assets/bootstrap.sh");

  it("has valid Bash syntax", () => {
    expect(() => execFileSync("bash", ["-n", installer])).not.toThrow();
  });

  it("pins and verifies privileged artifacts and preserves Nginx on validation failure", async () => {
    const source = await readFile(installer, "utf8");

    expect(source).toContain('DEPLOYKIT_RUNNER_VERSION="2.337.0"');
    expect(source).toContain('DEPLOYKIT_MIN_COMPOSE_VERSION="2.24.4"');
    expect(source).toContain('dpkg --compare-versions "$DEPLOYKIT_COMPOSE_VERSION" ge "$DEPLOYKIT_MIN_COMPOSE_VERSION"');
    expect(source).toContain('DEPLOYKIT_RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"');
    expect(source).toContain('DEPLOYKIT_RUNNER_SHA256="9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393"');
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain("dist/server-cli.cjs");
    expect(source).not.toContain('npm install --global "$DEPLOYKIT_PACKAGE"');
    expect(source).toContain('DEPLOYKIT_PM2_ROOT="/opt/deploykit/pm2/${DEPLOYKIT_PM2_VERSION}"');
    expect(source).not.toContain('npm install --global "pm2@');
    expect(source).toContain(".package-sha256");
    expect(source).toContain("--disableupdate");
    expect(source).toContain("GITHUB_REF_PROTECTED");
    expect(source).toContain("if ! nginx -t; then");
    expect(source).toContain("the previous configuration was restored");
  });

  it("changes the firewall only behind the explicit flag", async () => {
    const source = await readFile(installer, "utf8");
    const guard = source.indexOf('if [[ "$DEPLOYKIT_FIREWALL" -eq 1 ]]');
    const enable = source.indexOf("ufw --force enable");

    expect(guard).toBeGreaterThan(0);
    expect(enable).toBeGreaterThan(guard);
  });
});
