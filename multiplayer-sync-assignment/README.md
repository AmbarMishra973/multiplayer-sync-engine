# Real-Time Multiplayer Cursor & State Sync Engine

A production-grade, zero-dependency real-time multiplayer cursor and state synchronization system. Built from first principles on top of native browser WebSockets and a custom RFC-6455 WebSocket engine implemented directly in Node.js standard modules (`node:http` and `node:crypto`).

Designed for interactive live broadcast experiences (e.g., fan-moment widgets during live events) where multiple participants interact simultaneously with minimal latency, smooth interpolation, and rock-solid failure recovery.

---

## ⚡ Quick Start

### Prerequisites
- Node.js `v18.0.0+` (Tested on `v22.18.0`)
- npm `v9+`

### Installation & Launch

1. **Install Dependencies**:
   ```bash
   # Server (zero runtime dependencies, devDependencies only)
   cd server && npm install

   # Client (React + Vite + Lucide)
   cd ../client && npm install
   ```

2. **Run Server & Client**:
   - **Terminal 1 (Server)**:
     ```bash
     cd server
     npm run dev
     # Listens on http://localhost:8080 (RFC-6455 WebSocket at ws://localhost:8080)
     # Health check: http://localhost:8080/health
     ```

   - **Terminal 2 (Client)**:
     ```bash
     cd client
     npm run dev
     # Starts Vite dev server at http://localhost:5173
     ```

3. **Verify the Multi-Client Experience**:
   - Open **3 to 5 browser tabs or windows** to `http://localhost:5173`.
   - Move your mouse in one window; observe cursors glide smoothly across all other tabs with distinctive colors and names.
   - Tap reaction emojis (or press keys `1-6`) to burst 60 FPS physics particles across all screens.
   - Tap the **FAN HYPE** button to test collaborative state reconciliation.

4. **Run Server Automated Protocol Verification**:
   ```bash
   cd server
   npm test
   ```

---

## ☁️ Deploying on Render (Render.com)

This application is architected for single-click, zero-config deployment on Render as a unified Node.js Web Service (serving both the React single-page application and the native RFC-6455 WebSocket engine on a single port with automatic HTTPS/WSS encryption).

