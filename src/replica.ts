import { randomUUID } from "node:crypto";
import {
  applyPatch,
  createEmptyDataStore,
  createProjectionGraph,
  getSyncCursor,
  type TCoreContext,
  type TDataStore,
  type TNormalizedPatch,
} from "./core";
import type { DiffClient } from "./zenmoney/client";
import { patchToWire, wireToPatch } from "./zenmoney/wire";

export type Graph = ReturnType<typeof createProjectionGraph>;

/** One immutable server state with the core's projections bound to one instant. */
export type Snapshot = {
  data: TDataStore;
  graph: Graph;
  ctx: TCoreContext;
  syncedAt: number;
};

/**
 * The confirmed ZenMoney state in memory. Every pull and push runs through
 * one queue, so a write never interleaves with a sync of the same process.
 */
export class Replica {
  private base: TDataStore = createEmptyDataStore();
  private serverTimestamp = 0;
  private syncedAt = 0;
  private cached?: Snapshot;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private client: DiffClient,
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Runs `fn` alone in the queue. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A snapshot no older than the TTL. Call outside `exclusive`. */
  fresh(): Promise<Snapshot> {
    return this.exclusive(async () => {
      if (!this.syncedAt || this.now() - this.syncedAt > this.ttlMs) await this.pull();
      return this.snapshot();
    });
  }

  /** Pulls now. Call only inside `exclusive`. */
  async pull(): Promise<void> {
    const cursor = getSyncCursor(this.serverTimestamp);
    const wire = await this.client.diff({ serverTimestamp: Math.round(cursor / 1000) });
    this.accept(wireToPatch(wire));
  }

  /**
   * Sends a core transport patch and accepts the server's answer, which holds
   * every change since the cursor, ours included. Call only inside `exclusive`.
   */
  async push(transport: TNormalizedPatch): Promise<void> {
    const cursor = getSyncCursor(this.serverTimestamp);
    const wire = await this.client.diff({ ...patchToWire(transport), serverTimestamp: Math.round(cursor / 1000) });
    this.accept(wireToPatch(wire));
  }

  snapshot(): Snapshot {
    if (this.cached) return this.cached;
    const frozen = this.now();
    const ctx: TCoreContext = { now: () => frozen, uuid: randomUUID };
    this.cached = { data: this.base, graph: createProjectionGraph(ctx), ctx, syncedAt: this.syncedAt };
    return this.cached;
  }

  private accept(patch: TNormalizedPatch) {
    this.base = applyPatch(this.base, patch);
    const ts = (patch as { serverTimestamp?: number }).serverTimestamp;
    if (ts) this.serverTimestamp = ts;
    this.syncedAt = this.now();
    this.cached = undefined;
  }
}
