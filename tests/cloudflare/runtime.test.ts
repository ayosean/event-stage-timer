import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Miniflare,
  convertV4MiniflareOptions,
  type WebSocket,
} from "miniflare";
import type { Command } from "../../shared/timer";
const origin = "https://backup.test";
const objectName = "stage-timer-backup-v1";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-stage-timer-"));
  const options = convertV4MiniflareOptions({
    name: "stage-timer-test",
    modules: true,
    scriptPath: "dist/worker/worker.js",
    compatibilityDate: "2026-10-01",
    resourcePersistencePath: directory,
    bindings: {
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "test-only-password",
      SESSION_SECRET: "test-only-secret-at-least-32-characters",
    },
    durableObjects: { TIMER: { className: "StageTimer", useSQLite: true } },
    telemetry: { enabled: false },
  });
  let mf = new Miniflare(options);
  const sockets: WebSocket[] = [];
  let cookie = "";
  const request = (
    path: string,
    init: Parameters<Miniflare["dispatchFetch"]>[1] = {},
  ) =>
    mf.dispatchFetch(origin + path, {
      ...init,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  const login = async () => {
    const response = await request("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: "admin",
        password: "test-only-password",
      }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    assert.match(
      response.headers.get("Set-Cookie")!,
      /HttpOnly; Secure; SameSite=Strict/,
    );
  };
  const connect = async (role: "controller" | "display") => {
    const response = await request("/ws/" + role, {
      headers: { Upgrade: "websocket" },
    });
    assert.equal(response.status, 101);
    const socket = response.webSocket!;
    sockets.push(socket);
    // The inbox is intentionally buffered: broadcasts and ACKs may arrive
    // before a test starts waiting, just as they do on a fast real connection.
    type Message = { type: string; [key: string]: any };
    const inbox: Message[] = [];
    const waiters: (() => void)[] = [];
    socket.addEventListener("message", (event) => {
      inbox.push(JSON.parse(event.data as string));
      waiters.shift()?.();
    });
    socket.accept();
    const receive = async (type: string): Promise<Message> => {
      for (;;) {
        const index = inbox.findIndex((value) => value.type === type);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for " + type)),
            5000,
          );
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    };
    const sync = async () => {
      inbox.length = 0;
      socket.send(JSON.stringify({ type: "sync", sent: 123 }));
      await receive("sync");
      return receive("state");
    };
    const command = async (command: Command) => {
      const state = await sync();
      socket.send(
        JSON.stringify({
          type: "command",
          id: crypto.randomUUID(),
          revision: state.revision,
          command,
        }),
      );
      await receive("ack");
      return sync();
    };
    const state = await receive("state");
    return { socket, receive, sync, command, state };
  };
  return {
    request,
    login,
    connect,
    runtime: () => mf,
    cookie: () => cookie,
    restart: async () => {
      for (const socket of sockets) {
        try {
          socket.close(1000, "Restart test");
        } catch {}
      }
      sockets.length = 0;
      await mf.dispose();
      mf = new Miniflare(options);
    },
    close: async () => {
      for (const socket of sockets) {
        try {
          socket.close(1000);
        } catch {}
      }
      await mf.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Cloudflare: 90-minute start, pause/resume, running adjustments and ready presets", async () => {
  const f = await fixture();
  try {
    await f.login();
    const c = await f.connect("controller");
    assert.equal(c.state.timer.status, "ready");
    let state = await c.command({ type: "start" });
    assert.equal(state.timer.status, "running");
    assert.equal(state.timer.deadline - state.timer.startedAt, 5400000);
    const deadline = state.timer.deadline;
    state = await c.command({ type: "adjust", deltaMs: 300000 });
    assert.equal(state.timer.deadline, deadline + 300000);
    state = await c.command({ type: "adjust", deltaMs: -30000 });
    assert.equal(state.timer.deadline, deadline + 270000);
    state = await c.command({ type: "pause" });
    const paused = state.timer.remainingMs;
    assert.equal(state.timer.status, "paused");
    state = await c.command({ type: "start" });
    assert.equal(state.timer.deadline - state.timer.startedAt, paused);
    for (const minutes of [30, 15]) {
      state = await c.command({
        type: "setDuration",
        durationMs: minutes * 60000,
      });
      assert.equal(state.timer.status, "ready");
      assert.equal(state.timer.deadline, null);
      assert.equal(state.timer.remainingMs, minutes * 60000);
    }
    await c.command({
      type: "add",
      name: "Next presenter",
      durationMs: 4500000,
    });
    state = await c.command({ type: "step", direction: 1 });
    assert.equal(state.timer.status, "ready");
    assert.equal(state.timer.deadline, null);
  } finally {
    await f.close();
  }
});

test("Cloudflare: refresh/reconnect and a full runtime restart preserve deadline, rundown and login", async () => {
  const f = await fixture();
  try {
    await f.login();
    const c = await f.connect("controller");
    await c.command({
      type: "add",
      name: "Durable presenter",
      durationMs: 1800000,
    });
    const running = await c.command({ type: "start" });
    const viewer = await f.connect("display");
    assert.equal(viewer.state.timer.deadline, running.timer.deadline);
    assert.equal(viewer.state.sessions, undefined);
    viewer.socket.close(1000);
    const refreshed = await f.connect("display");
    assert.equal(refreshed.state.timer.deadline, running.timer.deadline);
    await f.restart();
    assert.deepEqual(await (await f.request("/api/auth")).json(), {
      authenticated: true,
    });
    const restored = await f.connect("controller");
    assert.equal(restored.state.timer.deadline, running.timer.deadline);
    assert.equal(restored.state.timer.status, "running");
    assert.deepEqual(restored.state.sessions, running.sessions);
    assert.equal(restored.state.selectedId, running.selectedId);
  } finally {
    await f.close();
  }
});

test("Cloudflare: hibernated sockets recover attachments, authorization, viewer count and timer state", async () => {
  const f = await fixture();
  try {
    await f.login();
    const c = await f.connect("controller");
    const v = await f.connect("display");
    const running = await c.command({ type: "start" });
    await f
      .runtime()
      .unsafeEvictDurableObject("stage-timer-test", "StageTimer", {
        name: objectName,
        webSockets: "hibernate",
      });
    const resumed = await c.sync();
    assert.equal(resumed.timer.deadline, running.timer.deadline);
    assert.equal(resumed.viewers, 1);
    const paused = await c.command({ type: "pause" });
    assert.equal(paused.timer.status, "paused");
    assert.equal((await v.sync()).timer.remainingMs, paused.timer.remainingMs);
  } finally {
    await f.close();
  }
});

test("Cloudflare: clock mode persists, and returning to countdown never auto-starts", async () => {
  const f = await fixture();
  try {
    await f.login();
    const c = await f.connect("controller");
    await c.command({ type: "start" });
    const clock = await c.command({ type: "setDisplayMode", mode: "clock" });
    assert.equal(clock.timer.status, "paused");
    await f.restart();
    const restored = await f.connect("controller");
    assert.equal(restored.state.displayMode, "clock");
    assert.equal(restored.state.timer.remainingMs, clock.timer.remainingMs);
    const countdown = await restored.command({
      type: "setDisplayMode",
      mode: "countdown",
    });
    assert.equal(countdown.timer.status, "paused");
  } finally {
    await f.close();
  }
});

test("Cloudflare: zero runs into overtime with the original deadline after restart", async () => {
  const f = await fixture();
  try {
    await f.login();
    const c = await f.connect("controller");
    await c.command({ type: "setDuration", durationMs: 1000 });
    const running = await c.command({ type: "start" });
    await f.restart();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const v = await f.connect("display");
    assert.equal(v.state.timer.deadline, running.timer.deadline);
    assert.equal(v.state.timer.status, "running");
    assert.ok(v.state.serverNow > v.state.timer.deadline);
  } finally {
    await f.close();
  }
});

test("Cloudflare: unauthorized, cross-origin, invalid, stale and read-only commands are rejected", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request("/ws/controller", { headers: { Upgrade: "websocket" } }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request("/ws/display", {
          headers: { Upgrade: "websocket", Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/login", {
          method: "POST",
          headers: { Origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
      403,
    );
    const v = await f.connect("display");
    v.socket.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: v.state.revision,
        command: { type: "start" },
      }),
    );
    assert.match((await v.receive("error")).error, /Unauthorized/);
    await f.login();
    const c = await f.connect("controller");
    c.socket.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: c.state.revision,
        command: { type: "setDuration", durationMs: -1 },
      }),
    );
    assert.match((await c.receive("error")).error, /Invalid/);
    const initial = await c.sync();
    await c.command({ type: "start" });
    c.socket.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: initial.revision,
        command: { type: "pause" },
      }),
    );
    assert.match((await c.receive("error")).error, /State changed/);
    await f.request("/api/logout", { method: "POST" });
    assert.deepEqual(await (await f.request("/api/auth")).json(), {
      authenticated: false,
    });
    assert.equal(
      (await f.request("/ws/controller", { headers: { Upgrade: "websocket" } }))
        .status,
      401,
    );
    assert.equal((await v.sync()).timer.status, "running");
  } finally {
    await f.close();
  }
});

test("Cloudflare: durable login throttling, size limits and security headers", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await f.request("/api/login", {
            method: "POST",
            body: JSON.stringify({ username: "admin", password: "wrong" }),
          })
        ).status,
        401,
      );
    await f.restart();
    const limited = await f.request("/api/login", {
      method: "POST",
      body: "{}",
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) > 0);
    const health = await f.request("/health");
    assert.equal(health.status, 200);
    assert.match(
      health.headers.get("Content-Security-Policy")!,
      /frame-ancestors 'none'/,
    );
    const oversized = await f.request("/api/login", {
      method: "POST",
      body: " ".repeat(17000),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await f.close();
  }
});
