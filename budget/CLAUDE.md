# Budget app

Personal budgeting app: Node 24 server (TypeScript run directly, no build step) + React/Vite frontend + SQLite (`node:sqlite`). Bank data comes from SimpleFIN Bridge (one `/accounts` poll a day; ~24 requests/day allowed); manual accounts cover institutions it can't reach. AI features (categorization, Q&A, monthly insights) run through the Claude Code CLI (`claude -p`, no tools) on the user's subscription, with the sign-in stored under `data/claude`; see [server/claude.ts](server/claude.ts). Packaged as a Home Assistant add-on: the repo root holds `repository.json`; this `budget/` folder is the add-on (`config.yaml` + `Dockerfile`). All commands below run from `budget/`.

## Commands

- `npm run build` then `npm start`: serve the app at http://127.0.0.1:8099
- `npm run dev:server` + `npm run dev:web`: watch mode (Vite proxies `/api` to the server)
- `npm run typecheck`

## Constraints

- Server code must stay erasable-syntax-only TypeScript (no enums, no parameter properties) and import with `.ts` extensions, because Node runs it directly.
- Frontend URLs must stay relative (`api/...`, Vite `base: './'`) so the app works behind Home Assistant ingress.
- The SimpleFIN access URL (it embeds credentials) lives in `data/secrets.db`, never in `budget.db`. Never read, print or copy `data/secrets.db` or `.env`, and never ask the user to paste a setup token or access URL into chat; it goes in the Accounts tab or the add-on options.
- Target hardware is a Home Assistant Green (ARM, 4 GB, eMMC): keep dependencies light and avoid chatty disk writes.
- `GET /api/summary` is the contract for the Daily Briefing add-on; keep it backward compatible.

## Analyzing the user's finances

When asked to analyze spending, debts, trends or anything about the data, query it read-only:

```
node scripts/query.mjs "SELECT c.name, ROUND(SUM(t.amount), 2) AS spent FROM transactions t JOIN categories c ON c.id = t.category_id WHERE c.kind = 'expense' AND substr(t.date, 1, 7) = '2026-10' GROUP BY c.id ORDER BY spent DESC"
```

The app must be running. For an instance on Home Assistant set `BUDGET_URL` and `BUDGET_TOKEN`.

Schema:

- `accounts(id, source, org_name, name, type, balance, available, currency, balance_date)`: source is simplefin | manual; type is depository | credit | loan | investment | other. `balance` is signed: negative = owed.
- `transactions(id, account_id, date, name, merchant, amount, pending, category_id, category_source, notes)`: amount > 0 is money out, amount < 0 is money in. category_source none means only the default 'Other' was applied.
- `categories(id, name, kind)`: kind is expense | income | transfer. Exclude transfers from spending totals.
- `budgets(category_id, amount)`: monthly target.
- `balance_snapshots(date, account_id, balance)`: daily signed balances, for net worth over time.
- `rules(pattern, category_id)`, `insights(month, content, created_at)`, `meta(key, value)` (last_sync).

Describe what the data shows; do not give personalized investment advice.
