import { commandSchema } from "../shared/commands.js";
import express from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { expire, reduce, type State } from "../shared/timer.js";
import { Store } from "./store.js";
export interface Config {
  username?: string;
  password: string;
  secret: string;
  dbPath: string;
  publicUrl?: string;
  production?: boolean;
  now?: () => number;
}
export function createApp(config: Config) {
  const now = config.now ?? Date.now;
  const store = new Store(config.dbPath);
  let state = store.load();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "connect-src": ["'self'"],
          "upgrade-insecure-requests": config.production ? [] : null,
        },
      },
      strictTransportSecurity: config.production ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  const server = createServer(app);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
  });
  const clients = new Map<
    WebSocket,
    { role: "controller" | "display"; token: string; alive: boolean }
  >();
  const digest = (token: string) =>
    createHash("sha256").update(config.secret).update(token).digest("hex");
  const cookieName = config.production ? "__Host-stage_admin" : "stage_admin";
  const passwordHash = scryptSync(config.password, config.secret, 32);
  const cookieToken = (cookie: string | undefined) => {
    const item = cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + "="));
    return item?.slice(cookieName.length + 1) ?? "";
  };
  const authorized = (token: string) => {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const row = store.db
      .prepare("SELECT expires FROM auth WHERE token=?")
      .get(digest(token)) as { expires: number } | undefined;
    return !!row && row.expires > now();
  };
  const originOK = (origin: string | undefined, host: string | undefined) =>
    !!origin && origin === (config.publicUrl ?? `http://${host}`);
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_req, res) => {
    try {
      store.db.prepare("SELECT 1").get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.get("/api/auth", (req, res) =>
    res.json({ authenticated: authorized(cookieToken(req.headers.cookie)) }),
  );
  const attempts = new Map<string, { count: number; until: number }>();
  app.post("/api/login", (req, res) => {
    if (!originOK(req.headers.origin, req.headers.host)) {
      res.sendStatus(403);
      return;
    }
    const ip = req.ip ?? "unknown";
    const current = attempts.get(ip);
    const attempt =
      current && current.until > now()
        ? current
        : { count: 0, until: now() + 15 * 60000 };
    if (attempt.count >= 10) {
      res.setHeader("Retry-After", Math.ceil((attempt.until - now()) / 1000));
      res
        .status(429)
        .json({ error: "Too many attempts. Try again in 15 minutes." });
      return;
    }
    attempt.count++;
    attempts.set(ip, attempt);
    const parsed = z
      .object({
        username: z.string().min(1).max(80),
        password: z.string().min(1).max(1024),
      })
      .safeParse(req.body);
    if (
      !parsed.success ||
      parsed.data.username !== (config.username ?? "admin") ||
      !timingSafeEqual(
        passwordHash,
        scryptSync(parsed.data.password, config.secret, 32),
      )
    ) {
      res.status(401).json({ error: "Incorrect username or password." });
      return;
    }
    attempts.delete(ip);
    const token = randomBytes(32).toString("hex");
    store.db.prepare("DELETE FROM auth WHERE expires <= ?").run(now());
    store.db
      .prepare("INSERT INTO auth VALUES (?,?)")
      .run(digest(token), now() + 24 * 3600000);
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: !!config.production,
      sameSite: "strict",
      path: "/",
      maxAge: 24 * 3600000,
    });
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    if (!originOK(req.headers.origin, req.headers.host)) {
      res.sendStatus(403);
      return;
    }
    const token = cookieToken(req.headers.cookie);
    store.db.prepare("DELETE FROM auth WHERE token=?").run(digest(token));
    for (const [ws, client] of clients)
      if (client.role === "controller" && client.token === token)
        ws.close(4001, "Signed out");
    res.clearCookie(cookieName, {
      path: "/",
      secure: !!config.production,
      sameSite: "strict",
      httpOnly: true,
    });
    res.json({ ok: true });
  });
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function normalize() {
    const next = expire(state, now());
    if (next !== state) {
      store.save(next);
      state = next;
    }
  }
  function snapshot(role: "controller" | "display", commandId?: string) {
    normalize();
    return {
      type: "state",
      revision: state.revision,
      timer: state.timer,
      serverNow: now(),
      ...(role === "controller"
        ? {
            sessions: state.sessions,
            selectedId: state.selectedId,
            viewers: [...clients.values()].filter((c) => c.role === "display")
              .length,
          }
        : {}),
      commandId,
    };
  }
  function broadcast() {
    for (const [ws, c] of clients)
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify(snapshot(c.role)));
  }
  function schedule() {
    clearTimeout(expiry);
    if (state.timer.status === "running" && state.timer.deadline !== null) {
      expiry = setTimeout(
        () => {
          normalize();
          broadcast();
          schedule();
        },
        Math.min(2147483647, Math.max(1, state.timer.deadline - now())),
      );
      expiry.unref();
    }
  }
  normalize();
  schedule();
  server.on("upgrade", (req, socket, head) => {
    const path = req.url;
    const role =
      path === "/ws/controller"
        ? "controller"
        : path === "/ws/display"
          ? "display"
          : null;
    if (!role || !originOK(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = cookieToken(req.headers.cookie);
    if (role === "controller" && !authorized(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(ws, { role, token, alive: true });
      broadcast();
      ws.on("error", () => {});
      ws.on("pong", () => {
        const c = clients.get(ws);
        if (c) c.alive = true;
      });
      let rateStart = now(),
        rateCount = 0;
      ws.on("message", (data) => {
        const send = (value: unknown) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
        };
        try {
          if (now() - rateStart > 1000) {
            rateStart = now();
            rateCount = 0;
          }
          if (++rateCount > 30) {
            ws.close(1008, "Too many messages");
            return;
          }
          const msg = JSON.parse(data.toString());
          if (
            msg.type === "sync" &&
            typeof msg.sent === "number" &&
            Number.isFinite(msg.sent)
          ) {
            send({ type: "sync", sent: msg.sent, serverNow: now() });
            send(snapshot(role));
            return;
          }
          if (role !== "controller" || !authorized(token)) {
            send({ type: "error", error: "Unauthorized timer command." });
            if (role === "controller") ws.close(4001, "Login expired");
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
          normalize();
          if (parsed.data.revision !== state.revision) {
            send({
              type: "error",
              error: "State changed. Review the timer and try again.",
            });
            send(snapshot(role));
            return;
          }
          const next = reduce(state, parsed.data.command, now());
          store.save(next);
          state = next;
          schedule();
          broadcast();
          send({ type: "ack", id: parsed.data.id });
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Command failed.",
          });
        }
      });
      ws.on("close", () => {
        clients.delete(ws);
        broadcast();
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const [ws, c] of clients) {
      if (!c.alive) {
        ws.terminate();
        continue;
      }
      if (c.role === "controller" && !authorized(c.token)) {
        ws.close(4001, "Login expired");
        continue;
      }
      c.alive = false;
      ws.ping();
    }
    for (const [ip, a] of attempts) if (a.until <= now()) attempts.delete(ip);
  }, 15000);
  heartbeat.unref();
  const root = resolve("dist/client");
  app.use(express.static(root, { index: false, maxAge: "1h" }));
  app.get(["/", "/controller", "/display"], (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.path === "/") {
      res.redirect("/controller");
      return;
    }
    res.sendFile(resolve(root, "index.html"));
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({
        error:
          error instanceof SyntaxError ? "Invalid JSON." : "Request failed.",
      });
    },
  );
  return {
    app,
    server,
    store,
    getState: () => {
      normalize();
      return structuredClone(state) as State;
    },
    close: async () => {
      clearTimeout(expiry);
      clearInterval(heartbeat);
      for (const ws of clients.keys()) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      store.close();
    },
  };
}
