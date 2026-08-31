import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DeployKitError } from "../errors.js";

export interface AdvisorCompletionRequest {
  system: string;
  prompt: string;
}

export interface AdvisorProvider {
  readonly id: "openai" | "anthropic";
  complete(request: AdvisorCompletionRequest): Promise<string>;
}

export interface AdvisorRuntimeEnvironment {
  CI?: string;
  GITHUB_ACTIONS?: string;
  DEPLOYKIT_SERVER_RUNTIME?: string;
}

export function assertLocalAdvisorRuntime(
  environment: AdvisorRuntimeEnvironment = process.env,
): void {
  if (
    environment.CI?.toLowerCase() === "true" ||
    environment.GITHUB_ACTIONS?.toLowerCase() === "true" ||
    environment.DEPLOYKIT_SERVER_RUNTIME === "1"
  ) {
    throw new DeployKitError("DK_UNSUPPORTED", "The AI advisor is local-only and is disabled in CI and server runtimes");
  }
}

interface OpenAIClientLike {
  chat: {
    completions: {
      create(input: Record<string, unknown>): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

export interface OpenAIAdvisorOptions {
  apiKey?: string;
  model: string;
  client?: OpenAIClientLike;
  environment?: AdvisorRuntimeEnvironment;
}

export class OpenAIAdvisorProvider implements AdvisorProvider {
  readonly id = "openai" as const;
  readonly #client: OpenAIClientLike;
  readonly #model: string;
  readonly #environment: AdvisorRuntimeEnvironment | undefined;

  constructor(options: OpenAIAdvisorOptions) {
    if (!options.client && !options.apiKey) {
      throw new Error("An OpenAI API key is required");
    }
    if (options.model.length === 0) throw new Error("An OpenAI model is required");
    this.#client =
      options.client ??
      (new OpenAI({ apiKey: options.apiKey }) as unknown as OpenAIClientLike);
    this.#model = options.model;
    this.#environment = options.environment;
  }

  async complete(request: AdvisorCompletionRequest): Promise<string> {
    assertLocalAdvisorRuntime(this.#environment);
    const response = await this.#client.chat.completions.create({
      model: this.#model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    });
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI returned no advisor patch");
    return content;
  }
}

interface AnthropicClientLike {
  messages: {
    create(input: Record<string, unknown>): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export interface AnthropicAdvisorOptions {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  client?: AnthropicClientLike;
  environment?: AdvisorRuntimeEnvironment;
}

export class AnthropicAdvisorProvider implements AdvisorProvider {
  readonly id = "anthropic" as const;
  readonly #client: AnthropicClientLike;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #environment: AdvisorRuntimeEnvironment | undefined;

  constructor(options: AnthropicAdvisorOptions) {
    if (!options.client && !options.apiKey) {
      throw new Error("An Anthropic API key is required");
    }
    if (options.model.length === 0) throw new Error("An Anthropic model is required");
    this.#client =
      options.client ??
      (new Anthropic({ apiKey: options.apiKey }) as unknown as AnthropicClientLike);
    this.#model = options.model;
    this.#maxTokens = options.maxTokens ?? 4_096;
    if (!Number.isInteger(this.#maxTokens) || this.#maxTokens < 256) {
      throw new Error("maxTokens must be an integer of at least 256");
    }
    this.#environment = options.environment;
  }

  async complete(request: AdvisorCompletionRequest): Promise<string> {
    assertLocalAdvisorRuntime(this.#environment);
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: this.#maxTokens,
      temperature: 0,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    });
    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!content) throw new Error("Anthropic returned no advisor patch");
    return content;
  }
}
