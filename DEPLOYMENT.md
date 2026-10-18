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

The application was deployed directly from the local checkout with Railway CLI because GitHub rejected write access. **GitHub publication and deployment-on-push are still pending.** Once repository write access is restored, push the committed implementation, connect this existing Railway service to `ayosean/event-stage-timer` on branch `main`, and enable automatic deployments. Reuse the service and volume above rather than creating a duplicate.

The production Docker build and health check succeeded. An actual Railway redeployment also preserved the running deadline, rundown, selected session, and existing admin login; the timer was then reset to 90:00 ready. A live browser smoke test verified HTTPS admin login, WSS synchronization, manual start, refresh, live time adjustment, pause/resume, preset loading without auto-start, red zero, and restoration to 90:00 ready. This verification is a point-in-time check, not a seven-day soak test. Rehearse sleep prevention and connectivity on the physical iPad.

## Optional live smoke test

Run this **before** an event: it changes the live countdown and returns it to 90:00 ready. Install the development dependencies and Chromium first. Store a JSON object containing `ADMIN_USERNAME` and `ADMIN_PASSWORD` in a secure file outside this repository, then run:

```sh
LIVE_URL=https://event-stage-timer-production.up.railway.app \
LIVE_CREDENTIALS_FILE=/secure/path/timer-credentials.json \
node tests/live-smoke.mjs
```

Screenshots are written to the ignored `test-results/live` directory (or `LIVE_ARTIFACT_DIR`). The script uses `HTTPS_PROXY` if supplied. It does not disable TLS verification.
