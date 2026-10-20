# Independent Cloudflare backup

This branch (`cloudflare-backup`) deploys a separate timer to Cloudflare Workers.
It does **not** change Railway, its volume, environment variables, deployment
configuration, source branch, or live timer. Do not merge it into `main` merely
to deploy the backup. Railway remains connected to `main`.

The Cloudflare timer has independent SQLite-backed Durable Object storage,
login sessions, rundown, selected presenter, countdown and Pacific clock mode.
It does not automatically mirror Railway's timer or presenter changes. The same
manual-start rules, overtime, presets and 30-second adjustments apply. Current
Time shows Pacific hours and minutes without seconds or AM/PM.

## Deploy using your Cloudflare account and GitHub

1. Sign in to https://dash.cloudflare.com/ and open **Workers & Pages**.
2. Choose **Create application** / **Create Worker**, then **Import a repository**
   (the wording may be **Connect to Git**). Choose GitHub and authorize access
   to **ayosean/event-stage-timer**.
3. Set the Worker name to **event-stage-timer-backup**. Select production branch
   **cloudflare-backup**, never `main`. Use the repository root (`/`).
4. Set the build command to **`npm run build:cloudflare`** and deploy command
   to **`npx wrangler deploy`**. If there is a non-production branch deploy
   command, disable those branch builds initially. Do not use Pages: this is
   a Worker with Durable Objects, not a static Pages deployment.
5. Use Node **24** for builds. If needed, set the **build variable**
   `NODE_VERSION=24` in Build settings. Credentials belong in runtime secrets,
   not build variables and never variables starting with `VITE_`.
6. Deploy. Wrangler reads `wrangler.jsonc`, uploads the React assets, creates the
   `StageTimer` SQLite Durable Object namespace via migration `v1`, and binds it
   as `TIMER`. No external database, Railway volume, or custom domain is needed.
7. Open the new Worker's **Settings → Variables and Secrets**. Add runtime
   **Secret** entries:

   | Name             | Value                                            |
   | ---------------- | ------------------------------------------------ |
   | `ADMIN_PASSWORD` | Your chosen dashboard password                   |
   | `SESSION_SECRET` | A unique random secret of at least 32 characters |

   `ADMIN_USERNAME=avteam` is already configured in `wrangler.jsonc`. Set the
   password to your existing dashboard password if you want matching logins.
   Generate a secret with a password manager, or locally with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Save/deploy the secret changes so the active Worker receives them. If the
   initial import offers runtime secrets before the first deploy, set them there.
   Until both secrets exist, `/health` returns **503** and login is unavailable.

8. Open the Worker's generated `https://event-stage-timer-backup.<your-subdomain>.workers.dev`
   address. Check **`/health`** returns `{"ok":true}`. Open **`/controller`**,
   sign in, and copy the new **`/display`** URL to the iPad.
9. Verify the backup using a short timer: start, pause, reload the display, switch
   to Current Time, then load the 90-minute preset and confirm it remains ready.
   Keep both backup URLs bookmarked separately from Railway.

The exact workers.dev subdomain belongs to your account and is only known after
creation. The branch is ready for deployment; a successful local build does not
mean a live Cloudflare deployment has happened.

SQLite-backed Durable Objects support the Workers Free plan. Free-plan request,
compute and storage limits still apply; consult
https://developers.cloudflare.com/durable-objects/platform/pricing/ and monitor
usage during the event. Hibernating WebSockets avoid a constantly active object;
the app only wakes for connections, clock synchronization and user commands.
No server interval runs once per second.

## Switching to the backup

- Open the **Cloudflare controller**, enter the needed presenter/duration and
  switch the iPad to the **Cloudflare display** URL.
- Press **Start** manually. Railway's timer state is not imported automatically.
- Multiple Cloudflare displays synchronize with the Cloudflare controller only.
- Keep the backup rundown prepared separately if you want a quicker failover.
- Returning to Railway uses your original Railway URLs and its independent state.

## Local verification and CLI deployment

Requires Node 24. From this branch:

```sh
npm ci
npm run test:cloudflare
npm run test:e2e:cloudflare -- --project=chromium
```

For local interactive use, copy `.dev.vars.example` to `.dev.vars`, replace its
test values, run `npm run build:cloudflare`, then `npm run dev:cloudflare`.
`.dev.vars` and `.wrangler/` are ignored by Git. Test credentials in Playwright
configuration are local test values only, never deployment credentials.

Optional deployment from your own terminal, instead of GitHub import:

```sh
npx wrangler login
npm run build:cloudflare
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

If secret upload asks to create the named Worker, allow it, then deploy the full
configuration. Never change the Worker name, object class name, namespace binding,
object instance name or migration history during an ordinary update: those
identities keep the existing Cloudflare timer storage attached. Do not delete the
Worker or Durable Object namespace to update the app.
