# Budget

Home Assistant add-on: personal budgeting with SimpleFIN bank sync and Claude Code AI (categorization, questions, monthly reviews). Runs on a Home Assistant Green.

## Install

1. Settings → Add-ons → Add-on Store → ⋮ → Repositories, add `https://github.com/j0eyoung/budget`.
2. Install **Budget**, then start it and turn on **Show in sidebar**. The first start builds the image on the Green and takes several minutes.
3. Open Budget → Accounts:
   - paste a setup token from [bridge.simplefin.org](https://bridge.simplefin.org) and click Connect;
   - click **Connect Claude**, open the link, approve, paste the code back;
   - add a manual account for anything SimpleFIN can't reach (e.g. a mortgage servicer).

## Options

| Option | Purpose |
|---|---|
| `simplefin_setup_token` | Alternative to pasting the token in the UI; claimed once on start |
| `claude_code_oauth_token` | Fallback sign-in from `claude setup-token`; the in-app login is preferred |
| `claude_model` | `haiku`, `sonnet` (default) or `opus` |
| `api_token` | Required for requests that don't come through HA ingress (other add-ons, Claude Code on a PC). Enable the port under Network first. |

## For other add-ons

`GET /api/summary` returns net worth, this month's spend vs budget, over-budget categories, balances and recent charges as JSON. Send `Authorization: Bearer <api_token>`.

## Development

See [budget/CLAUDE.md](budget/CLAUDE.md). Run from the `budget` folder with `npm run build && npm start`.
