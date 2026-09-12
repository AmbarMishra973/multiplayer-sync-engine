/**
 * Client Transport and Sync Connection Layer
 * Built on native browser WebSocket API with zero external socket libraries.
 * Handles room membership, throttling, sequence ordering, RTT measurement, and simulated network degradation.
 */

import {
  ClientAction,
  RemotePeerState,
  ServerMessage,
  parseServerMessage,
} from "./protocol";

export interface RoomOptions {
  roomId: string;
  clientId: string;
  name?: string;
  color?: string;
  wsUrl?: string;
  throttleIntervalMs?: number; // Cursor send throttle interval (default: 30ms ~ 33Hz)
}

export interface ClientMetrics {
  rttMs: number;
  jitterMs: number;
  packetsSent: number;
  packetsReceived: number;
  remoteUpdatesPerSec: number;
  connected: boolean;
}

export interface SimulatedNetworkConfig {
  latencyMs: number;
  jitterMs: number;
  packetLossRate: number; // 0.0 to 1.0
}

export interface RoomHandle {
  roomId: string;
  clientId: string;
  sendAction: (action: ClientAction) => void;
  onRemoteAction: (cb: (clientId: string, action: ClientAction) => void) => () => void;
  onStateSnapshot: (cb: (clients: RemotePeerState[], hypeCount: number) => void) => () => void;
  onPeerJoin: (cb: (peer: RemotePeerState) => void) => () => void;
  onPeerLeave: (cb: (clientId: string, reason: string) => void) => () => void;
  onHypeUpdate: (cb: (totalCount: number, recentTapperId: string) => void) => () => void;
  onMetrics: (cb: (metrics: ClientMetrics) => void) => () => void;
  setSimulatedNetwork: (config: Partial<SimulatedNetworkConfig>) => void;
  reconnect: () => void;
  destroy: () => void;
}

