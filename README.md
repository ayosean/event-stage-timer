# Event Stage Timer

A single-service event countdown for a remote controller and any number of read-only presenter displays. React + TypeScript + Vite, Node 24, native WebSockets, and SQLite. No external database or paid real-time service is required.

- `/controller`: password-protected dark production dashboard, rundown editor, presets, live adjustments, and viewer count.
- `/display`: **only** a huge centered countdown on pure black. White digits while counting down; red `00:00` at zero, then elapsed overtime counting up (`00:01`, `00:02`, …). No names, branding, controls, or scrolling. Current Time mode instead shows only a large white Pacific Time clock.
- `/health`: database health check, returns `{"ok":true}` when healthy.

## Deploy to Railway

1. Create/select the Railway service connected to **this repository**, source branch **main**, root directory `/`. Enable **automatic deployments** for pushes to main. The repository cannot change your Railway project's GitHub connection or autodeploy setting. If desired, enable Railway's “Wait for CI” after the GitHub checks are available.
2. Attach a **persistent volume mounted at `/data`** to this service. This is required; the image filesystem is disposable. Keep **one service replica**, one region, and no horizontal scaling. Disable service sleeping/serverless mode for the live event. The application checks Railway's volume mount environment when running on Railway in production.
3. Generate a public Railway HTTPS domain under Networking. Set these Railway variables:

   | Variable         | Value                                                                                                                                               |
   | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `ADMIN_USERNAME` | Your admin username (defaults to `admin` if omitted).                                                                                               |
   | `ADMIN_PASSWORD` | Your admin password. A long unique password is recommended.                                                                                         |
   | `SESSION_SECRET` | At least 32 random characters. Generate with `openssl rand -hex 32`. Keep stable across deployments.                                                |
   | `PUBLIC_URL`     | Your exact public origin, e.g. `https://your-service.up.railway.app`. No path. Must match the browser's address, including a custom domain if used. |
   | `DATA_DIR`       | `/data`                                                                                                                                             |
   | `NODE_ENV`       | `production` (also set by the Docker image).                                                                                                        |

   Railway supplies `PORT` and `RAILWAY_VOLUME_MOUNT_PATH`. Do not replace these. Do not put credentials in Vite variables or public files.

4. Deploy/redeploy. Railway uses the included Dockerfile, runs **`npm run build`**, starts **`npm start`**, and checks **`/health`**. The server binds to `0.0.0.0:$PORT`; the same service serves the compiled frontend, API, and WebSocket upgrades. HTTPS/WSS terminate at Railway's proxy.
5. Confirm the Railway deployment is healthy and `https://YOUR-DOMAIN/health` returns `{"ok":true}`. Open `/controller` and sign in. Select **90 min**: it must say **READY TO START**. Use **Copy URL** to open `/display` on the iPad. Press **Start timer** to start both.
6. Before the event, repeat the smoke checks below on your actual devices and Wi-Fi networks. Verify the service has no restart loop and enough Railway credit/resources for the full seven days.

A push alone is not proof of a successful Railway deployment. Until the domain, secrets, and volume are configured and the health check succeeds, treat the application as not live.

### Persistence and recovery

SQLite is stored at `/data/stage-timer.sqlite` (plus WAL/SHM files). Each command is committed synchronously, using WAL and `synchronous=FULL`, **before** it is broadcast. Rundown order, durations, selected session, revision, status, start/pause timestamps, and deadline survive restart. A running timer continues toward its original deadline during downtime; paused timers stay paused. An elapsed deadline recovers running in overtime, preserving the original deadline. Deployment never starts a ready timer.

Do not remove or replace the volume during redeploys. Enable Railway volume backups/snapshots where available. For application-consistent manual backups while online, use SQLite's backup API/CLI rather than copying just the main database while WAL is active. A normal single-volume redeploy can briefly interrupt connections; clients reconnect automatically. This design is one event workspace per service, not a multi-instance cluster. Deploy outside critical live moments when practical.

## Controller operation

The dashboard separates **LIVE output** from **off-air preparation**. A running
countdown or Pacific clock owns its own saved state and is independent of the
rundown. Planning commands cannot change the LIVE deadline, remaining time,
mode, or original session name.

