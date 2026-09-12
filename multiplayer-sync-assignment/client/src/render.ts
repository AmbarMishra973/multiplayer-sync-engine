/**
 * 60 FPS HTML5 Canvas Multi-Client Renderer
 * Renders smoothed remote cursors, motion trails, name badges, and a particle physics reaction engine.
 */

import { RenderedCursor } from "./interpolation";

export interface EmojiBurst {
  id: string;
  emoji: string;
  x: number; // Screen pixels
  y: number;
  scale: number;
  alpha: number;
  vy: number;
  particles: Particle[];
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  rotation: number;
  vRot: number;
}

export interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  color: string;
}

const PARTICLE_COLORS = [
  "#f43f5e",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#38bdf8",
  "#818cf8",
  "#c084fc",
];

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  private bursts: EmojiBurst[] = [];
  private shockwaves: Shockwave[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas 2D context unavailable");
    this.ctx = context;
    this.resize();
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  get width(): number {
    return this.canvas.width / this.dpr;
  }

  get height(): number {
    return this.canvas.height / this.dpr;
  }

  /**
   * Spawns an emoji explosion with physical debris particles.
   */
  addReactionBurst(emoji: string, normalizedX: number, normalizedY: number, color = "#6366f1"): void {
    const x = normalizedX * this.width;
    const y = normalizedY * this.height;

    const particles: Particle[] = [];
    const count = 18;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 2.5 + Math.random() * 4.5;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5,
        color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
        size: 3 + Math.random() * 4,
        alpha: 1.0,
        rotation: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.2,
      });
    }

    this.bursts.push({
      id: Math.random().toString(36).substring(2),
      emoji,
      x,
      y,
      scale: 0.5,
      alpha: 1.0,
      vy: -2.0,
      particles,
    });

    this.shockwaves.push({
      x,
      y,
      radius: 10,
      maxRadius: 75,
      alpha: 0.8,
      color,
    });
  }

  /**
   * Main render frame loop: clears canvas and draws all active layers.
   */
  render(
    cursors: RenderedCursor[],
    localCursor: { x: number; y: number } | null,
    localName: string,
    localColor: string
  ): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);

    // 1. Draw Shockwaves
    this.renderShockwaves(ctx);

    // 2. Draw Remote Cursor Trails & Cursors
    for (const cursor of cursors) {
      this.renderCursorTrail(ctx, cursor, w, h);
      this.renderCursor(ctx, cursor.x * w, cursor.y * h, cursor.name, cursor.color, false);
    }

    // 3. Draw Local Cursor Preview (if active)
    if (localCursor) {
      this.renderCursor(
        ctx,
        localCursor.x * w,
        localCursor.y * h,
        `${localName} (You)`,
        localColor,
        true
      );
    }

    // 4. Draw Reaction Bursts and Particles
    this.renderBursts(ctx);

    ctx.restore();
  }

  private renderCursorTrail(
    ctx: CanvasRenderingContext2D,
    cursor: RenderedCursor,
    w: number,
    h: number
  ): void {
    if (cursor.trail.length < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cursor.trail[0].x * w, cursor.trail[0].y * h);

    for (let i = 1; i < cursor.trail.length; i++) {
      const pt = cursor.trail[i];
      ctx.lineTo(pt.x * w, pt.y * h);
    }

    ctx.strokeStyle = cursor.color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.25;
    ctx.stroke();
    ctx.restore();
  }

  private renderCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    name: string,
    color: string,
    isLocal: boolean
  ): void {
    ctx.save();
    ctx.translate(x, y);

    // Pulsing aura for local cursor
    if (isLocal) {
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.25;
      ctx.fill();
    }

    // Modern pointer polygon
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 16);
    ctx.lineTo(4, 13);
    ctx.lineTo(9, 21);
    ctx.lineTo(12, 19);
    ctx.lineTo(7, 11);
    ctx.lineTo(15, 11);
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fill();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Name badge
    ctx.shadowBlur = 0;
    const badgeText = name;
    ctx.font = "600 11px 'Plus Jakarta Sans', system-ui, sans-serif";
    const textWidth = ctx.measureText(badgeText).width;
    const badgeW = textWidth + 16;
    const badgeH = 20;
    const badgeX = 14;
    const badgeY = 14;

    // Badge background
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    ctx.fillStyle = "#0f172a";
    ctx.globalAlpha = 0.88;
    ctx.fill();

    // Badge border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.9;
    ctx.stroke();

    // Badge text
    ctx.fillStyle = "#f8fafc";
    ctx.globalAlpha = 1.0;
    ctx.fillText(badgeText, badgeX + 8, badgeY + 14);

    ctx.restore();
  }

  private renderShockwaves(ctx: CanvasRenderingContext2D): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.radius += 2.5;
      sw.alpha -= 0.03;

      if (sw.alpha <= 0 || sw.radius >= sw.maxRadius) {
        this.shockwaves.splice(i, 1);
        continue;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.strokeStyle = sw.color;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = sw.alpha;
      ctx.stroke();
      ctx.restore();
    }
  }

  private renderBursts(ctx: CanvasRenderingContext2D): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];

      // Update main emoji position & scale
      burst.y += burst.vy;
      burst.vy += 0.05; // slight deceleration
      burst.scale = Math.min(1.4, burst.scale + 0.08);
      burst.alpha -= 0.018;

      // Draw particles
      for (const p of burst.particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.15; // gravity
        p.vx *= 0.96; // air drag
        p.rotation += p.vRot;
        p.alpha -= 0.022;

        if (p.alpha > 0) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          ctx.beginPath();
          ctx.rect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.fillStyle = p.color;
          ctx.globalAlpha = Math.max(0, p.alpha);
          ctx.fill();
          ctx.restore();
        }
      }

      // Draw center emoji
      if (burst.alpha > 0) {
        ctx.save();
        ctx.translate(burst.x, burst.y);
        ctx.scale(burst.scale, burst.scale);
        ctx.font = "32px 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = Math.max(0, burst.alpha);
        ctx.fillText(burst.emoji, 0, 0);
        ctx.restore();
      }

      // Remove dead bursts
      if (burst.alpha <= 0 && burst.particles.every((p) => p.alpha <= 0)) {
        this.bursts.splice(i, 1);
      }
    }
  }
}
