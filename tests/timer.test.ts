import { formatClockTime, DEFAULT_CLOCK_TIME_ZONE } from "../shared/clock.js";
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
  formatPacificTime,
  initialState,
  reduce,
  remaining,
  normalizeState,
  parseLiveTime,
} from "../shared/timer.js";
function takeAndStartState(
  state: ReturnType<typeof initialState>,
  now: number,
) {
  state = reduce(state, { type: "setDisplayMode", mode: "countdown" }, now);
  state = reduce(state, { type: "take" }, now);
  return reduce(state, { type: "start" }, now);
}
function takeClockState(state: ReturnType<typeof initialState>, now: number) {
  return reduce(
    reduce(state, { type: "setDisplayMode", mode: "clock" }, now),
    { type: "take" },
    now,
  );
}
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
    takeAndStart: async () => {
      await command({ type: "setDisplayMode", mode: "countdown" });
      await command({ type: "take" });
      return command({ type: "start" });
    },
    takeClock: async () => {
      await command({ type: "setDisplayMode", mode: "clock" });
      return command({ type: "take" });
    },
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
test("presets and custom durations stay off air until explicitly published, paused or started", async () => {
  const f = await fixture();
  try {
    const live = await f.command({ type: "start" });
    for (const durationMs of [1800000, 125000]) {
      const prepared = await f.command({ type: "setDuration", durationMs });
      assert.deepEqual(prepared.timer, live.timer);
      assert.equal(prepared.preparedDurationMs, durationMs);
    }
    let output = await f.command({ type: "take" });
    assert.equal(output.timer.status, "ready");
    assert.equal(output.timer.deadline, null);
    assert.equal(output.timer.remainingMs, 125000);
    output = await f.takeAndStart();
    assert.equal(output.timer.deadline, f.now + 125000);
    output = await f.command({ type: "reset" });
    assert.equal(output.timer.status, "ready");
    assert.equal(output.timer.deadline, null);
  } finally {
    await f.close();
  }
});
test("next, previous, and session selection only prepare; LIVE keeps its deadline", async () => {
  const f = await fixture();
  try {
    await f.command({
      type: "add",
      name: "Second presenter",
      durationMs: 1800000,
    });
    const first = f.service.getState().selectedId;
    const live = await f.command({ type: "start" });
    for (const command of [
      { type: "step", direction: 1 },
      { type: "step", direction: -1 },
      { type: "select", id: first },
    ]) {
      const state = await f.command(command);
      assert.deepEqual(state.timer, live.timer);
      assert.deepEqual(state.liveSession, live.liveSession);
    }
    await f.command({ type: "step", direction: 1 });
    await f.command({ type: "setDisplayMode", mode: "countdown" });
    const ready = await f.command({ type: "take" });
    assert.equal(ready.timer.status, "ready");
    assert.equal(ready.timer.deadline, null);
    assert.equal(ready.timer.remainingMs, 1800000);
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
    const before = await f.takeAndStart();
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
test("zero transitions into overtime and preserves the deadline after restart", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setDuration", durationMs: 1000 });
    const started = await f.takeAndStart();
    f.advance(1000);
    assert.equal(
      formatTime(remaining(f.service.getState().timer, f.now)),
      "00:00",
    );
    f.advance(1000);
    assert.equal(
      formatTime(remaining(f.service.getState().timer, f.now)),
      "00:01",
    );
    await f.restart();
    const s = f.service.getState();
    assert.equal(s.timer.status, "running");
    assert.equal(s.timer.deadline, started.timer.deadline);
    assert.equal(remaining(s.timer, f.now), -1000);
    assert.equal(formatTime(-10000), "00:10");
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
test("deleting the LIVE source preserves output and chooses another prepared session", () => {
  let state = initialState();
  const id = state.selectedId;
  state = reduce(state, { type: "duplicate", id }, 0);
  const copy = state.sessions[1].id;
  state = takeAndStartState(state, 0);
  const live = structuredClone(state);
  state = reduce(
    state,
    { type: "update", id, name: "New title", durationMs: 60000 },
    1,
  );
  state = reduce(state, { type: "delete", id }, 2);
  assert.equal(state.selectedId, copy);
  assert.deepEqual(state.timer, live.timer);
  assert.deepEqual(state.liveSession, live.liveSession);
  assert.throws(
    () => reduce(state, { type: "delete", id: copy }, 3),
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

test("a deadline that passes while the server is down recovers running in overtime", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setDuration", durationMs: 1000 });
    await f.takeAndStart();
    f.advance(5000);
    await f.restart();
    const state = f.service.getState();
    assert.equal(state.timer.status, "running");
    assert.equal(formatTime(remaining(state.timer, f.now)), "00:04");
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

test("overtime pause, resume, adjustments and the 15-minute preset preserve manual control", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setDuration", durationMs: 1000 });
    await f.takeAndStart();
    f.advance(31000);
    let s = await f.command({ type: "pause" });
    assert.equal(s.timer.remainingMs, -30000);
    assert.equal(s.timer.status, "paused");
    f.advance(60000);
    await f.restart();
    s = f.service.getState();
    assert.equal(remaining(s.timer, f.now), -30000);
    s = await f.command({ type: "start" });
    assert.equal(s.timer.deadline, f.now - 30000);
    f.advance(5000);
    s = await f.command({ type: "adjust", deltaMs: 300000 });
    assert.equal(s.timer.status, "running");
    assert.equal(remaining(s.timer, f.now), 265000);
    s = await f.command({ type: "adjust", deltaMs: -300000 });
    assert.equal(remaining(s.timer, f.now), -35000);
    assert.equal(s.timer.status, "running");
    const overtime = structuredClone(s.timer);
    s = await f.command({ type: "setDuration", durationMs: 900000 });
    assert.deepEqual(s.timer, overtime);
    s = await f.command({ type: "take" });
    assert.equal(s.timer.status, "ready");
    assert.equal(s.timer.deadline, null);
    assert.equal(formatTime(remaining(s.timer, f.now)), "15:00");
    s = await f.command({ type: "adjust", deltaMs: -600000 });
    s = await f.command({ type: "adjust", deltaMs: -600000 });
    assert.equal(s.timer.status, "paused");
    assert.equal(s.timer.deadline, null);
  } finally {
    await f.close();
  }
});

test("an overtime viewer refresh or reconnect retains the original deadline", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setDuration", durationMs: 1000 });
    const started = await f.takeAndStart();
    f.advance(62000);
    let viewer = await f.open("display");
    let state = await viewer.next("state");
    assert.equal(state.timer.deadline, started.timer.deadline);
    assert.equal(formatTime(remaining(state.timer, state.serverNow)), "01:01");
    viewer.socket.terminate();
    f.advance(5000);
    viewer = await f.open("display");
    state = await viewer.next("state");
    assert.equal(state.timer.status, "running");
    assert.equal(formatTime(remaining(state.timer, state.serverNow)), "01:06");
  } finally {
    await f.close();
  }
});

test("upgrading a previously expired timer never starts it automatically", () => {
  const s = initialState();
  s.timer.status = "expired";
  s.timer.remainingMs = 0;
  s.timer.pausedAt = 1234;
  const migrated = normalizeState(s, 60000);
  assert.equal(migrated.timer.status, "paused");
  assert.equal(migrated.timer.deadline, null);
  assert.equal(remaining(migrated.timer, 60000), 0);
  const started = reduce(migrated, { type: "start" }, 60000);
  assert.equal(started.timer.status, "running");
  assert.equal(formatTime(remaining(started.timer, 62000)), "00:02");
});

test("30-second adjustments preserve the running deadline, paused state and overtime", async () => {
  const f = await fixture();
  try {
    const original = await f.command({ type: "start" });
    f.advance(1500);
    let state = await f.command({ type: "adjust", deltaMs: 30000 });
    assert.equal(state.timer.deadline, original.timer.deadline! + 30000);
    assert.equal(state.timer.status, "running");
    state = await f.command({ type: "adjust", deltaMs: -30000 });
    assert.equal(state.timer.deadline, original.timer.deadline);
    state = await f.command({ type: "pause" });
    const paused = state.timer.remainingMs;
    state = await f.command({ type: "adjust", deltaMs: 30000 });
    assert.equal(state.timer.status, "paused");
    assert.equal(state.timer.deadline, null);
    assert.equal(state.timer.remainingMs, paused + 30000);
    state = await f.command({ type: "adjust", deltaMs: -30000 });
    assert.equal(state.timer.status, "paused");
    assert.equal(state.timer.remainingMs, paused);
    await f.command({ type: "setDuration", durationMs: 1000 });
    await f.takeAndStart();
    f.advance(16000);
    state = await f.command({ type: "adjust", deltaMs: 30000 });
    assert.equal(remaining(state.timer, f.now), 15000);
    assert.equal(state.timer.status, "running");
    state = await f.command({ type: "adjust", deltaMs: -30000 });
    assert.equal(remaining(state.timer, f.now), -15000);
    assert.equal(state.timer.status, "running");
    state = await f.command({ type: "reset" });
    assert.equal(state.timer.status, "ready");
    state = await f.command({ type: "adjust", deltaMs: -30000 });
    assert.equal(state.timer.status, "paused");
    assert.equal(state.timer.deadline, null);
  } finally {
    await f.close();
  }
});

test("San Francisco clock applies Pacific time, midnight and both daylight-saving transitions", () => {
  for (const [utc, expected] of [
    ["2026-01-15T20:05:09Z", "12:05"],
    ["2026-07-15T19:05:09Z", "12:05"],
    ["2026-01-15T08:00:00Z", "12:00"],
    ["2026-03-08T09:59:59Z", "1:59"],
    ["2026-03-08T10:00:00Z", "3:00"],
    ["2026-11-01T08:59:59Z", "1:59"],
    ["2026-11-01T09:00:00Z", "1:00"],
  ])
    assert.equal(formatPacificTime(Date.parse(utc)), expected);
});

test("Current Time pauses the countdown and persists across restart without auto-resuming", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "start" });
    f.advance(12345);
    const clock = await f.takeClock();
    assert.equal(clock.displayMode, "clock");
    assert.equal(clock.timer.status, "paused");
    assert.equal(clock.timer.remainingMs, 5400000 - 12345);
    assert.equal(clock.timer.deadline, null);
    f.advance(300000);
    await f.restart();
    assert.deepEqual(f.service.getState(), clock);
    let state = await f.command({ type: "setDisplayMode", mode: "countdown" });
    assert.equal(state.displayMode, "clock");
    assert.deepEqual(state.timer, clock.timer);
    state = await f.command({ type: "take" });
    assert.equal(state.displayMode, "countdown");
    assert.equal(state.timer.status, "ready");
    assert.equal(state.timer.deadline, null);
    state = await f.command({ type: "start" });
    assert.equal(state.timer.deadline, f.now + state.preparedDurationMs);
  } finally {
    await f.close();
  }
});

