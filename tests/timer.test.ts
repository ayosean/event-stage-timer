import { commandSchema } from "../shared/commands.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import {
  formatTime,
  initialState,
  reduce,
  remaining,
} from "../shared/timer.js";
const password = "test-only-password-1234",
  secret = "test-only-session-secret-at-least-32-characters";
async function fixture(
  overrides: { username?: string; password?: string } = {},
) {
  let time = 1_800_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), "stage-timer-"));
  const config = {
    password,
    secret,
    dbPath: join(dir, "timer.sqlite"),
    now: () => time,
    ...overrides,
  };
  let service = createApp(config);
  const listen = async () => {
    await new Promise<void>((resolve) =>
      service.server.listen(0, "127.0.0.1", resolve),
    );
    const address = service.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await listen();
  const login = async () => {
    const r = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({
        username: config.username ?? "admin",
        password: config.password,
      }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0];
  };
  const open = async (role: "controller" | "display", cookie?: string) => {
    const socket = new WebSocket(base.replace("http", "ws") + "/ws/" + role, {
      headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const queue: any[] = [];
    const waiting: ((value: any) => void)[] = [];
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiting.length) waiting.shift()!(msg);
      else queue.push(msg);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return {
      socket,
      async next(type: string): Promise<any> {
        const end = Date.now() + 3000;
        while (Date.now() < end) {
          const msg = queue.length
            ? queue.shift()
            : await new Promise<any>((resolve, reject) => {
                const callback = (v: any) => {
                  clearTimeout(timeout);
                  resolve(v);
                };
                const timeout = setTimeout(() => {
                  const i = waiting.indexOf(callback);
                  if (i >= 0) waiting.splice(i, 1);
                  reject(Error("Timed out waiting for " + type));
                }, 3000);
                waiting.push(callback);
              });
          if (msg.type === type) return msg;
        }
        throw Error("Missing " + type);
      },
    };
  };
  let controller: Awaited<ReturnType<typeof open>> | undefined;
  const command = async (command: unknown) => {
    controller ??= await open("controller", await login());
    controller.socket.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: service.getState().revision,
        command,
      }),
    );
    await controller.next("ack");
    return service.getState();
  };
  return {
    get service() {
      return service;
    },
    get base() {
      return base;
    },
    setTime: (t: number) => {
      time = t;
    },
    advance: (ms: number) => {
      time += ms;
    },
    get now() {
      return time;
    },
    command,
    open,
    login,
    async restart() {
      await service.close();
      controller = undefined;
      service = createApp(config);
      base = await listen();
    },
    async close() {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("starting a 90-minute timer uses an authoritative deadline", async () => {
  const f = await fixture();
  try {
    const s = await f.command({ type: "start" });
    assert.equal(s.timer.deadline, f.now + 90 * 60000);
    assert.equal(s.timer.status, "running");
  } finally {
    await f.close();
  }
});
test("pause and resume preserve precise remaining time", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "start" });
    f.advance(12345);
    let s = await f.command({ type: "pause" });
    assert.equal(s.timer.remainingMs, 5400000 - 12345);
    f.advance(300000);
    s = await f.command({ type: "start" });
    assert.equal(s.timer.deadline, f.now + 5400000 - 12345);
  } finally {
    await f.close();
  }
});
test("add five minutes while running extends deadline without restarting", async () => {
  const f = await fixture();
  try {
    const first = await f.command({ type: "start" });
    f.advance(15000);
    const s = await f.command({ type: "adjust", deltaMs: 300000 });
    assert.equal(s.timer.deadline, first.timer.deadline! + 300000);
    assert.equal(s.timer.startedAt, first.timer.startedAt);
    assert.equal(s.timer.status, "running");
  } finally {
    await f.close();
  }
});
test("30-minute preset, custom duration, and reset always remain ready", async () => {
  const f = await fixture();
  try {
    for (const cmd of [
      { type: "setDuration", durationMs: 1800000 },
      { type: "setDuration", durationMs: 125000 },
      { type: "reset" },
    ]) {
      await f.command({ type: "start" });
      const s = await f.command(cmd);
      assert.equal(s.timer.status, "ready");
      assert.equal(s.timer.deadline, null);
      assert.equal(s.timer.remainingMs, s.timer.durationMs);
    }
  } finally {
    await f.close();
  }
});
test("next, previous, and direct session selection never auto-start", async () => {
  const f = await fixture();
  try {
    await f.command({
      type: "add",
      name: "Second presenter",
      durationMs: 1800000,
    });
    const first = f.service.getState().selectedId;
    for (const cmd of [
      { type: "step", direction: 1 },
      { type: "step", direction: -1 },
      { type: "select", id: first },
    ]) {
      await f.command({ type: "start" });
      const s = await f.command(cmd);
      assert.equal(s.timer.status, "ready");
      assert.equal(s.timer.deadline, null);
    }
  } finally {
    await f.close();
  }
});
test("viewer refresh receives the running deadline and no session data", async () => {
  const f = await fixture();
  try {
    const started = await f.command({ type: "start" });
    let v = await f.open("display");
    const first = await v.next("state");
    v.socket.terminate();
    f.advance(15000);
    v = await f.open("display");
    const fresh = await v.next("state");
    assert.equal(first.timer.deadline, started.timer.deadline);
    assert.equal(fresh.timer.deadline, started.timer.deadline);
    assert.equal(fresh.timer.status, "running");
    assert.equal(fresh.sessions, undefined);
    assert.equal(remaining(fresh.timer, fresh.serverNow), 5385000);
  } finally {
    await f.close();
  }
});
test("reconnecting after interruption synchronizes changes made while offline", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "start" });
    const v = await f.open("display");
    await v.next("state");
    v.socket.terminate();
    await f.command({ type: "adjust", deltaMs: 300000 });
    f.advance(20000);
    const reconnected = await f.open("display");
    const s = await reconnected.next("state");
    assert.equal(s.timer.deadline, f.service.getState().timer.deadline);
    assert.equal(remaining(s.timer, s.serverNow), 5680000);
  } finally {
    await f.close();
  }
});
test("SQLite recovers rundown, selected session and running deadline after server restart", async () => {
  const f = await fixture();
  try {
    await f.command({
      type: "add",
      name: "Closing keynote",
      durationMs: 1800000,
    });
    await f.command({ type: "step", direction: 1 });
    const before = await f.command({ type: "start" });
    f.advance(45000);
    await f.restart();
    const after = f.service.getState();
    assert.deepEqual(after, before);
    assert.equal(remaining(after.timer, f.now), 1755000);
    const viewer = await f.open("display");
    assert.equal(
      (await viewer.next("state")).timer.deadline,
      before.timer.deadline,
    );
  } finally {
    await f.close();
  }
});
test("paused state and authentication survive restart; logout revokes active controllers", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "start" });
    f.advance(3000);
    const paused = await f.command({ type: "pause" });
    const cookie = await f.login();
    await f.restart();
    assert.deepEqual(f.service.getState(), paused);
    const controller = await f.open("controller", cookie);
    await controller.next("state");
    const closed = new Promise<number>((resolve) =>
      controller.socket.once("close", resolve),
    );
    const response = await fetch(f.base + "/api/logout", {
      method: "POST",
      headers: { Origin: f.base, Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(await closed, 4001);
  } finally {
    await f.close();
  }
});
test("unauthorized controller connections, cross-origin requests and viewer commands are rejected", async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { Origin: f.base },
      { Origin: "https://evil.example", Cookie: await f.login() },
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          f.base.replace("http", "ws") + "/ws/controller",
          { headers },
        );
        socket.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode!);
          res.resume();
          socket.terminate();
        });
        socket.on("error", () => {});
        socket.on("open", () => reject(Error("Unexpected authorization")));
      });
      assert.ok(status === 401 || status === 403);
    }
    const before = f.service.getState();
    const v = await f.open("display", await f.login());
    await v.next("state");
    v.socket.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: before.revision,
        command: { type: "start" },
      }),
    );
    assert.match((await v.next("error")).error, /Unauthorized/);
    assert.deepEqual(f.service.getState(), before);
    const bad = await fetch(f.base + "/api/login", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password }),
    });
    assert.equal(bad.status, 403);
  } finally {
    await f.close();
  }
});
test("expiration displays exactly 00:00 and persists after restart", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setDuration", durationMs: 1000 });
    await f.command({ type: "start" });
    f.advance(1001);
    const s = f.service.getState();
    assert.equal(s.timer.status, "expired");
    assert.equal(formatTime(remaining(s.timer, f.now)), "00:00");
    await f.restart();
    assert.equal(f.service.getState().timer.remainingMs, 0);
    assert.equal(f.service.getState().timer.status, "expired");
    assert.equal(formatTime(-10000), "00:00");
  } finally {
    await f.close();
  }
});
test("invalid input, stale commands and duplicate command replays cannot change the timer", async () => {
  const f = await fixture();
  try {
    assert.equal(
      commandSchema.safeParse({ type: "setDuration", durationMs: -1 }).success,
      false,
    );
    assert.equal(
      commandSchema.safeParse({ type: "add", name: " ", durationMs: 1800000 })
        .success,
      false,
    );
    const c = await f.open("controller", await f.login());
    const snapshot = await c.next("state");
    const cmd = {
      type: "command",
      id: crypto.randomUUID(),
      revision: snapshot.revision,
      command: { type: "adjust", deltaMs: 300000 },
    };
    c.socket.send(JSON.stringify(cmd));
    await c.next("ack");
    const first = f.service.getState();
    c.socket.send(JSON.stringify(cmd));
    assert.match((await c.next("error")).error, /State changed/);
    assert.deepEqual(f.service.getState(), first);
  } finally {
    await f.close();
  }
});
test("session edit, duplicate, reorder and delete preserve a valid selection", () => {
  let s = initialState();
  const id = s.selectedId;
  s = reduce(s, { type: "duplicate", id }, 0);
  const copy = s.sessions[1].id;
  s = reduce(s, { type: "move", id: copy, direction: -1 }, 0);
  assert.equal(s.sessions[0].id, copy);
  s = reduce(s, { type: "start" }, 0);
  s = reduce(
    s,
    { type: "update", id, name: "New title", durationMs: 60000 },
    1,
  );
  assert.equal(s.timer.status, "ready");
  s = reduce(s, { type: "delete", id }, 2);
  assert.equal(s.selectedId, copy);
  assert.equal(s.timer.status, "ready");
  assert.throws(
    () => reduce(s, { type: "delete", id: copy }, 3),
    /at least one/,
  );
});
test("login throttling and invalid passwords are rejected without issuing cookies", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 11; i++) {
      const r = await fetch(f.base + "/api/login", {
        method: "POST",
        headers: { Origin: f.base, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong" }),
      });
      assert.equal(r.status, i < 10 ? 401 : 429);
      assert.equal(r.headers.get("set-cookie"), null);
    }
  } finally {
    await f.close();
  }
});

test("a deadline that passes while the server is down recovers expired", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setDuration", durationMs: 1000 });
    await f.command({ type: "start" });
    f.advance(5000);
    await f.restart();
    const state = f.service.getState();
    assert.equal(state.timer.status, "expired");
    assert.equal(formatTime(state.timer.remainingMs), "00:00");
  } finally {
    await f.close();
  }
});

test("configured username and password are both required for login", async () => {
  const f = await fixture({
    username: "event-crew",
    password: "short-test-password",
  });
  try {
    for (const [username, password, status] of [
      ["wrong-user", "short-test-password", 401],
      ["event-crew", "wrong-password", 401],
      ["event-crew", "short-test-password", 200],
      ["", "short-test-password", 401],
    ] as const) {
      const response = await fetch(f.base + "/api/login", {
        method: "POST",
        headers: { Origin: f.base, "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, status);
      assert.equal(!!response.headers.get("set-cookie"), status === 200);
    }
  } finally {
    await f.close();
  }
});
