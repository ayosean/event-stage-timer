import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { commandSchema } from "../shared/commands";
import {
  initialState,
  normalizeState,
  reduce,
  type State,
} from "../shared/timer";

interface Env {
  TIMER: DurableObjectNamespace<StageTimer>;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
}
type Role = "controller" | "display";
interface Client {
  role: Role;
  digest: string;
  rateStart: number;
  rateCount: number;
}
const encoder = new TextEncoder();
const cookieName = "__Host-stage_backup_admin";
const commandEnvelope = z.object({
  type: z.literal("command"),
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  command: commandSchema,
});
function json(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
function cookieToken(request: Request) {
  return (
    request.headers
      .get("Cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) ?? ""
  );
}
function cookie(token: string, seconds: number) {
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
}

// One named object owns the independent backup event. SQLite and socket
// attachments survive hibernation/redeployment; no per-second server tick.
export class StageTimer extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.storage.transactionSync(() => {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
      );
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS auth (token TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
      );
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS attempts (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)",
      );
      if (!this.sql.exec("SELECT id FROM state WHERE id=1").toArray().length)
        this.save(initialState());
    });
  }
  private save(state: State) {
    this.sql.exec(
      "INSERT INTO state(id, body) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      JSON.stringify(state),
    );
  }
  private load() {
    const row = this.sql
      .exec<{ body: string }>("SELECT body FROM state WHERE id=1")
      .one();
    const stored: State = JSON.parse(row.body);
    const state = normalizeState(stored, Date.now());
    if (state !== stored) this.save(state);
    return state;
  }
  private authorized(digest: string) {
    return !!this.sql
      .exec(
        "SELECT token FROM auth WHERE token=? AND expires>?",
        digest,
        Date.now(),
      )
      .toArray().length;
  }
  private async digest(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return "";
    const hash = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(this.env.SESSION_SECRET + token),
    );
    return Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  private snapshot(role: Role) {
    const state = this.load();
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
            viewers: this.ctx
              .getWebSockets("display")
              .filter((ws) => ws.readyState === 1).length,
          }
        : {}),
    };
  }
  private send(ws: WebSocket, data: unknown) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }
  private broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const client = ws.deserializeAttachment() as Client;
      if (client.role === "controller" && !this.authorized(client.digest)) {
        ws.close(4001, "Login expired");
        continue;
      }
      this.send(ws, this.snapshot(client.role));
    }
  }
  async fetch(request: Request): Promise<Response> {
    if (
      !this.env.ADMIN_PASSWORD ||
      !this.env.SESSION_SECRET ||
      this.env.SESSION_SECRET.length < 32
    )
      return json(
        {
          error:
            "Configure ADMIN_PASSWORD and SESSION_SECRET (32+ characters).",
        },
        503,
      );
    const url = new URL(request.url);
    const path = url.pathname;
    const sameOrigin = request.headers.get("Origin") === url.origin;
    if (path === "/health" && request.method === "GET") {
      this.sql.exec("SELECT 1");
      return json({ ok: true });
    }
    if (path === "/api/login" && request.method === "POST") {
      if (!sameOrigin) return json({ error: "Forbidden." }, 403);
      if (Number(request.headers.get("Content-Length")) > 16384)
        return json({ error: "Request too large." }, 413);
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const now = Date.now();
      this.sql.exec("DELETE FROM attempts WHERE until<=?", now);
      const attempt = this.sql
        .exec<{ count: number; until: number }>(
          "SELECT count, until FROM attempts WHERE ip=?",
          ip,
        )
        .toArray()[0];
      if (attempt && attempt.count >= 10)
        return json(
          { error: "Too many attempts. Try again in 15 minutes." },
          429,
          { "Retry-After": String(Math.ceil((attempt.until - now) / 1000)) },
        );
      this.sql.exec(
        "INSERT INTO attempts VALUES(?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count=count+1",
        ip,
        now + 900000,
      );
      // Bound streamed requests too: Content-Length is optional and untrusted.
      let body = "";
      const reader = request.body?.getReader();
      let bytes = 0;
      const decoder = new TextDecoder();
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16384) {
            await reader.cancel();
            return json({ error: "Request too large." }, 413);
          }
          body += decoder.decode(value, { stream: true });
        }
      body += decoder.decode();
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return json({ error: "Invalid JSON." }, 400);
      }
      const parsed = z
        .object({
          username: z.string().min(1).max(80),
          password: z.string().min(1).max(1024),
        })
        .safeParse(data);
      if (!parsed.success)
        return json({ error: "Incorrect username or password." }, 401);
      // Web Crypto verifies a fixed-length HMAC in constant time. The password
      // lives only in Worker secrets, never in static assets or query strings.
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(this.env.SESSION_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(this.env.ADMIN_PASSWORD),
      );
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(parsed.data.password),
      );
      if (
        !valid ||
        parsed.data.username !== (this.env.ADMIN_USERNAME ?? "admin")
      )
        return json({ error: "Incorrect username or password." }, 401);
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      const digest = await this.digest(token);
      this.sql.exec("DELETE FROM auth WHERE expires<=?", Date.now());
      this.sql.exec(
        "INSERT INTO auth VALUES(?, ?)",
        digest,
        Date.now() + 86400000,
      );
      this.sql.exec("DELETE FROM attempts WHERE ip=?", ip);
      return json({ ok: true }, 200, { "Set-Cookie": cookie(token, 86400) });
    }
    const digest = await this.digest(cookieToken(request));
    if (path === "/api/auth" && request.method === "GET")
      return json({ authenticated: this.authorized(digest) });
    if (path === "/api/logout" && request.method === "POST") {
      if (!sameOrigin) return json({ error: "Forbidden." }, 403);
      this.sql.exec("DELETE FROM auth WHERE token=?", digest);
      for (const ws of this.ctx.getWebSockets("controller"))
        if ((ws.deserializeAttachment() as Client).digest === digest)
          ws.close(4001, "Signed out");
      return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (path === "/ws/controller" || path === "/ws/display") {
      if (!sameOrigin) return json({ error: "Forbidden." }, 403);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return json({ error: "WebSocket required." }, 426);
      const role: Role = path === "/ws/controller" ? "controller" : "display";
      if (role === "controller" && !this.authorized(digest))
        return json({ error: "Unauthorized." }, 401);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({
        role,
        digest,
        rateStart: Date.now(),
        rateCount: 0,
      } satisfies Client);
      this.ctx.acceptWebSocket(server, [role]);
      this.broadcast();
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: "Not found." }, 404);
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const client = ws.deserializeAttachment() as Client;
    if (client.role === "controller" && !this.authorized(client.digest)) {
      ws.close(4001, "Login expired");
      return;
    }
    if (typeof message !== "string") {
      ws.close(1003, "Text messages required");
      return;
    }
    if (encoder.encode(message).byteLength > 16384) {
      ws.close(1009, "Message too large");
      return;
    }
    if (Date.now() - client.rateStart >= 1000) {
      client.rateStart = Date.now();
      client.rateCount = 0;
    }
    client.rateCount++;
    ws.serializeAttachment(client);
    if (client.rateCount > 30) {
      ws.close(1008, "Too many messages");
      return;
    }
    try {
      const msg = JSON.parse(message);
      if (
        msg?.type === "sync" &&
        typeof msg.sent === "number" &&
        Number.isFinite(msg.sent)
      ) {
        this.send(ws, { type: "sync", sent: msg.sent, serverNow: Date.now() });
        this.send(ws, this.snapshot(client.role));
        return;
      }
      if (client.role !== "controller") {
        this.send(ws, { type: "error", error: "Unauthorized timer command." });
        return;
      }
      const parsed = commandEnvelope.safeParse(msg);
      if (!parsed.success) {
        this.send(ws, { type: "error", error: "Invalid command." });
        return;
      }
      const state = this.load();
      if (parsed.data.revision !== state.revision) {
        this.send(ws, {
          type: "error",
          error: "State changed. Review the timer and try again.",
        });
        this.send(ws, this.snapshot(client.role));
        return;
      }
      // Synchronous SQLite writes serialize commands. Cloudflare's output gate
      // holds sends until durable writes commit, before acknowledging success.
      this.save(reduce(state, parsed.data.command, Date.now()));
      this.broadcast();
      this.send(ws, { type: "ack", id: parsed.data.id });
    } catch (error) {
      this.send(ws, {
        type: "error",
        error: error instanceof Error ? error.message : "Command failed.",
      });
    }
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Browsers can disconnect without a close frame (1005/1006). Those
    // reserved observation codes must never be sent in a close frame.
    const replyCode =
      code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)
        ? code
        : 1000;
    ws.close(replyCode, reason);
    this.broadcast();
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection error");
    this.broadcast();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/ws/") ||
        url.pathname === "/health"
      ) {
        response = await env.TIMER.getByName("stage-timer-backup-v1").fetch(
          request,
        );
        if (response.status === 101) return response;
      } else if (url.pathname === "/") {
        response = Response.redirect(new URL("/controller", url).href, 302);
      } else {
        const page =
          url.pathname === "/controller" || url.pathname === "/display";
        if (page) url.pathname = "/index.html";
        response = await env.ASSETS.fetch(new Request(url, request));
        if (page) {
          response = new Response(response.body, response);
          response.headers.set("Cache-Control", "no-store");
        }
      }
    } catch {
      response = json({ error: "Service unavailable. Please reconnect." }, 503);
    }
    const result = new Response(response.body, response);
    result.headers.set("X-Content-Type-Options", "nosniff");
    result.headers.set("Referrer-Policy", "no-referrer");
    result.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    result.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    return result;
  },
} satisfies ExportedHandler<Env>;
