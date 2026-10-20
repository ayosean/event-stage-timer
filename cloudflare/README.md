# Cloudflare backup deployment

A standby copy of the stage timer that runs on Cloudflare Workers, for use if
the Railway service is unavailable. It is fully separate from Railway: its own
URL, its own login secrets, and its own timer state. Nothing in this folder is
used by the Railway Docker build, and deploying it does not touch Railway.

It reuses the same React client (`src/`) and timer logic (`shared/`). The Node
server is replaced by `src/index.ts`: a Worker that serves the built client,
and one SQLite-backed Durable Object that stores the timer, logins, and live
WebSocket connections. This runs on Cloudflare's free plan.

## First deploy

From the repository root, with Node 22 or newer:

```sh
npm ci
cd cloudflare
npm ci
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD   # long, unique controller password
npx wrangler secret put SESSION_SECRET   # paste output of: openssl rand -hex 32
npm run deploy
```

`ADMIN_USERNAME` is optional (defaults to `admin`); set it the same way if you
use a different username on Railway. Wrangler prints the backup URL, e.g.
`https://event-stage-timer-backup.<your-subdomain>.workers.dev`. Open
`/controller` and `/display` on that URL, and check `/health`.

Re-run `npm run deploy` after pulling app changes to keep the backup current.
In CI, set `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and
`CLOUDFLARE_ACCOUNT_ID` instead of `wrangler login`.

## Switching to the backup

The backup keeps its own timer state, so before switching, load the rundown on
the backup controller, then point the controller and display iPads at the
backup URL.

## Local test

Create `cloudflare/.dev.vars` (ignored by git) with `ADMIN_PASSWORD` and
`SESSION_SECRET`, then run `npm run dev` here. The app is at
http://localhost:8787.
