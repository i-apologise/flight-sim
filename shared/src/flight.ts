/**
 * Euler-primary arcade flight.
 * Ground: taxi + gradual nose rotate; lift-off is natural (no altitude teleport).
 */
import {
  ACCEL_RATE,
  AUTO_LEVEL_RATE,
  BANK_TURN_RATE,
  BRAKE_DECEL,
  GROUND_FRICTION,
  GROUND_Y,
  LANDING_AGL_ASSIST,
  LANDING_MAX_BANK,
  LANDING_MAX_PITCH,
  LANDING_MAX_SINK,
  LANDING_TOUCH_AGL,
  MAP_HALF_EXTENT,
  MAX_ALTITUDE,
  MAX_SPEED,
  PITCH_RATE,
  PLANE_GROUND_OFFSET,
  ROLL_RATE,
  ROTATE_SPEED,
  TAKEOFF_GRACE_MS,
  TAXI_MAX_SPEED,
  YAW_RATE,
} from './constants.js';
import {
  clamp,
  forwardFromEuler,
  quatFromYawPitchRoll,
  unwrapAngle,
  type Quat,
} from './math.js';

export interface FlightInput {
  pitch: number;
  roll: number;
  yaw: number;
  throttleDelta: number;
  throttleSet?: number | null;
  brake?: boolean;
  landingAssist?: boolean;
}

export interface FlightState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  throttle: number;
  speed: number;
  q?: Quat;
  onGround: boolean;
  gearDown: boolean;
  takeoffGraceUntil?: number;
}

const GROUND_Y_POS = () => GROUND_Y + PLANE_GROUND_OFFSET;

export function createFlightState(x = 0, y = 80, z = 0, yaw = 0): FlightState {
  const onGround = y <= GROUND_Y + PLANE_GROUND_OFFSET + 0.5;
  const state: FlightState = {
    x,
    y: onGround ? GROUND_Y_POS() : y,
    z,
    yaw: unwrapAngle(yaw),
    pitch: 0,
    roll: 0,
    throttle: onGround ? 0 : 0.5,
    speed: onGround ? 0 : MAX_SPEED * 0.4,
    onGround,
    gearDown: true,
    takeoffGraceUntil: 0,
  };
  rebuildQuat(state);
  return state;
}

