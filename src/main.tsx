import {
  CLOCK_TIME_ZONES,
  DEFAULT_CLOCK_TIME_ZONE,
  clockTimeZoneLabels,
  formatClockTime,
  type ClockTimeZone,
} from "../shared/clock";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  GripVertical,
  LogOut,
  Monitor,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import {
  formatTime,
  parseLiveTime,
  type Command,
  type Session,
} from "../shared/timer";
import { useTimer } from "./useTimer";
import "./style.css";
function Digits({
  value,
  red = false,
  display = false,
}: {
  value: string;
  red?: boolean;
  display?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null),
    text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      if (!box.current || !text.current) return;
      const b = box.current.getBoundingClientRect();
      const el = text.current;
      el.style.fontSize = "100px";
      const bounds = el.getBoundingClientRect();
      el.style.fontSize = `${Math.floor(100 * Math.min((b.width * 0.96) / bounds.width, (b.height * 0.91) / bounds.height))}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [value.length, display]);
  return (
    <div
      ref={box}
      className={`digits ${display ? "display-digits" : ""} ${red ? "zero" : ""}`}
    >
      <span ref={text}>{value}</span>
    </div>
  );
}
function Display() {
  const { ms, snapshot, serverNow } = useTimer("display");
  const clockMode = snapshot?.displayMode === "clock";
  const clockTimeZone = snapshot?.clockTimeZone ?? DEFAULT_CLOCK_TIME_ZONE;
  useEffect(() => {
    document.title = "Countdown";
    let disposed = false;
    let lock: WakeLockSentinel | null = null;
    let requesting = false;
    const request = async () => {
      if (
        disposed ||
        requesting ||
        document.visibilityState !== "visible" ||
        (lock && !lock.released) ||
        !("wakeLock" in navigator)
      )
        return;
      requesting = true;
      try {
        const acquired = await navigator.wakeLock.request("screen");
        if (disposed) {
          void acquired.release();
          return;
        }
        lock = acquired;
        acquired.addEventListener("release", () => {
          lock = null;
        });
      } catch {
        /* iOS may require a gesture or manual Auto-Lock settings. */
      } finally {
        requesting = false;
      }
    };
    void request();
    const visible = () => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", visible);
    document.addEventListener("pointerdown", request);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visible);
      document.removeEventListener("pointerdown", request);
      void lock?.release();
    };
  }, []);
  return (
    <main className="presenter-display">
      {snapshot && (
        <Digits
          value={
            clockMode
              ? formatClockTime(
                  serverNow,
                  snapshot?.clockTimeZone ?? DEFAULT_CLOCK_TIME_ZONE,
                )
              : formatTime(ms)
          }
          red={!clockMode && ms <= 0}
          display
        />
      )}
    </main>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username, password }),
            });
            if (response.ok) {
              setPassword("");
              onLogin();
            } else {
              const data = await response.json();
              setError(data.error ?? "Unable to sign in.");
            }
          } catch {
            setError("Connection failed. Try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand-icon">
          <Timer size={24} />
        </div>
        <p className="eyebrow">EVENT STAGE TIMER</p>
        <h1>Take control of the room.</h1>
        <p className="muted">Sign in to your live event controller.</p>
        <label>
          Username
          <input
            autoFocus
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={80}
          />
        </label>
        <label>
          Admin password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={1024}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Open controller"}
          <ChevronRight size={18} />
        </button>
        <p className="login-note">
          Presenter displays never need your password.
        </p>
      </form>
    </main>
  );
}
function SessionEditor({
  session,
  onClose,
  onSave,
}: {
  session: Session | null;
  onClose: () => void;
  onSave: (name: string, minutes: number) => void;
}) {
  const [name, setName] = useState(session?.name ?? ""),
    [minutes, setMinutes] = useState(session ? session.durationMs / 60000 : 30);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name, Math.round(minutes * 60000));
          onClose();
        }}
      >
        <div className="section-heading">
          <h2>{session ? "Edit session" : "Add a session"}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close editor"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <label>
          Presenter / session name
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Keynote · Alex Morgan"
          />
        </label>
        <label>
          Duration in minutes
          <input
            type="number"
            min={1 / 60}
            max={999}
            step="any"
            required
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <p className="muted small">
          Saving updates the rundown without changing the current countdown or
          clock. The saved duration applies when you send the prepared session
          to LIVE. Use the +/− controls to adjust the timer currently on screen.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">
            {session ? "Save changes" : "Add session"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function LiveConfirmation({
  label,
  disabled,
  onConfirm,
  onCancel,
}: {
  label: string;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onCancel}
      aria-labelledby="live-confirm-heading"
    >
      <h2 id="live-confirm-heading">Change LIVE output?</h2>
      <p>{label}</p>
      <p className="muted">
        This changes what every presenter display shows. The current output
        keeps going until you confirm.
      </p>
      <div className="dialog-actions">
        <button onClick={onCancel}>Keep LIVE unchanged</button>
        <button className="primary" disabled={disabled} onClick={onConfirm}>
          Confirm LIVE change
        </button>
      </div>
    </dialog>
  );
}
function Controller({ onLogout }: { onLogout: () => void }) {
  const {
    snapshot,
    connected,
    ms,
    serverNow,
    command,
    error,
    pending,
    clearError,
  } = useTimer("controller", true, onLogout);
  const [outputTab, setOutputTab] = useState<"live" | "staging">("live");
  const [liveTime, setLiveTime] = useState("");
  const [custom, setCustom] = useState(""),
    [editor, setEditor] = useState<Session | null | undefined>(undefined),
    [copied, setCopied] = useState(false),
    [notice, setNotice] = useState(""),
    [deleteId, setDeleteId] = useState<string | null>(null),
    [liveChange, setLiveChange] = useState<{
      command: Command;
      revision: number;
      label: string;
    } | null>(null);
  const sessions = snapshot?.sessions ?? [];
  const current = sessions.find((s) => s.id === snapshot?.selectedId);
  const index = sessions.findIndex((s) => s.id === current?.id);
  const liveSession = snapshot?.liveSession;
  const liveIndex = sessions.findIndex((s) => s.id === liveSession?.id);
  const clockMode = snapshot?.displayMode === "clock";
  const clockTimeZone = snapshot?.clockTimeZone ?? DEFAULT_CLOCK_TIME_ZONE;
  const preparedMode = snapshot?.preparedDisplayMode ?? "countdown";
  const preparedZone = snapshot?.preparedClockTimeZone ?? clockTimeZone;
  const running = snapshot?.timer.status === "running";
  const overtime = !!snapshot && snapshot.timer.status !== "ready" && ms <= 0;
  const disabled = !connected || pending || !snapshot;
  const displayUrl = `${location.origin}/display`;
  function changeLive(next: Command, label: string) {
    if (!snapshot || disabled) return;
    if (clockMode || snapshot.timer.status !== "ready")
      setLiveChange({ command: next, revision: snapshot.revision, label });
    else command(next, snapshot.revision);
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/controller">
          <span className="brand-icon">
            <Timer size={20} />
          </span>
          STAGE<span className="brand-light">TIMER</span>
        </a>
        <span className="workspace-label">LIVE EVENT WORKSPACE</span>
        <div className="header-actions">
          <span className={`connection ${connected ? "online" : ""}`}>
            <i />
            {connected ? "Connected" : "Reconnecting"}
          </span>
          <button
            className="icon-button"
            title="Sign out"
            aria-label="Sign out"
            onClick={async () => {
              try {
                const response = await fetch("/api/logout", { method: "POST" });
                if (response.ok) onLogout();
                else setNotice("Sign out failed. Try again.");
              } catch {
                setNotice("Connection failed. Try signing out again.");
              }
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <main className="dashboard">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SHOW CONTROL</p>
            <h1>Make every minute count.</h1>
            <p className="muted">
              Your rundown. Your timing. You’re in control.
            </p>
          </div>
          <a
            className="button display-link"
            href="/display"
            target="_blank"
            rel="noreferrer"
          >
            <Monitor size={17} />
            Open display
            <ExternalLink size={14} />
          </a>
        </div>
        {!connected && (
          <div className="offline-banner" role="status">
            Connecting to the timer server. Controls are unavailable until
            synchronized.
          </div>
        )}
        {(error || notice) && (
          <div className="error-banner" role="alert">
            {error || notice}
            <button
              className="icon-button"
              aria-label="Dismiss notice"
              onClick={() => {
                setNotice("");
                clearError();
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="dashboard-grid">
          <section className="timer-column">
            <div className="output-tabs-bar">
              <div
                className="output-tabs"
                role="tablist"
                aria-label="Output workspace"
              >
                {(["live", "staging"] as const).map((tab) => (
                  <button
                    key={tab}
                    id={`tab-${tab}`}
                    role="tab"
                    aria-selected={outputTab === tab}
                    aria-controls={`panel-${tab}`}
                    tabIndex={outputTab === tab ? 0 : -1}
                    onClick={() => setOutputTab(tab)}
                    onKeyDown={(event) => {
                      if (
                        ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      ) {
                        event.preventDefault();
                        const next =
                          event.key === "Home"
                            ? "live"
                            : event.key === "End"
                              ? "staging"
                              : tab === "live"
                                ? "staging"
                                : "live";
                        setOutputTab(next);
                        document.getElementById(`tab-${next}`)?.focus();
                      }
                    }}
                  >
                    {tab === "live" ? <Radio size={16} /> : <Timer size={16} />}
                    {tab === "live" ? "LIVE Output" : "Staging"}
                  </button>
                ))}
              </div>
              <span className="workspace-live-status" aria-label="LIVE status">
                LIVE ·{" "}
                {clockMode
                  ? formatClockTime(serverNow, clockTimeZone)
                  : formatTime(ms)}
                {!clockMode && ` · ${running ? "Running" : "Paused"}`}
              </span>
            </div>
            <div
              className="panel timer-panel"
              id="panel-live"
              role="tabpanel"
              aria-labelledby="tab-live"
              hidden={outputTab !== "live"}
            >
              <div className="timer-panel-heading">
                <span className="eyebrow">
                  <Radio size={14} />
                  LIVE OUTPUT
                </span>
                <span
                  className={`status-pill ${!clockMode && overtime ? "overtime" : running ? "running" : ""}`}
                >
                  {clockMode
                    ? clockTimeZone === "America/New_York"
                      ? "EASTERN TIME"
                      : "PACIFIC TIME"
                    : running
                      ? overtime
                        ? "OVERTIME"
                        : "RUNNING"
                      : snapshot?.timer.status === "paused"
                        ? overtime
                          ? "PAUSED · OVERTIME"
                          : "PAUSED"
                        : "READY TO START"}
                </span>
              </div>
              <div className="session-heading">
                {!clockMode && (
                  <span className="session-index">
                    {liveIndex >= 0
                      ? String(liveIndex + 1).padStart(2, "0")
                      : "LIVE"}
                  </span>
                )}
                <h2>
                  {clockMode
                    ? clockTimeZoneLabels[clockTimeZone].heading
                    : (liveSession?.name ?? "Connecting…")}
                </h2>
              </div>
              <div className="preview-clock">
                <Digits
                  value={
                    clockMode
                      ? formatClockTime(
                          serverNow,
                          snapshot?.clockTimeZone ?? DEFAULT_CLOCK_TIME_ZONE,
                        )
                      : formatTime(ms)
                  }
                  red={!clockMode && ms <= 0}
                />
              </div>
              <p className="timer-hint">
                {clockMode
                  ? "Current time is live on all displays. Prepare another output off air, then press TAKE to change it."
                  : running
                    ? overtime
                      ? "Overtime is counting up on all connected displays."
                      : "Countdown is live on all connected displays."
                    : overtime
                      ? "Overtime is paused. Press Resume to continue counting up."
                      : "Timer is loaded. Press Start when your presenter is ready."}
              </p>
              <div className="transport">
                <button
                  className={`primary start-button ${running ? "pause-button" : ""}`}
                  disabled={disabled || clockMode}
                  onClick={() => command({ type: running ? "pause" : "start" })}
                >
                  {running ? <Pause size={21} /> : <Play size={21} />}{" "}
                  {running
                    ? "Pause"
                    : snapshot?.timer.status === "paused"
                      ? "Resume"
                      : "Start timer"}
                </button>
                <button
                  disabled={disabled || clockMode}
                  className="reset-button"
                  onClick={() =>
                    changeLive(
                      { type: "reset" },
                      "Reset the LIVE countdown to its original loaded duration, paused.",
                    )
                  }
                >
                  <RotateCcw size={17} />
                  <span>Reset</span>
                </button>
              </div>
              <div className="adjustments">
                <span className="control-caption">ADJUST LIVE TIME</span>
                <div>
                  {(
                    [
                      -600000, -300000, -60000, -30000, 30000, 60000, 300000,
                      600000,
                    ] as const
                  ).map((deltaMs) => {
                    const seconds = Math.abs(deltaMs) < 60000;
                    const amount = Math.abs(deltaMs) / (seconds ? 1000 : 60000);
                    return (
                      <button
                        key={deltaMs}
                        disabled={disabled || clockMode}
                        aria-label={`${deltaMs > 0 ? "Add" : "Subtract"} ${amount} ${seconds ? "seconds" : "minutes"}`}
                        onClick={() => command({ type: "adjust", deltaMs })}
                      >
                        {deltaMs > 0 ? "+" : "−"}
                        {amount}
                        <span>{seconds ? "s" : "m"}</span>
                      </button>
                    );
                  })}
                </div>
                <form
                  className="live-time-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const remainingMs = parseLiveTime(liveTime);
                    if (remainingMs !== null && !disabled && !clockMode)
                      command({ type: "setLiveTime", remainingMs });
                  }}
                >
                  <label htmlFor="live-time">Custom LIVE time</label>
                  <input
                    id="live-time"
                    type="text"
                    placeholder="12:30 or 15"
                    value={liveTime}
                    maxLength={6}
                    autoComplete="off"
                    aria-describedby="live-time-help"
                    disabled={disabled || clockMode}
                    onChange={(event) => setLiveTime(event.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={
                      disabled || clockMode || parseLiveTime(liveTime) === null
                    }
                  >
                    Set LIVE time
                  </button>
                  <p id="live-time-help" className="muted">
                    Enter minutes or MM:SS (up to 999:00). Applies immediately;
                    running stays running, paused stays paused.
                  </p>
                </form>
              </div>
            </div>
            <section
              className="panel duration-panel"
              id="panel-staging"
              role="tabpanel"
              aria-labelledby="tab-staging"
              hidden={outputTab !== "staging"}
            >
              <div className="section-heading">
                <h2>Prepare next output</h2>
                <span className="subtle-chip">OFF AIR · Safe to edit</span>
              </div>
              <div
                className="display-mode-controls"
                role="group"
                aria-label="Prepared display mode"
              >
                <button
                  disabled={disabled}
                  aria-pressed={preparedMode === "countdown"}
                  onClick={() =>
                    command({ type: "setDisplayMode", mode: "countdown" })
                  }
                >
                  <Timer size={16} />
                  Countdown
                </button>
                <button
                  disabled={disabled}
                  aria-pressed={preparedMode === "clock"}
                  onClick={() =>
                    command({ type: "setDisplayMode", mode: "clock" })
                  }
                >
                  <Clock size={16} />
                  Current Time
                </button>
              </div>
              <div className="clock-timezone-control">
                <label htmlFor="clock-timezone">Clock timezone</label>
                <select
                  id="clock-timezone"
                  disabled={disabled}
                  value={preparedZone}
                  onChange={(event) =>
                    command({
                      type: "setClockTimeZone",
                      timeZone: event.target.value as ClockTimeZone,
                    })
                  }
                >
                  {CLOCK_TIME_ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {clockTimeZoneLabels[zone].label}
                    </option>
                  ))}
                </select>
                <p>Off air until TAKE. Daylight saving time is automatic.</p>
              </div>
              <div className="prepare-navigation">
                <button
                  disabled={disabled || index <= 0}
                  aria-label="Previous presenter"
                  title="Prepare previous presenter; LIVE stays unchanged"
                  onClick={() => command({ type: "step", direction: -1 })}
                >
                  <ChevronLeft size={18} /> Previous
                </button>
                <button
                  disabled={disabled || index >= sessions.length - 1}
                  aria-label="Next presenter"
                  title="Prepare next presenter; LIVE stays unchanged"
                  onClick={() => command({ type: "step", direction: 1 })}
                >
                  Next <ChevronRight size={18} />
                </button>
              </div>
              <div className="prepared-summary">
                <span>
                  {preparedMode === "clock"
                    ? clockTimeZoneLabels[preparedZone].heading
                    : (current?.name ?? "Preparing…")}
                </span>
                <div className="preview-clock">
                  <Digits
                    value={
                      preparedMode === "clock"
                        ? formatClockTime(serverNow, preparedZone)
                        : formatTime(snapshot?.preparedDurationMs ?? 0)
                    }
                  />
                </div>
                <p>
                  Session selection, modes, timezones, presets, and rundown
                  edits stay off air. LIVE output keeps going until TAKE.
                </p>
              </div>
              <div className="presets">
                {[15, 30, 45, 60, 90].map((n) => (
                  <button
                    key={n}
                    disabled={disabled}
                    className={
                      snapshot?.preparedDurationMs === n * 60000
                        ? "selected"
                        : ""
                    }
                    onClick={() =>
                      command({ type: "setDuration", durationMs: n * 60000 })
                    }
                  >
                    {n}
                    <span>min</span>
                  </button>
                ))}
              </div>
              <form
                className="custom-duration"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = Number(custom);
                  if (value >= 1 / 60 && value <= 999)
                    command({
                      type: "setDuration",
                      durationMs: Math.round(value * 60000),
                    });
                }}
              >
                <label htmlFor="custom-duration">Custom duration</label>
                <div className="input-unit">
                  <input
                    id="custom-duration"
                    type="number"
                    min={1 / 60}
                    max={999}
                    step="any"
                    required
                    placeholder="Minutes"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                  />
                  <span>min</span>
                </div>
                <button disabled={disabled || !custom} type="submit">
                  Prepare timer
                </button>
              </form>
              <div className="prepared-actions">
                <button
                  className="primary take-button"
                  disabled={disabled}
                  onClick={() =>
                    changeLive(
                      { type: "take" },
                      preparedMode === "clock"
                        ? `Take ${clockTimeZoneLabels[preparedZone].label} clock LIVE.`
                        : `Take ${current?.name ?? "the prepared timer"} LIVE, paused. Press Start when ready.`,
                    )
                  }
                >
                  TAKE
                </button>
                <p>
                  {preparedMode === "clock"
                    ? "TAKE sends the selected clock to every display."
                    : "TAKE loads this timer paused. Open LIVE Output and press Start to begin."}
                </p>
              </div>
            </section>
            <section className="panel display-panel">
              <span className="display-icon">
                <Monitor size={21} />
              </span>
              <div>
                <h2>Presenter display</h2>
                <p className="muted">
                  <span className={connected ? "viewer-dot" : ""} />
                  {snapshot?.viewers ?? 0} connected{" "}
                  {snapshot?.viewers === 1 ? "viewer" : "viewers"}
                  <span className="dot-separator">·</span>Read-only
                </p>
              </div>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(displayUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                  } catch {
                    setNotice(`Display URL: ${displayUrl}`);
                  }
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                <span>{copied ? "Copied" : "Copy URL"}</span>
              </button>
            </section>
          </section>
          <aside className="panel rundown-panel">
            <div className="rundown-header">
              <div>
                <p className="eyebrow">THE RUN OF SHOW</p>
                <h2>
                  Session rundown <span>{sessions.length}</span>
                </h2>
              </div>
              <button
                className="icon-button add-session"
                disabled={disabled}
                aria-label="Add session"
                onClick={() => setEditor(null)}
              >
                <Plus size={21} />
              </button>
            </div>
            <p className="rundown-edit-note">
              Edit, add, delete, reorder, or select sessions freely. Everything
              here stays off air until you press TAKE.
            </p>
            <div className="rundown-meta">
              <span>PRESENTER / SESSION</span>
              <span>DURATION</span>
            </div>
            <ol className="session-list">
              {sessions.map((session, i) => (
                <li
                  key={session.id}
                  className={
                    current?.id === session.id ? "current-session" : ""
                  }
                >
                  <div className="session-row">
                    <span className="row-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <button
                      className="session-select"
                      aria-label={`Prepare ${session.name}`}
                      title="Prepare this session; LIVE output stays unchanged"
                      disabled={disabled}
                      onClick={() => {
                        command({ type: "select", id: session.id });
                        setOutputTab("staging");
                      }}
                    >
                      <span>{session.name}</span>
                      {current?.id === session.id && <small>PREPARED</small>}
                      {session.id === liveSession?.id && (
                        <small className="live-row-label">LIVE SOURCE</small>
                      )}
                    </button>
                    <span className="row-duration">
                      {formatTime(session.durationMs)}
                    </span>
                  </div>
                  <div className="row-actions">
                    <GripVertical size={13} />
                    <button
                      className="icon-button"
                      aria-label={`Move ${session.name} up`}
                      disabled={disabled || i === 0}
                      onClick={() =>
                        command({ type: "move", id: session.id, direction: -1 })
                      }
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Move ${session.name} down`}
                      disabled={disabled || i === sessions.length - 1}
                      onClick={() =>
                        command({ type: "move", id: session.id, direction: 1 })
                      }
                    >
                      <ArrowDown size={14} />
                    </button>
                    <span className="row-action-space" />
                    <button
                      className="icon-button session-edit"
                      aria-label={`Edit ${session.name}`}
                      title="Edit agenda only; keep the current display running"
                      disabled={disabled}
                      onClick={() => setEditor(session)}
                    >
                      <Pencil size={14} />
                      Edit
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Duplicate ${session.name}`}
                      disabled={disabled}
                      onClick={() =>
                        command({ type: "duplicate", id: session.id })
                      }
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Delete ${session.name}`}
                      disabled={disabled || sessions.length === 1}
                      title="Delete from rundown; LIVE output stays unchanged"
                      onClick={() => setDeleteId(session.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {deleteId === session.id && (
                    <div className="delete-confirm">
                      Delete this session?
                      <button
                        onClick={() => {
                          command({ type: "delete", id: session.id });
                          setDeleteId(null);
                        }}
                        disabled={disabled}
                      >
                        Delete
                      </button>
                      <button onClick={() => setDeleteId(null)}>Cancel</button>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <button
              className="add-session-button"
              disabled={disabled}
              onClick={() => setEditor(null)}
            >
              <Plus size={17} />
              Add session
            </button>
            <div className="manual-note">
              <span className="manual-note-icon">
                <Pause size={14} />
              </span>
              <div>
                <strong>You call the start.</strong>
                <p>
                  Selecting sessions only prepares them. Press TAKE to send the
                  prepared output LIVE. Countdowns load paused and require
                  Start.
                </p>
              </div>
            </div>
            <div className="rundown-footer">
              <span>
                {sessions.length}{" "}
                {sessions.length === 1 ? "session" : "sessions"}
              </span>
              <span>
                {Math.round(
                  sessions.reduce((total, s) => total + s.durationMs, 0) /
                    60000,
                )}{" "}
                min total
              </span>
            </div>
          </aside>
        </div>
        <footer className="page-footer">
          <span>
            <span className="footer-dot" /> Built for the moments that matter.
          </span>
          <span>SERVER-SYNCHRONIZED TIMING</span>
        </footer>
      </main>
      {liveChange && (
        <LiveConfirmation
          label={liveChange.label}
          disabled={disabled}
          onCancel={() => setLiveChange(null)}
          onConfirm={() => {
            command(liveChange.command, liveChange.revision);
            setLiveChange(null);
          }}
        />
      )}
      {editor !== undefined && (
        <SessionEditor
          session={editor}
          onClose={() => setEditor(undefined)}
          onSave={(name, durationMs) =>
            command(
              editor
                ? { type: "update", id: editor.id, name, durationMs }
                : { type: "add", name, durationMs },
            )
          }
        />
      )}
    </div>
  );
}
function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [failed, setFailed] = useState(false);
  const display = location.pathname === "/display";
  async function check() {
    try {
      setFailed(false);
      const response = await fetch("/api/auth");
      if (!response.ok) throw Error();
      setAuth((await response.json()).authenticated);
    } catch {
      setFailed(true);
    }
  }
  useEffect(() => {
    if (!display) void check();
  }, [display]);
  if (display) return <Display />;
  if (failed)
    return (
      <main className="login-page">
        <div className="login-card">
          <h1>Can’t reach the server.</h1>
          <p className="muted">Check your connection and try again.</p>
          <button onClick={() => void check()}>Retry</button>
        </div>
      </main>
    );
  if (auth === null)
    return (
      <main className="login-page">
        <p className="muted">Connecting to your workspace…</p>
      </main>
    );
  return auth ? (
    <Controller onLogout={() => setAuth(false)} />
  ) : (
    <Login onLogin={() => setAuth(true)} />
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