- In **Prepare next timer**, choose a presenter, a **15 / 30 / 45 / 60 / 90**
  preset, or a custom duration. Previous/Next only change which session is
  prepared. These actions never start, pause, reset, or replace LIVE output.
- Edit, add, duplicate, reorder, and delete rundown sessions freely. Even deleting
  the LIVE source entry leaves its output running with its original name and
  deadline. Keep at least one agenda entry. Limits: 200 sessions, 120-character
  names, duration 1 second–999 minutes.
- **Start prepared LIVE** explicitly publishes and starts the prepared timer.
  **Show prepared paused** publishes it in the ready state without a deadline;
  it stays paused until you manually press Start. An active countdown or clock
  requires a confirmation before either action can replace it.
- The LIVE panel's **Pause / Resume** and **+/−** controls intentionally affect
  the existing LIVE timer. They never publish a different prepared session.
  Adding/subtracting 30 seconds or 1, 5, or 10 minutes preserves running/paused
  status. Overtime counts upward in red and supports pause/resume/adjustments.
- **Reset** restores the LIVE timer's original loaded duration, paused. Reset
  and display mode switches require confirmation when an output is active.
  Cancel leaves the output unchanged. Confirmations are bound to the revision
  you reviewed; another controller's intervening command causes rejection rather
  than silently publishing a different prepared timer.
- Editing, selecting, or preparing sessions while the clock is on air leaves the
  clock visible. Only explicit LIVE controls can change it.
- LIVE state and the separately prepared session/duration both survive refresh
  and server restart. Migration from earlier versions preserves the existing
  LIVE deadline, start/pause timestamps and display mode.
- Controls disable while disconnected or awaiting acknowledgement. Commands are
  never queued or retried after a network failure. Review the synchronized state
  before retrying a timed-out command. Controller logins last 24 hours;
  expiration/sign-out does not stop the presenter displays.

## Current Time display

Use **Current Time** above the live preview to show San Francisco's current time on every connected display. It shows 12-hour time with just hours and minutes, for example `9:05`, without seconds or AM/PM, in large white type on black. The timezone is fixed to **America/Los_Angeles**, which automatically switches between PST and PDT. The device's own timezone does not change the display.

The **Current Time** button is a LIVE output control: switching to it pauses a
running countdown and preserves the exact remaining time, including overtime.
**Countdown** switches back without starting it; Resume is manual. An active
output requires confirmation for a mode switch. Rundown work and preparing a
new timer never change the clock. Explicitly publishing a prepared timer returns
the display to Countdown mode.

The server persists the selected mode on the volume and sends it to all viewers, including after refresh, reconnect, and server restart. Clock mode uses the same server-time synchronization and monotonic local clock as the countdown; it continues ticking through a temporary disconnection. Display viewers cannot change modes. Screen wake lock applies to both modes.

## iPad setup

1. Use a recent iPadOS and Safari. Connect the iPad to power, turn landscape, and lock orientation if appropriate. Open the exact HTTPS `/display` URL.
2. In **Settings → Display & Brightness → Auto-Lock**, choose **Never** if available. Disable Low Power Mode if it prevents that setting or screen wake lock. Managed-device policies may restrict these choices.
3. The display requests the **Screen Wake Lock API** where supported, tries again when visible, and retries when you tap the screen. There is deliberately no visible wake-lock button. Browser support, Low Power Mode, permissions, and OS rules vary: **browser code cannot guarantee an iPad never sleeps**. Set Auto-Lock yourself and rehearse on the actual iPad.
4. For a more immersive view, use Safari **Share → Add to Home Screen**, then launch the icon. The app includes a web app manifest and Apple standalone metadata. iPadOS decides whether system chrome is hidden. No offline-caching service worker is used: each load fetches the current app and timer state.
5. Optionally enable **Settings → Accessibility → Guided Access**, configure a passcode, open the display, and triple-click the top/home button to start a session. In Guided Access options, set **Display Auto-Lock → Never** where available. Guided Access helps prevent accidental app switching; verify its sleep settings separately. Keep the passcode available to your crew.
6. Keep Safari/the home-screen app in the foreground. A blank black screen on first load means the app has not received timer state yet; check `/health`, internet access, and the controller's viewer count. After state is received, a disconnected display continues locally from its last deadline. It cannot receive later pause/reset/presenter changes until reconnected.