test("preparing durations and presenters never replaces the LIVE Pacific clock", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "add", name: "Next session", durationMs: 1800000 });
    const first = f.service.getState().selectedId;
    await f.command({ type: "start" });
    const clock = await f.takeClock();
    for (const command of [
      { type: "setDuration", durationMs: 900000 },
      { type: "step", direction: 1 },
      { type: "select", id: first },
    ]) {
      const state = await f.command(command);
      assert.equal(state.displayMode, "clock");
      assert.deepEqual(state.timer, clock.timer);
      assert.deepEqual(state.liveSession, clock.liveSession);
    }
    await f.command({ type: "setDisplayMode", mode: "countdown" });
    const ready = await f.command({ type: "take" });
    assert.equal(ready.displayMode, "countdown");
    assert.equal(ready.timer.status, "ready");
    assert.equal(ready.timer.deadline, null);
  } finally {
    await f.close();
  }
});

test("read-only viewers restore clock mode on refresh/reconnect and cannot change modes", async () => {
  const f = await fixture();
  try {
    await f.takeClock();
    let viewer = await f.open("display");
    let state = await viewer.next("state");
    assert.equal(state.displayMode, "clock");
    assert.equal(state.serverNow, f.now);
    viewer.socket.terminate();
    f.advance(65000);
    viewer = await f.open("display");
    state = await viewer.next("state");
    assert.equal(state.displayMode, "clock");
    assert.equal(state.serverNow, f.now);
    assert.equal(state.sessions, undefined);
    viewer.socket.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: state.revision,
        command: { type: "setDisplayMode", mode: "countdown" },
      }),
    );
    assert.match((await viewer.next("error")).error, /Unauthorized/);
    assert.equal(f.service.getState().displayMode, "clock");
  } finally {
    await f.close();
  }
});

