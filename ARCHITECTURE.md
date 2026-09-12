# System Architecture & Technical Deep Dive

This document details the architectural decisions, protocol framing, mathematical models for interpolation, failure resilience, and horizontal scaling strategies of the Real-Time Multiplayer Cursor & State Sync Engine.

---

## 1. High-Level System Architecture

The system is strictly partitioned into distinct, decoupled architectural layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                             CLIENT LAYER                               │
├────────────────────────────────────────────────────────────────────────┤
│  Presentation & Render (render.ts)                                     │
│  - 60 FPS Canvas 2D double-buffered context                            │
│  - Normalized [0, 1] to screen pixel projection                        │
│  - Reaction particle physics engine (velocity, gravity, drag, rotation)│
├────────────────────────────────────────────────────────────────────────┤
│  Interpolation & Smoothing (interpolation.ts)                          │
│  - Bounded ring buffer of position samples (max 20 / 1.0s window)      │
│  - LERP / Catmull-Rom cubic spline / Dead reckoning extrapolation      │
├────────────────────────────────────────────────────────────────────────┤
│  Sync & Transport Adapter (connection.ts)                              │
│  - createRoom factory interface                                        │
│  - 33Hz cursor throttling with leading & trailing edge guarantees      │
│  - Heartbeat RTT & jitter rolling average                              │
│  - Synthetic network degradation pipeline                              │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Raw WebSocket (RFC 6455)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                             SERVER LAYER                               │
├────────────────────────────────────────────────────────────────────────┤
│  Native RFC-6455 Frame Parser & Upgrader (server.ts)                   │
│  - Built on Node.js node:http and node:crypto                          │
│  - Bitwise frame decoding (FIN, Opcode, Masking key XOR)               │
│  - Unmasked server frame assembly                                      │
├────────────────────────────────────────────────────────────────────────┤
│  Room & Presence Management (room.ts)                                  │
│  - Room membership map and peer state tracking                         │
│  - Snapshot generation on client join                                  │
│  - O(N) broadcast fan-out (sender excluded, no self-echo)              │
│  - Authoritative collaborative state reconciliation                    │
├────────────────────────────────────────────────────────────────────────┤
│  Wire Protocol Validation (protocol.ts)                                │
│  - TypeScript discriminated unions                                     │
│  - Runtime payload sanitization and error isolation                    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Zero-Dependency RFC-6455 WebSocket Implementation

Rather than relying on third-party libraries (`ws`, `Socket.IO`), the server implements RFC 6455 directly over Node's built-in `node:http` and `node:crypto`.

### The Upgrade Handshake (§4.2.2)
1. The client issues an HTTP `GET` with:
   ```http
   GET / HTTP/1.1
   Host: localhost:8080
   Upgrade: websocket
   Connection: Upgrade
   Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
   Sec-WebSocket-Version: 13
   ```
