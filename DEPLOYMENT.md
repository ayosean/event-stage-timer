# Deployment record

Verified on 2026-10-18:

- Controller: https://event-stage-timer-production.up.railway.app/controller
- Display: https://event-stage-timer-production.up.railway.app/display
- Health: https://event-stage-timer-production.up.railway.app/health
- Railway project: https://railway.com/project/1d374ae8-32eb-483e-916d-6154e7136d6b
- Production service: `event-stage-timer` (`0bdf1dd1-df2a-4132-b3b7-476f713a8461`).
- Production environment: `60ac967a-ce6e-4c7a-be6b-d155e90e5f20`.
- Persistent volume: `stage-timer-data`, mounted at `/data`, 512 MB.
- One replica, service sleeping disabled, health check `/health`.
- Login settings `ADMIN_USERNAME` and `ADMIN_PASSWORD`, and the generated `SESSION_SECRET`, are stored in Railway variables. They are not committed to this repository. Retrieve the controller password in Railway → service → Variables → `ADMIN_PASSWORD`.
- `PUBLIC_URL`, `DATA_DIR=/data`, and `NODE_ENV=production` are configured.

The application was initially deployed from the local checkout with Railway CLI. On 2026-10-19, GitHub access was resolved and all implementation commits were pushed to [ayosean/event-stage-timer](https://github.com/ayosean/event-stage-timer). This existing Railway service is connected to branch `main`, and a GitHub-source deployment succeeded. Automatic deployment on subsequent pushes is not yet active: Railway refused trigger creation because no project member has repository access through its GitHub integration. Grant the [Railway GitHub App](https://github.com/apps/railway-app/installations/new) access to `event-stage-timer`, then enable the `main` deployment trigger with Wait for CI. The implementation passed GitHub CI, including all 20 server tests and both Chromium and WebKit browser checks. Reuse the service and persistent volume above rather than creating a duplicate.

The production Docker build and health check succeeded. An actual Railway redeployment also preserved the running deadline, rundown, selected session, and existing admin login; the timer was then reset to 90:00 ready. A live browser smoke test verified HTTPS admin login, WSS synchronization, manual start, refresh, live time adjustment, pause/resume, preset loading without auto-start, red zero, and restoration to 90:00 ready. This verification is a point-in-time check, not a seven-day soak test. Rehearse sleep prevention and connectivity on the physical iPad.

## Optional live smoke test

Run this **before** an event: it changes the live countdown and returns it to 90:00 ready. Install the development dependencies and Chromium first. Store a JSON object containing `ADMIN_USERNAME` and `ADMIN_PASSWORD` in a secure file outside this repository, then run:

```sh
LIVE_URL=https://event-stage-timer-production.up.railway.app \
LIVE_CREDENTIALS_FILE=/secure/path/timer-credentials.json \
node tests/live-smoke.mjs
```

Screenshots are written to the ignored `test-results/live` directory (or `LIVE_ARTIFACT_DIR`). The script uses `HTTPS_PROXY` if supplied. It does not disable TLS verification.

## Cloudflare backup

A separate standby deployment on Cloudflare Workers lives in [`cloudflare/`](cloudflare/README.md). It has its own URL, secrets, and timer state, and the Railway build does not use any file in that folder.
