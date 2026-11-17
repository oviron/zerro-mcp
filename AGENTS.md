# zerro-mcp

MCP server for Zerro's envelope budget on top of ZenMoney. Public repo, English.

- Numbers come from Zerro's core in `vendor/zerro-core` (GPL-2, see `NOTICE.md`).
  Never edit it or reimplement its formulas; import it only through `src/core.ts`.
  An update is a fresh copy at a newer Zerro commit plus a parity check against zerro.app.
- `src/zenmoney/wire.ts` is the whole seconds ⇄ milliseconds boundary with ZenMoney.
- All pulls and pushes go through the one queue in `src/replica.ts`.
- Writes follow the protocol in README ("How writing works"); keep preview, token,
  lock, journal and verification together in `src/tools/write.ts` and `src/write/`.
- No personal data, tokens, account names or amounts in code, tests or docs.

Checks: `npm run typecheck && npm test && npm run build`. Tests use fixtures and the
fake ZenMoney in `test/fake.ts`, never the network.
