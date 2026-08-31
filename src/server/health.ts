import { ServerError } from "./errors.js";

export interface HealthResponse {
  readonly status: number;
  readonly body?: string;
}

export interface HealthClient {
  get(url: string, timeoutMs: number): Promise<HealthResponse>;
}

export class FetchHealthClient implements HealthClient {
  async get(url: string, timeoutMs: number): Promise<HealthResponse> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status };
  }
}

export interface HealthPollOptions {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly expectedStatuses?: readonly number[];
  readonly client?: HealthClient;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface HealthPollResult {
  readonly attempts: number;
  readonly status: number;
  readonly elapsedMs: number;
}

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

export async function pollHealth(options: HealthPollOptions): Promise<HealthPollResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const client = options.client ?? new FetchHealthClient();
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const accepted = new Set(options.expectedStatuses ?? []);
  if (timeoutMs < 0 || intervalMs < 0 || requestTimeoutMs <= 0) {
    throw new ServerError("SERVER_HEALTH_TIMEOUT", "health polling durations are invalid");
  }

  const started = now();
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  do {
    attempts += 1;
    try {
      const response = await client.get(options.url, requestTimeoutMs);
      lastStatus = response.status;
      if (accepted.size > 0 ? accepted.has(response.status) : response.status >= 200 && response.status < 400) {
        return { attempts, status: response.status, elapsedMs: now() - started };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) break;
    await wait(Math.min(intervalMs, timeoutMs - elapsed));
  } while (now() - started <= timeoutMs);

  throw new ServerError(
    "SERVER_HEALTH_TIMEOUT",
    `health check ${options.url} did not become ready within ${timeoutMs}ms`,
    { url: options.url, attempts, lastStatus, lastError },
  );
}
