/**
 * Stress test: N flying bots + metrics dump.
 * Usage: STRESS_MAX_PLAYERS=64 PLAYERS=50 DURATION_MS=30000 npx tsx stress-50.ts
 *
 * Join browser to room "arena" as spectator while this runs.
 */
import {
  MsgType,
  createFlightState,
  decodeMessage,
  encodeMessage,
  integrateArcadeFlight,
  unpackSnapshotPlayers,
  asUint8Array,
} from '@flight-sim/shared';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.API ?? 'http://127.0.0.1:8787';
const PLAYERS = Number(process.env.PLAYERS ?? 50);
const HZ = Number(process.env.HZ ?? 15);
const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);
const ROOM = process.env.ROOM ?? 'arena';
const MODE = (process.env.MODE ?? 'deathmatch') as 'deathmatch' | 'peaceful';

interface BotMetrics {
  id: number;
  bytesIn: number;
  bytesOut: number;
  snapshots: number;
  errors: number;
  lastPlayersInSnap: number;
  joined: boolean;
}

const metrics: BotMetrics[] = [];
const t0wall = Date.now();
const samples: Array<{
  t: number;
  players: number;
  snapPlayers: number;
  bytesInTotal: number;
  bytesOutTotal: number;
  snapshotsTotal: number;
  errors: number;
  rssMB: number;
  heapMB: number;
}> = [];

