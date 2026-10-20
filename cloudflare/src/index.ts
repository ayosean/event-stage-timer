// Cloudflare Workers port of server/app.ts for the backup deployment.
// One Durable Object holds the timer state, logins, and WebSockets, so the
// controller and displays behave exactly as they do on Railway.
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { commandSchema } from "../../shared/commands.js";
import {
  initialState,
  normalizeState,
  reduce,
  type State,
} from "../../shared/timer.js";
export interface Env {
  TIMER: DurableObjectNamespace<TimerRoom>;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  PUBLIC_URL?: string;
}
type Role = "controller" | "display";
interface Attachment {
  role: Role;
  token: string;
  lastSeen: number;
  rateStart: number;
  rateCount: number;
}
// Clients sync every 10 seconds; a socket silent for longer than this is gone.
const STALE_MS = 35000;
const OPEN = 1;
const securityHeaders: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline';connect-src 'self';upgrade-insecure-requests",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-XSS-Protection": "0",
};
// Mirrors helmet in server/app.ts, which drops the HTTPS-only parts locally.
function secure(response: Response, url: URL, noStore = false) {
  if (response.status === 101) return response;
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(securityHeaders)) res.headers.set(k, v);
  if (url.protocol !== "https:") {
    res.headers.delete("Strict-Transport-Security");
    res.headers.set(
      "Content-Security-Policy",
      securityHeaders["Content-Security-Policy"].replace(
        ";upgrade-insecure-requests",
        "",
      ),
    );
  }
  if (noStore) res.headers.set("Cache-Control", "no-store");
  return res;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      path === "/health" ||
      path.startsWith("/api/") ||
      path.startsWith("/ws/")
    )
      return secure(
        await env.TIMER.get(env.TIMER.idFromName("main")).fetch(request),
        url,
        path.startsWith("/api/"),
      );
    if (path === "/")
      return secure(
        Response.redirect(url.origin + "/controller", 302),
        url,
        true,
      );
    if (path === "/controller" || path === "/display")
      return secure(
        await env.ASSETS.fetch(
          new Request(new URL("/index.html", url), request),
        ),
        url,
        true,
      );
    return secure(await env.ASSETS.fetch(request), url);
  },
} satisfies ExportedHandler<Env>;
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, { status, headers });
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export class TimerRoom extends DurableObject<Env> {
  sql: SqlStorage;
  state: State;
  attempts = new Map<string, { count: number; until: number }>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS auth (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    );
    const row = this.sql
      .exec<{ body: string }>("SELECT body FROM state WHERE id=1")
      .toArray()[0];
    this.state = row ? JSON.parse(row.body) : initialState();
    if (!row) this.save(this.state);
  }
  save(state: State) {
    this.sql.exec(
      "INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      JSON.stringify(state),
    );
  }
  normalize() {
    const next = normalizeState(this.state, Date.now());
    if (next !== this.state) {
      this.save(next);
      this.state = next;
    }
  }
  config() {
    const { ADMIN_PASSWORD: password, SESSION_SECRET: secret } = this.env;
    const username = this.env.ADMIN_USERNAME || "admin";
    if (
      !password ||
      password.length > 1024 ||
      !secret ||
      secret.length < 32 ||
      username.length > 80
    )
      return null;
    return { username, password, secret };
  }
  async digest(token: string, secret: string) {
    return hex(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secret + token),
      ),
    );
  }
  async authorized(token: string, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const row = this.sql
      .exec<{ expires: number }>(
        "SELECT expires FROM auth WHERE token=?",
        await this.digest(token, secret),
      )
      .toArray()[0];
    return !!row && row.expires > Date.now();
  }
  async passwordMatches(given: string, expected: string, secret: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sign = (v: string) =>
      crypto.subtle.sign("HMAC", key, new TextEncoder().encode(v));
    const [a, b] = await Promise.all([sign(given), sign(expected)]);
    return crypto.subtle.timingSafeEqual(a, b);
  }
  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === OPEN);
  }
  snapshot(role: Role, commandId?: string) {
    this.normalize();
    const state = this.state;
    return {
      type: "state",
      displayMode: state.displayMode,
      revision: state.revision,
      timer: state.timer,
      serverNow: Date.now(),
      ...(role === "controller"
        ? {
            sessions: state.sessions,
            selectedId: state.selectedId,
            viewers: this.sockets().filter(
              (ws) =>
                (ws.deserializeAttachment() as Attachment).role === "display",
            ).length,
          }
        : {}),
      commandId,
    };
  }
  prune() {
    for (const ws of this.sockets())
      if (
        Date.now() - (ws.deserializeAttachment() as Attachment).lastSeen >
        STALE_MS
      )
        try {
          ws.close(1001, "Connection timed out");
        } catch {}
  }
  broadcast() {
    this.prune();
    for (const ws of this.sockets())
      try {
        ws.send(
          JSON.stringify(
            this.snapshot((ws.deserializeAttachment() as Attachment).role),
          ),
        );
      } catch {}
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = this.config();
    if (path === "/health") {
      try {
        this.sql.exec("SELECT 1");
        return config
          ? json({ ok: true })
          : json({ ok: false, error: "Login secrets are not set." }, 503);
      } catch {
        return json({ ok: false }, 503);
      }
    }
    if (!config)
      return json(
        {
          error:
            "Set ADMIN_PASSWORD (1–1024 characters) and SESSION_SECRET (32+ characters) as Worker secrets.",
        },
        500,
      );
    const { secret } = config;
    const production = url.protocol === "https:";
    const cookieName = production ? "__Host-stage_admin" : "stage_admin";
    const cookieToken =
      request.headers
        .get("Cookie")
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1) ?? "";
    const expectedOrigin = this.env.PUBLIC_URL
      ? new URL(this.env.PUBLIC_URL).origin
      : url.origin;
    const originOK = request.headers.get("Origin") === expectedOrigin;
    const cookieAttrs = `Path=/; HttpOnly;${production ? " Secure;" : ""} SameSite=Strict`;
    if (path === "/api/auth" && request.method === "GET")
      return json({
        authenticated: await this.authorized(cookieToken, secret),
      });
    if (path === "/api/login" && request.method === "POST") {
      if (!originOK) return new Response("Forbidden", { status: 403 });
      const now = Date.now();
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      for (const [key, a] of this.attempts)
        if (a.until <= now) this.attempts.delete(key);
      const current = this.attempts.get(ip);
      const attempt =
        current && current.until > now
          ? current
          : { count: 0, until: now + 15 * 60000 };
      if (attempt.count >= 10)
        return json(
          { error: "Too many attempts. Try again in 15 minutes." },
          429,
          {
            "Retry-After": String(Math.ceil((attempt.until - now) / 1000)),
          },
        );
      attempt.count++;
      this.attempts.set(ip, attempt);
      const text = await request.text();
      if (text.length > 16384) return json({ error: "Request failed." }, 413);
      let body: unknown;
      if (request.headers.get("Content-Type")?.includes("json"))
        try {
          body = JSON.parse(text);
        } catch {
          return json({ error: "Invalid JSON." }, 400);
        }
      const parsed = z
        .object({
          username: z.string().min(1).max(80),
          password: z.string().min(1).max(1024),
        })
        .safeParse(body);
      if (
        !parsed.success ||
        parsed.data.username !== config.username ||
        !(await this.passwordMatches(
          parsed.data.password,
          config.password,
          secret,
        ))
      )
        return json({ error: "Incorrect username or password." }, 401);
      this.attempts.delete(ip);
      const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
      this.sql.exec("DELETE FROM auth WHERE expires <= ?", now);
      this.sql.exec(
        "INSERT INTO auth VALUES (?,?)",
        await this.digest(token, secret),
        now + 24 * 3600000,
      );
      return json({ ok: true }, 200, {
        "Set-Cookie": `${cookieName}=${token}; Max-Age=86400; ${cookieAttrs}`,
      });
    }
    if (path === "/api/logout" && request.method === "POST") {
      if (!originOK) return new Response("Forbidden", { status: 403 });
      this.sql.exec(
        "DELETE FROM auth WHERE token=?",
        await this.digest(cookieToken, secret),
      );
      for (const ws of this.sockets()) {
        const c = ws.deserializeAttachment() as Attachment;
        if (c.role === "controller" && c.token === cookieToken)
          ws.close(4001, "Signed out");
      }
      return json({ ok: true }, 200, {
        "Set-Cookie": `${cookieName}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieAttrs}`,
      });
    }
    const role =
      path === "/ws/controller"
        ? "controller"
        : path === "/ws/display"
          ? "display"
          : null;
    if (role) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      if (!originOK) return new Response("Forbidden", { status: 403 });
      if (
        role === "controller" &&
        !(await this.authorized(cookieToken, secret))
      )
        return new Response("Unauthorized", { status: 401 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        role,
        token: cookieToken,
        lastSeen: Date.now(),
        rateStart: Date.now(),
        rateCount: 0,
      } satisfies Attachment);
      this.broadcast();
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "Not found." }, 404);
  }
  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const send = (value: unknown) => {
      if (ws.readyState === OPEN) ws.send(JSON.stringify(value));
    };
    const c = ws.deserializeAttachment() as Attachment;
    const now = Date.now();
    c.lastSeen = now;
    if (now - c.rateStart > 1000) {
      c.rateStart = now;
      c.rateCount = 0;
    }
    c.rateCount++;
    ws.serializeAttachment(c);
    if (c.rateCount > 30) {
      ws.close(1008, "Too many messages");
      return;
    }
    const config = this.config();
    try {
      if (!config) throw new Error("Server is not configured.");
      const msg = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      );
      if (
        msg.type === "sync" &&
        typeof msg.sent === "number" &&
        Number.isFinite(msg.sent)
      ) {
        // Railway checks login expiry on a heartbeat; sync arrives every 10 s.
        if (
          c.role === "controller" &&
          !(await this.authorized(c.token, config.secret))
        ) {
          ws.close(4001, "Login expired");
          return;
        }
        send({ type: "sync", sent: msg.sent, serverNow: Date.now() });
        send(this.snapshot(c.role));
        this.prune();
        return;
      }
      if (
        c.role !== "controller" ||
        !(await this.authorized(c.token, config.secret))
      ) {
        send({ type: "error", error: "Unauthorized timer command." });
        if (c.role === "controller") ws.close(4001, "Login expired");
        return;
      }
      const parsed = z
        .object({
          type: z.literal("command"),
          id: z.string().uuid(),
          revision: z.number().int().nonnegative(),
          command: commandSchema,
        })
        .safeParse(msg);
      if (!parsed.success) {
        send({ type: "error", error: "Invalid command." });
        return;
      }
      this.normalize();
      if (parsed.data.revision !== this.state.revision) {
        send({
          type: "error",
          error: "State changed. Review the timer and try again.",
        });
        send(this.snapshot(c.role));
        return;
      }
      const next = reduce(this.state, parsed.data.command, Date.now());
      this.save(next);
      this.state = next;
      this.broadcast();
      send({ type: "ack", id: parsed.data.id });
    } catch (error) {
      send({
        type: "error",
        error: error instanceof Error ? error.message : "Command failed.",
      });
    }
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
    this.broadcast();
  }
  async webSocketError() {
    this.broadcast();
  }
}