test("existing stored countdowns without a display mode upgrade without losing their running deadline", async () => {
  const f = await fixture();
  try {
    const before = await f.command({ type: "start" });
    const legacy = structuredClone(before);
    Reflect.deleteProperty(legacy, "displayMode");
    f.service.store.save(legacy);
    f.advance(5000);
    await f.restart();
    const state = f.service.getState();
    assert.equal(state.displayMode, "countdown");
    assert.deepEqual(state.timer, before.timer);
    assert.equal(state.selectedId, before.selectedId);
  } finally {
    await f.close();
  }
});

for (const mode of [
  "ready",
  "running",
  "paused",
  "clock",
  "overtime",
] as const) {
  test(`every preparation and agenda command is isolated from ${mode} LIVE output`, () => {
    let state = initialState();
    state = reduce(
      state,
      { type: "add", name: "Next presenter", durationMs: 1800000 },
      1000,
    );
    const current = state.selectedId;
    const next = state.sessions[1].id;
    if (mode !== "ready") state = takeAndStartState(state, 1000);
    if (mode === "paused") state = reduce(state, { type: "pause" }, 12345);
    if (mode === "clock") state = takeClockState(state, 12345);
    const now = mode === "overtime" ? 6000000 : 15000;
    const before = structuredClone(state);
    const edit = (command: Parameters<typeof reduce>[1]) => {
      state = reduce(state, command, now);
      assert.deepEqual(state.timer, before.timer);
      assert.equal(state.displayMode, before.displayMode);
      assert.deepEqual(state.liveSession, before.liveSession);
    };
    edit({
      type: "update",
      id: current,
      name: "Renamed live presenter",
      durationMs: 1200000,
    });
    edit({ type: "add", name: "New agenda item", durationMs: 900000 });
    edit({ type: "duplicate", id: current });
    edit({ type: "move", id: current, direction: 1 });
    edit({ type: "select", id: next });
    edit({ type: "setDuration", durationMs: 2700000 });
    edit({ type: "step", direction: -1 });
    edit({ type: "select", id: current });
    edit({ type: "delete", id: current });
    assert.ok(!state.sessions.some((session) => session.id === current));
    const preparedDuration = state.preparedDurationMs;
    state = reduce(state, { type: "setDisplayMode", mode: "countdown" }, now);
    const loaded = reduce(state, { type: "take" }, now);
    assert.equal(loaded.timer.status, "ready");
    assert.equal(loaded.timer.remainingMs, preparedDuration);
    assert.equal(loaded.timer.deadline, null);
    const started = takeAndStartState(state, now);
    assert.equal(started.timer.status, "running");
    assert.equal(started.timer.deadline, now + preparedDuration);
  });
}

