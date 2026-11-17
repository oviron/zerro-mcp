import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compileTransactionQuery, TrFilterMode, type TEnvelope, type TEnvelopeId, type TEnvMetrics, type TGoalInfo } from "../core";
import { fmt, fmtFx, header, View, type Month } from "../view";
import type { Ctx } from "../server";
import { toolText, withErrors } from "./result";

const monthArg = z.string().optional().describe("Month as YYYY-MM. Defaults to the current month.");
const READ = { readOnlyHint: true, openWorldHint: true } as const;

/** Zerro's built-in groups, named as its interface names them. */
const DEFAULT_GROUPS: Record<string, string> = {
  "default:tags": "Categories",
  "default:accounts": "Transfers",
  "default:merchants": "Debts",
  "default:payees": "Debts",
};
const groupName = (g: string) => DEFAULT_GROUPS[g] ?? g;

type Figures = { leftover: number; assigned: number; activity: number; available: number };

function figures(view: View, m: TEnvMetrics, scope: "self" | "total", month: Month): Figures {
  const c = m.currency;
  return {
    leftover: view.convert(m[`${scope}Leftover`], c, month),
    assigned: view.convert(m[`${scope}Assigned`], c, month),
    activity: view.convert(m[`${scope}Activity`], c, month),
    available: view.convert(m[`${scope}Available`], c, month),
  };
}

const figText = (f: Figures, c: string) =>
  `leftover ${fmt(f.leftover, c)} · assigned ${fmt(f.assigned, c)} · activity ${fmt(f.activity, c)} · available ${fmt(f.available, c)}`;

/** incomePercent stores a share of income (0.25 is 25%); the other types an amount. */
const goalAmount = (g: TGoalInfo) =>
  g.goal.type === "incomePercent" ? `${Math.round(g.goal.amount * 10000) / 100}% of income` : fmt(g.goal.amount, g.currency);

function goalText(g: TGoalInfo): string {
  const end = g.goal.end ? ` by ${g.goal.end}` : "";
  return `goal ${g.goal.type} ${goalAmount(g)}${end}: need now ${fmt(g.needNow, g.currency)}, progress ${Math.round(g.progress * 100)}%`;
}

/** The month whose stored goals last mention this envelope, at or before `month`. */
function goalSetIn(view: View, id: TEnvelopeId, month: Month): Month | null {
  const raw = view.graph.rawGoals(view.data) as Record<string, Record<string, unknown> | undefined>;
  const months = Object.keys(raw).filter(m => m <= month).sort().reverse();
  return (months.find(m => raw[m] && id in raw[m]!) as Month | undefined) ?? null;
}

