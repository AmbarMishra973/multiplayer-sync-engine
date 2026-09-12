/**
 * Real-Time Multiplayer State Sync Protocol
 * Defines strictly typed wire schemas, type guards, and validation for client-server communication.
 */

export interface RemotePeerState {
  clientId: string;
  name: string;
  color: string;
  cursor?: {
    x: number;
    y: number;
    seq: number;
    ts: number;
  };
  lastSeenTs: number;
}

// ==========================================
// Client Actions (dispatched via room.sendAction)
// ==========================================

export interface CursorAction {
  type: "cursor";
  x: number; // Normalized coordinate [0, 1]
  y: number; // Normalized coordinate [0, 1]
  seq?: number; // Monotonically increasing sequence number
  ts?: number; // Client timestamp in ms (performance.now or Date.now)
}

export interface ReactionAction {
  type: "reaction";
  emoji: string;
  x: number; // Normalized coordinate [0, 1]
  y: number; // Normalized coordinate [0, 1]
  seq?: number;
  ts?: number;
}

export interface HypeTapAction {
  type: "hype_tap";
  seq?: number;
  ts?: number;
}

export type ClientAction = CursorAction | ReactionAction | HypeTapAction;

// ==========================================
// Client -> Server Wire Messages
// ==========================================

export interface JoinMessage {
  type: "join";
  roomId: string;
  clientId: string;
  name: string;
  color: string;
}

export interface CursorWireMessage {
  type: "cursor";
  seq: number;
  ts: number;
  x: number;
  y: number;
}

export interface ReactionWireMessage {
  type: "reaction";
  seq: number;
  ts: number;
  emoji: string;
  x: number;
  y: number;
}

export interface HypeTapWireMessage {
  type: "hype_tap";
  seq: number;
  ts: number;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export type ClientMessage =
  | JoinMessage
  | CursorWireMessage
  | ReactionWireMessage
  | HypeTapWireMessage
  | PingMessage;

// ==========================================
// Server -> Client Wire Messages
// ==========================================

export interface WelcomeMessage {
  type: "welcome";
  clientId: string;
  roomId: string;
  serverTime: number;
  heartbeatIntervalMs: number;
}

export interface RoomStateMessage {
  type: "room_state";
  clients: RemotePeerState[];
  hypeCount: number;
}

export interface ClientJoinedMessage {
  type: "client_joined";
  client: RemotePeerState;
}

export interface ClientLeftMessage {
  type: "client_left";
  clientId: string;
  reason: "disconnect" | "timeout" | "left";
}

export interface CursorBroadcastMessage {
  type: "cursor";
  clientId: string;
  seq: number;
  ts: number;
  x: number;
  y: number;
}

export interface ReactionBroadcastMessage {
  type: "reaction";
  clientId: string;
  seq: number;
  ts: number;
  emoji: string;
  x: number;
  y: number;
}

export interface HypeUpdateMessage {
  type: "hype_update";
  totalCount: number;
  recentTapperId: string;
  timestamp: number;
}

export interface PongMessage {
  type: "pong";
  clientTs: number;
  serverTs: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | RoomStateMessage
  | ClientJoinedMessage
  | ClientLeftMessage
  | CursorBroadcastMessage
  | ReactionBroadcastMessage
  | HypeUpdateMessage
  | PongMessage
  | ErrorMessage;

// ==========================================
// Runtime Validation Helpers
// ==========================================

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isNumber(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val);
}

function isString(val: unknown): val is string {
  return typeof val === "string";
}

export function parseClientMessage(raw: unknown): ValidationResult<ClientMessage> {
  if (!isObject(raw)) {
    return { success: false, error: "Message must be a JSON object" };
  }

  const type = raw.type;
  if (!isString(type)) {
    return { success: false, error: "Message missing string 'type' property" };
  }

  switch (type) {
    case "join": {
      if (!isString(raw.roomId) || raw.roomId.trim().length === 0) {
        return { success: false, error: "join message requires non-empty string roomId" };
      }
      if (!isString(raw.clientId) || raw.clientId.trim().length === 0) {
        return { success: false, error: "join message requires non-empty string clientId" };
      }
      return {
        success: true,
        data: {
          type: "join",
          roomId: raw.roomId.trim(),
          clientId: raw.clientId.trim(),
          name: isString(raw.name) && raw.name.trim() ? raw.name.trim() : `Viewer-${raw.clientId.slice(0, 4)}`,
          color: isString(raw.color) && raw.color.trim() ? raw.color.trim() : "#6366f1",
        },
      };
    }

    case "cursor": {
      if (!isNumber(raw.x) || !isNumber(raw.y)) {
        return { success: false, error: "cursor coordinates x and y must be numbers" };
      }
      // Clamp coordinates to normalized range [0, 1]
      const clampedX = Math.max(0, Math.min(1, raw.x));
      const clampedY = Math.max(0, Math.min(1, raw.y));
      const seq = isNumber(raw.seq) ? raw.seq : 0;
      const ts = isNumber(raw.ts) ? raw.ts : Date.now();
      return {
        success: true,
        data: {
          type: "cursor",
          x: clampedX,
          y: clampedY,
          seq,
          ts,
        },
      };
    }

    case "reaction": {
      if (!isString(raw.emoji) || raw.emoji.length === 0) {
        return { success: false, error: "reaction requires an emoji string" };
      }
      if (!isNumber(raw.x) || !isNumber(raw.y)) {
        return { success: false, error: "reaction coordinates x and y must be numbers" };
      }
      const clampedX = Math.max(0, Math.min(1, raw.x));
      const clampedY = Math.max(0, Math.min(1, raw.y));
      const seq = isNumber(raw.seq) ? raw.seq : 0;
      const ts = isNumber(raw.ts) ? raw.ts : Date.now();
      return {
        success: true,
        data: {
          type: "reaction",
          emoji: raw.emoji.slice(0, 10), // Limit length to avoid massive payloads
          x: clampedX,
          y: clampedY,
          seq,
          ts,
        },
      };
    }

    case "hype_tap": {
      const seq = isNumber(raw.seq) ? raw.seq : 0;
      const ts = isNumber(raw.ts) ? raw.ts : Date.now();
      return {
        success: true,
        data: {
          type: "hype_tap",
          seq,
          ts,
        },
      };
    }

    case "ping": {
      const ts = isNumber(raw.ts) ? raw.ts : Date.now();
      return {
        success: true,
        data: {
          type: "ping",
          ts,
        },
      };
    }

    default:
      return { success: false, error: `Unknown client message type: '${String(type)}'` };
  }
}

export function parseServerMessage(raw: unknown): ValidationResult<ServerMessage> {
  if (!isObject(raw)) {
    return { success: false, error: "Server payload is not a JSON object" };
  }
  const type = raw.type;
  if (!isString(type)) {
    return { success: false, error: "Server payload missing 'type'" };
  }

  switch (type) {
    case "welcome":
    case "room_state":
    case "client_joined":
    case "client_left":
    case "cursor":
    case "reaction":
    case "hype_update":
    case "pong":
    case "error":
      return { success: true, data: raw as unknown as ServerMessage };
    default:
      return { success: false, error: `Unrecognized server message type: '${String(type)}'` };
  }
}
