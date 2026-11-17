import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../server";
import { patchToWire } from "../zenmoney/wire";
import { UnknownOutcomeError } from "../zenmoney/client";
import { View, ToolInputError, fmt } from "../view";
import { checkHiddenDocuments, Journal, WriteLock } from "../write/guard";
import { describePlan, NothingToChange, planAction, requireAmount, requireEnvelopeOrTba, type Action, type Plan } from "../write/plan";
import { toolText, withErrors } from "./result";
import type { Snapshot } from "../replica";

const monthArg = z.string().optional().describe("Month as YYYY-MM. Defaults to the current month.");
const confirmArg = z
  .string()
  .optional()
  .describe("Token from a preview of exactly this call. Without it the tool only previews and changes nothing.");
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const RULES =
  " Call without confirm first: the answer previews the change and gives a token; call again with the same arguments and confirm=<token> to write. " +
  "While it writes, nobody may edit the budget in Zerro, and an open Zerro tab must have no unsent changes: ZenMoney keeps whichever copy of a month's budget arrives last.";

type Build = (view: View) => Action;

export function registerWriteTools(server: McpServer, ctx: Ctx) {
  const lock = new WriteLock(ctx.config.stateDir);

  server.registerTool(
    "set_envelope_budget",
    {
      title: "Set Zerro Envelope Budget",
      description:
        "Set an envelope's total \"Assigned\" for a month, as typing it in Zerro's budget table does: for a parent the amount includes its children's assignments. Amount is in the envelope's currency." +
        RULES,
      inputSchema: {
        envelope: z.string().describe("Envelope id (tag#…, payee#…, merchant#…, account#…) or exact name."),
        amount: z.number().describe("New total assigned, in the envelope currency. May be negative."),
        month: monthArg,
        confirm: confirmArg,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    withErrors(async ({ envelope, amount, month, confirm }) =>
      run(ctx, lock, confirm, view => {
        requireAmount(amount, false);
        return { kind: "set", month: view.month(month), envelope: view.resolveEnvelope(envelope).id, amount };
      }),
    ),
  );

  server.registerTool(
    "move_envelope_funds",
    {
      title: "Move Zerro Envelope Funds",
      description:
        "Move a positive amount of budget between two envelopes in a month, or between an envelope and \"To be assigned\" (pass toBeAssigned as from or to). Each side's assignment changes by the amount converted to its currency at the month's rates." +
        RULES,
      inputSchema: {
        from: z.string().describe("Envelope id or exact name, or toBeAssigned."),
        to: z.string().describe("Envelope id or exact name, or toBeAssigned."),
        amount: z.number().describe("Positive amount to move."),
        currency: z.string().describe("Currency of the amount, e.g. RUB."),
        month: monthArg,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrors(async ({ from, to, amount, currency, month, confirm }) =>
      run(ctx, lock, confirm, view => {
        requireAmount(amount, true);
        const code = currency.trim().toUpperCase();
        if (!(code in view.graph.currentFxRates(view.data).rates)) throw new ToolInputError(`Unknown currency ${code}`);
        const a = requireEnvelopeOrTba(view, from);
        const b = requireEnvelopeOrTba(view, to);
        if (a === b) throw new ToolInputError("from and to are the same");
        return { kind: "move", month: view.month(month), from: a, to: b, amount, currency: code };
      }),
    ),
  );

  server.registerTool(
    "cover_overspend",
    {
      title: "Cover Zerro Overspend",
      description:
        "Raise assignments so that overspent envelopes are back to zero available in a month, as Zerro's \"cover overspending\" does: one envelope, or every overspent envelope when envelope is omitted. The money comes from \"To be assigned\"." +
        RULES,
      inputSchema: {
        envelope: z.string().optional().describe("Envelope id or exact name. Omit to cover all."),
        month: monthArg,
        confirm: confirmArg,
      },
      annotations: WRITE,
    },
    withErrors(async ({ envelope, month, confirm }) =>
      run(ctx, lock, confirm, view => ({
        kind: "cover",
        month: view.month(month),
        envelope: envelope ? view.resolveEnvelope(envelope).id : undefined,
      })),
    ),
  );
}

/** The whole pull → compile → (push → verify) cycle is one queue item. */
async function run(ctx: Ctx, lock: WriteLock, confirm: string | undefined, build: Build) {
  return ctx.replica.exclusive(async () => {
    await ctx.replica.pull();
    const snap = ctx.replica.snapshot();
    let plan: Plan;
    try {
      plan = planAction(snap, build(new View(snap, ctx.config.displayCurrency)), ctx.config.displayCurrency);
    } catch (error) {
      if (error instanceof NothingToChange) return toolText(error.message);
      throw error;
    }
    if (!confirm) return preview(plan, "Preview — nothing written yet.");
    if (confirm.trim() !== plan.token)
      return preview(plan, "The data or the arguments changed since that preview, so nothing was written. New preview:");

    checkHiddenDocuments(snap.data);
    lock.acquire();
    try {
      return await execute(ctx, snap, plan);
    } finally {
      lock.release();
    }
  });
}

function preview(plan: Plan, title: string) {
  return {
    ...toolText(`${title}\n${describePlan(plan)}\n\nTo write, call again with the same arguments and confirm="${plan.token}".`),
    structuredContent: summary(plan, { status: "preview", token: plan.token }),
  };
}

async function execute(ctx: Ctx, before: Snapshot, plan: Plan) {
  const journal = new Journal(ctx.config.stateDir, plan.token, {
    action: plan.action,
    changes: plan.changes,
    original: plan.original,
    sent: patchToWire(plan.transport),
    status: "sending",
  });
  let sendError: string | undefined;
  try {
    await ctx.replica.push(plan.transport);
  } catch (error) {
    if (!(error instanceof UnknownOutcomeError)) {
      journal.close({ status: "rejected", error: (error as Error).message });
      throw error;
    }
    sendError = error.message;
    journal.update({ status: "unknown", error: sendError });
  }

  try {
    await ctx.replica.pull();
  } catch (error) {
    journal.update({ status: "unverified", verifyError: (error as Error).message });
    return toolText(
      `${sendError ? `The write may or may not have reached ZenMoney (${sendError}).` : "Sent."} ` +
        `Could not pull to verify: ${(error as Error).message}. Nothing will be retried; check with get_envelopes. Journal: ${journal.path}`,
    );
  }

  const mismatches = verify(ctx, before, plan);
  if (!mismatches.length) {
    journal.close({ status: "confirmed", recovered: !!sendError });
    return {
      ...toolText(`Written and confirmed on the server${sendError ? " (the answer was lost, but the pull shows the change)" : ""}.\n${describePlan(plan)}`),
      structuredContent: summary(plan, { status: "confirmed" }),
    };
  }
  journal.update({ status: sendError ? "unknown" : "unconfirmed", mismatches });
  return {
    ...toolText(
      `${sendError ? `The write may not have reached ZenMoney (${sendError}).` : "Sent, but the server state differs from the preview."} Nothing will be retried.\n` +
        `- ${mismatches.join("\n- ")}\nJournal with the previous rows: ${journal.path}`,
    ),
    structuredContent: summary(plan, { status: "unconfirmed", mismatches }),
    isError: true,
  };
}

/** Every month's own-assignments must equal the plan's, other keys untouched. */
function verify(ctx: Ctx, before: Snapshot, plan: Plan): string[] {
  const view = new View(ctx.replica.snapshot(), ctx.config.displayCurrency);
  const actual = view.graph.budgets(view.data) as Record<string, Record<string, number>>;
  const expected = plan.expectedBudgets;
  const envs = view.envelopes();
  const old = new View(before, ctx.config.displayCurrency).graph.budgets(before.data) as Record<string, Record<string, number>>;
  const out: string[] = [];
  for (const month of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    for (const id of new Set([...Object.keys(expected[month] ?? {}), ...Object.keys(actual[month] ?? {})])) {
      const want = expected[month]?.[id] ?? 0;
      const got = actual[month]?.[id] ?? 0;
      if (want === got) continue;
      const was = old[month]?.[id] ?? 0;
      const name = envs[id as never]?.name ?? id;
      const cur = envs[id as never]?.currency ?? "";
      out.push(
        got === was
          ? `${month} ${name}: still ${fmt(got, cur)}, expected ${fmt(want, cur)}`
          : `${month} ${name}: ${fmt(got, cur)} on the server, expected ${fmt(want, cur)} (was ${fmt(was, cur)}; someone else may have written)`,
      );
    }
  }
  return out;
}

function summary(plan: Plan, extra: Record<string, unknown>) {
  return {
    ...extra,
    action: plan.action,
    changes: plan.changes,
    envelopes: plan.effects.map(e => ({ ...e, assigned: { before: e.assigned[0], after: e.assigned[1] }, available: { before: e.available[0], after: e.available[1] } })),
    toBeAssigned: plan.toBeAssigned,
  };
}