export function createRoom(options: RoomOptions): RoomHandle {
  const {
    roomId,
    clientId,
    name = `Viewer-${clientId.slice(0, 4)}`,
    color = "#3b82f6",
    wsUrl = `ws://${window.location.hostname}:8080`,
    throttleIntervalMs = 30,
  } = options;

  let ws: WebSocket | null = null;
  let isDestroyed = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let localSeq = 0;

  // Throttling state for continuous cursor updates
  let lastCursorSentTime = 0;
  let pendingCursor: { x: number; y: number } | null = null;
  let cursorTrailingTimer: number | null = null;

  // RTT & Jitter tracking
  let lastPingSentTs = 0;
  let measuredRtt = 0;
  let measuredJitter = 0;
  let pingTimer: number | null = null;

  // Metrics counters
  let packetsSent = 0;
  let packetsReceived = 0;
  let receivedUpdatesInSecond = 0;
  let remoteUpdatesPerSec = 0;
  let updatesRateInterval: number | null = null;

  // Simulated network degradation
  let simulatedNet: SimulatedNetworkConfig = {
    latencyMs: 0,
    jitterMs: 0,
    packetLossRate: 0,
  };

  // Event callbacks
  const remoteActionListeners = new Set<(clientId: string, action: ClientAction) => void>();
  const stateSnapshotListeners = new Set<(clients: RemotePeerState[], hypeCount: number) => void>();
  const peerJoinListeners = new Set<(peer: RemotePeerState) => void>();
  const peerLeaveListeners = new Set<(clientId: string, reason: string) => void>();
  const hypeUpdateListeners = new Set<(totalCount: number, recentTapperId: string) => void>();
  const metricsListeners = new Set<(metrics: ClientMetrics) => void>();

  function notifyMetrics() {
    const metrics: ClientMetrics = {
      rttMs: Math.round(measuredRtt),
      jitterMs: Math.round(measuredJitter),
      packetsSent,
      packetsReceived,
      remoteUpdatesPerSec,
      connected: ws?.readyState === WebSocket.OPEN,
    };
    metricsListeners.forEach((cb) => cb(metrics));
  }

  function emitOutgoingRaw(payload: Record<string, unknown>) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    packetsSent++;
    const jsonStr = JSON.stringify(payload);

    // If simulated latency/jitter or packet loss is enabled, apply it
    if (simulatedNet.packetLossRate > 0 && Math.random() < simulatedNet.packetLossRate) {
      // Packet dropped synthetically for testing
      return;
    }

    const delay =
      simulatedNet.latencyMs +
      (simulatedNet.jitterMs > 0 ? (Math.random() * 2 - 1) * simulatedNet.jitterMs : 0);

    if (delay > 2) {
      window.setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(jsonStr);
        }
      }, delay);
    } else {
      ws.send(jsonStr);
    }
  }

  function flushCursor(x: number, y: number) {
    localSeq++;
    const now = performance.now();
    lastCursorSentTime = now;
    pendingCursor = null;

    emitOutgoingRaw({
      type: "cursor",
      seq: localSeq,
      ts: Date.now(),
      x,
      y,
    });
  }

  function connect() {
    if (isDestroyed) return;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.warn("[ClientSync] Connection init error:", err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      // Send join message
      emitOutgoingRaw({
        type: "join",
        roomId,
        clientId,
        name,
        color,
      });

      startPingHeartbeat();
      notifyMetrics();
    };

    ws.onmessage = (event) => {
      packetsReceived++;
      receivedUpdatesInSecond++;

      try {
        const raw = JSON.parse(event.data);
        const msg = parseServerMessage(raw);
        if (!msg) return;

        handleServerMessage(msg);
      } catch (err) {
        console.error("[ClientSync] Failed to parse message:", err);
      }
    };

    ws.onclose = () => {
      notifyMetrics();
      stopPingHeartbeat();
      if (!isDestroyed) {
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.warn("[ClientSync] WebSocket error:", err);
      // onclose will trigger next
    };
  }

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome":
        break;

      case "room_state":
        stateSnapshotListeners.forEach((cb) => cb(msg.clients, msg.hypeCount));
        break;

      case "client_joined":
        peerJoinListeners.forEach((cb) => cb(msg.client));
        break;

      case "client_left":
        peerLeaveListeners.forEach((cb) => cb(msg.clientId, msg.reason));
        break;

      case "cursor": {
        const action: ClientAction = {
          type: "cursor",
          x: msg.x,
          y: msg.y,
          seq: msg.seq,
          ts: msg.ts,
        };
        remoteActionListeners.forEach((cb) => cb(msg.clientId, action));
        break;
      }

      case "reaction": {
        const action: ClientAction = {
          type: "reaction",
          emoji: msg.emoji,
          x: msg.x,
          y: msg.y,
          seq: msg.seq,
          ts: msg.ts,
        };
        remoteActionListeners.forEach((cb) => cb(msg.clientId, action));
        break;
      }

      case "hype_update":
        hypeUpdateListeners.forEach((cb) => cb(msg.totalCount, msg.recentTapperId));
        break;

      case "pong": {
        const rtt = Date.now() - msg.clientTs;
        if (measuredRtt === 0) {
          measuredRtt = rtt;
        } else {
          // Rolling Exponential Moving Average (EMA)
          const diff = Math.abs(rtt - measuredRtt);
          measuredJitter = measuredJitter * 0.8 + diff * 0.2;
          measuredRtt = measuredRtt * 0.8 + rtt * 0.2;
        }
        notifyMetrics();
        break;
      }

      case "error":
        console.warn("[ClientSync] Server rejected action:", msg.code, msg.message);
        break;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null || isDestroyed) return;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 8000);
    reconnectAttempts++;
    console.log(`[ClientSync] Reconnecting in ${Math.round(delay)}ms (Attempt ${reconnectAttempts})...`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startPingHeartbeat() {
    stopPingHeartbeat();
    pingTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        lastPingSentTs = Date.now();
        emitOutgoingRaw({ type: "ping", ts: lastPingSentTs });
      }
    }, 4000);
  }

  function stopPingHeartbeat() {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  // Updates-per-second calculation interval
  updatesRateInterval = window.setInterval(() => {
    remoteUpdatesPerSec = receivedUpdatesInSecond;
    receivedUpdatesInSecond = 0;
    notifyMetrics();
  }, 1000);

  // Initialize connection
  connect();

  // Core API object
  return {
    roomId,
    clientId,

    sendAction(action: ClientAction) {
      if (action.type === "cursor") {
        const now = performance.now();
        const elapsed = now - lastCursorSentTime;

        // Immediate dispatch if interval has passed
        if (elapsed >= throttleIntervalMs) {
          if (cursorTrailingTimer !== null) {
            clearTimeout(cursorTrailingTimer);
            cursorTrailingTimer = null;
          }
          flushCursor(action.x, action.y);
        } else {
          // Schedule trailing edge dispatch so last position is never dropped
          pendingCursor = { x: action.x, y: action.y };
          if (cursorTrailingTimer === null) {
            cursorTrailingTimer = window.setTimeout(() => {
              cursorTrailingTimer = null;
              if (pendingCursor) {
                flushCursor(pendingCursor.x, pendingCursor.y);
              }
            }, throttleIntervalMs - elapsed);
          }
        }
      } else if (action.type === "reaction") {
        localSeq++;
        emitOutgoingRaw({
          type: "reaction",
          seq: localSeq,
          ts: Date.now(),
          emoji: action.emoji,
          x: action.x,
          y: action.y,
        });
      } else if (action.type === "hype_tap") {
        localSeq++;
        emitOutgoingRaw({
          type: "hype_tap",
          seq: localSeq,
          ts: Date.now(),
        });
      }
    },

    onRemoteAction(cb) {
      remoteActionListeners.add(cb);
      return () => remoteActionListeners.delete(cb);
    },

    onStateSnapshot(cb) {
      stateSnapshotListeners.add(cb);
      return () => stateSnapshotListeners.delete(cb);
    },

    onPeerJoin(cb) {
      peerJoinListeners.add(cb);
      return () => peerJoinListeners.delete(cb);
    },

    onPeerLeave(cb) {
      peerLeaveListeners.add(cb);
      return () => peerLeaveListeners.delete(cb);
    },

    onHypeUpdate(cb) {
      hypeUpdateListeners.add(cb);
      return () => hypeUpdateListeners.delete(cb);
    },

    onMetrics(cb) {
      metricsListeners.add(cb);
      return () => metricsListeners.delete(cb);
    },

    setSimulatedNetwork(config) {
      simulatedNet = { ...simulatedNet, ...config };
    },

    reconnect() {
      if (ws) {
        ws.close();
      }
      connect();
    },

    destroy() {
      isDestroyed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (cursorTrailingTimer !== null) clearTimeout(cursorTrailingTimer);
      if (updatesRateInterval !== null) clearInterval(updatesRateInterval);
      stopPingHeartbeat();
      if (ws) {
        ws.close(1000, "Client leaving");
        ws = null;
      }
      remoteActionListeners.clear();
      stateSnapshotListeners.clear();
      peerJoinListeners.clear();
      peerLeaveListeners.clear();
      hypeUpdateListeners.clear();
      metricsListeners.clear();
    },
  };
}
