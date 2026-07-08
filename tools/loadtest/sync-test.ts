/**
 * Prove remote motion: A moves continuously, B must observe changing positions.
 */
import { MsgType, decodeMessage, encodeMessage, unpackSnapshotPlayers, asUint8Array } from '@flight-sim/shared';
import WebSocket from 'ws';

const BASE = process.env.API ?? 'http://127.0.0.1:8787';

async function join(nick: string) {
  const res = await fetch(`${BASE}/api/rooms/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nickname: nick,
      playerUuid: crypto.randomUUID(),
      mode: 'deathmatch',
      roomId: 'arena',
    }),
  });
  if (!res.ok) throw new Error('join fail');
  return res.json() as Promise<{ roomId: string; token: string; playerUuid: string }>;
}

type Obs = { id: number; positions: Array<{ t: number; x: number; z: number }> };

async function main() {
  const ja = await join('Mover');
  const jb = await join('Watcher');

  const aPos = { x: 0, y: 100, z: 0, ya: 0 };
  let aId = -1;
  let bId = -1;
  const observed: Obs = { id: -1, positions: [] };

  const wa = new WebSocket(BASE.replace('http', 'ws') + `/ws/${ja.roomId}`);
  const wb = new WebSocket(BASE.replace('http', 'ws') + `/ws/${jb.roomId}`);
  wa.binaryType = 'nodebuffer';
  wb.binaryType = 'nodebuffer';

  await Promise.all([
    new Promise<void>((res, rej) => {
      wa.on('open', () => {
        wa.send(
          encodeMessage(MsgType.C2S_JOIN, {
            protocolVersion: 1,
            playerUuid: ja.playerUuid,
            nickname: 'Mover',
            token: ja.token,
          }),
        );
      });
      wa.on('message', (d) => {
        const m = decodeMessage(new Uint8Array(d as Buffer));
        if (m.type === MsgType.S2C_WELCOME) {
          aId = (m.payload as { playerId: number }).playerId;
          res();
        }
      });
      wa.on('error', rej);
      setTimeout(() => rej(new Error('A timeout')), 5000);
    }),
    new Promise<void>((res, rej) => {
      wb.on('open', () => {
        wb.send(
          encodeMessage(MsgType.C2S_JOIN, {
            protocolVersion: 1,
            playerUuid: jb.playerUuid,
            nickname: 'Watcher',
            token: jb.token,
          }),
        );
      });
      wb.on('message', (d) => {
        const m = decodeMessage(new Uint8Array(d as Buffer));
        if (m.type === MsgType.S2C_WELCOME) {
          bId = (m.payload as { playerId: number }).playerId;
          res();
        }
        if (m.type === MsgType.S2C_SNAPSHOT) {
          const snap = m.payload as { t: number; f?: number; b?: unknown; p?: Array<{ id: number; x: number; z: number }> };
          let players = snap.p ?? [];
          if (snap.f === 1 && snap.b) {
            const bin = asUint8Array(snap.b);
            if (bin) players = unpackSnapshotPlayers(bin);
          }
          for (const p of players) {
            if (p.id === aId) {
              observed.id = p.id;
              observed.positions.push({ t: snap.t, x: p.x, z: p.z });
            }
          }
        }
      });
      wb.on('error', rej);
      setTimeout(() => rej(new Error('B timeout')), 5000);
    }),
  ]);

  console.log('ids', { aId, bId });

  // A flies +Z at 100 m/s for 2 seconds @ 20Hz
  const start = Date.now();
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      aPos.z = elapsed * 100;
      aPos.x = 0;
      aPos.y = 100;
      wa.send(
        encodeMessage(MsgType.C2S_STATE, {
          x: aPos.x,
          y: aPos.y,
          z: aPos.z,
          ya: 0,
          pi: 0,
          ro: 0,
          th: 1,
          fl: 1,
        }),
      );
      // watcher also sends so not idle
      wb.send(
        encodeMessage(MsgType.C2S_STATE, {
          x: 500,
          y: 100,
          z: 500,
          ya: 0,
          pi: 0,
          ro: 0,
          th: 0.5,
          fl: 1,
        }),
      );
      if (elapsed >= 2) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });

  await new Promise((r) => setTimeout(r, 300));

  const zs = observed.positions.map((p) => p.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const delta = zMax - zMin;
  const samples = observed.positions.length;

  console.log({
    samples,
    zMin: zMin.toFixed(1),
    zMax: zMax.toFixed(1),
    delta: delta.toFixed(1),
    ok: samples >= 20 && delta > 50,
  });

  wa.close();
  wb.close();
  process.exit(samples >= 20 && delta > 50 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