for (const clock of [false, true]) {
  test(`independent LIVE and prepared state both survive restart while showing ${clock ? "clock" : "countdown"}`, async () => {
    const f = await fixture();
    try {
      await f.command({ type: "add", name: "Upcoming", durationMs: 1800000 });
      await f.takeAndStart();
      f.advance(12345);
      if (clock) await f.takeClock();
      const before = f.service.getState();
      const viewer = await f.open("display");
      await viewer.next("state");
      await f.command({
        type: "update",
        id: before.selectedId,
        name: "Changed agenda title",
        durationMs: 1200000,
      });
      await f.command({ type: "step", direction: 1 });
      await f.command({ type: "setDuration", durationMs: 900000 });
      const after = await f.command({
        type: "delete",
        id: before.liveSession.id,
      });
      let live = await viewer.next("state");
      while (live.revision < after.revision) live = await viewer.next("state");
      assert.deepEqual(live.timer, before.timer);
      assert.equal(live.displayMode, before.displayMode);
      for (const privateField of [
        "sessions",
        "liveSession",
        "selectedId",
        "preparedDurationMs",
      ])
        assert.equal(live[privateField], undefined);
      f.advance(65000);
      await f.restart();
      const restored = f.service.getState();
      assert.deepEqual(restored.timer, before.timer);
      assert.deepEqual(restored.liveSession, before.liveSession);
      assert.equal(restored.displayMode, before.displayMode);
      assert.equal(restored.preparedDurationMs, after.preparedDurationMs);
      assert.equal(restored.selectedId, after.selectedId);
      assert.deepEqual(restored.sessions, after.sessions);
      const refreshed = await f.open("display");
      const snapshot = await refreshed.next("state");
      assert.deepEqual(snapshot.timer, before.timer);
      assert.equal(snapshot.displayMode, before.displayMode);
      const started = await f.takeAndStart();
      assert.equal(started.timer.deadline, f.now + 900000);
      assert.equal(started.liveSession.name, "Upcoming");
    } finally {
      await f.close();
    }
  });
}

