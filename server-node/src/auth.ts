import { createHmac, timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, SEAT_CLAIM_TTL_MS, SESSION_TTL_MS } from '@flight-sim/shared';

const SECRET = process.env.SESSION_SECRET ?? 'dev-flight-sim-secret-change-me';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecode(s: string): string | null {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export interface SessionToken {
  protocolVersion: number;
  playerUuid: string;
  requestedNickname: string;
  roomId: string;
  iatMs: number;
  expMs: number;
  raw: string;
}

/**
 * Token format (dot-separated, nick/room base64url so they may contain any chars):
 * version.uuid.nickB64.roomB64.iat.exp.sig
 */
export function mintToken(playerUuid: string, requestedNickname: string, roomId: string): {
  token: string;
  expiresAt: number;
  iatMs: number;
} {
  const iatMs = Date.now();
  const expMs = iatMs + SESSION_TTL_MS;
  const payload = `${PROTOCOL_VERSION}.${playerUuid}.${b64url(requestedNickname)}.${b64url(roomId)}.${iatMs}.${expMs}`;
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresAt: expMs, iatMs };
}

export function verifyToken(token: string, expectedRoomId: string): SessionToken | null {
  const parts = token.split('.');
  if (parts.length !== 7) return null;
  const [ver, playerUuid, nickB64, roomB64, iatStr, expStr, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const payload = `${ver}.${playerUuid}.${nickB64}.${roomB64}.${iatStr}.${expStr}`;
  const expect = createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  const requestedNickname = b64urlDecode(nickB64);
  const roomId = b64urlDecode(roomB64);
  if (!requestedNickname || !roomId) return null;
  if (roomId !== expectedRoomId) return null;
  const protocolVersion = Number(ver);
  const iatMs = Number(iatStr);
  const expMs = Number(expStr);
  if (!Number.isFinite(iatMs) || !Number.isFinite(expMs)) return null;
  if (protocolVersion !== PROTOCOL_VERSION) return null;
  if (Date.now() > expMs) return null;
  return { protocolVersion, playerUuid, requestedNickname, roomId, iatMs, expMs, raw: token };
}

export function isFreshSeatClaim(iatMs: number, now = Date.now()): boolean {
  return now - iatMs <= SEAT_CLAIM_TTL_MS;
}