### Option A: Render Blueprint (Automatic One-Click)
1. Fork or push this repository to GitHub: `https://github.com/AmbarMishra973/multiplayer-sync-engine.git`.
2. Go to your [Render Dashboard](https://dashboard.render.com/) and click **New +** -> **Blueprint**.
3. Connect your GitHub repository. Render will automatically detect `render.yaml` and configure the Web Service with the following defaults:
   - **Build Command**: `npm run install:all && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
4. Click **Apply**. Render will deploy the application and give you a live URL (e.g., `https://multiplayer-sync-engine.onrender.com`).

### Option B: Manual Web Service Setup
1. On your Render Dashboard, click **New +** -> **Web Service**.
2. Connect `https://github.com/AmbarMishra973/multiplayer-sync-engine.git`.
3. Select **Node** as the Environment.
4. Set **Build Command**: `npm run install:all && npm run build`
5. Set **Start Command**: `npm start`
6. Set **Health Check Path**: `/health`
7. Click **Create Web Service**. Once deployed, open the live Render URL in multiple tabs or devices to test live multi-user cursor sync!

---

## 📡 Protocol Design

### Wire Format & Transport
- Transport: Raw WebSocket connection over RFC-6455 frame specification.
- Wire Encoding: UTF-8 JSON payloads with strict discriminator typing (`type`).
- Coordinate Normalization: All cursor coordinates $(x, y)$ are normalized to $[0.0, 1.0]$. This ensures flawless positioning regardless of different viewport dimensions or DPI across devices.

### Message Schemas

#### Client -> Server Messages

| Type | Shape | Description |
| :--- | :--- | :--- |
| `join` | `{ type: "join", roomId: string, clientId: string, name?: string, color?: string }` | Registers client into a room and requests initial room state. |
| `cursor` | `{ type: "cursor", seq: number, ts: number, x: number, y: number }` | Normalized cursor coordinates with monotonic sequence and client timestamp. |
| `reaction` | `{ type: "reaction", seq: number, ts: number, emoji: string, x: number, y: number }` | Discrete emoji reaction burst trigger at normalized coordinates. |
| `hype_tap` | `{ type: "hype_tap", seq: number, ts: number }` | Collaborative fan hype button tap for atomic conflict reconciliation. |
| `ping` | `{ type: "ping", ts: number }` | Heartbeat latency ping for RTT and jitter calculation. |

#### Server -> Client Messages

| Type | Shape | Description |
| :--- | :--- | :--- |
| `welcome` | `{ type: "welcome", clientId: string, roomId: string, serverTime: number, heartbeatIntervalMs: number }` | Acknowledges join, sets heartbeat interval. |
| `room_state` | `{ type: "room_state", clients: RemotePeerState[], hypeCount: number }` | State snapshot of all currently connected peers and hype total sent to newly joined client. |
| `client_joined` | `{ type: "client_joined", client: RemotePeerState }` | Broadcast to existing participants when a new peer connects. |
| `client_left` | `{ type: "client_left", clientId: string, reason: "disconnect" \| "timeout" \| "left" }` | Broadcast when a peer disconnects or times out. |
| `cursor` | `{ type: "cursor", clientId: string, seq: number, ts: number, x: number, y: number }` | Broadcasts remote peer cursor to other room participants (sender excluded). |
| `reaction` | `{ type: "reaction", clientId: string, seq: number, ts: number, emoji: string, x: number, y: number }` | Relays reaction bursts with sender ID to room participants. |
| `hype_update` | `{ type: "hype_update", totalCount: number, recentTapperId: string, timestamp: number }` | Authoritative reconciled hype count broadcast to all clients. |
| `pong` | `{ type: "pong", clientTs: number, serverTs: number }` | Heartbeat response echoing client timestamp to measure RTT. |
| `error` | `{ type: "error", code: string, message: string }` | Sent when malformed JSON or unknown actions are rejected. |

### Throttling & Batching Strategy
High-frequency input devices emit `mousemove` events at 60Hz–240Hz. Flooding the network with uncapped mouse moves saturates bandwidth and creates queuing latency.

- **Throttling Frequency**: Client cursors are capped at **33Hz** (`throttleIntervalMs = 30ms`).
- **Leading & Trailing Edge Dispatch**:
  - *Leading Edge*: The first mouse movement after idle is dispatched immediately with 0ms latency.
  - *Interval Capping*: Subsequent events within 30ms update an internal pending coordinate.
  - *Guaranteed Trailing Edge*: When mouse movement halts, a timer flushes the final pending coordinate. This guarantees that remote cursors never freeze offset from their true target stopping point.
- **Bandwidth Reduction**: Cuts upstream cursor packet volume by ~75% while maintaining visually indistinguishable smoothness via interpolation.

---

## 🏎️ Interpolation & Extrapolation Strategy

### Strategy Comparison & Tradeoffs

The client implements four selectable strategies (switchable live via the UI control panel):

1. **Dead Reckoning / Velocity Extrapolation (Bonus)**:
   - *How it works*: When network packets arrive or when waiting for the next update, projects position forward along the velocity vector $v = \frac{p_{new} - p_{old}}{\Delta t}$ damped exponentially ($d = e^{-\Delta t / 80}$) to avoid overshoot.
   - *Latency Added*: **0ms added latency** (renders at real-time present).
   - *Tradeoff*: Instant response, but sudden abrupt direction changes can cause slight micro-corrections when the real update arrives.

2. **Catmull-Rom Spline Interpolation**:
   - *How it works*: Evaluates a $C^1$-continuous cubic spline across four surrounding historical samples.
   - *Latency Added*: ~50ms render delay buffer.
   - *Tradeoff*: Produces fluid, organic curves during fast movements without sharp angular kinks.

3. **Linear Interpolation (LERP)**:
   - *How it works*: Evaluates linear position $p(t) = p_0 + (p_1 - p_0) \cdot \alpha$ where $\alpha = \frac{t_{render} - t_0}{t_1 - t_0}$ within a historical buffer window (default: 50ms).
   - *Latency Added*: Equal to the configured buffer delay (50ms).
   - *Tradeoff*: Consistent and reliable across varying frame rates.

4. **Raw Snapping (Baseline Comparison)**:
   - Teleports cursor directly to latest received packet without interpolation. Included in the UI to vividly demonstrate how jarring un-interpolated updates are under real network conditions.

### Memory Bounding
To prevent unbounded memory growth:
- Each peer maintains a bounded circular array of at most 20 samples.
- Samples older than 1.0 second are discarded on every push.
- Memory consumption per peer is strictly bounded to $O(1)$ (<2KB per active participant).

---

## 🛡️ Failure & Edge Case Handling

1. **Disconnect Detection (Clean & Abrupt)**:
   - *Clean Close*: When a user closes the tab or navigates away, the browser sends an RFC-6455 close frame (Opcode `0x8`). The server immediately unregisters the client and broadcasts `client_left`.
   - *Abrupt Drop / Silent Network Loss*: Handled by bidirectional heartbeats. The server sweeps connections every 10 seconds. Sockets silent for >25 seconds are terminated and pruned.

2. **Reconnect Handling**:
   - The client stores a persistent `clientId` in `sessionStorage`.
   - If the WebSocket disconnects, the client engages an exponential backoff reconnect loop (1s, 1.5s, 2.25s up to 8s).
   - Upon reconnect, the client rejoins with the same `clientId`. The server recognizes the existing session, replaces the socket descriptor, and does not spawn a duplicate cursor or trigger redundant join/leave events.

3. **Out-of-Order Packet Delivery**:
   - Every continuous action message carries a monotonically increasing sequence integer (`seq`) and timestamp (`ts`).
   - The server and client reject any cursor update where `seq <= last_seen_seq` (unless a sequence wraparound occurs), discarding stale packets delivered late.

4. **Malformed Payload Immunity**:
   - All incoming payloads pass through `parseClientMessage(raw)` validation.
   - Invalid JSON, missing properties, or wrong data types trigger an `{ type: "error" }` response to the offending client without throwing or crashing the server process.

---

## 🎯 Conflict Resolution & Action Reconciliation

In a broadcast "fan-moment", multiple viewers tap simultaneously on collaborative widgets (e.g. the **Fan Hype Meter**).

- **Reconciliation Model**:
  - The server maintains authoritative ownership of the hype counter.
  - When clients tap the hype button, they render an optimistic local visual particle burst and dispatch `{ type: "hype_tap" }`.
  - The server serializes incoming taps sequentially, increments the canonical total, and broadcasts `{ type: "hype_update", totalCount, recentTapperId, timestamp }`.
  - Clients reconcile their local displayed count to the server's authoritative value, eliminating discrepancies.

---

## 🧪 Built-In Network Degradation Simulator

The demo includes a built-in network simulator directly in the web UI (no Chrome DevTools throttling required):
- **Artificial Latency Slider**: Injects 0ms to 350ms of synthetic delay.
- **Jitter Slider**: Injects $\pm0$ms to $\pm50$ms of synthetic variance.
- **Packet Loss Slider**: Injects 0% to 20% random packet drop.

Evaluators can tweak these sliders while watching remote cursors to visually observe the interpolation and extrapolation engines operating under degraded network conditions.

---

## ⚠️ Known Limitations

1. **In-Memory Volatility**: Room states, presence lists, and hype totals reside in server memory. Restarting the server process resets room states to initial values.
2. **Single-Node Process**: Operates on a single Node.js instance. Multi-server horizontal clustering requires a shared relay layer (see [ARCHITECTURE.md](file:///c:/Users/dell1/Desktop/New%20folder%20(2)/ARCHITECTURE.md)).
3. **Public Rooms / No Authentication**: Rooms are identified by room ID strings without JWTs or password access control.
4. **WebSocket Native Server Scope**: Implements essential RFC-6455 features (handshake, text framing, extended payload lengths, masking/unmasking, pings, and close frames). Does not implement fragmented multi-frame streaming or permessage-deflate compression.

---

## ⏱️ Time Spent on Assignment

- **Protocol & RFC-6455 Native Server**: ~3.5 hours
- **Interpolation & Extrapolation Engine**: ~3 hours
- **Canvas Renderer & Reaction Particle System**: ~2.5 hours
- **Client App, Telemetry HUD & Network Simulator**: ~3 hours
- **Documentation & Architecture Specifications**: ~2 hours
- **Total Time**: ~14 hours

---

## 🤖 AI Tools Disclosure
Assisted by Antigravity (Google DeepMind) for architectural planning, TypeScript interface structuring, and automated test scaffolding. All design decisions, frame parsing logic, interpolation math, and documentation were implemented and verified for correctness.