test("existing stored LIVE timers migrate without changing deadline, timestamps or Pacific mode", () => {
  for (const clock of [false, true]) {
    let state = reduce(initialState(), { type: "start" }, 1000);
    if (clock) state = takeClockState(state, 1500);
    const before = structuredClone(state);
    Reflect.deleteProperty(state, "preparedDurationMs");
    Reflect.deleteProperty(state, "liveSession");
    const migrated = normalizeState(state, 5000);
    assert.deepEqual(migrated.timer, before.timer);
    assert.equal(migrated.displayMode, before.displayMode);
    assert.deepEqual(migrated.liveSession, before.liveSession);
    assert.equal(migrated.preparedDurationMs, before.preparedDurationMs);
  }
});

test("LIVE pause/resume/reset controls never publish a different prepared timer", () => {
  let state = takeAndStartState(initialState(), 1000);
  state = reduce(
    state,
    { type: "add", name: "Prepared next", durationMs: 1800000 },
    2000,
  );
  state = reduce(state, { type: "step", direction: 1 }, 2000);
  const liveSource = structuredClone(state.liveSession);
  const preparedId = state.selectedId;
  state = reduce(state, { type: "pause" }, 3000);
  assert.equal(state.timer.remainingMs, 5398000);
  state = reduce(state, { type: "start" }, 10000);
  assert.equal(state.timer.deadline, 5408000);
  assert.deepEqual(state.liveSession, liveSource);
  state = reduce(state, { type: "reset" }, 11000);
  assert.equal(state.timer.status, "ready");
  assert.equal(state.timer.remainingMs, 5400000);
  assert.equal(state.selectedId, preparedId);
  assert.equal(state.preparedDurationMs, 1800000);
  state = reduce(state, { type: "start" }, 12000);
  assert.equal(state.timer.deadline, 5412000);
  assert.deepEqual(state.liveSession, liveSource);
});

test("Eastern and Pacific format correctly through midnight and both DST transitions", () => {
  for (const [utc, expected] of [
    ["2026-01-15T17:05:09Z", "12:05"],
    ["2026-07-15T16:05:09Z", "12:05"],
    ["2026-01-15T05:00:00Z", "12:00"],
    ["2026-03-08T06:59:59Z", "1:59"],
    ["2026-03-08T07:00:00Z", "3:00"],
    ["2026-11-01T05:59:59Z", "1:59"],
    ["2026-11-01T06:00:00Z", "1:00"],
  ])
    assert.equal(
      formatClockTime(Date.parse(utc), "America/New_York"),
      expected,
    );
  const now = Date.parse("2026-10-29T16:00:00Z");
  assert.equal(formatClockTime(now, "America/New_York"), "12:00");
  assert.equal(formatClockTime(now, "America/Los_Angeles"), "9:00");
});

