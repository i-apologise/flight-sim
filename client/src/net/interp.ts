import { lerp, lerpAngle } from '@flight-sim/shared';

export interface PoseSample {
  t: number;
  x: number;
  y: number;
  z: number;
  ya: number;
  pi: number;
  ro: number;
  th: number;
  hp: number;
  fl: number;
}

/**
 * Latest-state smoother — does NOT depend on server clock sync.
 * Each snapshot sets a target; render lerps toward it every frame.
 * This is why remotes were "frozen": clock-based interp often sampled
 * past/before the buffer and held a stale pose.
 */
export class RemoteBuffer {
  name = 'Pilot';
  kills = 0;
  deaths = 0;

  /** Most recent network pose */
  latest: PoseSample | null = null;
  /** What we draw (smoothed) */
  display: PoseSample | null = null;
  updates = 0;

  push(s: PoseSample): void {
    this.latest = { ...s };
    this.updates++;
    if (!this.display) {
      this.display = { ...s };
    }
  }

  /**
   * Advance display toward latest. Call every render frame with dt seconds.
   * Returns pose to draw, or null if never received.
   */
  tick(dt: number): PoseSample | null {
    if (!this.latest) return null;
    if (!this.display) {
      this.display = { ...this.latest };
      return this.display;
    }

    // Faster catch-up when far, smooth when close
    const dx = this.latest.x - this.display.x;
    const dy = this.latest.y - this.display.y;
    const dz = this.latest.z - this.display.z;
    const dist = Math.hypot(dx, dy, dz);

    // Snap if desynced badly (teleport / spawn)
    if (dist > 80) {
      this.display = { ...this.latest };
      return this.display;
    }

    // Exponential smooth — ~12 Hz feel, tracks 15 Hz net well
    const alpha = 1 - Math.exp(-14 * Math.min(dt, 0.05));
    const d = this.display;
    const L = this.latest;
    d.x = lerp(d.x, L.x, alpha);
    d.y = lerp(d.y, L.y, alpha);
    d.z = lerp(d.z, L.z, alpha);
    d.ya = lerpAngle(d.ya, L.ya, alpha);
    d.pi = lerpAngle(d.pi, L.pi, alpha);
    d.ro = lerpAngle(d.ro, L.ro, alpha);
    d.th = lerp(d.th, L.th, alpha);
    d.hp = L.hp;
    d.fl = L.fl;
    d.t = L.t;
    return d;
  }

  /** Instant read of latest network position (for HUD distance) */
  latestPose(): PoseSample | null {
    return this.latest;
  }
}
