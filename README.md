# Budget

Home Assistant add-on: personal budgeting with SimpleFIN bank sync and Claude Code AI (categorization, questions, monthly reviews). Runs on a Home Assistant Green.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → Repositories, add `https://github.com/j0eyoung/budget`.
2. Install **Budget**, then start it and turn on **Show in sidebar**. The first start builds the image on the Green and takes several minutes.
3. Open Budget → Accounts:
   - paste a setup token from [bridge.simplefin.org](https://bridge.simplefin.org) and click Connect;
   - click **Connect Claude**, open the link, approve, paste the code back;
   - add a manual account for anything SimpleFIN can't reach (e.g. a mortgage servicer), and import its history with **Import CSV**.

## What it does

- **Dashboard**: today's check ("anything to flag?"), spend vs budget with last-month comparison, tracked categories with running totals, monthly cash flow, net worth.
- **Transactions**: AI categories, merchant rules, notes, and splits (one Costco trip into groceries + pharmacy).
- **Budget**: monthly targets, 3-month averages, one-click fill from averages.
- **Recurring**: detected bills and subscriptions, monthly total, price increases, ones that may have stopped.
- **Debt**: current payoff pace per account and an avalanche vs snowball plan with extra payments.
- **Health**: warns when an account stops updating or a sync fails.
- **Backups**: the database is copied nightly to the add-on's config folder (`/addon_configs/<id>_budget/backups`, last 7 kept) and restored automatically if the add-on starts with empty data. The SimpleFIN connection is not backed up; reconnect with a new setup token after a reinstall.

## Options

| Option | Purpose |
|---|---|
| `simplefin_setup_token` | Alternative to pasting the token in the UI; claimed once on start |
| `claude_code_oauth_token` | Fallback sign-in from `claude setup-token`; the in-app login is preferred |
| `claude_model` | `haiku`, `sonnet` (default) or `opus` |
| `api_token` | Required for requests that don't come through HA ingress (other add-ons, Claude Code on a PC). Enable the port under Network first. |

## For other add-ons

Send `Authorization: Bearer <api_token>` (not needed through ingress).

- `GET /api/summary`: net worth, this month's spend vs budget, over-budget categories, balances, recent charges, bills due in the next 7 days, connection issues and today's briefing text.
- `GET /api/briefing?generate=1`: today's "anything to flag?" text (generated through Claude if it hasn't been yet today) plus the data behind it.

## Development

See [budget/CLAUDE.md](budget/CLAUDE.md). Run from the `budget` folder with `npm run build && npm start`.
