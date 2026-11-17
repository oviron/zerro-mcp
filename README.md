# zerro-mcp

An [MCP](https://modelcontextprotocol.io) server for the envelope budget of
[Zerro](https://zerro.app), the open-source web client for
[ZenMoney](https://zenmoney.app). An agent can read and change the budget the
way Zerro shows it — envelopes, "To be assigned", overspend, goals — without a
browser.

Zerro keeps its budget inside ZenMoney: assignments, goals and envelope
settings are JSON documents in reminders of a hidden account
`🤖 [Zerro Data]`, and everything else (leftovers, available, "To be
assigned") is computed from transactions. This server does not reimplement
that math: it runs Zerro's own calculation core, vendored from the Zerro
repository (see [NOTICE.md](NOTICE.md)), so the numbers match Zerro.

This is not ZenMoney's native category budget (what ZenMoney apps show). For
ZenMoney data itself — accounts, transactions, categories — use a ZenMoney MCP
server.

## Tools

Reading:

| Tool | What it gives |
|---|---|
| `get_envelopes` | Envelopes of a month in Zerro's groups: leftover, assigned, activity, available — own and with children — and the goal |
| `get_month_summary` | Month totals: money in the budget, "To be assigned" and its state, overspend, assigned in future months |
| `get_envelope_activity` | Transactions behind an envelope's activity, routed as Zerro routes them |
| `get_goals` | Goals in effect for a month, what each envelope still needs, progress |
| `sync_data` | Pull from ZenMoney now |

Writing (only with `ZERRO_MCP_WRITE=1`):

| Tool | What it does |
|---|---|
| `set_envelope_budget` | Set an envelope's total "Assigned" for a month, as typing it in Zerro |
| `move_envelope_funds` | Move an amount between envelopes or to/from "To be assigned" |
| `cover_overspend` | Cover overspend of one envelope or all of them |

Envelopes are named by id (`tag#…`, `payee#…`, `merchant#…`, `account#…`) or by
exact name; an ambiguous name returns the candidates. Months are `YYYY-MM`
within the range Zerro has.

### How writing works

ZenMoney has no compare-and-swap: a document is replaced by whichever copy
arrives with the newer timestamp, and Zerro writes a month's budget as one
document. So each write tool works in two calls:

1. Without `confirm` it pulls, compiles the change with Zerro's own action
   (the same code the buttons in Zerro run), applies it in memory and returns
   the result — what changes, the envelopes after, "To be assigned" after — and
   a token.
2. With `confirm: <token>` it pulls again and recomputes. If anything moved
   (new transactions, rates, someone else's edit), the token no longer matches
   and you get a new preview instead of a write. Otherwise it sends the change,
   pulls, and checks that every month's assignments are exactly as previewed.

While a write runs, nobody should edit the budget in Zerro, and an open Zerro
tab must not hold unsent changes. Writes are refused when Zerro's stored
documents look damaged (the same month stored twice, a malformed payload).
Each write leaves a private journal in `ZERRO_MCP_STATE_DIR/journal` with the
rows as they were before, what was sent and how it ended; a journal still named
`*.open.json` is a write whose outcome was not confirmed. A lost answer is
never retried automatically: the server pulls and reports what it sees.

Enable writing on one machine only, and run one write at a time per account.

## Setup

Get a ZenMoney token at <https://zerro.app/token>.

```json
{
  "mcpServers": {
    "zerro": {
      "command": "npx",
      "args": ["-y", "--package=https://github.com/oviron/zerro-mcp/releases/download/v0.1.0/zerro-mcp-0.1.0.tgz", "zerro-mcp"],
      "env": { "ZENMONEY_TOKEN": "…" }
    }
  }
}
```

Or from a clone: `npm ci && npm run build`, then run `node build/index.js`.

| Variable | Default | Meaning |
|---|---|---|
| `ZENMONEY_TOKEN` | — | ZenMoney API token, required |
| `ZENMONEY_API_URL` | `https://api.zenmoney.ru` | or `https://api.zenmoney.app` |
| `ZENMONEY_TIMEOUT` | `60` | Seconds to wait for ZenMoney |
| `ZERRO_SYNC_TTL` | `30` | Tools pull first when data is older than this many seconds |
| `ZERRO_DISPLAY_CURRENCY` | your ZenMoney currency | Currency for month totals (Zerro keeps its own choice in the browser) |
| `ZERRO_MCP_WRITE` | off | `1` adds the write tools |
| `ZERRO_MCP_STATE_DIR` | `~/.local/state/zerro-mcp` | Write lock and journals |

Requires Node.js 20 or newer. The server keeps ZenMoney data in memory only.

## Development

```bash
npm ci
npm run typecheck
npm test        # fixtures and a fake ZenMoney server; no network
npm run build   # one self-contained build/index.js
```

The core lives in `vendor/zerro-core`, unchanged from upstream; `src/core.ts`
is the only module that imports it. Updating it: copy `src/zerro-core` from a
newer Zerro commit (without tests), update `NOTICE.md`, run the checks, and
compare a few envelopes and the month summary with zerro.app on the same data.

## License

GPL-2.0-only, the license of Zerro, whose core this server includes.