## Timing and network behavior

The server owns timer state and epoch deadlines. It never decrements a counter every second. Clients render remaining time using the deadline and an estimate of server time, using timestamp round trips to account for device clock differences and a monotonic browser clock between syncs. Sync requests run every 10 seconds; the server pings sockets every 15 seconds to remove dead viewers. The same deadline continues to measure overtime without a server tick or an expiration timeout. Before zero, remaining time rounds up (`90:00`, `89:59`, …); at zero the digits turn red, then elapsed full seconds count up (`00:00`, `00:01`, …). Overtime shows digits only, with no minus sign, label, or extra display elements. Pausing stores signed remaining time, and resuming restores the correct deadline. Old stopped-at-zero states from earlier versions migrate to paused zero and require manual Resume.

Clients reconnect with bounded exponential backoff and jitter, restore state after refresh, and resynchronize after visibility/network changes. Each reconnected viewer receives the current authoritative deadline rather than starting a timer. If a browser is suspended, it reconciles on returning to the foreground. Timing during an outage reflects only the last known server state. Internet latency and device/browser scheduling mean this is not a frame-accurate broadcast timecode system.

## Security

The display is public/read-only; anyone with the URL can view the countdown. It receives no rundown names or admin credentials. Display sockets reject commands even if the same browser also has an admin cookie. Controller WebSockets require a valid server-stored session cookie on upgrade and again on every command. Production HTTP and WebSocket requests check the exact configured origin to prevent cross-site commands. Login is rate limited, input is validated with Zod, payload sizes and WebSocket message rates are bounded, and Helmet supplies response headers/CSP. Credentials are supplied only to the backend. There are no credentials in query strings.

Use HTTPS/WSS in production. Changing `SESSION_SECRET` invalidates all logins; changing `ADMIN_PASSWORD` prevents new logins with the old password, but does not revoke existing 24-hour sessions by itself. Rotate `SESSION_SECRET` too if revoking access. Rotate secrets outside critical show moments. The database contains rundown details and hashed session tokens; restrict volume/backup access.

## Local development

Requires Node **24.x** (native `node:sqlite`).

```sh
npm ci
cp .env.example .env
# Edit ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET. Leave PUBLIC_URL commented for local HTTP.
npm run build
npm start
# http://localhost:3000/controller and /display
```

For development, run `npm run dev` and `npm run dev:ui` in separate terminals; open Vite's URL (usually port 5173). Vite proxies `/api` and `/ws` to the backend. Do not set `PUBLIC_URL` for this local two-server workflow. `.env` is loaded by the backend only; the frontend gets no secrets. Production uses one service and same-origin paths with no localhost dependency.

```sh
npm test                  # domain + real HTTP/WebSocket + SQLite restart tests
npm run build             # strict TypeScript check and production builds
npx playwright install --with-deps chromium webkit
npm run test:e2e           # browser checks, including landscape iPad-sized display, Chromium + WebKit
npm run format:check
```

Browser tests start their own server on port 3000 with disposable test credentials and use `data/browser-test-*` (ignored by Git). The browser suite checks offline local ticking, reconnect, refresh, all controls needed for the main flow, red overtime, 15-minute preset, landscape fitting, and mobile layout. Integration tests cover all ten requested scenarios, plus auth revocation, stale/replayed commands, input validation, login throttling, and rundown operations. CI runs these checks on pushes and pull requests.

### Live-device smoke checks

On a laptop and landscape iPad using different networks: log in, prepare 90 minutes, Show prepared paused, start, pause/resume, add five minutes, reload the iPad, and disconnect/reconnect Wi-Fi. While LIVE is running, prepare 30 minutes, edit/delete its source agenda entry, and select a different presenter; verify the LIVE deadline is unchanged. Then explicitly publish the prepared timer paused and verify it stays ready until Start. Temporarily load a short duration and verify red `00:00` followed by increasing overtime. Redeploy once before the event and verify the same deadline and rundown return. Test Auto-Lock and Guided Access for longer than the device's normal sleep interval. Automated browser tests cannot verify the physical iPad's sleep settings.
