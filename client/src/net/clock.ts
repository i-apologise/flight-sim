/**
 * Maps client performance.now() → server Date.now() timeline.
 * Must be seeded from welcome.serverTime before remote interpolation.
 */
export class NetClock {
  offsetMs = 0;
  rttMs = 80;
  private samples = 0;
  synced = false;
  lastServerTime = 0;

  /** Seed from S2C_WELCOME so interp works before first pong. */
  seedFromWelcome(serverTime: number): void {
    this.offsetMs = serverTime - performance.now();
    this.lastServerTime = serverTime;
    this.synced = true;
    this.samples = 0;
  }

  onPong(clientTime: number, serverTime: number): void {
    const now = performance.now();
    const rtt = now - clientTime;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return;
    this.rttMs = this.samples === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
    const offset = serverTime + rtt / 2 - now;
    this.offsetMs = !this.synced || this.samples === 0 ? offset : this.offsetMs * 0.85 + offset * 0.15;
    this.lastServerTime = serverTime;
    this.synced = true;
    this.samples++;
  }

  serverNow(): number {
    return performance.now() + this.offsetMs;
  }
}
