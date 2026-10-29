import {
  DEFAULT_CLOCK_TIME_ZONE,
  CLOCK_TIME_ZONES,
  formatClockTime,
  type ClockTimeZone,
} from "./clock.js";
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
export type DisplayMode = "countdown" | "clock";
export interface State {
  displayMode: DisplayMode;
  clockTimeZone: ClockTimeZone;
  revision: number;
  sessions: Session[];
  selectedId: string;
  preparedDurationMs: number;
  preparedDisplayMode: DisplayMode;
  preparedClockTimeZone: ClockTimeZone;
  liveSession: Session;
  timer: Timer;
}
export interface Snapshot {
  displayMode: DisplayMode;
  clockTimeZone: ClockTimeZone;
  type: "state";
  revision: number;
  timer: Timer;
  serverNow: number;
  sessions?: Session[];
  selectedId?: string;
  preparedDurationMs?: number;
  preparedDisplayMode?: DisplayMode;
  preparedClockTimeZone?: ClockTimeZone;
  liveSession?: Session;
  viewers?: number;
  commandId?: string;
}
// Signed time: positive counts down; negative measures elapsed overtime.
export const remaining = (timer: Timer, now: number) =>
  timer.status === "running" && timer.deadline !== null
    ? timer.deadline - now
    : timer.remainingMs;
export function formatTime(ms: number) {
  const seconds = ms < 0 ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
// A plain number is minutes; a colon explicitly separates minutes/seconds.
export function parseLiveTime(input: string): number | null {
  const match = /^(\d{1,3})(?::([0-5]\d))?$/.exec(input.trim());
  if (!match) return null;
  const ms = (Number(match[1]) * 60 + Number(match[2] ?? 0)) * 1000;
  return ms <= MAX_MS ? ms : null;
}
export function initialState(): State {
  const session = {
    id: crypto.randomUUID(),
    name: "Opening session",
    durationMs: 90 * 60000,
  };
  return {
    displayMode: "countdown",
    clockTimeZone: DEFAULT_CLOCK_TIME_ZONE,
    revision: 0,
    sessions: [session],
    selectedId: session.id,
    preparedDurationMs: session.durationMs,
    preparedDisplayMode: "countdown",
    preparedClockTimeZone: DEFAULT_CLOCK_TIME_ZONE,
    liveSession: { ...session },
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
// Old deployments stopped at zero. Preserve that stopped state during upgrade;
// only an explicit Start/Resume may start it under the new overtime behavior.
export function normalizeState(state: State, now: number): State {
  const legacyExpired = state.timer.status === "expired";
  if (
    state.displayMode &&
    CLOCK_TIME_ZONES.includes(state.clockTimeZone) &&
    state.preparedDurationMs !== undefined &&
    state.liveSession &&
    state.preparedDisplayMode &&
    CLOCK_TIME_ZONES.includes(state.preparedClockTimeZone) &&
    !legacyExpired
  )
    return state;
  const selected =
    state.sessions.find((session) => session.id === state.selectedId) ??
    state.sessions[0];
  return {
    ...state,
    displayMode: state.displayMode ?? "countdown",
    clockTimeZone: CLOCK_TIME_ZONES.includes(state.clockTimeZone)
      ? state.clockTimeZone
      : DEFAULT_CLOCK_TIME_ZONE,
    preparedDurationMs: state.preparedDurationMs ?? selected.durationMs,
    preparedDisplayMode:
      state.preparedDisplayMode ?? state.displayMode ?? "countdown",
    preparedClockTimeZone: CLOCK_TIME_ZONES.includes(
      state.preparedClockTimeZone,
    )
      ? state.preparedClockTimeZone
      : CLOCK_TIME_ZONES.includes(state.clockTimeZone)
        ? state.clockTimeZone
        : DEFAULT_CLOCK_TIME_ZONE,
    liveSession: state.liveSession ?? {
      ...selected,
      durationMs: state.timer.durationMs,
    },
    revision: state.revision + 1,
    timer: legacyExpired
      ? {
          ...state.timer,
          status: "paused",
          remainingMs: 0,
          deadline: null,
          pausedAt: state.timer.pausedAt ?? now,
        }
      : state.timer,
  };
}
// Retained for callers that explicitly need Pacific time.
export const formatPacificTime = (epochMs: number) =>
  formatClockTime(epochMs, DEFAULT_CLOCK_TIME_ZONE);
export function reduce(input: State, command: Command, now: number): State {
  const state = structuredClone(normalizeState(input, now));
  const timer = state.timer;
  const session = (id: string) => {
    const s = state.sessions.find((s) => s.id === id);
    if (!s) throw new Error("Session no longer exists.");
    return s;
  };
  const select = (id: string) => {
    state.selectedId = id;
    state.preparedDurationMs = session(id).durationMs;
  };
  const publish = () => {
    state.liveSession = {
      ...session(state.selectedId),
      durationMs: state.preparedDurationMs,
    };
    state.timer = ready(state.preparedDurationMs);
    state.displayMode = "countdown";
  };
  switch (command.type) {
    case "setClockTimeZone":
      state.preparedClockTimeZone = command.timeZone;
      break;
    case "setDisplayMode":
      state.preparedDisplayMode = command.mode;
      break;
    case "take":
      if (state.preparedDisplayMode === "clock") {
        if (timer.status === "running") {
          timer.remainingMs = remaining(timer, now);
          timer.status = "paused";
          timer.deadline = null;
          timer.pausedAt = now;
        }
        state.displayMode = "clock";
        state.clockTimeZone = state.preparedClockTimeZone;
      } else publish();
      break;
    case "start":
      if (state.displayMode !== "countdown")
        throw new Error("Use TAKE to show a countdown before starting it.");
      if (timer.status !== "running") {
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
      state.preparedDurationMs = command.durationMs;
      break;
    case "setLiveTime": {
      if (state.displayMode !== "countdown")
        throw new Error(
          "Use TAKE to show a countdown before setting LIVE time.",
        );
      timer.remainingMs = command.remainingMs;
      if (timer.status === "running")
        timer.deadline = now + command.remainingMs;
      // Keep ready/paused timers stopped, including when setting zero.
      if (timer.status === "expired") timer.status = "paused";
      break;
    }
    case "adjust": {
      const value = Math.min(MAX_MS, remaining(timer, now) + command.deltaMs);
      timer.remainingMs = value;
      if (timer.status === "running") timer.deadline = now + value;
      // An adjustment never starts a stopped timer, even if it crosses zero.
      if (timer.status !== "running" && value <= 0) timer.status = "paused";
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
      Object.assign(s, { name: command.name, durationMs: command.durationMs });
      if (s.id === state.selectedId) state.preparedDurationMs = s.durationMs;
      // Rundown edits only change the saved agenda. Loading a session is a
      // separate command; never replace the timer or clock during an edit.
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
