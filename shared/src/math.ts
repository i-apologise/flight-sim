export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export function isFiniteNumber(n: number): boolean {
  return Number.isFinite(n);
}

export function isFiniteVec3(v: Vec3): boolean {
  return isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z);
}

export function length3(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z);
}

export function normalize3(x: number, y: number, z: number): Vec3 | null {
  const len = length3(x, y, z);
  if (len < 1e-8 || !Number.isFinite(len)) return null;
  return { x: x / len, y: y / len, z: z / len };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angle lerp (radians). */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function unwrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Unit-axis angle rotation. */
export function quatFromAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return quatNormalize({ x: ax * s, y: ay * s, z: az * s, w: Math.cos(half) });
}

/** Rotate vector by quaternion. */
export function quatRotateVec(q: Quat, v: Vec3): Vec3 {
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  // v + q.w * t + cross(q.xyz, t)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Local +Z (nose). */
export function quatForward(q: Quat): Vec3 {
  return quatRotateVec(q, { x: 0, y: 0, z: 1 });
}

/** Local +X (right wing). */
export function quatRight(q: Quat): Vec3 {
  return quatRotateVec(q, { x: 1, y: 0, z: 0 });
}

/** Local +Y (up). */
export function quatUp(q: Quat): Vec3 {
  return quatRotateVec(q, { x: 0, y: 1, z: 0 });
}

/**
 * Yaw (heading around world Y) from identity, then pitch/roll in local space.
 * Nose along +Z at identity — matches Three.js object default.
 *
 * Sign convention (aviation-friendly):
 * - yaw: 0 faces +Z, positive turns toward +X (right-hand about +Y)
 * - pitch: **positive = nose up** (so we apply **-pitch** about local +X,
 *   because a positive RH rotation about +X takes +Z toward -Y / nose-down)
 * - roll: **positive = left wing down** (positive RH about +Z / nose)
 */
export function quatFromYawPitchRoll(yaw: number, pitch: number, roll: number): Quat {
  const qYaw = quatFromAxisAngle(0, 1, 0, yaw);
  const qPitch = quatFromAxisAngle(1, 0, 0, -pitch); // +pitch => nose up
  const qRoll = quatFromAxisAngle(0, 0, 1, roll);
  // World yaw, then local pitch, then local roll: q = qYaw * qPitch * qRoll
  return quatNormalize(quatMultiply(qYaw, quatMultiply(qPitch, qRoll)));
}

/**
 * Extract yaw/pitch/roll (radians) consistent with quatFromYawPitchRoll.
 * Near vertical, roll is under-defined and returns 0.
 */
export function yawPitchRollFromQuat(q: Quat): { yaw: number; pitch: number; roll: number } {
  const f = quatForward(q);
  const r = quatRight(q);
  const u = quatUp(q);

  const pitch = Math.asin(clamp(f.y, -1, 1));
  const yaw = Math.atan2(f.x, f.z);

  // Level reference (world-up projected orthogonal to nose)
  const d = f.y; // worldUp · forward
  let lx = -f.x * d;
  let ly = 1 - f.y * d;
  let lz = -f.z * d;
  const llen = Math.hypot(lx, ly, lz);
  if (llen < 1e-4) {
    return { yaw, pitch, roll: 0 };
  }
  lx /= llen;
  ly /= llen;
  lz /= llen;

  // Signed angle from level-up to actual up about the nose
  const cosR = clamp(lx * u.x + ly * u.y + lz * u.z, -1, 1);
  const cx = ly * u.z - lz * u.y;
  const cy = lz * u.x - lx * u.z;
  const cz = lx * u.y - ly * u.x;
  const sinR = cx * f.x + cy * f.y + cz * f.z;
  const roll = Math.atan2(sinR, cosR);

  // Fallback blend near poles using wing lift component
  void r;
  return { yaw, pitch, roll };
}

/**
 * Forward from yaw/pitch (roll does not change nose direction).
 * Identity nose = +Z. Matches quatForward(quatFromYawPitchRoll(y,p,r)).
 */
export function forwardFromEuler(yaw: number, pitch: number, _roll: number): Vec3 {
  const cp = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: Math.cos(yaw) * cp,
  };
}

/**
 * Ray-sphere intersection. Ray origin o, unit direction d, sphere center c, radius r.
 * Returns smallest t >= 0 if hit, else null.
 */
export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const fz = oz - cz;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / 2;
  const t1 = (-b + s) / 2;
  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}

export function dist3(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}
