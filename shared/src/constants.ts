export const PROTOCOL_VERSION = 1;

/**
 * Concurrency model (honest):
 * - One Node process can handle ~500 players if room-sharded (16–24/room),
 *   packed snapshots, ~15 Hz broadcast, and no server physics.
 * - 500 in ONE room is intentionally unsupported (O(n²) fan-out).
 * - Scale beyond ~500 with multiple processes / sticky room routing.
 */
export const NET_HZ_DEFAULT = 15;
export const NET_HZ_MAX = 20;
export const SIM_HZ = 60;

export const MAX_PLAYERS_DOGFOOD = 16;
export const MAX_PLAYERS_PUBLIC = 24;
export const MAX_PLAYERS_HARD = 32;

/** Controllable cruise feel — not twitchy fighter jet */
export const MAX_SPEED = 110;
export const MAX_SPEED_HARD = 130;
export const MAP_HALF_EXTENT = 4000;
export const MAX_ALTITUDE = 2000;
export const GROUND_Y = 0;
export const PLANE_GROUND_OFFSET = 2.5;

export const PLAYER_RADIUS = 12;
export const PLAYER_RADIUS_LAG = 16;
export const MAX_HP = 100;
export const FIRE_COOLDOWN_MS = 90;
export const MG_DAMAGE = 12;
export const MG_RANGE = 700;
export const RESPAWN_MS = 2500;
export const SPAWN_INVULN_MS = 700;

export const INTERP_DELAY_MS = 60;
export const EXTRAPOLATE_MS = 120;

export const IDLE_TIMEOUT_MS = 120_000;
export const KEEPALIVE_MS = 2500;
export const HISTORY_MS = 1000;
export const LAG_COMP_MS_DEFAULT = 80;
export const MAX_MSG_SIZE = 16 * 1024;
export const ORIGIN_SLACK_MIN_M = 8;
export const STRIKE_KICK_THRESHOLD = 40;
export const GLOBAL_MAX_ROOMS_FREE = 4;
export const GLOBAL_MAX_PLAYERS_FREE = 32;
export const GLOBAL_MAX_ROOMS_PUBLIC = 64;
/** Architecture ceiling for one well-tuned process (many rooms). */
export const GLOBAL_MAX_PLAYERS_PUBLIC = 500;
export const SEAT_CLAIM_TTL_MS = 60_000;
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const STATE_KEEPALIVE_MS = 200;
export const PING_INTERVAL_MS = 2000;
export const SCOREBOARD_INTERVAL_MS = 5000;

export const ACCEL_RATE = 2.8;
export const PITCH_RATE = 1.35;
export const ROLL_RATE = 1.9;
export const YAW_RATE = 0.95;
/** Coordinated turn from bank — keep mild to avoid wobble */
export const BANK_TURN_RATE = 0.75;
export const AUTO_LEVEL_RATE = 1.1;

export const DIRTY_POS_EPS = 0.08;
export const DIRTY_ANG_EPS = 0.015;
export const DIRTY_THROTTLE_EPS = 0.02;
export const CORRECT_SNAP_M = 40;
export const CRASH_SPEED_THRESHOLD = 45;
export const CRASH_DAMAGE = 30;
export const CRASH_COOLDOWN_MS = 1500;

export const LOBBY_ROOM_DEATHMATCH = 'arena';
export const LOBBY_ROOM_PEACEFUL = 'skypark';

export const RUNWAY_HALF_LENGTH = 420;
export const RUNWAY_HALF_WIDTH = 28;
export const RUNWAY_SURFACE_Y = 0.15;

export const LANDING_AGL_ASSIST = 35;
export const LANDING_TOUCH_AGL = 2.8;
export const LANDING_MAX_SINK = 18;
export const LANDING_MAX_BANK = 0.45;
export const LANDING_MAX_PITCH = 0.35;
/** Must be BELOW TAXI_MAX_SPEED or takeoff is impossible */
export const ROTATE_SPEED = 32;
export const TAXI_MAX_SPEED = 55;
export const TAKEOFF_GRACE_MS = 1500;
export const BRAKE_DECEL = 40;
export const GROUND_FRICTION = 16;
export const THROTTLE_STEP = 0.12;

export const SPAWN_POINTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 80, -100, 0],
  [50, 80, -80, 0.3],
  [-50, 80, -80, -0.3],
  [90, 85, -30, 0.6],
  [-90, 85, -30, -0.6],
  [60, 80, 50, 1.0],
  [-60, 80, 50, -1.0],
  [30, 75, 100, Math.PI],
  [-30, 75, 100, Math.PI],
  [100, 90, 40, 1.4],
  [-100, 90, 40, -1.4],
  [0, 100, 0, 0],
];

export const RESPAWN_POINTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 120, -120, 0],
  [80, 120, -50, 0.4],
  [-80, 120, -50, -0.4],
  [100, 130, 50, 1.2],
  [-100, 130, 50, -1.2],
  [0, 110, 120, Math.PI],
  [120, 125, 0, Math.PI / 2],
  [-120, 125, 0, -Math.PI / 2],
];

export type GameMode = 'peaceful' | 'deathmatch';

export const FLAG_ALIVE = 1 << 0;
export const FLAG_INVULN = 1 << 1;
export const FLAG_FIRING = 1 << 2;
export const FLAG_GEAR = 1 << 3;
export const FLAG_ONGROUND = 1 << 4;
