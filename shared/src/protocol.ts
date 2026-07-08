import type { GameMode } from './constants.js';

/** Message type opcodes — fixed for wire compatibility. */
export const MsgType = {
  // Client → Server
  C2S_JOIN: 1,
  C2S_STATE: 2,
  C2S_FIRE: 3,
  C2S_PING: 4,
  C2S_RESPAWN: 5,
  C2S_LEAVE: 6,

  // Server → Client
  S2C_WELCOME: 10,
  S2C_SNAPSHOT: 11,
  S2C_PLAYER_JOINED: 12,
  S2C_PLAYER_LEFT: 13,
  S2C_DAMAGE: 14,
  S2C_HIT_CONFIRM: 15,
  S2C_KILL: 16,
  S2C_SPAWN: 17,
  S2C_SCOREBOARD: 18,
  S2C_PONG: 19,
  S2C_REJECT: 20,
  S2C_ROOM_FULL: 21,
  S2C_CORRECT: 22,
  S2C_CHAT: 23, // reserved phase-2
} as const;

export type MsgTypeId = (typeof MsgType)[keyof typeof MsgType];

export type PlayerPhase = 'Alive' | 'Dying' | 'Dead' | 'Spawning';
export type PlayerId = number;

export interface C2SJoin {
  protocolVersion: number;
  playerUuid: string;
  nickname: string;
  token: string;
}

export interface C2SState {
  x: number;
  y: number;
  z: number;
  ya: number; // yaw
  pi: number; // pitch
  ro: number; // roll
  th: number; // throttle 0..1
  fl?: number; // flags
  t?: number; // client time ms optional
}

export interface C2SFire {
  dx: number;
  dy: number;
  dz: number;
  seq: number;
  t?: number;
  ox?: number;
  oy?: number;
  oz?: number;
}

export interface C2SPing {
  clientTime: number;
}

export interface C2SRespawn {
  // empty reserved
}

export interface SnapshotPlayer {
  id: PlayerId;
  n?: string; // name only on join diffs; omitted in packed
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

export interface S2CWelcome {
  playerId: PlayerId;
  roomId: string;
  mode: GameMode;
  maxPlayers: number;
  protocolVersion: number;
  displayName: string;
  spawn: { x: number; y: number; z: number; ya: number; pi: number; ro: number };
  players: Array<SnapshotPlayer & { n: string; kills: number; deaths: number }>;
  serverTime: number;
  tickHz: number;
}

export interface S2CSnapshot {
  t: number; // server time ms
  f?: number; // format: 0 msgpack players, 1 packed bin
  p?: SnapshotPlayer[];
  b?: Uint8Array; // packed body when f===1
}

export interface S2CPlayerJoined {
  id: PlayerId;
  n: string;
  x: number;
  y: number;
  z: number;
  ya: number;
  pi: number;
  ro: number;
  hp: number;
  fl: number;
}

export interface S2CPlayerLeft {
  id: PlayerId;
}

export interface S2CDamage {
  targetId: PlayerId;
  attackerId: PlayerId;
  amount: number;
  hp: number;
  x?: number;
  y?: number;
  z?: number;
}

export interface S2CHitConfirm {
  seq: number;
  targetId: PlayerId;
  amount: number;
}

export interface S2CKill {
  killerId: PlayerId;
  victimId: PlayerId;
  killerName: string;
  victimName: string;
  killerKills: number;
  victimDeaths: number;
}

export interface S2CSpawn {
  id: PlayerId;
  x: number;
  y: number;
  z: number;
  ya: number;
  pi: number;
  ro: number;
  hp: number;
  invulnMs: number;
}

export interface S2CScoreboard {
  entries: Array<{ id: PlayerId; n: string; k: number; d: number; dmg: number }>;
}

export interface S2CPong {
  clientTime: number;
  serverTime: number;
}

export type RejectCode =
  | 'BAD_TOKEN'
  | 'BAD_VERSION'
  | 'MALFORMED'
  | 'BANNED'
  | 'WORLD_FULL'
  | 'ROOM_DISABLED';

export interface S2CReject {
  code: RejectCode;
  message?: string;
}

export interface S2CRoomFull {
  count: number;
  max: number;
}

export interface S2CCorrect {
  x: number;
  y: number;
  z: number;
  ya: number;
  pi: number;
  ro: number;
  th: number;
}

export type ClientMessage =
  | { type: typeof MsgType.C2S_JOIN; payload: C2SJoin }
  | { type: typeof MsgType.C2S_STATE; payload: C2SState }
  | { type: typeof MsgType.C2S_FIRE; payload: C2SFire }
  | { type: typeof MsgType.C2S_PING; payload: C2SPing }
  | { type: typeof MsgType.C2S_RESPAWN; payload: C2SRespawn }
  | { type: typeof MsgType.C2S_LEAVE; payload: Record<string, never> };

export type ServerMessage =
  | { type: typeof MsgType.S2C_WELCOME; payload: S2CWelcome }
  | { type: typeof MsgType.S2C_SNAPSHOT; payload: S2CSnapshot }
  | { type: typeof MsgType.S2C_PLAYER_JOINED; payload: S2CPlayerJoined }
  | { type: typeof MsgType.S2C_PLAYER_LEFT; payload: S2CPlayerLeft }
  | { type: typeof MsgType.S2C_DAMAGE; payload: S2CDamage }
  | { type: typeof MsgType.S2C_HIT_CONFIRM; payload: S2CHitConfirm }
  | { type: typeof MsgType.S2C_KILL; payload: S2CKill }
  | { type: typeof MsgType.S2C_SPAWN; payload: S2CSpawn }
  | { type: typeof MsgType.S2C_SCOREBOARD; payload: S2CScoreboard }
  | { type: typeof MsgType.S2C_PONG; payload: S2CPong }
  | { type: typeof MsgType.S2C_REJECT; payload: S2CReject }
  | { type: typeof MsgType.S2C_ROOM_FULL; payload: S2CRoomFull }
  | { type: typeof MsgType.S2C_CORRECT; payload: S2CCorrect };
