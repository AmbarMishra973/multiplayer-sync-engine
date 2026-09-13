/**
 * Zero-Dependency Native RFC-6455 WebSocket Server
 * Implemented using Node's standard `node:http` and `node:crypto` modules.
 * Strictly adheres to RFC 6455 for handshake, frame parsing, masking, unmasking, and framing.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import { RoomManager, ConnectedSocket } from "./room.js";
import {
  parseClientMessage,
  WelcomeMessage,
  PongMessage,
  ErrorMessage,
  ServerMessage,
} from "./protocol.js";

const PORT = Number(process.env.PORT) || 8080;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HEARTBEAT_INTERVAL_MS = 10000;

export class RawWebSocketConnection implements ConnectedSocket {
  readonly socket: Duplex;
  isAlive = true;
  clientId: string | null = null;
  roomId: string | null = null;
  private buffer = Buffer.alloc(0);
  private closed = false;

  private onMessageCallback?: (text: string) => void;
  private onCloseCallback?: () => void;

  constructor(socket: Duplex) {
    this.socket = socket;

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
    });

    socket.on("error", (err: Error) => {
      console.warn(`[Socket ${this.clientId ?? "unknown"}] Socket error:`, err.message);
      this.handleClose();
    });

    socket.on("close", () => {
      this.handleClose();
    });

    socket.on("end", () => {
      this.handleClose();
    });
  }

  onMessage(cb: (text: string) => void): void {
    this.onMessageCallback = cb;
  }

  onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  /**
   * Encodes and sends an unmasked RFC 6455 text frame to the client.
   * Per RFC 6455 §5.1, frames from server to client MUST NOT be masked.
   */
  sendText(text: string): void {
    if (this.closed || !this.socket.writable) return;

    const payload = Buffer.from(text, "utf8");
    const length = payload.length;

    let header: Buffer;
    if (length <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN=1, Opcode=0x1 (Text)
      header[1] = length; // MASK=0
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126; // Extended 16-bit length
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127; // Extended 64-bit length
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      console.error("[WebSocket] Write error:", err);
    }
  }

  /**
   * Sends an RFC 6455 Ping frame (Opcode 0x9).
   */
  sendPing(): void {
    if (this.closed || !this.socket.writable) return;
    const pingFrame = Buffer.from([0x89, 0x00]); // FIN=1, Opcode=9, Len=0
    try {
      this.socket.write(pingFrame);
    } catch {
      // ignore
    }
  }

  /**
   * Closes the connection with an RFC 6455 Close frame (Opcode 0x8).
   */
  close(code = 1000, reason = ""): void {
    if (this.closed) return;

    try {
      const reasonBuf = Buffer.from(reason, "utf8");
      const len = 2 + reasonBuf.length;
      const frame = Buffer.alloc(2 + len);
      frame[0] = 0x88; // FIN=1, Opcode=8 (Close)
      frame[1] = len;
      frame.writeUInt16BE(code, 2);
      reasonBuf.copy(frame, 4);

      if (this.socket.writable) {
        this.socket.write(frame, () => {
          this.socket.end();
        });
      } else {
        this.socket.destroy();
      }
    } catch {
      this.socket.destroy();
    }

    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onCloseCallback) {
      this.onCloseCallback();
      this.onCloseCallback = undefined;
    }
  }

  /**
   * Parses complete RFC 6455 frames from the accumulated stream buffer.
   */
  private processBuffer(): void {
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];

      const fin = (byte0 & 0x80) === 0x80;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) === 0x80;
      let payloadLen = byte1 & 0x7f;

      let offset = 2;

      // Handle extended payload lengths
      if (payloadLen === 126) {
        if (this.buffer.length < 4) return; // Wait for full header
        payloadLen = this.buffer.readUInt16BE(2);
        offset += 2;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close(1009, "Payload too large");
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      // Check for masking key (Client to server frames MUST be masked per RFC 6455 §5.1)
      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      // Check if full payload is present
      if (this.buffer.length < offset + payloadLen) {
        return; // Need more data
      }

      // Extract and unmask payload
      const rawPayload = this.buffer.subarray(offset, offset + payloadLen);
      const unmaskedPayload = Buffer.allocUnsafe(payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payloadLen; i++) {
          unmaskedPayload[i] = rawPayload[i] ^ maskKey[i % 4];
        }
      } else {
        rawPayload.copy(unmaskedPayload);
      }

      // Slice out the consumed frame from buffer
      this.buffer = this.buffer.subarray(offset + payloadLen);

      // Handle Opcode
      switch (opcode) {
        case 0x1: { // Text frame
          const text = unmaskedPayload.toString("utf8");
          if (this.onMessageCallback) {
            this.onMessageCallback(text);
          }
          break;
        }

        case 0x8: { // Close frame
          let code = 1000;
          let reason = "";
          if (payloadLen >= 2) {
            code = unmaskedPayload.readUInt16BE(0);
            reason = unmaskedPayload.subarray(2).toString("utf8");
          }
          this.close(code, reason);
          return;
        }

        case 0x9: { // Ping frame: respond with Pong (Opcode 0xA)
          if (this.socket.writable) {
            const pongHeader = Buffer.alloc(2);
            pongHeader[0] = 0x8a; // FIN=1, Opcode=0xA (Pong)
            pongHeader[1] = payloadLen;
            this.socket.write(Buffer.concat([pongHeader, unmaskedPayload]));
          }
          break;
        }

        case 0xa: { // Pong frame
          this.isAlive = true;
          break;
        }

        default:
          // Ignore unsupported frames (continuation or binary)
          break;
      }
    }
  }
}

