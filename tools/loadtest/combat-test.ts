/**
 * Two-player combat smoke test against running server.
 */
import {
  MsgType,
  decodeMessage,
  encodeMessage,
  unpackSnapshotPlayers,
  asUint8Array,
} from '@flight-sim/shared';
import WebSocket from 'ws';

const BASE = process.env.API ?? 'http://127.0.0.1:8787';

async function join(nick: string, uuid: string) {
  const res = await fetch(`${BASE}/api/rooms/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: nick, playerUuid: uuid, mode: 'deathmatch', roomId: 'arena' }),
  });
  if (!res.ok) throw new Error(`join ${res.status}`);
  return res.json() as Promise<{ roomId: string; token: string; playerUuid: string }>;
}

function connect(join: { roomId: string; token: string; playerUuid: string }, nick: string) {
  return new Promise<{
    ws: WebSocket;
    playerId: number;
    pos: { x: number; y: number; z: number; ya: number };
    hp: number;
    hits: number;
  }>((resolve, reject) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + `/ws/${join.roomId}`);
    ws.binaryType = 'nodebuffer';
    const state = {
      ws,
      playerId: -1,
      pos: { x: 0, y: 80, z: 0, ya: 0 },
      hp: 100,
      hits: 0,
    };
    const t = setTimeout(() => reject(new Error('timeout join ' + nick)), 5000);
    ws.on('open', () => {
      ws.send(
        encodeMessage(MsgType.C2S_JOIN, {
          protocolVersion: 1,
          playerUuid: join.playerUuid,
          nickname: nick,
          token: join.token,
        }),
      );
    });
    ws.on('message', (data) => {
      const msg = decodeMessage(new Uint8Array(data as Buffer));
      if (msg.type === MsgType.S2C_WELCOME) {
        clearTimeout(t);
        const w = msg.payload as { playerId: number; spawn: { x: number; y: number; z: number; ya: number } };
        state.playerId = w.playerId;
        state.pos = { x: w.spawn.x, y: w.spawn.y, z: w.spawn.z, ya: w.spawn.ya };
        resolve(state);
      }
      if (msg.type === MsgType.S2C_HIT_CONFIRM) state.hits++;
      if (msg.type === MsgType.S2C_DAMAGE) {
        const p = msg.payload as { targetId: number; hp: number };
        if (p.targetId === state.playerId) state.hp = p.hp;
      }
      if (msg.type === MsgType.S2C_SPAWN) {
        const p = msg.payload as { id: number; x: number; y: number; z: number; ya: number; hp: number };
        if (p.id === state.playerId) {
          state.pos = { x: p.x, y: p.y, z: p.z, ya: p.ya };
          state.hp = p.hp;
        }
      }
    });
    ws.on('error', reject);
  });
}

function sendState(s: Awaited<ReturnType<typeof connect>>) {
  s.ws.send(
    encodeMessage(MsgType.C2S_STATE, {
      x: s.pos.x,
      y: s.pos.y,
      z: s.pos.z,
      ya: s.pos.ya,
      pi: 0,
      ro: 0,
      th: 0.5,
      fl: 1,
    }),
  );
}

function sendFireAt(attacker: Awaited<ReturnType<typeof connect>>, target: Awaited<ReturnType<typeof connect>>) {
  const dx = target.pos.x - attacker.pos.x;
  const dy = target.pos.y - attacker.pos.y;
  const dz = target.pos.z - attacker.pos.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  attacker.ws.send(
    encodeMessage(MsgType.C2S_FIRE, {
      dx: dx / len,
      dy: dy / len,
      dz: dz / len,
      seq: Date.now(),
      ox: attacker.pos.x,
      oy: attacker.pos.y,
      oz: attacker.pos.z,
    }),
  );
}

const aJoin = await join('Shooter', crypto.randomUUID());
const bJoin = await join('Target', crypto.randomUUID());
const a = await connect(aJoin, 'Shooter');
const b = await connect(bJoin, 'Target');
console.log('joined', { a: a.playerId, b: b.playerId, aPos: a.pos, bPos: b.pos });

// Place target in front of shooter
a.pos = { x: 0, y: 100, z: 0, ya: 0 };
b.pos = { x: 0, y: 100, z: 80, ya: Math.PI }; // ahead on +Z

// Warm up states (clear needsState + invuln wait)
for (let i = 0; i < 20; i++) {
  sendState(a);
  sendState(b);
  await new Promise((r) => setTimeout(r, 100));
}
// Wait past spawn invuln
await new Promise((r) => setTimeout(r, 900));

const hpBefore = b.hp;
for (let i = 0; i < 15; i++) {
  sendState(a);
  sendState(b);
  sendFireAt(a, b);
  await new Promise((r) => setTimeout(r, 100));
}

console.log({
  hits: a.hits,
  targetHpBefore: hpBefore,
  targetHpAfter: b.hp,
  ok: a.hits > 0 && b.hp < 100,
});

a.ws.close();
b.ws.close();
process.exit(a.hits > 0 && b.hp < 100 ? 0 : 1);