async function httpJoin(nick: string, uuid: string) {
  const res = await fetch(`${BASE}/api/rooms/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nickname: nick,
      playerUuid: uuid,
      mode: MODE,
      roomId: ROOM,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`join ${res.status} ${body}`);
  }
  return res.json() as Promise<{ roomId: string; token: string; playerUuid: string; maxPlayers: number }>;
}

async function startBot(i: number): Promise<void> {
  const m: BotMetrics = {
    id: i,
    bytesIn: 0,
    bytesOut: 0,
    snapshots: 0,
    errors: 0,
    lastPlayersInSnap: 0,
    joined: false,
  };
  metrics.push(m);

  const uuid = crypto.randomUUID();
  const nick = `Bot${String(i).padStart(2, '0')}`;
  let seat: Awaited<ReturnType<typeof httpJoin>>;
  try {
    seat = await httpJoin(nick, uuid);
  } catch (e) {
    m.errors++;
    console.error(`bot ${i} join fail`, e);
    return;
  }

  const wsUrl = BASE.replace('http', 'ws') + `/ws/${seat.roomId}`;
  // Spiral formation around origin for visual density
  const angle = (i / PLAYERS) * Math.PI * 2;
  const radius = 80 + (i % 10) * 25;
  const flight = createFlightState(
    Math.cos(angle) * radius,
    60 + (i % 5) * 15,
    Math.sin(angle) * radius,
    angle + Math.PI / 2,
  );
  flight.throttle = 0.4 + (i % 5) * 0.1;
  flight.speed = 40 + (i % 8) * 5;
  flight.onGround = false;

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'nodebuffer';
    const start = Date.now();
    let alive = true;

    const end = () => {
      alive = false;
      try {
        ws.close();
      } catch {
        /* */
      }
      resolve();
    };

    ws.on('open', () => {
      const joinMsg = encodeMessage(MsgType.C2S_JOIN, {
        protocolVersion: 1,
        playerUuid: seat.playerUuid,
        nickname: nick,
        token: seat.token,
      });
      ws.send(joinMsg);
      m.bytesOut += joinMsg.byteLength;
    });

    ws.on('message', (data) => {
      const buf = data as Buffer;
      m.bytesIn += buf.byteLength;
      try {
        const msg = decodeMessage(new Uint8Array(buf));
        if (msg.type === MsgType.S2C_WELCOME) {
          m.joined = true;
        }
        if (msg.type === MsgType.S2C_SNAPSHOT) {
          m.snapshots++;
          const snap = msg.payload as { f?: number; p?: unknown[]; b?: unknown };
          if (snap.f === 1 && snap.b) {
            const bin = asUint8Array(snap.b);
            if (bin) m.lastPlayersInSnap = unpackSnapshotPlayers(bin).length;
          } else if (Array.isArray(snap.p)) {
            m.lastPlayersInSnap = snap.p.length;
          }
        }
        if (msg.type === MsgType.S2C_REJECT || msg.type === MsgType.S2C_ROOM_FULL) {
          m.errors++;
        }
      } catch {
        m.errors++;
      }
    });

    ws.on('error', () => {
      m.errors++;
    });
    ws.on('close', () => {
      if (alive) end();
    });

    // Flight + state loop
    const iv = setInterval(() => {
      if (!alive || ws.readyState !== WebSocket.OPEN) return;
      // Gentle circling
      integrateArcadeFlight(
        flight,
        {
          pitch: 0.05 * Math.sin(Date.now() / 2000 + i),
          roll: 0.35,
          yaw: 0,
          throttleDelta: 0,
          throttleSet: flight.throttle,
        },
        1 / HZ,
      );
      const stateMsg = encodeMessage(MsgType.C2S_STATE, {
        x: flight.x,
        y: flight.y,
        z: flight.z,
        ya: flight.yaw,
        pi: flight.pitch,
        ro: flight.roll,
        th: flight.throttle,
        fl: 1,
      });
      ws.send(stateMsg);
      m.bytesOut += stateMsg.byteLength;

      if (Date.now() - start >= DURATION_MS) {
        clearInterval(iv);
        end();
      }
    }, 1000 / HZ);

    setTimeout(() => {
      clearInterval(iv);
      end();
    }, DURATION_MS + 2000);
  });
}

async function pollServer() {
  try {
    const h = await fetch(`${BASE}/api/health`).then((r) => r.json()) as {
      players?: number;
      rooms?: number;
    };
    const mem = process.memoryUsage();
    const bytesIn = metrics.reduce((a, m) => a + m.bytesIn, 0);
    const bytesOut = metrics.reduce((a, m) => a + m.bytesOut, 0);
    const snaps = metrics.reduce((a, m) => a + m.snapshots, 0);
    const errs = metrics.reduce((a, m) => a + m.errors, 0);
    const maxSnap = Math.max(0, ...metrics.map((m) => m.lastPlayersInSnap));
    samples.push({
      t: Date.now() - t0wall,
      players: h.players ?? 0,
      snapPlayers: maxSnap,
      bytesInTotal: bytesIn,
      bytesOutTotal: bytesOut,
      snapshotsTotal: snaps,
      errors: errs,
      rssMB: mem.rss / 1024 / 1024,
      heapMB: mem.heapUsed / 1024 / 1024,
    });
  } catch {
    /* server down */
  }
}

console.log(`\n=== STRESS TEST ===`);
console.log(`bots=${PLAYERS} hz=${HZ} duration=${DURATION_MS}ms room=${ROOM} mode=${MODE}`);
console.log(`Open browser → Join multiplayer (room ${ROOM}) as spectator\n`);

const pollIv = setInterval(() => void pollServer(), 1000);
void pollServer();

// Stagger joins to avoid burst
const bots: Promise<void>[] = [];
for (let i = 0; i < PLAYERS; i++) {
  bots.push(
    (async () => {
      await new Promise((r) => setTimeout(r, i * 40));
      await startBot(i);
    })(),
  );
}

await Promise.all(bots);
clearInterval(pollIv);
await pollServer();

const joined = metrics.filter((m) => m.joined).length;
const bytesIn = metrics.reduce((a, m) => a + m.bytesIn, 0);
const bytesOut = metrics.reduce((a, m) => a + m.bytesOut, 0);
const snaps = metrics.reduce((a, m) => a + m.snapshots, 0);
const errs = metrics.reduce((a, m) => a + m.errors, 0);
const durS = DURATION_MS / 1000;

const report = {
  meta: {
    players: PLAYERS,
    joined,
    hz: HZ,
    durationMs: DURATION_MS,
    room: ROOM,
    mode: MODE,
    api: BASE,
    timestamp: new Date().toISOString(),
  },
  totals: {
    bytesIn,
    bytesOut,
    snapshots: snaps,
    errors: errs,
    bytesInPerSec: bytesIn / durS,
    bytesOutPerSec: bytesOut / durS,
    avgSnapshotsPerBot: snaps / Math.max(1, joined),
  },
  bandwidth: {
    downlinkMBps: bytesIn / durS / 1024 / 1024,
    uplinkMBps: bytesOut / durS / 1024 / 1024,
    downlinkKBpsPerBot: bytesIn / durS / 1024 / Math.max(1, joined),
  },
  timeline: samples,
  pass: joined >= PLAYERS * 0.9 && errs < PLAYERS * 2,
};

const outDir = path.resolve(process.cwd(), '../../benchmarks');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `stress-${PLAYERS}-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

// Markdown summary
const md = `# Stress benchmark: ${PLAYERS} bots

| Metric | Value |
|--------|-------|
| Joined | ${joined}/${PLAYERS} |
| Duration | ${durS}s |
| Tick rate | ${HZ} Hz |
| Room | ${ROOM} (${MODE}) |
| Downlink total | ${(bytesIn / 1024 / 1024).toFixed(2)} MB (${(bytesIn / durS / 1024).toFixed(1)} KB/s) |
| Uplink total | ${(bytesOut / 1024 / 1024).toFixed(2)} MB (${(bytesOut / durS / 1024).toFixed(1)} KB/s) |
| KB/s per bot down | ${(bytesIn / durS / 1024 / Math.max(1, joined)).toFixed(1)} |
| Snapshots (sum all bots) | ${snaps} |
| Errors | ${errs} |
| Peak server players (health) | ${Math.max(0, ...samples.map((s) => s.players))} |
| Peak players in snapshot | ${Math.max(0, ...samples.map((s) => s.snapPlayers))} |
| Bot process RSS end | ${samples.at(-1)?.rssMB.toFixed(1) ?? '?'} MB |
| Result | ${report.pass ? 'PASS' : 'FAIL'} |

## Timeline (1s samples)

| t(s) | players | snapN | down KB/s | rss MB |
|------|---------|-------|-----------|--------|
${samples
  .map((s, i) => {
    const prev = samples[i - 1];
    const dIn = prev ? (s.bytesInTotal - prev.bytesInTotal) / 1024 : 0;
    return `| ${(s.t / 1000).toFixed(0)} | ${s.players} | ${s.snapPlayers} | ${dIn.toFixed(0)} | ${s.rssMB.toFixed(0)} |`;
  })
  .join('\n')}

## Notes

- Client FPS must be measured in browser (see browser benchmark hook).
- Room capacity requires server \`STRESS_MAX_PLAYERS>=${PLAYERS + 1}\`.
`;

const mdFile = outFile.replace(/\.json$/, '.md');
fs.writeFileSync(mdFile, md);

console.log('\n=== RESULTS ===');
console.log(md);
console.log(`JSON: ${outFile}`);
console.log(`MD:   ${mdFile}`);

process.exit(report.pass ? 0 : 1);