2. The server intercepts this via `server.on('upgrade', (req, socket, head) => ...)`:
   - Concatenates `Sec-WebSocket-Key` with the magic GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`.
   - Computes SHA-1 hash and Base64 encodes the result:
     $$\text{AcceptKey} = \text{Base64}(\text{SHA1}(\text{Key} + \text{GUID}))$$
   - Emits HTTP `101 Switching Protocols`:
     ```http
     HTTP/1.1 101 Switching Protocols\r\n
     Upgrade: websocket\r\n
     Connection: Upgrade\r\n
     Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n
     ```

### Bitwise Frame Parsing (§5.2)
Incoming client bytes are parsed through an accumulated stream buffer:
- **Byte 0**:
  - Bit 7: `FIN` (Indicates complete message).
  - Bits 0-3: `Opcode` (`0x1` text, `0x8` close, `0x9` ping, `0xA` pong).
- **Byte 1**:
  - Bit 7: `MASK` bit. Must be `1` for all client-to-server frames (RFC 6455 §5.1 requires the server to drop connections if unmasked).
  - Bits 0-6: Payload length. If `126`, the next 2 bytes are parsed as `uint16BE`. If `127`, the next 8 bytes are parsed as `uint64BE`.
- **Masking Key**: 4 bytes extracted immediately following the length header.
- **Unmasking Algorithm**:
  $$P_i = C_i \oplus M_{i \pmod 4}$$
  Where $C$ is the cipher payload, $M$ is the 4-byte mask, and $P$ is the unmasked UTF-8 plaintext.

### Outgoing Frame Encoding (§5.1)
Frames from server to client **must not be masked**:
- Small frames ($\le 125$ bytes): 2-byte header `[0x81, len]` followed by UTF-8 bytes.
- Medium frames ($126 \le len \le 65535$): 4-byte header `[0x81, 126, len_hi, len_lo]`.
- Large frames ($> 65535$): 10-byte header with 64-bit integer length.

---

## 3. Bandwidth Analysis & Throttling

### High-Frequency Mousemove Problem
Unchecked, modern gaming mice and trackpads emit `mousemove` events at 120Hz to 240Hz.
- Raw payload per event: ~120 bytes JSON.
- At 120Hz: $120 \times 120 = 14.4\text{ KB/s}$ per user upstream.
- For a room of 10 clients: $10 \times 9 \times 14.4\text{ KB/s} = 1.296\text{ MB/s}$ server fan-out bandwidth.

### Throttled Design
By enforcing a 33Hz client-side throttle with trailing-edge guarantee:
- Capped packet rate: 33 packets/sec maximum.
- Bandwidth per user upstream: $33 \times 120 \approx 3.96\text{ KB/s}$ (**72.5% reduction**).
- Trailing-edge timer guarantees the stopping point coordinate is never lost:
  ```ts
  if (elapsed >= throttleIntervalMs) {
    flushCursor(x, y);
  } else {
    pendingCursor = { x, y };
    if (!trailingTimer) {
      trailingTimer = setTimeout(() => flushCursor(pendingCursor.x, pendingCursor.y), throttleIntervalMs - elapsed);
    }
  }
  ```

---

## 4. Interpolation & Extrapolation Mathematical Models

### 1. Linear Interpolation (LERP)
Given two sample packets $P_0 = (x_0, y_0, t_0)$ and $P_1 = (x_1, y_1, t_1)$ where $t_0 \le t_{render} \le t_1$:
$$\alpha = \frac{t_{render} - t_0}{t_1 - t_0}$$
$$x(t_{render}) = x_0 + \alpha (x_1 - x_0)$$
$$y(t_{render}) = y_0 + \alpha (y_1 - y_0)$$
Where $t_{render} = t_{current} - \Delta_{buffer}$. With $\Delta_{buffer} = 50\text{ms}$, updates spaced 30ms apart always have at least two enclosing samples, guaranteeing smooth movement.

### 2. Catmull-Rom Cubic Spline
For continuous curves without angular corners:
Given four consecutive samples $P_{i-1}, P_i, P_{i+1}, P_{i+2}$ and localized interval $u \in [0, 1]$:
$$P(u) = \frac{1}{2} \begin{bmatrix} 1 & u & u^2 & u^3 \end{bmatrix} \begin{bmatrix} 0 & 2 & 0 & 0 \\ -1 & 0 & 1 & 0 \\ 2 & -5 & 4 & -1 \\ -1 & 3 & -3 & 1 \end{bmatrix} \begin{bmatrix} P_{i-1} \\ P_i \\ P_{i+1} \\ P_{i+2} \end{bmatrix}$$
This creates $C^1$-smooth curves, preventing abrupt visual direction changes during fast diagonal or curved movements.

### 3. Dead Reckoning (Velocity Extrapolation)
When network latency spikes and $t_{render} > t_{latest}$, interpolation runs out of future samples. Rather than stalling:
1. Estimate velocity:
   $$v_x = \frac{x_{latest} - x_{prev}}{t_{latest} - t_{prev}}, \quad v_y = \frac{y_{latest} - y_{prev}}{t_{latest} - t_{prev}}$$
2. Project forward with exponential decay damping:
   $$\Delta t_{ahead} = t_{render} - t_{latest}$$
   $$\text{dampening} = e^{-\Delta t_{ahead} / \tau}, \quad (\tau = 80\text{ms})$$
   $$x_{projected} = x_{latest} + v_x \cdot \Delta t_{ahead} \cdot \text{dampening}$$
   $$y_{projected} = y_{latest} + v_y \cdot \Delta t_{ahead} \cdot \text{dampening}$$
The dampening prevents the cursor from flying off-screen if the remote user stopped moving during the packet drop.

---

## 5. Broadcast Complexity & Clean Fan-Out

### Avoiding $O(N^2)$ Re-broadcast Bugs
A common bug in real-time relays is echoing a client's own coordinates back to itself, doubling their bandwidth and causing local jitter if rendered:
```ts
// room.ts
broadcast(message: ServerMessage, excludeClientId?: string): void {
  const serialized = JSON.stringify(message);
  for (const [clientId, peer] of this.peers.entries()) {
    if (excludeClientId && clientId === excludeClientId) {
      continue; // Skip sender: eliminates O(N) wasteful echoes
    }
    peer.socket.sendText(serialized);
  }
}
```
- Message serialization is performed **once** per broadcast event ($O(1)$ JSON formatting), then distributed to $N-1$ sockets.
- Room peer lookups use a native `Map<string, Peer>`, guaranteeing $O(1)$ insertion, lookup, and deletion.

---

## 6. Extensibility: Adding New Action Types

The system decouples the transport layer from application actions. To add a new action (e.g. `drawing_stroke`):

1. **Update Protocol Definition (`protocol.ts`)**:
   ```ts
   export interface DrawingStrokeAction {
     type: "drawing_stroke";
     points: Array<{ x: number; y: number }>;
     color: string;
     seq?: number;
     ts?: number;
   }
   export type ClientAction = CursorAction | ReactionAction | HypeTapAction | DrawingStrokeAction;
   ```
2. **Add Validation Case**:
   Add a case in `parseClientMessage` to sanitize `points` and `color`.
3. **Handle in Room Relay (`room.ts`)**:
   Add `handleDrawingStroke(clientId, msg)` which calls `this.broadcast(strokeMsg, clientId)`.
4. **Render in Client (`render.ts`)**:
   Add `renderStroke(...)` on the canvas context.
5. **No Changes Required in Transport**: The underlying RFC-6455 server, framing, buffer parser, and WebSocket transport code remain 100% untouched.

---

## 7. Horizontal Scaling Strategy (Multi-Server Architecture)

For production deployments scaling to thousands of concurrent rooms across multiple server instances:

```
                          ┌───────────────────────────┐
                          │     Load Balancer         │
                          │ (NGINX / AWS ALB / Envoy) │
                          └─────────────┬─────────────┘
                                        │ Consistent Hash on roomId
                        ┌───────────────┴───────────────┐
                        ▼                               ▼
            ┌───────────────────────┐       ┌───────────────────────┐
            │    Sync Server A      │       │    Sync Server B      │
            │   (Rooms 1 - 500)     │       │  (Rooms 501 - 1000)   │
            └───────────┬───────────┘       └───────────┬───────────┘
                        │                               │
                        └───────────────┬───────────────┘
                                        ▼
                        ┌───────────────────────────────┐
                        │      Redis Pub/Sub & State    │
                        │ (Presence & Cross-Node Relay) │
                        └───────────────────────────────┘
```

### 1. Consistent Hash Room Routing
- Route WebSocket upgrade requests using the query parameter `roomId` (e.g. `ws://cluster/ws?room=watch-party-42`).
- A consistent hashing proxy (HAProxy or NGINX) directs all participants of `roomId` to the same server node.
- **Advantage**: Broadcasts remain entirely local to that Node process in memory ($O(N)$ with zero inter-server IPC overhead).

### 2. Cross-Node Fan-Out via Redis Pub/Sub
- If a room exceeds the capacity of a single server (e.g. a stadium broadcast with 50,000 spectators in one room):
  - Ingress servers subscribe to Redis channel `room:{roomId}`.
  - Active nodes publish cursor batches to Redis.
  - Egress nodes relay messages down to their locally connected subscribers.

### 3. Server Node Crash & Recovery
- Session presence tokens stored in Redis with short TTLs (15s).
- If a server node crashes, client WebSocket connections terminate; clients automatically execute exponential backoff reconnect, the load balancer routes them to surviving nodes, and clients rejoin with their persistent `clientId` within ~1.5s.