function rebuildQuat(state: FlightState): void {
  state.q = quatFromYawPitchRoll(state.yaw, state.pitch, state.roll);
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export function integrateArcadeFlight(state: FlightState, input: FlightInput, dt: number): void {
  if (dt <= 0 || dt > 0.1) return;
  dt = Math.min(dt, 1 / 30);

  if (state.gearDown === undefined) state.gearDown = true;
  if (state.onGround === undefined) state.onGround = false;
  if (state.takeoffGraceUntil === undefined) state.takeoffGraceUntil = 0;

  if (input.throttleSet !== undefined && input.throttleSet !== null) {
    state.throttle = clamp(input.throttleSet, 0, 1);
  } else {
    state.throttle = clamp(state.throttle + input.throttleDelta * dt, 0, 1);
  }

  if (state.onGround) integrateGround(state, input, dt);
  else integrateAir(state, input, dt);

  state.x = clamp(state.x, -MAP_HALF_EXTENT, MAP_HALF_EXTENT);
  state.z = clamp(state.z, -MAP_HALF_EXTENT, MAP_HALF_EXTENT);
  if (state.onGround) {
    state.y = GROUND_Y_POS();
  } else {
    state.y = clamp(state.y, GROUND_Y_POS(), MAX_ALTITUDE);
  }
  state.yaw = unwrapAngle(state.yaw);
  state.roll = clamp(state.roll, -1.15, 1.15);
  state.pitch = clamp(state.pitch, -1.1, 1.1);
  rebuildQuat(state);
}

/**
 * Ground roll:
 * - Steer with A/D / Q/E
 * - Below rotate speed: nose stays level
 * - At/above rotate speed: W/S rotate nose gradually (not instant air)
 * - Lift-off when nose is up enough AND speed is enough — no Y teleport
 */
function integrateGround(state: FlightState, input: FlightInput, dt: number): void {
  const steer = clamp(input.yaw + input.roll * 0.9, -1, 1);
  const steerRate = 1.35 * (0.2 + 0.8 * clamp(state.speed / 28, 0, 1));
  state.yaw = unwrapAngle(state.yaw - steer * steerRate * dt);
  state.roll = 0;

  const target = state.throttle * TAXI_MAX_SPEED;
  state.speed += (target - state.speed) * Math.min(1, 2.8 * dt);
  if (input.brake) {
    state.speed = Math.max(0, state.speed - BRAKE_DECEL * dt);
  } else if (state.throttle < 0.02) {
    state.speed = Math.max(0, state.speed - GROUND_FRICTION * dt);
  }

  // Gradual nose rotate for takeoff (only when rolling fast enough)
  const canRotate = state.speed >= ROTATE_SPEED * 0.85;
  if (canRotate) {
    // Slow rotate — hold W for ~1s to raise nose; no snap-to-air
    const pitchIn = clamp(input.pitch, -1, 1);
    if (Math.abs(pitchIn) > 0.05) {
      state.pitch += pitchIn * PITCH_RATE * 0.28 * dt;
    } else {
      state.pitch *= 1 - Math.min(1, 1.2 * dt);
      if (Math.abs(state.pitch) < 0.015) state.pitch = 0;
    }
    state.pitch = clamp(state.pitch, -0.04, 0.38);
  } else {
    state.pitch = 0;
  }

  const c = Math.cos(state.yaw);
  const s = Math.sin(state.yaw);
  state.x += s * state.speed * dt;
  state.z += c * state.speed * dt;
  state.y = GROUND_Y_POS();

  // Lift-off only after nose is clearly up — then climb happens over time in air (no Y teleport)
  if (state.speed >= ROTATE_SPEED && state.pitch >= 0.22) {
    state.onGround = false;
    state.takeoffGraceUntil = nowMs() + TAKEOFF_GRACE_MS;
  }
}

function integrateAir(state: FlightState, input: FlightInput, dt: number): void {
  const pitchIn = clamp(input.pitch, -1, 1);
  const rollIn = clamp(input.roll, -1, 1);
  const yawIn = clamp(input.yaw, -1, 1);

  const agl = state.y - GROUND_Y_POS();
  const grace = (state.takeoffGraceUntil ?? 0) > nowMs();
  const finalApproach =
    !grace &&
    state.gearDown &&
    agl < 14 &&
    state.speed < MAX_SPEED * 0.55 &&
    Math.abs(state.pitch) < 0.35;
  const assist = !grace && (!!input.landingAssist || finalApproach) && agl < LANDING_AGL_ASSIST;

  state.pitch += pitchIn * PITCH_RATE * dt;
  state.roll += rollIn * ROLL_RATE * dt;
  state.yaw += -yawIn * YAW_RATE * dt;

  const speedFactor = clamp(state.speed / (MAX_SPEED * 0.5), 0.2, 1.15);
  state.yaw += -Math.sin(state.roll) * BANK_TURN_RATE * speedFactor * dt;

  if (Math.abs(rollIn) < 0.08) {
    state.roll *= 1 - Math.min(1, AUTO_LEVEL_RATE * dt);
    if (Math.abs(state.roll) < 0.008) state.roll = 0;
  }

  if (assist && state.pitch < 0.08 && agl < 18) {
    state.pitch += 0.4 * dt * (1 - agl / 18);
  }

  state.pitch = clamp(state.pitch, -1.1, 1.1);
  state.roll = clamp(state.roll, -1.15, 1.15);
  state.yaw = unwrapAngle(state.yaw);

  const targetSpeed = state.throttle * MAX_SPEED;
  const pitchBleed = 1 - clamp(state.pitch, -0.5, 0.7) * 0.18;
  const gearDrag = state.gearDown ? 0.93 : 1;
  const target = Math.max(0, targetSpeed * pitchBleed * gearDrag);
  state.speed += (target - state.speed) * Math.min(1, ACCEL_RATE * dt);
  state.speed = Math.max(0, state.speed);
  if (input.brake) {
    state.speed = Math.max(0, state.speed - BRAKE_DECEL * 0.35 * dt);
  }

  const nose = forwardFromEuler(state.yaw, state.pitch, state.roll);
  state.x += nose.x * state.speed * dt;
  state.y += nose.y * state.speed * dt;
  state.z += nose.z * state.speed * dt;

  if (state.y > MAX_ALTITUDE) {
    state.y = MAX_ALTITUDE;
    if (state.pitch > 0) state.pitch *= 0.85;
  }

  const minY = GROUND_Y_POS();
  const newAgl = state.y - minY;
  // During takeoff grace, don't snap back to ground
  const climbingOut = grace || (state.pitch > 0.1 && nose.y > 0.03);

  if (newAgl <= 0) {
    state.y = minY;
  }

  if (newAgl <= LANDING_TOUCH_AGL && !climbingOut) {
    const sink = Math.max(0, -nose.y * state.speed);
    const soft =
      state.gearDown &&
      Math.abs(state.roll) < LANDING_MAX_BANK &&
      state.pitch < LANDING_MAX_PITCH &&
      state.pitch > -0.12 &&
      sink < LANDING_MAX_SINK;

    if (soft || newAgl <= 0.02) {
      state.y = minY;
      state.onGround = true;
      state.gearDown = true;
      state.pitch = 0;
      state.roll = 0;
      state.speed = soft
        ? Math.min(state.speed, TAXI_MAX_SPEED * 0.85)
        : Math.min(state.speed * 0.3, 12);
    }
  }

  if (Math.abs(state.x) >= MAP_HALF_EXTENT - 1 || Math.abs(state.z) >= MAP_HALF_EXTENT - 1) {
    state.yaw = unwrapAngle(state.yaw + Math.PI);
    state.x = clamp(state.x, -MAP_HALF_EXTENT + 2, MAP_HALF_EXTENT - 2);
    state.z = clamp(state.z, -MAP_HALF_EXTENT + 2, MAP_HALF_EXTENT - 2);
  }
}

export function createAirborneState(
  x: number,
  y: number,
  z: number,
  yaw: number,
  speed = 55,
  throttle = 0.55,
): FlightState {
  const state = createFlightState(x, Math.max(y, 50), z, yaw);
  state.onGround = false;
  state.gearDown = true;
  state.pitch = 0.04;
  state.roll = 0;
  state.speed = speed;
  state.throttle = throttle;
  state.takeoffGraceUntil = nowMs() + 400;
  rebuildQuat(state);
  return state;
}

export function setFlightPose(
  state: FlightState,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll: number,
): void {
  state.x = x;
  state.y = y;
  state.z = z;
  state.yaw = unwrapAngle(yaw);
  state.pitch = pitch;
  state.roll = unwrapAngle(roll);
  state.onGround = y <= GROUND_Y + PLANE_GROUND_OFFSET + 0.6;
  rebuildQuat(state);
}

export function toggleGear(state: FlightState): void {
  if (state.onGround) {
    state.gearDown = true;
    return;
  }
  state.gearDown = !state.gearDown;
}

export { forwardFromEuler };
