/**
 * Client-Side Interpolation & Extrapolation Engine
 * Eliminates network jitter, stutter, and teleportation without unbounded memory growth.
 * Supports LERP, Hermite Spline, Velocity Extrapolation (Dead Reckoning), and Raw Snapping.
 */

export type InterpolationMode = "lerp" | "hermite" | "extrapolation" | "raw";

export interface PositionSample {
  x: number;
  y: number;
  ts: number;
  seq: number;
}

export interface RenderedCursor {
  clientId: string;
  name: string;
  color: string;
  x: number; // Rendered normalized coordinate [0, 1]
  y: number;
  targetX: number; // Raw latest received coordinate
  targetY: number;
  vx: number; // Normalized units / ms
  vy: number;
  trail: Array<{ x: number; y: number; opacity: number }>;
}

export class RemotePeerInterpolator {
  readonly clientId: string;
  name: string;
  color: string;

  private samples: PositionSample[] = [];
  private readonly maxSamples = 20;
  private readonly maxBufferAgeMs = 1000;

  // Rendered position state
  currentX = 0.5;
  currentY = 0.5;
  targetX = 0.5;
  targetY = 0.5;
  vx = 0;
  vy = 0;

  trail: Array<{ x: number; y: number; opacity: number }> = [];

  constructor(clientId: string, name: string, color: string, initialX = 0.5, initialY = 0.5) {
    this.clientId = clientId;
    this.name = name;
    this.color = color;
    this.currentX = initialX;
    this.currentY = initialY;
    this.targetX = initialX;
    this.targetY = initialY;

    const now = performance.now();
    this.samples.push({ x: initialX, y: initialY, ts: now, seq: 0 });
  }

  /**
   * Adds a new incoming position packet.
   * Enforces sequence order and updates velocity estimate.
   */
  pushSample(x: number, y: number, seq: number): void {
    const now = performance.now();
    this.targetX = x;
    this.targetY = y;

    // Discard duplicate or stale sequence numbers
    const last = this.samples[this.samples.length - 1];
    if (last && seq <= last.seq && Math.abs(seq - last.seq) < 100000) {
      return;
    }

    // Estimate velocity vector
    if (last) {
      const dt = Math.max(1, now - last.ts);
      this.vx = (x - last.x) / dt;
      this.vy = (y - last.y) / dt;
    }

    this.samples.push({ x, y, ts: now, seq });

    // Enforce memory bounds: prune old samples
    this.pruneSamples(now);
  }

