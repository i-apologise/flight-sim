import { decode, encode } from '@msgpack/msgpack';
import { MAX_MSG_SIZE } from './constants.js';
import { unwrapAngle } from './math.js';
import type { SnapshotPlayer } from './protocol.js';

export type Envelope = [number, unknown];

export function encodeMessage(type: number, payload: unknown): Uint8Array {
  const bytes = encode([type, payload] satisfies Envelope);
  if (bytes.byteLength > MAX_MSG_SIZE) {
    throw new Error(`message exceeds MAX_MSG_SIZE: ${bytes.byteLength}`);
  }
  return bytes;
}

export function decodeMessage(data: ArrayBuffer | Uint8Array): { type: number; payload: unknown } {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength > MAX_MSG_SIZE) throw new Error('message too large');
  const decoded = decode(u8);
  if (!Array.isArray(decoded) || decoded.length < 2) throw new Error('bad envelope');
  const type = decoded[0];
  if (typeof type !== 'number') throw new Error('bad type');
  return { type, payload: decoded[1] };
}

/** Coerce msgpack bin / Uint8Array / number[] / ArrayBuffer to Uint8Array. */
export function asUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return null;
}

export const PACKED_PLAYER_BYTES = 24;

export function packSnapshotPlayers(players: SnapshotPlayer[]): Uint8Array {
  const buf = new ArrayBuffer(players.length * PACKED_PLAYER_BYTES);
  const view = new DataView(buf);
  let o = 0;
  for (const p of players) {
    const ya = unwrapAngle(p.ya);
    const pi = unwrapAngle(p.pi);
    const ro = unwrapAngle(p.ro);
    view.setUint16(o, p.id & 0xffff, true);
    o += 2;
    view.setFloat32(o, p.x, true);
    o += 4;
    view.setFloat32(o, p.y, true);
    o += 4;
    view.setFloat32(o, p.z, true);
    o += 4;
    view.setInt16(o, radToMilli(ya), true);
    o += 2;
    view.setInt16(o, radToMilli(pi), true);
    o += 2;
    view.setInt16(o, radToMilli(ro), true);
    o += 2;
    view.setUint8(o++, clampU8(Math.round(p.th * 255)));
    view.setUint8(o++, clampU8(Math.round(p.hp)));
    view.setUint8(o++, p.fl & 0xff);
    view.setUint8(o++, 0);
  }
  return new Uint8Array(buf);
}

export function unpackSnapshotPlayers(bin: Uint8Array): SnapshotPlayer[] {
  if (bin.byteLength % PACKED_PLAYER_BYTES !== 0) throw new Error('bad packed length');
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: SnapshotPlayer[] = [];
  for (let o = 0; o < bin.byteLength; o += PACKED_PLAYER_BYTES) {
    out.push({
      id: view.getUint16(o, true),
      x: view.getFloat32(o + 2, true),
      y: view.getFloat32(o + 6, true),
      z: view.getFloat32(o + 10, true),
      ya: milliToRad(view.getInt16(o + 14, true)),
      pi: milliToRad(view.getInt16(o + 16, true)),
      ro: milliToRad(view.getInt16(o + 18, true)),
      th: view.getUint8(o + 20) / 255,
      hp: view.getUint8(o + 21),
      fl: view.getUint8(o + 22),
    });
  }
  return out;
}

function radToMilli(r: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(r * 1000)));
}

function milliToRad(m: number): number {
  return m / 1000;
}

function clampU8(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

export function packedSnapshotByteLength(playerCount: number): number {
  return playerCount * PACKED_PLAYER_BYTES;
}