export function registerReadTools(server: McpServer, ctx: Ctx) {
  server.registerTool(
    "get_envelopes",
    {
      title: "Get Zerro Envelopes",
      description:
        "Zerro envelope budget for a month, grouped as in Zerro: for each envelope its own figures and, for parents, totals with children — leftover from last month, assigned, activity, available — plus its goal. Envelopes are categories (tag#), payees/merchants (payee#, merchant#, used for debts with people) and off-balance accounts (account#). Amounts are in the envelope currency at the month's rates, as Zerro shows them. These are Zerro's budgets, not ZenMoney's native category budgets. By default lists envelopes Zerro shows for the month; hidden and empty ones need include_hidden.",
      inputSchema: {
        month: monthArg,
        envelope: z.string().optional().describe("Only this envelope (id or exact name) and its children."),
        group: z.string().optional().describe("Only this group (exact name)."),
        include_hidden: z.boolean().optional().describe("Also list hidden and empty envelopes."),
      },
      annotations: READ,
    },
    withErrors(async ({ month: wanted, envelope, group, include_hidden }) => {
      const view = new View(await ctx.replica.fresh(), ctx.config.displayCurrency);
      const month = view.month(wanted);
      const envs = view.envelopes();
      const metrics = view.graph.envMetrics(view.data)[month];
      const goals = view.graph.goals(view.data)[month] ?? {};
      const only = envelope ? view.resolveEnvelope(envelope) : undefined;
      // A named envelope is shown even when Zerro would hide it.
      const visible = include_hidden || only ? undefined : view.visibleIds(month);
      const structure = view.graph.envelopeStructure(view.data);

      const rows: unknown[] = [];
      const lines: string[] = [header(view, month), `Envelopes for ${month}`];
      const show = (id: TEnvelopeId) => !visible || visible.has(id);

      const emit = (e: TEnvelope, depth: number) => {
        const m = metrics[e.id];
        const self = figures(view, m, "self", month);
        const total = figures(view, m, "total", month);
        const goal = goals[e.id];
        const hasChildren = e.children.length > 0;
        const pad = "  ".repeat(depth + 1);
        lines.push(`${pad}${e.name} [${e.id}] ${figText(hasChildren ? total : self, e.currency)}`);
        if (hasChildren) lines.push(`${pad}  own: ${figText(self, e.currency)}`);
        if (goal) lines.push(`${pad}  ${goalText(goal)}`);
        if (e.currency !== view.displayCurrency)
          lines.push(`${pad}  available ≈ ${fmt(view.convert(m.totalAvailable, view.displayCurrency, month), view.displayCurrency)}`);
        rows.push({
          id: e.id,
          name: e.name,
          group: groupName(e.group),
          parent: e.parent,
          currency: e.currency,
          visibility: e.visibility,
          keepIncome: e.keepIncome,
          carryNegatives: e.carryNegatives,
          self,
          total,
          goal: goal ? { ...goal.goal, needNow: goal.needNow, progress: goal.progress, targetBudget: goal.targetBudget } : null,
        });
      };

      for (const g of structure) {
        if (group && ![g.group, groupName(g.group)].some(n => n.toLowerCase() === group.trim().toLowerCase())) continue;
        const parents = g.children.filter(n => (only ? n.id === only.id || n.id === only.parent : true) && show(n.id));
        if (!parents.length) continue;
        lines.push(`\n${groupName(g.group) || "(no group)"}`);
        for (const node of parents) {
          const parent = envs[node.id];
          if (!only || only.id === parent.id) emit(parent, 0);
          for (const child of node.children) {
            if (!show(child.id)) continue;
            if (only && only.id !== parent.id && only.id !== child.id) continue;
            emit(envs[child.id], 1);
          }
        }
      }
      if (!rows.length) lines.push("No envelopes match.");
      return { ...toolText(lines.join("\n")), structuredContent: { month, syncedAt: view.syncedAt(), envelopes: rows } };
    }),
  );

  server.registerTool(
    "get_month_summary",
    {
      title: "Get Zerro Month Summary",
      description:
        "Zerro's month totals: money in the budget at the start and end of the month, income not tied to an envelope, envelope activity, assigned, available, assigned in future months, \"To be assigned\" (free money not yet given to envelopes) with its state, and overspend. Converted to the display currency at the month's rates.",
      inputSchema: { month: monthArg },
      annotations: READ,
    },
    withErrors(async ({ month: wanted }) => {
      const view = new View(await ctx.replica.fresh(), ctx.config.displayCurrency);
      const month = view.month(wanted);
      const t = view.graph.monthTotals(view.data)[month];
      const cur = view.displayCurrency;
      const conv = (a: Parameters<View["convert"]>[0]) => view.convert(a, cur, month);
      const fields = {
        fundsStart: conv(t.fundsStart),
        fundsChange: conv(t.fundsChange),
        fundsEnd: conv(t.fundsEnd),
        generalIncome: conv(t.generalIncome),
        envActivity: conv(t.envActivity),
        transferFees: conv(t.transferFees),
        assigned: conv(t.assigned),
        available: conv(t.available),
        assignedInFuture: conv(t.assignedInFuture),
        freeFunds: conv(t.freeFunds),
        toBeAssigned: conv(t.toBeAssigned),
        overspend: conv(t.overspend),
      };
      const label: Record<keyof typeof fields, string> = {
        fundsStart: "Money in budget at start",
        fundsChange: "Change of money in budget",
        fundsEnd: "Money in budget at end",
        generalIncome: "Income not kept by envelopes",
        envActivity: "Envelope activity",
        transferFees: "Transfer fees",
        assigned: "Assigned this month",
        available: "Available in envelopes",
        assignedInFuture: "Assigned in future months",
        freeFunds: "Free funds",
        toBeAssigned: "To be assigned",
        overspend: "Overspend",
      };
      const lines = [header(view, month), `Zerro month summary for ${month}, ${cur}`];
      for (const k of Object.keys(fields) as (keyof typeof fields)[]) {
        const raw = t[k];
        const multi = Object.keys(raw).filter(c => raw[c as never]).length > 1 || (Object.keys(raw)[0] && Object.keys(raw)[0] !== cur);
        lines.push(`- ${label[k]}: ${fmt(fields[k], cur)}${multi ? ` (${fmtFx(raw)})` : ""}`);
      }
      lines.push(`- To be assigned state: ${t.toBeAssignedState}`);
      return {
        ...toolText(lines.join("\n")),
        structuredContent: { month, currency: cur, syncedAt: view.syncedAt(), ...fields, toBeAssignedState: t.toBeAssignedState },
      };
    }),
  );

  server.registerTool(
    "get_envelope_activity",
    {
      title: "Get Zerro Envelope Activity",
      description:
        "Transactions that make up an envelope's activity in a month, routed the way Zerro routes them (by envelope, not just by ZenMoney category: keepIncome, payees and debts count). Newest first, paged.",
      inputSchema: {
        envelope: z.string().describe("Envelope id (tag#…, payee#…, merchant#…, account#…) or exact name."),
        month: monthArg,
        include_children: z.boolean().optional().describe("Include the children's activity. Default true."),
        limit: z.number().int().min(1).max(500).optional().describe("Page size, default 50."),
        offset: z.number().int().min(0).optional().describe("Rows to skip, default 0."),
      },
      annotations: READ,
    },
    withErrors(async ({ envelope, month: wanted, include_children, limit = 50, offset = 0 }) => {
      const view = new View(await ctx.replica.fresh(), ctx.config.displayCurrency);
      const month = view.month(wanted);
      const env = view.resolveEnvelope(envelope);
      const queryContext = view.graph.transactionQueryContext(view.data);
      const all = view.graph
        .sortedTransactions(view.data)
        .filter(
          compileTransactionQuery({
            clauses: [
              {
                kind: "activity",
                envelopeIds: [env.id],
                scope: include_children === false ? "self" : "tree",
                mode: TrFilterMode.Envelope,
                month,
              },
            ],
          }, queryContext),
        );
      all.sort((a, b) => (a.date === b.date ? b.created - a.created : a.date < b.date ? 1 : -1));
      const page = all.slice(offset, offset + limit);
      const d = view.data;
      const cur = (id: number) => d.instrument[id]?.shortTitle ?? `#${id}`;
      const acc = (id: string | null) => (id ? (d.account[id]?.title ?? id) : "?");
      const tags = (ids: string[] | null) => (ids ?? []).map(id => d.tag[id]?.title ?? id).join(", ");
      const rows = page.map(t => ({
        id: t.id,
        date: t.date,
        outcome: t.outcome ? { amount: t.outcome, currency: cur(t.outcomeInstrument), account: acc(t.outcomeAccount) } : null,
        income: t.income ? { amount: t.income, currency: cur(t.incomeInstrument), account: acc(t.incomeAccount) } : null,
        payee: t.payee ?? (t.merchant ? d.merchant[t.merchant]?.title : null) ?? null,
        tags: tags(t.tag),
        comment: t.comment ?? null,
      }));
      const lines = [
        header(view, month),
        `${env.name} [${env.id}] activity in ${month}: ${all.length} transactions${all.length > page.length ? `, showing ${offset + 1}–${offset + page.length}` : ""}`,
        ...rows.map(r => {
          const money = [r.outcome && `−${fmt(r.outcome.amount, r.outcome.currency)} from ${r.outcome.account}`, r.income && `+${fmt(r.income.amount, r.income.currency)} to ${r.income.account}`]
            .filter(Boolean)
            .join(", ");
          return `- ${r.date} ${money}${r.payee ? ` · ${r.payee}` : ""}${r.tags ? ` · ${r.tags}` : ""}${r.comment ? ` · “${r.comment}”` : ""} · ${r.id}`;
        }),
      ];
      return {
        ...toolText(lines.join("\n")),
        structuredContent: { month, envelope: env.id, total: all.length, offset, transactions: rows },
      };
    }),
  );

  server.registerTool(
    "get_goals",
    {
      title: "Get Zerro Goals",
      description:
        "Envelope goals in effect for a month (a goal set in an earlier month carries on until changed or past its end): type, amount, end date, how much the envelope still needs this month, progress, plus totals. Types: monthly (assign this much each month), monthlySpend (spend up to this much), targetBalance (reach this balance, by the end date if set), incomePercent (share of income; its amount is a fraction, 0.25 = 25%).",
      inputSchema: { month: monthArg },
      annotations: READ,
    },
    withErrors(async ({ month: wanted }) => {
      const view = new View(await ctx.replica.fresh(), ctx.config.displayCurrency);
      const month = view.month(wanted);
      const envs = view.envelopes();
      const goals = Object.values(view.graph.goals(view.data)[month] ?? {}) as TGoalInfo[];
      const totals = view.graph.goalTotals(view.data)[month];
      const cur = view.displayCurrency;
      const rows = goals.map(g => ({
        envelope: g.id,
        name: envs[g.id]?.name ?? g.id,
        ...g.goal,
        currency: g.currency,
        setIn: goalSetIn(view, g.id, month),
        needNow: g.needNow,
        targetBudget: g.targetBudget,
        progress: g.progress,
      }));
      const need = view.convert(totals?.need, cur, month);
      const target = view.convert(totals?.target, cur, month);
      const lines = [
        header(view, month),
        `Goals in ${month}: ${rows.length}; need now ${fmt(need, cur)} of ${fmt(target, cur)}, progress ${Math.round((totals?.progress ?? 0) * 100)}%`,
        ...goals.map(g => `- ${envs[g.id]?.name ?? g.id} [${g.id}]: ${goalText(g)}`),
      ];
      return {
        ...toolText(lines.join("\n")),
        structuredContent: { month, currency: cur, need, target, progress: totals?.progress ?? 0, goals: rows },
      };
    }),
  );
}

