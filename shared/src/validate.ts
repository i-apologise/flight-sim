import {
  GROUND_Y,
  MAP_HALF_EXTENT,
  MAX_ALTITUDE,
  MAX_SPEED_HARD,
  PLANE_GROUND_OFFSET,
} from './constants.js';
import { isFiniteNumber, unwrapAngle } from './math.js';

export interface PoseLike {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  throttle: number;
}

export type ValidateFail = 'nan' | 'bounds' | 'speed' | 'throttle' | 'angles';

export function validatePose(p: PoseLike, prev?: PoseLike, dtSec?: number): ValidateFail | null {
  if (
    !isFiniteNumber(p.x) ||
    !isFiniteNumber(p.y) ||
    !isFiniteNumber(p.z) ||
    !isFiniteNumber(p.yaw) ||
    !isFiniteNumber(p.pitch) ||
    !isFiniteNumber(p.roll) ||
    !isFiniteNumber(p.throttle)
  ) {
    return 'nan';
  }
  if (p.throttle < -0.05 || p.throttle > 1.05) return 'throttle';
  if (Math.abs(p.pitch) > Math.PI / 2 + 0.25) return 'angles';
  if (Math.abs(p.x) > MAP_HALF_EXTENT + 50 || Math.abs(p.z) > MAP_HALF_EXTENT + 50) return 'bounds';
  if (p.y < GROUND_Y - 20 || p.y > MAX_ALTITUDE + 50) return 'bounds';

  if (prev && dtSec !== undefined && dtSec > 0 && dtSec < 1) {
    const dist = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    const speed = dist / dtSec;
    // Allow larger jump after long silence (respawn / lag) — only strict when continuous
    if (dtSec < 0.35 && speed > MAX_SPEED_HARD * 1.25) return 'speed';
  }
  return null;
}

export function clampPoseToBounds(p: PoseLike): PoseLike {
  return {
    ...p,
    x: Math.max(-MAP_HALF_EXTENT, Math.min(MAP_HALF_EXTENT, p.x)),
    y: Math.max(GROUND_Y + PLANE_GROUND_OFFSET * 0.5, Math.min(MAX_ALTITUDE, p.y)),
    z: Math.max(-MAP_HALF_EXTENT, Math.min(MAP_HALF_EXTENT, p.z)),
    yaw: unwrapAngle(p.yaw),
    pitch: Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, p.pitch)),
    roll: unwrapAngle(p.roll),
    throttle: Math.max(0, Math.min(1, p.throttle)),
  };
}

export function sanitizeNickname(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_ \-]/g, '').trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Pilot';
}
