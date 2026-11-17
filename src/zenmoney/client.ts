import type { WireDiff } from "./wire";

/** Thrown when the request may have reached the server but no answer came back. */
export class UnknownOutcomeError extends Error {}

/** ZenMoney definitely did not apply the request (a 4xx answer). */
export class ZenMoneyError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export type DiffRequest = WireDiff & { serverTimestamp: number };

export interface DiffClient {
  diff(request: DiffRequest): Promise<WireDiff>;
}

/** The one ZenMoney endpoint Zerro uses: POST /v8/diff/. */
export class ZenMoneyClient implements DiffClient {
  constructor(
    private token: string,
    private base: string,
    private timeoutMs: number,
  ) {}

  async diff(request: DiffRequest): Promise<WireDiff> {
    const body = JSON.stringify({ ...request, currentClientTimestamp: Math.round(Date.now() / 1000) });
    let response: Response;
    try {
      response = await fetch(`${this.base}/v8/diff/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError"
        ? `no answer within ${Math.round(this.timeoutMs / 1000)}s`
        : (error as Error).message;
      throw new UnknownOutcomeError(`ZenMoney API request failed: ${reason}`);
    }
    const status = response.status;
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new UnknownOutcomeError(`ZenMoney API answer was cut off (HTTP ${status})`);
    }
    // Only a 4xx is a definite refusal; anything else may have been applied.
    const refused = status >= 400 && status < 500 && status !== 408;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      if (refused) throw new ZenMoneyError(`ZenMoney API refused the request (HTTP ${status})`, status);
      throw new UnknownOutcomeError(`Unparsable ZenMoney answer (HTTP ${status})`);
    }
    const apiError = json && typeof json === "object" ? (json as { error?: unknown }).error : undefined;
    if (refused) throw new ZenMoneyError(`ZenMoney API refused the request (HTTP ${status})${apiError ? `: ${JSON.stringify(apiError)}` : ""}`, status);
    if (apiError || status < 200 || status >= 300)
      throw new UnknownOutcomeError(`ZenMoney API failed (HTTP ${status})${apiError ? `: ${JSON.stringify(apiError)}` : ""}`);
    return json as WireDiff;
  }
}
