import { FIRE_COOLDOWN_MS, type FlightInput } from '@flight-sim/shared';

export class InputManager {
  private keys = new Set<string>();
  showScores = false;
  private gearTogglePressed = false;
  private gearLatched = false;
  private lastFireAt = 0;
  /** Absolute throttle from keys 0-9 this frame */
  private throttleSet: number | null = null;

  constructor() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
      if (e.code === 'Tab') {
        e.preventDefault();
        this.showScores = true;
      }
      if (e.code === 'KeyG') {
        if (!this.gearLatched) {
          this.gearTogglePressed = true;
          this.gearLatched = true;
        }
      }
      // Speed control: 1–9 = 10–90%, 0 = 0%, also Digit keys
      const digit = digitThrottle(e.code);
      if (digit !== null) this.throttleSet = digit;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Tab') this.showScores = false;
      if (e.code === 'KeyG') this.gearLatched = false;
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  sampleFlight(onGround: boolean): FlightInput {
    const up = this.down('KeyW') || this.down('ArrowUp');
    const down = this.down('KeyS') || this.down('ArrowDown');
    const left = this.down('KeyA') || this.down('ArrowLeft');
    const right = this.down('KeyD') || this.down('ArrowRight');
    const yawL = this.down('KeyQ');
    const yawR = this.down('KeyE');
    // Fine throttle adjust
    const thrUp = this.down('ShiftLeft') || this.down('ShiftRight');
    const thrDn = this.down('ControlLeft') || this.down('ControlRight');
    const brake = this.down('KeyB') || (onGround && this.down('Space'));
    const landingAssist = this.down('KeyF') || this.down('KeyL');

    const set = this.throttleSet;
    this.throttleSet = null;

    return {
      pitch: (up ? 1 : 0) + (down ? -1 : 0),
      roll: (left ? 1 : 0) + (right ? -1 : 0),
      yaw: (yawL ? 1 : 0) + (yawR ? -1 : 0),
      // Slower fine adjust so 0-9 are the main speed control
      throttleDelta: (thrUp ? 0.35 : 0) + (thrDn ? -0.35 : 0),
      throttleSet: set,
      brake,
      landingAssist,
    };
  }

  pollFire(onGround: boolean, now: number): boolean {
    if (onGround) return false;
    if (!this.down('Space')) return false;
    if (now - this.lastFireAt < FIRE_COOLDOWN_MS) return false;
    this.lastFireAt = now;
    return true;
  }

  consumeGearToggle(): boolean {
    if (!this.gearTogglePressed) return false;
    this.gearTogglePressed = false;
    return true;
  }

  private down(code: string): boolean {
    return this.keys.has(code);
  }
}

function digitThrottle(code: string): number | null {
  // Digit0–Digit9 and Numpad0–9
  const map: Record<string, number> = {
    Digit0: 0,
    Digit1: 0.1,
    Digit2: 0.2,
    Digit3: 0.3,
    Digit4: 0.4,
    Digit5: 0.5,
    Digit6: 0.6,
    Digit7: 0.7,
    Digit8: 0.8,
    Digit9: 0.9,
    Numpad0: 0,
    Numpad1: 0.1,
    Numpad2: 0.2,
    Numpad3: 0.3,
    Numpad4: 0.4,
    Numpad5: 0.5,
    Numpad6: 0.6,
    Numpad7: 0.7,
    Numpad8: 0.8,
    Numpad9: 0.9,
  };
  // Key 0 = idle, hold Shift+0 or use Digit0 for 0; 9 is 90% — full throttle = hold Shift
  return map[code] ?? null;
}