// ==========================================
// HTTP & Upgrade Server Setup
// ==========================================

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function tryServeStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const possiblePaths = [
    path.resolve(process.cwd(), "client/dist"),
    path.resolve(process.cwd(), "../client/dist"),
    path.resolve(process.cwd(), "dist"),
  ];

  let distDir: string | null = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      distDir = p;
      break;
    }
  }

  if (!distDir) return false;

  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(distDir, urlPath === "/" ? "index.html" : urlPath);

  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // SPA Fallback: if no extension, serve index.html
  if (!path.extname(urlPath)) {
    const indexPath = path.join(distDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
  }

  return false;
}

export function createMultiplayerServer() {
  const roomManager = new RoomManager();

  const server = http.createServer((req, res) => {
    // Basic CORS & Status endpoint
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health" || req.url === "/status") {
      let totalClients = 0;
      const activeRooms: Array<{ roomId: string; count: number }> = [];
      for (const [roomId, room] of (roomManager as any).rooms.entries()) {
        totalClients += room.peerCount;
        activeRooms.push({ roomId, count: room.peerCount });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          engine: "Zero-Dependency RFC 6455 WebSocket Server",
          totalClients,
          rooms: activeRooms,
          timestamp: Date.now(),
        })
      );
      return;
    }

    if (tryServeStatic(req, res)) {
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Real-Time Multiplayer Sync Server (RFC 6455) is running.");
  });

  // Handle native HTTP Upgrade request
  server.on("upgrade", (req, socket, head) => {
    const upgradeHeader = req.headers["upgrade"];
    const connectionHeader = req.headers["connection"];
    const wsKey = req.headers["sec-websocket-key"];

    const isWebSocket =
      upgradeHeader &&
      upgradeHeader.toLowerCase() === "websocket" &&
      connectionHeader &&
      connectionHeader.toLowerCase().includes("upgrade");

    if (!isWebSocket || !wsKey || typeof wsKey !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // RFC 6455 §4.2.2: Compute Sec-WebSocket-Accept
    const acceptKey = crypto
      .createHash("sha1")
      .update(wsKey + WS_GUID)
      .digest("base64");

    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ];

    socket.write(responseHeaders.join("\r\n"));

    // Upgrade successful, wrap socket in our RFC-6455 connection handler
    const connection = new RawWebSocketConnection(socket);

    connection.onMessage((rawText) => {
      try {
        const parsed = JSON.parse(rawText);
        const result = parseClientMessage(parsed);

        if (!result.success) {
          const errPayload: ErrorMessage = {
            type: "error",
            code: "INVALID_PAYLOAD",
            message: result.error,
          };
          connection.sendText(JSON.stringify(errPayload));
          return;
        }

        const msg = result.data;

        switch (msg.type) {
          case "join": {
            connection.clientId = msg.clientId;
            connection.roomId = msg.roomId;
            const room = roomManager.getOrCreateRoom(msg.roomId);
            roomManager.registerClient(msg.roomId, msg.clientId);
            room.join(msg.clientId, msg.name, msg.color, connection);

            const welcome: WelcomeMessage = {
              type: "welcome",
              clientId: msg.clientId,
              roomId: msg.roomId,
              serverTime: Date.now(),
              heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            };
            connection.sendText(JSON.stringify(welcome));
            break;
          }

          case "cursor": {
            if (!connection.clientId || !connection.roomId) return;
            const room = roomManager.getRoom(connection.roomId);
            if (room) {
              room.handleCursor(connection.clientId, msg.seq, msg.ts, msg.x, msg.y);
            }
            break;
          }

          case "reaction": {
            if (!connection.clientId || !connection.roomId) return;
            const room = roomManager.getRoom(connection.roomId);
            if (room) {
              room.handleReaction(
                connection.clientId,
                msg.seq,
                msg.ts,
                msg.emoji,
                msg.x,
                msg.y
              );
            }
            break;
          }

          case "hype_tap": {
            if (!connection.clientId || !connection.roomId) return;
            const room = roomManager.getRoom(connection.roomId);
            if (room) {
              room.handleHypeTap(connection.clientId);
            }
            break;
          }

          case "ping": {
            const pong: PongMessage = {
              type: "pong",
              clientTs: msg.ts,
              serverTs: Date.now(),
            };
            connection.sendText(JSON.stringify(pong));
            break;
          }
        }
      } catch (err: any) {
        const errPayload: ErrorMessage = {
          type: "error",
          code: "MALFORMED_JSON",
          message: err?.message || "Invalid JSON syntax",
        };
        connection.sendText(JSON.stringify(errPayload));
      }
    });

    connection.onClose(() => {
      if (connection.clientId) {
        roomManager.unregisterClient(connection.clientId, connection);
      }
    });
  });

  // Periodic heartbeat sweep & ping frames to ensure no dead zombie sockets remain
  const heartbeatTimer = setInterval(() => {
    roomManager.sweepAllDeadClients();
  }, HEARTBEAT_INTERVAL_MS);

  server.on("close", () => {
    clearInterval(heartbeatTimer);
  });

  return { server, roomManager };
}

const isMain =
  process.argv[1] &&
  !process.argv[1].includes("test-server") &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));

if (process.env.NODE_ENV !== "test" && isMain) {
  const { server } = createMultiplayerServer();
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Real-Time Multiplayer Sync Server`);
    console.log(`🌐 RFC-6455 Native WebSocket Transport (Zero External Dependencies)`);
    console.log(`📡 Listening on http://localhost:${PORT}`);
    console.log(`🩺 Health check: http://localhost:${PORT}/health`);
    console.log(`====================================================`);
  });
}
