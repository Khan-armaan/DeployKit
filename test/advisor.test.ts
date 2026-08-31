import { describe, expect, it, vi } from "vitest";

import {
  AnthropicAdvisorProvider,
  applyManifestPatch,
  assertLocalAdvisorRuntime,
  OpenAIAdvisorProvider,
  parseAdvisorPatch,
  prepareAdvisorFiles,
  redactSecrets,
  requestManifestAdvice,
  type AdvisorProvider,
} from "../src/advisor/index.js";
import { parseManifest, type ProjectManifest } from "../src/manifest.js";

function manifest(): ProjectManifest {
  return parseManifest({
    apiVersion: "deploykit/v1alpha1",
    metadata: { name: "advisor-app", requiredVersion: "0.1.0" },
    services: {},
    routes: [],
    secrets: { required: [], generated: [] },
    targets: {
      production: {
        runnerLabel: "vps-one",
        primaryDomain: "advisor.example.com",
        aliases: [],
        environment: "production",
        publicOverrides: {},
        runtimeOverrides: {},
      },
    },
  });
}

describe("advisor redaction and file approval", () => {
  it("redacts supplied and detected credentials", () => {
    const source = [
      "DATABASE_PASSWORD=correct-horse-battery-staple",
      '"api_key": "sk-abcdefghijklmnopqrstuv"',
      "postgres://app:hunter2@database.example.com/app",
      "-----BEGIN PRIVATE KEY-----",
      "top-secret-key",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(source, ["correct-horse-battery-staple"]);
    expect(redacted).not.toContain("correct-horse");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("top-secret-key");
    expect(redacted).toContain("[REDACTED]");
  });

  it("requires exact approval and always rejects credential-like paths", () => {
    expect(() =>
      prepareAdvisorFiles([{ path: "package.json", content: "{}" }], ["compose.yaml"]),
    ).toThrow(/not explicitly approved/);
    expect(() =>
      prepareAdvisorFiles([{ path: ".env", content: "SAFE=no" }], [".env"]),
    ).toThrow(/credential-like/);
  });
});

describe("structured advisor patches", () => {
  it("parses fenced JSON, applies a merge patch without mutation, and blocks prototypes", () => {
    const original = manifest();
    const proposal = parseAdvisorPatch(
      '```json\n{"patch":{"metadata":{"requiredVersion":"0.1.1"}},"rationale":"Pin the patch release.","warnings":[]}\n```',
    );
    const candidate = applyManifestPatch(original, proposal.patch);
    expect(candidate.metadata.requiredVersion).toBe("0.1.1");
    expect(original.metadata.requiredVersion).toBe("0.1.0");
    expect(() =>
      parseAdvisorPatch(
        '{"patch":{"__proto__":{"polluted":true}},"rationale":"bad","warnings":[]}',
      ),
    ).toThrow(/Unsafe property/);
  });

  it("returns a validated in-memory proposal and redacted review diff", async () => {
    let capturedPrompt = "";
    const provider: AdvisorProvider = {
      id: "openai",
      async complete(request) {
        capturedPrompt = request.prompt;
        return JSON.stringify({
          patch: { metadata: { requiredVersion: "0.1.1" } },
          rationale: "Use the fixed release.",
          warnings: [],
        });
      },
    };
    const result = await requestManifestAdvice({
      manifest: manifest(),
      files: [{ path: "compose.yaml", content: "TOKEN=do-not-send" }],
      approvedPaths: ["compose.yaml"],
      provider,
      validate: parseManifest,
      secretValues: ["do-not-send"],
    });
    expect(capturedPrompt).not.toContain("do-not-send");
    expect(result.candidate.metadata.requiredVersion).toBe("0.1.1");
    expect(result.diff).toContain("/metadata/requiredVersion");
    expect(result.diff).not.toContain("do-not-send");
  });
});

describe("provider adapters", () => {
  it("blocks all providers in CI/server runtimes", () => {
    expect(() => assertLocalAdvisorRuntime({ CI: "true" })).toThrow(/local-only/);
    expect(() => assertLocalAdvisorRuntime({ DEPLOYKIT_SERVER_RUNTIME: "1" })).toThrow(
      /local-only/,
    );
  });

  it("requests JSON from OpenAI without exposing the API key", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"patch":{},"rationale":"No change","warnings":[]}' } }],
    });
    const provider = new OpenAIAdvisorProvider({
      apiKey: "not-stored-in-request",
      model: "gpt-test",
      client: { chat: { completions: { create } } },
      environment: {},
    });
    await provider.complete({ system: "system", prompt: "prompt" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-test",
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain("not-stored-in-request");
  });

  it("joins Anthropic text blocks and ignores non-text blocks", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: '{"patch":{},' },
        { type: "tool_use" },
        { type: "text", text: '"rationale":"No change","warnings":[]}' },
      ],
    });
    const provider = new AnthropicAdvisorProvider({
      model: "claude-test",
      client: { messages: { create } },
      environment: {},
    });
    await expect(provider.complete({ system: "system", prompt: "prompt" })).resolves.toBe(
      '{"patch":{},"rationale":"No change","warnings":[]}',
    );
  });
});
