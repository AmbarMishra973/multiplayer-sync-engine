/**
 * Client-Side Protocol Schema Definitions and Validation
 * Mirrored from server protocol for full type-safety.
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

export interface CursorAction {
  type: "cursor";
  x: number;
  y: number;
  seq?: number;
  ts?: number;
}

export interface ReactionAction {
  type: "reaction";
  emoji: string;
  x: number;
  y: number;
  seq?: number;
  ts?: number;
}

export interface HypeTapAction {
  type: "hype_tap";
  seq?: number;
  ts?: number;
}

export type ClientAction = CursorAction | ReactionAction | HypeTapAction;

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

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== "string") {
    return null;
  }
  return obj as unknown as ServerMessage;
}
