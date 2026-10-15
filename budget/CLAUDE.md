# Budget app

Personal budgeting app: Node 24 server (TypeScript run directly, no build step) + React/Vite frontend + SQLite (`node:sqlite`). Bank data comes from SimpleFIN Bridge (one `/accounts` poll a day; ~24 requests/day allowed); manual accounts and CSV import cover institutions it can't reach. A Plan tab projects a debt payoff and savings plan month by month. AI features (categorization, Q&A, daily briefing, monthly insights, receipt reading, plan import) run through the Claude Code CLI (`claude -p`, no tools) on the user's subscription, with the sign-in stored under `data/claude`; see [server/claude.ts](server/claude.ts). Packaged as a Home Assistant add-on: the repo root holds `repository.json`; this `budget/` folder is the add-on (`config.yaml` + `Dockerfile` + `icon.png`/`logo.png`). All commands below run from `budget/`.

## Commands

- `npm run build` then `npm start`: serve the app at http://127.0.0.1:8099
- `npm run dev:server` + `npm run dev:web`: watch mode (Vite proxies `/api` to the server)
- `npm run typecheck` (slow on this PC, ~50s)
- `python scripts/make_icon.py`: redraw `icon.png`/`logo.png` after changing `web/public/icon.svg`

## Constraints

- Server code must stay erasable-syntax-only TypeScript (no enums, no parameter properties) and import with `.ts` extensions, because Node runs it directly.
- Frontend URLs must stay relative (`api/...`, `./icon.svg`, Vite `base: './'`) so the app works behind Home Assistant ingress.
- Any total or per-category figure must read the `ledger` view, not `transactions`, or split transactions get counted wrong.
- The SimpleFIN access URL (it embeds credentials) lives in `data/secrets.db`, never in `budget.db`, and is not backed up. Never read, print or copy `data/secrets.db` or `.env`, and never ask the user to paste a setup token or access URL into chat; it goes in the Accounts tab or the add-on options.
- Target hardware is a Home Assistant Green (ARM, 4 GB, eMMC): keep dependencies light and avoid chatty disk writes.
- `GET /api/summary` and `GET /api/briefing` are the contract for the Daily Briefing add-on; only add fields, never rename or remove.
- The Claude CLI never gets tools or file access. Receipt photos go in as a stream-json image block (`askClaudeWithImage`), are resized in the browser first, and are never stored.
- Schema changes go through `addColumn` in [server/db.ts](server/db.ts) so existing databases (and restored backups) migrate on start.
- [shared/payoff.ts](shared/payoff.ts) (debt payoff math) is imported by both the server and the browser, so it stays plain TypeScript with no Node or DOM imports.
- The Plan ([server/plan.ts](server/plan.ts)) projects from real balances and the income schedule; "spending" there means expense categories except Debt Payments, because loan payments are modeled as debts. Keep that definition the same in the projection, the actual average and plan vs actual.

## Analyzing the user's finances

When asked to analyze spending, debts, trends or anything about the data, query it read-only:

```
node scripts/query.mjs "SELECT c.name, ROUND(SUM(l.amount), 2) AS spent FROM ledger l JOIN categories c ON c.id = l.category_id WHERE c.kind = 'expense' AND substr(l.date, 1, 7) = '2026-10' GROUP BY c.id ORDER BY spent DESC"
```

The app must be running. For an instance on Home Assistant set `BUDGET_URL` and `BUDGET_TOKEN`.

Schema:

- `ledger` (view): `transactions` with each split transaction replaced by its parts. Same columns plus `transaction_id`. Use it for all totals.
- `transactions(id, account_id, date, name, merchant, amount, pending, category_id, category_source, notes)`: amount > 0 is money out, amount < 0 is money in. category_source none means only the default 'Other' was applied; user means set by hand or split.
- `splits(id, transaction_id, amount, category_id)`: parts of a split; same sign as the parent and they sum to its amount.
- `accounts(id, source, org_name, name, type, balance, available, currency, balance_date, apr, min_payment, in_plan, promo_apr, promo_end)`: source is simplefin | manual; type is depository | credit | loan | investment | other. `balance` is signed: negative = owed. apr/min_payment/in_plan/promo_* feed the Debt and Plan tabs; promo_apr applies until promo_end.
- `categories(id, name, kind, track)`: kind is expense | income | savings | transfer; only expense counts as spending. track = running-total card on the dashboard.
- `budgets(category_id, amount)`: monthly target.
- `balance_snapshots(date, account_id, balance)`: daily signed balances, for net worth over time.
- `recurring_overrides(merchant_key, label, status, cadence)`: the user's corrections to recurring detection; status yes (confirmed, cadence optional) or no (hidden). merchant_key is the normalized merchant from [server/recurring.ts](server/recurring.ts).
- `rules(pattern, category_id)`, `insights(month, content, created_at)`, `meta(key, value)` (last_sync, last_sync_errors, last_sync_failure, last_backup, briefing, plan).
- `meta.plan`: the payoff-and-savings plan as JSON (`json_extract` works): income {paycheck, schedule, lastPayday, bonus, bonusMonths, side, raises[]}, spending (planned monthly, null = actual average), events[] {month, label, amount, monthly}, goals[] in order {kind debt|savings, name, accountId, target, by, items[]}. Absent until the user saves one.

Describe what the data shows; do not give personalized investment advice.
