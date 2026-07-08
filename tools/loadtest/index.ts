import {
  MsgType,
  createFlightState,
  decodeMessage,
  encodeMessage,
  integrateArcadeFlight,
} from '@flight-sim/shared';
import WebSocket from 'ws';

const BASE = process.env.API ?? 'http://127.0.0.1:8787';
const PLAYERS = Number(process.env.PLAYERS ?? process.argv.find((a) => a.startsWith('--players'))?.split('=')[1] ?? 8);
const HZ = Number(process.env.HZ ?? 10);
const DURATION_MS = Number(process.env.DURATION_MS ?? 15_000);

async function bot(i: number): Promise<{ bytesIn: number; errors: number }> {
  let bytesIn = 0;
  let errors = 0;
  const nickname = `Bot${i}`;
  const playerUuid = crypto.randomUUID();
  const joinRes = await fetch(`${BASE}/api/rooms/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname, playerUuid, mode: 'peaceful' }),
  });
  if (!joinRes.ok) throw new Error(`join ${joinRes.status}`);
  const join = (await joinRes.json()) as { roomId: string; token: string; playerUuid: string };
  const wsUrl = BASE.replace('http', 'ws') + `/ws/${join.roomId}`;

  const flight = createFlightState(i * 30, 80, i * 20, 0);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t0 = Date.now();
    let joined = false;

    ws.on('open', () => {
      ws.send(
        encodeMessage(MsgType.C2S_JOIN, {
          protocolVersion: 1,
          playerUuid: join.playerUuid,
          nickname,
          token: join.token,
        }),
      );
    });

    ws.on('message', (data) => {
      bytesIn += (data as Buffer).byteLength;
      try {
        const msg = decodeMessage(new Uint8Array(data as Buffer));
        if (msg.type === MsgType.S2C_WELCOME) joined = true;
        if (msg.type === MsgType.S2C_REJECT) errors++;
      } catch {
        errors++;
      }
    });

    ws.on('error', () => {
      errors++;
      reject(new Error('ws error'));
    });

    const iv = setInterval(() => {
      if (!joined || ws.readyState !== WebSocket.OPEN) return;
      integrateArcadeFlight(flight, { pitch: 0.1, roll: 0.05, yaw: 0, throttleDelta: 0 }, 1 / HZ);
      ws.send(
        encodeMessage(MsgType.C2S_STATE, {
          x: flight.x,
          y: flight.y,
          z: flight.z,
          ya: flight.yaw,
          pi: flight.pitch,
          ro: flight.roll,
          th: flight.throttle,
          fl: 1,
        }),
      );
      if (Date.now() - t0 > DURATION_MS) {
        clearInterval(iv);
        ws.close();
        resolve();
      }
    }, 1000 / HZ);
  });

  return { bytesIn, errors };
}

const n = Number.isFinite(PLAYERS) ? PLAYERS : 8;
console.log(`loadtest players=${n} hz=${HZ} duration=${DURATION_MS}ms base=${BASE}`);
const results = await Promise.all(Array.from({ length: n }, (_, i) => bot(i)));
const bytes = results.reduce((a, r) => a + r.bytesIn, 0);
const errors = results.reduce((a, r) => a + r.errors, 0);
console.log(`done bytesIn=${bytes} errors=${errors} perPlayerBytes/s≈${(bytes / n / (DURATION_MS / 1000)).toFixed(0)}`);
if (errors > 0) process.exitCode = 1;
