import { MAP_HALF_EXTENT } from '@flight-sim/shared';

export interface RadarContact {
  x: number;
  z: number;
  yaw: number;
  /** 'self' | 'ally' | 'enemy' | 'neutral' */
  kind: 'self' | 'ally' | 'enemy' | 'neutral';
  /** optional label */
  label?: string;
  /** dead / inactive */
  dead?: boolean;
}

export interface RadarOptions {
  /** World meters shown from center to edge (default 1200) */
  rangeM?: number;
  /** Size in CSS pixels */
  size?: number;
}

/**
 * Heading-up tactical radar (canvas).
 * +Z world is "north" on a fixed map; display rotates so local yaw faces up.
 */
export class Radar {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rangeM: number;
  private size: number;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, opts: RadarOptions = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.rangeM = opts.rangeM ?? 1400;
    this.size = opts.size ?? 168;
    this.resize();
  }

  setRange(meters: number): void {
    this.rangeM = Math.max(200, meters);
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = this.size;
    this.canvas.style.width = `${css}px`;
    this.canvas.style.height = `${css}px`;
    this.canvas.width = Math.round(css * this.dpr);
    this.canvas.height = Math.round(css * this.dpr);
  }

  /**
   * @param selfX self world X
   * @param selfZ self world Z
   * @param selfYaw heading (0 = +Z)
   * @param contacts others (do not include self; self drawn from args)
   */
  draw(selfX: number, selfZ: number, selfYaw: number, contacts: RadarContact[]): void {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(cx, cy) - 2 * this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background disc
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(4, 14, 10, 0.82)';
    ctx.fill();
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.55)';
    ctx.stroke();

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1 * this.dpr, 0, Math.PI * 2);
    ctx.clip();

    // Rotate so player nose is up: screen-up = world direction of selfYaw
    // World: x right, z forward(north). Screen: x right, y down.
    // Point in player frame: rotate world delta by -yaw, then map (x,z) -> (sx, -sz) for screen.
    ctx.translate(cx, cy);

    const scale = R / this.rangeM;

    // Range rings
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.18)';
    ctx.lineWidth = 1 * this.dpr;
    for (const frac of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(0, 0, R * frac, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Crosshair
    ctx.strokeStyle = 'rgba(60, 220, 120, 0.2)';
    ctx.beginPath();
    ctx.moveTo(-R, 0);
    ctx.lineTo(R, 0);
    ctx.moveTo(0, -R);
    ctx.lineTo(0, R);
    ctx.stroke();

    // Sweep arm (cosmetic)
    const sweep = (performance.now() / 1000) % (Math.PI * 2);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    grad.addColorStop(0, 'rgba(60, 220, 120, 0.0)');
    grad.addColorStop(1, 'rgba(60, 220, 120, 0.12)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, sweep - 0.45, sweep, false);
    ctx.closePath();
    ctx.fill();

    // Map boundary (world square) in player-relative frame
    this.drawMapBounds(ctx, selfX, selfZ, selfYaw, scale, R);
    this.drawHomeBeacon(ctx, selfX, selfZ, selfYaw, scale, R);

    // Contacts
    for (const c of contacts) {
      const { sx, sy, out } = this.project(c.x - selfX, c.z - selfZ, selfYaw, scale, R);
      const color =
        c.kind === 'enemy' ? '#ff5a4a' : c.kind === 'ally' ? '#5ad0ff' : c.kind === 'neutral' ? '#f0c14e' : '#7dff9a';
      if (c.dead) {
        this.drawX(ctx, sx, sy, 4 * this.dpr, 'rgba(180,180,180,0.7)');
      } else {
        this.drawBlip(ctx, sx, sy, c.yaw - selfYaw, color, out);
      }
    }

    // Self chevron at center (always nose-up)
    this.drawSelf(ctx);

    ctx.restore();

    // North tick (world +Z) relative to heading — small N mark on rim
    const nAngle = -selfYaw; // world +Z in player frame is angle 0 at heading 0; screen uses -z as up so...
    // In our project: world delta rotated by -yaw, then screen y = -localZ.
    // World north (0, +1 in z) in player frame when yaw=0: local (0,1) -> screen (0,-1) = up. Good.
    // Direction to north on rim: angle from +screen-x? Use project of far north point.
    const north = this.project(0 - 0, 1e6 - 0, selfYaw, 1, R); // direction only
    // recompute properly
    const nd = this.dirToScreen(0, 1, selfYaw);
    const nx = cx + nd.x * (R - 8 * this.dpr);
    const ny = cy + nd.y * (R - 8 * this.dpr);
    ctx.fillStyle = 'rgba(200, 230, 255, 0.85)';
    ctx.font = `${10 * this.dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);
    void nAngle;
    void north;

    // Range label
    ctx.fillStyle = 'rgba(120, 220, 160, 0.75)';
    ctx.font = `${9 * this.dpr}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.round(this.rangeM)}m`, cx - R + 6 * this.dpr, cy + R - 4 * this.dpr);
  }

  private drawMapBounds(
    ctx: CanvasRenderingContext2D,
    selfX: number,
    selfZ: number,
    selfYaw: number,
    scale: number,
    R: number,
  ): void {
    const half = MAP_HALF_EXTENT;
    const corners: Array<[number, number]> = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ];
    ctx.strokeStyle = 'rgba(80, 160, 255, 0.25)';
    ctx.lineWidth = 1 * this.dpr;
    ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
    ctx.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const [wx, wz] = corners[i]!;
      const p = this.project(wx - selfX, wz - selfZ, selfYaw, scale, R * 4);
      if (i === 0) ctx.moveTo(p.sx, p.sy);
      else ctx.lineTo(p.sx, p.sy);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Rotate world (dx,dz) into player frame and map to screen (origin at center). */
  private project(
    dx: number,
    dz: number,
    selfYaw: number,
    scale: number,
    clampR: number,
  ): { sx: number; sy: number; out: boolean } {
    const c = Math.cos(-selfYaw);
    const s = Math.sin(-selfYaw);
    // local X right, local Z forward
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    // screen: +x right, +y down; forward (lz+) should be up => -y
    let sx = lx * scale;
    let sy = -lz * scale;
    const dist = Math.hypot(sx, sy);
    let out = false;
    if (dist > clampR - 2) {
      out = true;
      const k = (clampR - 4 * this.dpr) / (dist || 1);
      sx *= k;
      sy *= k;
    }
    return { sx, sy, out };
  }

  private dirToScreen(dx: number, dz: number, selfYaw: number): { x: number; y: number } {
    const c = Math.cos(-selfYaw);
    const s = Math.sin(-selfYaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const len = Math.hypot(lx, lz) || 1;
    return { x: lx / len, y: -lz / len };
  }


  /** Runway / meet-up point at world origin. */
  private drawHomeBeacon(
    ctx: CanvasRenderingContext2D,
    selfX: number,
    selfZ: number,
    selfYaw: number,
    scale: number,
    R: number,
  ): void {
    const p = this.project(0 - selfX, 0 - selfZ, selfYaw, scale, R);
    ctx.save();
    ctx.translate(p.sx, p.sy);
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.9)';
    ctx.fillStyle = 'rgba(255, 220, 80, 0.35)';
    ctx.lineWidth = 1.5 * this.dpr;
    const s = 5 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s, 0);
    ctx.lineTo(0, s);
    ctx.lineTo(-s, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawSelf(ctx: CanvasRenderingContext2D): void {
    const s = 7 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.7, s * 0.75);
    ctx.lineTo(0, s * 0.35);
    ctx.lineTo(-s * 0.7, s * 0.75);
    ctx.closePath();
    ctx.fillStyle = '#7dff9a';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1 * this.dpr;
    ctx.fill();
    ctx.stroke();
  }

  private drawBlip(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    relYaw: number,
    color: string,
    edge: boolean,
  ): void {
    ctx.save();
    ctx.translate(sx, sy);
    if (!edge) {
      ctx.rotate(-relYaw); // relative heading on radar
      const s = 5 * this.dpr;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(s * 0.65, s * 0.7);
      ctx.lineTo(-s * 0.65, s * 0.7);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      // off-range chevron on rim
      ctx.beginPath();
      ctx.arc(0, 0, 3.2 * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1 * this.dpr;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawX(ctx: CanvasRenderingContext2D, sx: number, sy: number, s: number, color: string): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(sx - s, sy - s);
    ctx.lineTo(sx + s, sy + s);
    ctx.moveTo(sx + s, sy - s);
    ctx.lineTo(sx - s, sy + s);
    ctx.stroke();
  }
}
