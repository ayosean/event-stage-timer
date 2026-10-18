import type { Command } from "./commands.js";
export type { Command } from "./commands.js";
export const MAX_MS = 999 * 60_000;
export interface Session {
  id: string;
  name: string;
  durationMs: number;
}
export interface Timer {
  status: "ready" | "running" | "paused" | "expired";
  durationMs: number;
  remainingMs: number;
  deadline: number | null;
  startedAt: number | null;
  pausedAt: number | null;
}
export interface State {
  revision: number;
  sessions: Session[];
  selectedId: string;
  timer: Timer;
}
export interface Snapshot {
  type: "state";
  revision: number;
  timer: Timer;
  serverNow: number;
  sessions?: Session[];
  selectedId?: string;
  viewers?: number;
  commandId?: string;
}
export const remaining = (timer: Timer, now: number) =>
  Math.max(
    0,
    timer.status === "running" && timer.deadline !== null
      ? timer.deadline - now
      : timer.remainingMs,
  );
export function formatTime(ms: number) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function initialState(): State {
  const session = {
    id: crypto.randomUUID(),
    name: "Opening session",
    durationMs: 90 * 60000,
  };
  return {
    revision: 0,
    sessions: [session],
    selectedId: session.id,
    timer: ready(session.durationMs),
  };
}
export function ready(durationMs: number): Timer {
  return {
    status: "ready",
    durationMs,
    remainingMs: durationMs,
    deadline: null,
    startedAt: null,
    pausedAt: null,
  };
}
export function expire(state: State, now: number): State {
  return state.timer.status === "running" && remaining(state.timer, now) === 0
    ? {
        ...state,
        revision: state.revision + 1,
        timer: {
          ...state.timer,
          status: "expired",
          remainingMs: 0,
          deadline: null,
          pausedAt: now,
        },
      }
    : state;
}
export function reduce(input: State, command: Command, now: number): State {
  const state = structuredClone(expire(input, now));
  const timer = state.timer;
  const session = (id: string) => {
    const s = state.sessions.find((s) => s.id === id);
    if (!s) throw new Error("Session no longer exists.");
    return s;
  };
  const select = (id: string) => {
    state.selectedId = id;
    state.timer = ready(session(id).durationMs);
  };
  switch (command.type) {
    case "start":
      if (timer.status !== "running" && timer.remainingMs > 0) {
        timer.status = "running";
        timer.deadline = now + timer.remainingMs;
        timer.startedAt = now;
        timer.pausedAt = null;
      }
      break;
    case "pause":
      if (timer.status === "running") {
        timer.remainingMs = remaining(timer, now);
        timer.status = "paused";
        timer.deadline = null;
        timer.pausedAt = now;
      }
      break;
    case "reset":
      state.timer = ready(timer.durationMs);
      break;
    case "setDuration":
      session(state.selectedId).durationMs = command.durationMs;
      state.timer = ready(command.durationMs);
      break;
    case "adjust": {
      const value = Math.min(
        MAX_MS,
        Math.max(0, remaining(timer, now) + command.deltaMs),
      );
      timer.remainingMs = value;
      if (timer.status === "running") timer.deadline = now + value;
      if (value === 0) {
        timer.status = "expired";
        timer.deadline = null;
        timer.pausedAt = now;
      } else if (timer.status === "expired") {
        timer.status = "paused";
        timer.deadline = null;
      }
      break;
    }
    case "select":
      select(command.id);
      break;
    case "step": {
      const index =
        state.sessions.findIndex((s) => s.id === state.selectedId) +
        command.direction;
      if (state.sessions[index]) select(state.sessions[index].id);
      break;
    }
    case "add":
      if (state.sessions.length >= 200)
        throw new Error("Maximum 200 sessions.");
      state.sessions.push({
        id: crypto.randomUUID(),
        name: command.name,
        durationMs: command.durationMs,
      });
      break;
    case "update": {
      const s = session(command.id);
      const changed = s.durationMs !== command.durationMs;
      Object.assign(s, { name: command.name, durationMs: command.durationMs });
      if (s.id === state.selectedId && changed)
        state.timer = ready(s.durationMs);
      break;
    }
    case "duplicate": {
      if (state.sessions.length >= 200)
        throw new Error("Maximum 200 sessions.");
      const s = session(command.id);
      state.sessions.splice(state.sessions.indexOf(s) + 1, 0, {
        ...s,
        id: crypto.randomUUID(),
        name: (s.name + " (copy)").slice(0, 120),
      });
      break;
    }
    case "delete": {
      if (state.sessions.length === 1)
        throw new Error("Keep at least one session.");
      const index = state.sessions.findIndex(
        (s) => s.id === session(command.id).id,
      );
      state.sessions.splice(index, 1);
      if (command.id === state.selectedId)
        select(state.sessions[Math.min(index, state.sessions.length - 1)].id);
      break;
    }
    case "move": {
      const index = state.sessions.indexOf(session(command.id));
      const target = index + command.direction;
      if (state.sessions[target])
        [state.sessions[index], state.sessions[target]] = [
          state.sessions[target],
          state.sessions[index],
        ];
      break;
    }
  }
  state.revision++;
  return state;
}
