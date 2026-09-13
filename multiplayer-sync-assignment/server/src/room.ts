/**
 * Room and Presence Manager
 * Handles client membership, state snapshots, broadcast fan-out, and conflict reconciliation.
 */

import {
  RemotePeerState,
  ServerMessage,
  CursorBroadcastMessage,
  ReactionBroadcastMessage,
  HypeUpdateMessage,
} from "./protocol.js";

export interface ConnectedSocket {
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
  isAlive: boolean;
}

export interface Peer {
  clientId: string;
  name: string;
  color: string;
  socket: ConnectedSocket;
  lastSeenTs: number;
  lastSeq: number;
  cursor?: {
    x: number;
    y: number;
    seq: number;
    ts: number;
  };
}

export class Room {
  readonly roomId: string;
  private readonly peers = new Map<string, Peer>();
  private hypeCount = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  getPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  getPeer(clientId: string): Peer | undefined {
    return this.peers.get(clientId);
  }

  /**
   * Adds or updates a peer in the room.
   * Handles reconnecting peers gracefully without creating ghost cursors.
   */
  join(clientId: string, name: string, color: string, socket: ConnectedSocket): void {
    const existing = this.peers.get(clientId);
    const isReconnect = !!existing;

    if (existing && existing.socket !== socket) {
      try {
        existing.socket.close(1000, "Replaced by new connection");
      } catch {
        // Socket may already be dead
      }
    }

    const peer: Peer = {
      clientId,
      name,
      color,
      socket,
      lastSeenTs: Date.now(),
      lastSeq: existing ? existing.lastSeq : 0,
      cursor: existing?.cursor,
    };

    this.peers.set(clientId, peer);

    // 1. Send the newly connected client a full room state snapshot
    const activeRemoteClients: RemotePeerState[] = [];
    for (const [id, p] of this.peers.entries()) {
      if (id !== clientId) {
        activeRemoteClients.push({
          clientId: p.clientId,
          name: p.name,
          color: p.color,
          cursor: p.cursor,
          lastSeenTs: p.lastSeenTs,
        });
      }
    }

    const roomStateMsg: ServerMessage = {
      type: "room_state",
      clients: activeRemoteClients,
      hypeCount: this.hypeCount,
    };
    socket.sendText(JSON.stringify(roomStateMsg));

    // 2. Broadcast presence join to all other participants
    const joinMsg: ServerMessage = {
      type: "client_joined",
      client: {
        clientId: peer.clientId,
        name: peer.name,
        color: peer.color,
        cursor: peer.cursor,
        lastSeenTs: peer.lastSeenTs,
      },
    };
    this.broadcast(joinMsg, clientId);
  }

  /**
   * Removes a peer upon disconnect or timeout.
   */
  leave(clientId: string, reason: "disconnect" | "timeout" | "left" = "disconnect"): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;

    this.peers.delete(clientId);

    // Notify all remaining peers
    const leaveMsg: ServerMessage = {
      type: "client_left",
      clientId,
      reason,
    };
    this.broadcast(leaveMsg);
  }

  /**
   * Processes high-frequency cursor coordinates.
   * Enforces sequence order validation and relays to other peers (O(N) fan-out, no echo).
   */
  handleCursor(clientId: string, seq: number, ts: number, x: number, y: number): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;

    // Discard stale or out-of-order sequence updates
    if (seq <= peer.lastSeq && Math.abs(seq - peer.lastSeq) < 100000) {
      return;
    }

    peer.lastSeq = seq;
    peer.lastSeenTs = Date.now();
    peer.cursor = { x, y, seq, ts };

    const cursorMsg: CursorBroadcastMessage = {
      type: "cursor",
      clientId,
      seq,
      ts,
      x,
      y,
    };
    this.broadcast(cursorMsg, clientId);
  }

  /**
   * Relays discrete reaction bursts to all other participants.
   */
  handleReaction(clientId: string, seq: number, ts: number, emoji: string, x: number, y: number): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;

    peer.lastSeenTs = Date.now();

    const reactionMsg: ReactionBroadcastMessage = {
      type: "reaction",
      clientId,
      seq,
      ts,
      emoji,
      x,
      y,
    };
    this.broadcast(reactionMsg, clientId);
  }

  /**
   * Reconciles collaborative fan-hype button taps (conflict resolution).
   * Server maintains authoritative atomic counter and broadcasts updated total to all clients.
   */
  handleHypeTap(clientId: string): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;

    peer.lastSeenTs = Date.now();
    this.hypeCount += 1;

    const hypeMsg: HypeUpdateMessage = {
      type: "hype_update",
      totalCount: this.hypeCount,
      recentTapperId: clientId,
      timestamp: Date.now(),
    };

    // Broadcast to ALL peers so sender also receives authoritative reconciled count
    this.broadcast(hypeMsg);
  }

  /**
   * Prunes dead or silent connections that failed heartbeat pong.
   */
  sweepDeadClients(maxIdleMs = 25000): void {
    const now = Date.now();
    for (const [clientId, peer] of this.peers.entries()) {
      if (now - peer.lastSeenTs > maxIdleMs) {
        try {
          peer.socket.close(1001, "Heartbeat timeout");
        } catch {
          // ignore
        }
        this.leave(clientId, "timeout");
      }
    }
  }

  /**
   * Broadcasts a JSON message to room members.
   * Skips sender if excludeClientId is provided to prevent wasteful echo.
   */
  broadcast(message: ServerMessage, excludeClientId?: string): void {
    const serialized = JSON.stringify(message);
    for (const [clientId, peer] of this.peers.entries()) {
      if (excludeClientId && clientId === excludeClientId) {
        continue;
      }
      try {
        peer.socket.sendText(serialized);
      } catch (err) {
        console.error(`[Room ${this.roomId}] Failed to send to ${clientId}:`, err);
      }
    }
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly clientToRoom = new Map<string, string>();

  getOrCreateRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  registerClient(roomId: string, clientId: string): void {
    this.clientToRoom.set(clientId, roomId);
  }

  findRoomByClientId(clientId: string): Room | undefined {
    const roomId = this.clientToRoom.get(clientId);
    if (!roomId) return undefined;
    return this.rooms.get(roomId);
  }

  unregisterClient(clientId: string, socket?: ConnectedSocket): void {
    const roomId = this.clientToRoom.get(clientId);
    if (roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
        const peer = room.getPeer(clientId);
        // If socket is provided and does not match the active peer's socket, ignore old close event
        if (peer && socket && peer.socket !== socket) {
          return;
        }
        this.clientToRoom.delete(clientId);
        room.leave(clientId, "disconnect");
        if (room.peerCount === 0) {
          this.rooms.delete(roomId);
        }
      }
    }
  }

  sweepAllDeadClients(): void {
    for (const [roomId, room] of this.rooms.entries()) {
      room.sweepDeadClients();
      if (room.peerCount === 0) {
        this.rooms.delete(roomId);
      }
    }
  }
}