test("only TAKE can switch output modes or clock timezones; TAKE countdown never starts", () => {
  let state = takeAndStartState(initialState(), 1000);
  const running = structuredClone(state);
  state = reduce(state, { type: "setDisplayMode", mode: "clock" }, 2000);
  state = reduce(
    state,
    { type: "setClockTimeZone", timeZone: "America/New_York" },
    2000,
  );
  assert.deepEqual(state.timer, running.timer);
  assert.equal(state.displayMode, "countdown");
  assert.equal(state.clockTimeZone, DEFAULT_CLOCK_TIME_ZONE);
  state = reduce(state, { type: "take" }, 3000);
  assert.equal(state.displayMode, "clock");
  assert.equal(state.clockTimeZone, "America/New_York");
  assert.equal(state.timer.remainingMs, 5398000);
  const clock = structuredClone(state);
  state = reduce(
    state,
    { type: "setClockTimeZone", timeZone: "America/Los_Angeles" },
    4000,
  );
  assert.deepEqual(state.timer, clock.timer);
  assert.equal(state.clockTimeZone, "America/New_York");
  assert.equal(state.preparedClockTimeZone, "America/Los_Angeles");
  state = reduce(state, { type: "take" }, 5000);
  assert.equal(state.clockTimeZone, "America/Los_Angeles");
  assert.deepEqual(state.timer, clock.timer);
  assert.throws(() => reduce(state, { type: "start" }, 6000), /Use TAKE/);
  state = reduce(state, { type: "setDisplayMode", mode: "countdown" }, 7000);
  assert.equal(state.displayMode, "clock");
  state = reduce(state, { type: "take" }, 8000);
  assert.equal(state.timer.status, "ready");
  assert.equal(state.timer.deadline, null);
  assert.equal(state.displayMode, "countdown");
  assert.equal(
    commandSchema.safeParse({ type: "startPrepared" }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ type: "loadPrepared" }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ type: "setClockTimeZone", timeZone: "EST" })
      .success,
    false,
  );
});

test("LIVE and prepared timezones survive restart independently and viewers cannot TAKE", async () => {
  const f = await fixture();
  try {
    await f.command({ type: "setClockTimeZone", timeZone: "America/New_York" });
    await f.takeClock();
    const clock = f.service.getState();
    await f.command({
      type: "setClockTimeZone",
      timeZone: "America/Los_Angeles",
    });
    await f.command({ type: "setDisplayMode", mode: "countdown" });
    await f.restart();
    const state = f.service.getState();
    assert.equal(state.displayMode, "clock");
    assert.equal(state.clockTimeZone, "America/New_York");
    assert.equal(state.preparedClockTimeZone, "America/Los_Angeles");
    assert.equal(state.preparedDisplayMode, "countdown");
    assert.deepEqual(state.timer, clock.timer);
    const viewer = await f.open("display");
    const snapshot = await viewer.next("state");
    assert.equal(snapshot.clockTimeZone, "America/New_York");
    assert.equal(snapshot.preparedClockTimeZone, undefined);
    for (const command of [
      { type: "legacy", action: { type: "setDuration", durationMs: 1800000 } },
      { type: "setLiveTime", remainingMs: 60000 },
      { type: "take" },
      { type: "setClockTimeZone", timeZone: "America/Los_Angeles" },
    ]) {
      viewer.socket.send(
        JSON.stringify({
          type: "command",
          id: crypto.randomUUID(),
          revision: state.revision,
          command,
        }),
      );
      assert.match((await viewer.next("error")).error, /Unauthorized/);
    }
    assert.deepEqual(f.service.getState(), state);
  } finally {
    await f.close();
  }
});

test("timezone migration preserves old running deadlines and Pacific output", () => {
  const state = reduce(initialState(), { type: "start" }, 1000);
  const before = structuredClone(state);
  for (const field of [
    "clockTimeZone",
    "preparedClockTimeZone",
    "preparedDisplayMode",
  ])
    Reflect.deleteProperty(state, field);
  const restored = normalizeState(state, 15000);
  assert.deepEqual(restored.timer, before.timer);
  assert.equal(restored.clockTimeZone, "America/Los_Angeles");
  assert.equal(restored.preparedClockTimeZone, "America/Los_Angeles");
  assert.equal(restored.preparedDisplayMode, "countdown");
});