  /**
   * Memory management: guarantees O(1) buffer size and no memory leaks.
   */
  private pruneSamples(now: number): void {
    // Drop samples older than 1 second
    const cutoff = now - this.maxBufferAgeMs;
    while (this.samples.length > 2 && this.samples[0].ts < cutoff) {
      this.samples.shift();
    }
    // Hard cap on sample count
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  /**
   * Evaluates interpolated or extrapolated position at current animation frame.
   *
   * @param now Current performance.now() timestamp
   * @param bufferDelayMs Interpolation buffer delay window (e.g. 50ms)
   * @param mode Selected interpolation strategy
   */
  update(now: number, bufferDelayMs: number, mode: InterpolationMode): { x: number; y: number } {
    if (this.samples.length === 0) {
      return { x: this.currentX, y: this.currentY };
    }

    // Baseline: Raw Snapping (teleports directly to latest received coordinate)
    if (mode === "raw") {
      this.currentX = this.targetX;
      this.currentY = this.targetY;
      this.updateTrail();
      return { x: this.currentX, y: this.currentY };
    }

    const renderTime = now - bufferDelayMs;

    // If buffer has only 1 sample, lerp smoothly toward target
    if (this.samples.length === 1) {
      const alpha = 0.2;
      this.currentX += (this.targetX - this.currentX) * alpha;
      this.currentY += (this.targetY - this.currentY) * alpha;
      this.updateTrail();
      return { x: this.currentX, y: this.currentY };
    }

    const latest = this.samples[this.samples.length - 1];

    // Case 1: Render time is beyond our latest sample (network lag spike or packet pause)
    if (renderTime > latest.ts) {
      const dtAhead = renderTime - latest.ts;

      if (mode === "extrapolation" && dtAhead < 250) {
        // Dead Reckoning: extrapolate along velocity with exponential decay dampening
        // Dampening prevents overshoot when user suddenly stopped moving
        const dampening = Math.exp(-dtAhead / 80);
        const projectedX = latest.x + this.vx * dtAhead * dampening;
        const projectedY = latest.y + this.vy * dtAhead * dampening;

        // Smoothly blend toward projected position
        this.currentX += (Math.max(0, Math.min(1, projectedX)) - this.currentX) * 0.3;
        this.currentY += (Math.max(0, Math.min(1, projectedY)) - this.currentY) * 0.3;
      } else {
        // Smoothly settle into last known target position
        this.currentX += (latest.x - this.currentX) * 0.25;
        this.currentY += (latest.y - this.currentY) * 0.25;
      }

      this.updateTrail();
      return { x: this.currentX, y: this.currentY };
    }

    // Case 2: Render time is earlier than our oldest sample
    const oldest = this.samples[0];
    if (renderTime <= oldest.ts) {
      this.currentX = oldest.x;
      this.currentY = oldest.y;
      this.updateTrail();
      return { x: this.currentX, y: this.currentY };
    }

    // Case 3: Normal playback between two enclosing historical samples
    let i = this.samples.length - 1;
    while (i > 0 && this.samples[i].ts > renderTime) {
      i--;
    }

    const p0 = this.samples[i];
    const p1 = this.samples[i + 1];

    if (!p1) {
      this.currentX = p0.x;
      this.currentY = p0.y;
      this.updateTrail();
      return { x: this.currentX, y: this.currentY };
    }

    const span = Math.max(1, p1.ts - p0.ts);
    const alpha = Math.max(0, Math.min(1, (renderTime - p0.ts) / span));

    if (mode === "hermite" && this.samples.length >= 4 && i > 0 && i < this.samples.length - 2) {
      // Catmull-Rom cubic spline interpolation
      const pm1 = this.samples[i - 1];
      const p2 = this.samples[i + 2];
      this.currentX = catmullRom(pm1.x, p0.x, p1.x, p2.x, alpha);
      this.currentY = catmullRom(pm1.y, p0.y, p1.y, p2.y, alpha);
    } else {
      // Linear Interpolation (LERP)
      this.currentX = p0.x + (p1.x - p0.x) * alpha;
      this.currentY = p0.y + (p1.y - p0.y) * alpha;
    }

    this.updateTrail();
    return { x: this.currentX, y: this.currentY };
  }

  private updateTrail(): void {
    // Add position to trail
    this.trail.unshift({ x: this.currentX, y: this.currentY, opacity: 1.0 });

    // Fade and prune trail
    for (let i = 0; i < this.trail.length; i++) {
      this.trail[i].opacity -= 0.1;
    }
    this.trail = this.trail.filter((p) => p.opacity > 0.05).slice(0, 10);
  }
}

/**
 * Catmull-Rom cubic spline evaluation for smooth curved trajectory interpolation.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = t * t;
  const t3 = t * t2;
  return (
    (2 * p1 - 2 * p2 + v0 + v1) * t3 +
    (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 +
    v0 * t +
    p1
  );
}

/**
 * Registry of all remote peer interpolators in the current room session.
 */
export class InterpolationManager {
  private peers = new Map<string, RemotePeerInterpolator>();
  mode: InterpolationMode = "extrapolation";
  bufferDelayMs = 50;

  getPeer(clientId: string): RemotePeerInterpolator | undefined {
    return this.peers.get(clientId);
  }

  getOrCreatePeer(
    clientId: string,
    name: string,
    color: string,
    initialX = 0.5,
    initialY = 0.5
  ): RemotePeerInterpolator {
    let peer = this.peers.get(clientId);
    if (!peer) {
      peer = new RemotePeerInterpolator(clientId, name, color, initialX, initialY);
      this.peers.set(clientId, peer);
    } else {
      peer.name = name;
      peer.color = color;
    }
    return peer;
  }

  removePeer(clientId: string): void {
    this.peers.delete(clientId);
  }

  pushPeerCursor(clientId: string, x: number, y: number, seq: number): void {
    const peer = this.peers.get(clientId);
    if (peer) {
      peer.pushSample(x, y, seq);
    }
  }

  updateAll(now: number): RenderedCursor[] {
    const results: RenderedCursor[] = [];
    for (const peer of this.peers.values()) {
      const pos = peer.update(now, this.bufferDelayMs, this.mode);
      results.push({
        clientId: peer.clientId,
        name: peer.name,
        color: peer.color,
        x: pos.x,
        y: pos.y,
        targetX: peer.targetX,
        targetY: peer.targetY,
        vx: peer.vx,
        vy: peer.vy,
        trail: [...peer.trail],
      });
    }
    return results;
  }

  clear(): void {
    this.peers.clear();
  }
}
