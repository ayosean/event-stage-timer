import { useEffect, useRef, useState } from "react";
import { remaining, type Command, type Snapshot } from "../shared/timer";
export function useTimer(
  role: "display" | "controller",
  enabled = true,
  onUnauthorized?: () => void,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [ms, setMs] = useState(0);
  const [serverNow, setServerNow] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const current = useRef<Snapshot | null>(null);
  const clock = useRef<{ epoch: number; mono: number; bestRTT: number } | null>(
    null,
  );
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout>;
    let sync: ReturnType<typeof setInterval>;
    let watchdog: ReturnType<typeof setInterval>;
    let tries = 0;
    let lastMessage = performance.now();
    let clockSamples: { epoch: number; mono: number; rtt: number }[] = [];
    function connect() {
      if (disposed) return;
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${role}`,
      );
      ws.current = socket;
      const synchronize = () => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "sync", sent: performance.now() }),
          );
      };
      socket.onopen = () => {
        if (disposed || ws.current !== socket) return;
        clockSamples = [];
        tries = 0;
        lastMessage = performance.now();
        clock.current = null;
        setConnected(false);
        setError("");
        synchronize();
        sync = setInterval(synchronize, 10000);
        watchdog = setInterval(() => {
          if (performance.now() - lastMessage > 30000) socket.close();
        }, 5000);
      };
      socket.onmessage = (event) => {
        if (disposed || ws.current !== socket) return;
        lastMessage = performance.now();
        const msg = JSON.parse(event.data);
        if (msg.type === "state") {
          if (!clock.current)
            clock.current = {
              epoch: msg.serverNow,
              mono: performance.now(),
              bestRTT: Infinity,
            };
          setConnected(true);
          current.current = msg;
          setSnapshot(msg);
        } else if (msg.type === "sync") {
          const received = performance.now();
          const rtt = received - msg.sent;
          // Keep a rolling minute of samples, so an old fast connection cannot
          // prevent later drift correction after the network changes.
          clockSamples = clockSamples.filter(
            (sample) => received - sample.mono < 60000,
          );
          clockSamples.push({
            epoch: msg.serverNow + rtt / 2,
            mono: received,
            rtt,
          });
          const best = clockSamples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
          clock.current = {
            epoch: best.epoch,
            mono: best.mono,
            bestRTT: best.rtt,
          };
        } else if (msg.type === "error") {
          setError(msg.error);
          setPending(false);
          clearTimeout(pendingTimer.current);
        } else if (msg.type === "ack") {
          setPending(false);
          clearTimeout(pendingTimer.current);
        }
      };
      socket.onclose = (event) => {
        if (disposed || ws.current !== socket) return;
        clearInterval(sync);
        clearInterval(watchdog);
        setConnected(false);
        setPending(false);
        clearTimeout(pendingTimer.current);
        if (event.code === 4001) {
          unauthorized.current?.();
          return;
        }
        if (role === "controller") {
          void fetch("/api/auth")
            .then((response) => (response.ok ? response.json() : null))
            .then((result) => {
              if (!disposed && result && !result.authenticated)
                unauthorized.current?.();
            })
            .catch(() => {});
        }
        reconnect = setTimeout(
          connect,
          Math.min(10000, 500 * 2 ** Math.min(tries++, 5)) +
            Math.random() * 250,
        );
      };
      socket.onerror = () => socket.close();
    }
    connect();
    const wake = () => {
      if (document.visibilityState === "visible") {
        const socket = ws.current;
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: "sync", sent: performance.now() }),
          );
        else if (socket?.readyState !== WebSocket.CONNECTING) {
          clearTimeout(reconnect);
          connect();
        }
      }
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      clearTimeout(pendingTimer.current);
      clearInterval(sync);
      clearInterval(watchdog);
      ws.current?.close();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [enabled, role]);
  useEffect(() => {
    const tick = () => {
      const s = current.current,
        c = clock.current;
      if (s && c) {
        const now = c.epoch + performance.now() - c.mono;
        setServerNow(Math.floor(now / 1000) * 1000);
        setMs(Math.ceil(remaining(s.timer, now) / 1000) * 1000);
      }
    };
    tick();
    const interval = setInterval(tick, 50);
    return () => clearInterval(interval);
  }, []);
  function command(command: Command, revision?: number) {
    if (
      ws.current?.readyState !== WebSocket.OPEN ||
      !current.current ||
      pending
    )
      return;
    setError("");
    setPending(true);
    ws.current.send(
      JSON.stringify({
        type: "command",
        id: crypto.randomUUID(),
        revision: revision ?? current.current.revision,
        command,
      }),
    );
    pendingTimer.current = setTimeout(() => {
      setPending(false);
      setError(
        "Command confirmation timed out. Check the current timer before trying again.",
      );
      ws.current?.close();
    }, 5000);
  }
  return {
    snapshot,
    connected,
    error,
    pending,
    ms,
    serverNow: serverNow || snapshot?.serverNow || 0,
    command,
    clearError: () => setError(""),
  };
}