test("custom LIVE input accepts minutes or MM:SS and rejects ambiguous or out-of-range values", () => {
  for (const [text, ms] of [
    ["15", 900000],
    ["12:30", 750000],
    ["00:00", 0],
    ["999:00", 59940000],
    [" 0:30 ", 30000],
  ] as const)
    assert.equal(parseLiveTime(text), ms);
  for (const text of [
    "",
    "1:60",
    "-5",
    "1.5",
    "12:3",
    "999:01",
    "1000",
    "1:00:00",
  ])
    assert.equal(parseLiveTime(text), null);
  for (const ms of [-1, 59940001, 1.5, Infinity])
    assert.equal(
      commandSchema.safeParse({ type: "setLiveTime", remainingMs: ms }).success,
      false,
    );
});
test("custom LIVE time replaces remaining time without changing rundown, prepared output or running state and survives restart", async () => {
  const f = await fixture();
  try {
    const started = await f.takeAndStart();
    await f.command({ type: "setDuration", durationMs: 1800000 });
    const before = f.service.getState();
    f.advance(45000);
    const changed = await f.command({
      type: "setLiveTime",
      remainingMs: 750000,
    });
    assert.equal(changed.timer.status, "running");
    assert.equal(changed.timer.deadline, f.now + 750000);
    assert.equal(changed.timer.startedAt, started.timer.startedAt);
    assert.equal(changed.timer.durationMs, started.timer.durationMs);
    assert.deepEqual(changed.sessions, before.sessions);
    assert.equal(changed.preparedDurationMs, before.preparedDurationMs);
    assert.deepEqual(changed.liveSession, before.liveSession);
    const viewer = await f.open("display");
    assert.equal(
      (await viewer.next("state")).timer.deadline,
      changed.timer.deadline,
    );
    await f.restart();
    assert.deepEqual(f.service.getState().timer, changed.timer);
    await f.command({ type: "pause" });
    const paused = await f.command({ type: "setLiveTime", remainingMs: 30000 });
    assert.equal(paused.timer.status, "paused");
    assert.equal(paused.timer.deadline, null);
    f.advance(10000);
    assert.equal(remaining(f.service.getState().timer, f.now), 30000);
    await f.command({ type: "start" });
    const zero = await f.command({ type: "setLiveTime", remainingMs: 0 });
    assert.equal(formatTime(remaining(zero.timer, f.now)), "00:00");
    f.advance(1000);
    assert.equal(remaining(f.service.getState().timer, f.now), -1000);
    await f.command({ type: "reset" });
    const ready = await f.command({ type: "setLiveTime", remainingMs: 120000 });
    assert.equal(ready.timer.status, "ready");
    assert.equal(ready.timer.deadline, null);
    const clock = await f.takeClock();
    assert.throws(() =>
      reduce(clock, { type: "setLiveTime", remainingMs: 60000 }, f.now),
    );
  } finally {
    await f.close();
  }
});

test("Legacy direct controls atomically load paused countdowns and switch clocks without changing normal staging behavior", async () => {
  const f = await fixture();
  try {
    await f.takeAndStart();
    const rev = f.service.getState().revision;
    let s = await f.command({
      type: "legacy",
      action: { type: "setDuration", durationMs: 1800000 },
    });
    assert.equal(s.revision, rev + 1);
    assert.equal(s.timer.status, "ready");
    assert.equal(s.timer.deadline, null);
    assert.equal(s.timer.remainingMs, 1800000);
    await f.command({ type: "add", name: "Legacy second", durationMs: 900000 });
    await f.command({ type: "start" });
    s = await f.command({
      type: "legacy",
      action: { type: "step", direction: 1 },
    });
    assert.equal(s.liveSession.name, "Legacy second");
    assert.equal(s.timer.status, "ready");
    assert.equal(s.timer.remainingMs, 900000);
    s = await f.command({
      type: "legacy",
      action: { type: "select", id: s.sessions[0].id },
    });
    assert.equal(s.liveSession.id, s.sessions[0].id);
    await f.command({ type: "start" });
    s = await f.command({
      type: "legacy",
      action: { type: "setDisplayMode", mode: "clock" },
    });
    assert.equal(s.displayMode, "clock");
    assert.equal(s.timer.status, "paused");
    s = await f.command({
      type: "legacy",
      action: { type: "setClockTimeZone", timeZone: "America/New_York" },
    });
    assert.equal(s.clockTimeZone, "America/New_York");
    await f.restart();
    assert.deepEqual(f.service.getState(), s);
    const staged = await f.command({
      type: "setDuration",
      durationMs: 2700000,
    });
    assert.equal(staged.displayMode, "clock");
    assert.deepEqual(staged.timer, s.timer);
    const loaded = await f.command({
      type: "legacy",
      action: { type: "setDisplayMode", mode: "countdown" },
    });
    assert.equal(loaded.displayMode, "countdown");
    assert.equal(loaded.timer.status, "ready");
    assert.equal(loaded.timer.remainingMs, 2700000);
    assert.equal(
      commandSchema.safeParse({ type: "legacy", action: { type: "start" } })
        .success,
      false,
    );
  } finally {
    await f.close();
  }
});
