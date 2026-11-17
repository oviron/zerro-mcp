import { WIRE_KEYS, type WireDiff } from "./wire";

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
    // Only a 4xx is a definite refusal; anything else may have been applied.
    const refused = status >= 400 && status < 500 && status !== 408;
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (refused) throw new ZenMoneyError(`ZenMoney API refused the request (HTTP ${status})`, status);
      throw new UnknownOutcomeError(`ZenMoney API answer was cut off (HTTP ${status})`);
    }
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
    const malformed = malformedPart(json);
    if (malformed) throw new UnknownOutcomeError(`Malformed ZenMoney answer: ${malformed}`);
    return json as WireDiff;
  }
}

/** Fields every row of a collection carries; ZenMoney always sends whole rows. */
const REQUIRED: Record<string, string[]> = {
  country: ["id"],
  budget: ["date", "tag", "changed"],
  reminder: ["id", "changed", "comment"],
  deletion: ["id", "object", "stamp"],
};

/**
 * An answer of the wrong shape must not pass for a sync: the core merges rows
 * into the ones it has, so a skipped or partial row would read as unchanged.
 */
function malformedPart(json: unknown): string | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "not an object";
  const diff = json as Record<string, unknown>;
  if (typeof diff.serverTimestamp !== "number" || !Number.isFinite(diff.serverTimestamp)) return "no serverTimestamp";
  for (const key of WIRE_KEYS) {
    const rows = diff[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) return `${key} is not a list`;
    const fields = REQUIRED[key] ?? ["id", "changed"];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return `${key} has a row that is not an object`;
      const missing = fields.find(f => !(f in row));
      if (missing) return `${key} row without ${missing}`;
    }
  }
  return undefined;
}
