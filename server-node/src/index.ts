import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import {
  PROTOCOL_VERSION,
  sanitizeNickname,
  type GameMode,
} from '@flight-sim/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import { mintToken } from './auth.js';
import { Lobby } from './lobby.js';
import { GameRoom } from './room.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Prefer built client; fall back to monorepo client/dist. */
const CLIENT_DIST_CANDIDATES = [
  process.env.CLIENT_DIST,
  path.resolve(__dirname, '../../client/dist'),
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist'),
].filter(Boolean) as string[];

function resolveClientDist(): string | null {
  for (const dir of CLIENT_DIST_CANDIDATES) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const CLIENT_DIST = resolveClientDist();

const lobby = new Lobby();
const rooms = new Map<string, GameRoom>();

function getOrCreateRoom(roomId: string, mode: GameMode, max: number): GameRoom {
  let room = rooms.get(roomId);
  if (!room) {
    room = new GameRoom(roomId, mode, max, (count, m, mx) => {
      lobby.heartbeat(roomId, count, m, mx);
    });
    rooms.set(roomId, room);
    lobby.heartbeat(roomId, 0, mode, max);
  } else {
    room.setConfig(mode, max);
  }
  return room;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(data);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function tryServeStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (!CLIENT_DIST || req.method !== 'GET' && req.method !== 'HEAD') return false;

  let rel = pathname === '/' ? '/index.html' : pathname;
  // prevent path traversal
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(CLIENT_DIST, rel);

  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    filePath = path.join(CLIENT_DIST, 'index.html');
  }

  if (!fs.existsSync(filePath)) return false;

  const ext = path.extname(filePath);
  const type = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function sendDevHint(res: http.ServerResponse): void {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Flight Sim API</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e8eefc;padding:40px;line-height:1.5}
code{background:#1a2740;padding:2px 6px;border-radius:4px}a{color:#7eb6ff}</style></head>
<body>
  <h1>✈ Flight Sim — API server</h1>
  <p>You hit the <b>game API</b> (port ${PORT}), not a missing route bug.</p>
  <p><b>Play the game:</b></p>
  <ul>
    <li><b>Dev:</b> run <code>pnpm dev:all</code> then open <a href="http://localhost:5173">http://localhost:5173</a></li>
    <li><b>Single process:</b> <code>pnpm --filter @flight-sim/client build</code> then restart this server — UI is served from <code>/</code></li>
  </ul>
  <p>API: <a href="/api/health"><code>GET /api/health</code></a> · <code>POST /api/rooms/join</code> · <code>WS /ws/:roomId</code></p>
  <p>Client dist found: <code>${CLIENT_DIST ?? 'none — build client first'}</code></p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      ts: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
      players: lobby.globalPlayers,
      rooms: lobby.rooms.size,
      clientDist: CLIENT_DIST,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    sendJson(res, 200, {
      rooms: lobby.list().map((r) => ({
        roomId: r.roomId,
        mode: r.mode,
        count: r.count,
        max: r.max,
      })),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms/join') {
    try {
      const body = (await readJson(req)) as {
        nickname?: string;
        playerUuid?: string;
        mode?: GameMode;
        roomId?: string;
        excludeRoomIds?: string[];
      };
      const nickname = sanitizeNickname(body.nickname ?? 'Pilot');
      const playerUuid =
        body.playerUuid && body.playerUuid.length >= 8 ? body.playerUuid : crypto.randomUUID();
      const mode: GameMode = body.mode === 'peaceful' ? 'peaceful' : 'deathmatch';

      const alloc = lobby.allocate({
        mode,
        preferredRoomId: body.roomId,
        excludeRoomIds: body.excludeRoomIds,
      });
      if ('error' in alloc) {
        sendJson(res, 409, { error: 'WORLD_FULL' });
        return;
      }

      const room = getOrCreateRoom(alloc.roomId, mode, alloc.max);
      room.setConfig(mode, alloc.max);

      const { token, expiresAt } = mintToken(playerUuid, nickname, alloc.roomId);
      const host = req.headers.host ?? `localhost:${PORT}`;
      const wsProto = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';

      sendJson(res, 200, {
        roomId: alloc.roomId,
        wsUrl: `${wsProto}://${host}/ws/${alloc.roomId}`,
        mode,
        maxPlayers: alloc.max,
        token,
        playerUuid,
        expiresAt,
      });
    } catch (e) {
      console.error(e);
      sendJson(res, 400, { error: 'BAD_REQUEST' });
    }
    return;
  }

  // Static game UI (after API routes)
  if (tryServeStatic(req, res, url.pathname)) return;

  // Friendly root / unknown API
  if (url.pathname === '/' || !url.pathname.startsWith('/api')) {
    sendDevHint(res);
    return;
  }

  sendJson(res, 404, {
    error: 'NOT_FOUND',
    path: url.pathname,
    hint: 'Use POST /api/rooms/join, GET /api/health, or open the game UI at / (after client build) or http://localhost:5173 in dev',
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const m = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const roomId = decodeURIComponent(m[1]!);
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    let room = rooms.get(roomId);
    if (!room) {
      const meta = lobby.rooms.get(roomId);
      const mode = meta?.mode ?? (roomId.startsWith('peaceful') ? 'peaceful' : 'deathmatch');
      const max = meta?.max ?? lobby.tierMaxPlayers;
      room = getOrCreateRoom(roomId, mode, max);
    }
    room.handleConnection(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[flight-sim] server listening on http://${HOST}:${PORT}`);
  console.log(`[flight-sim] tier=${process.env.TIER ?? 'public'} protocol=v${PROTOCOL_VERSION}`);
  console.log(
    CLIENT_DIST
      ? `[flight-sim] serving client from ${CLIENT_DIST}`
      : `[flight-sim] no client/dist — run "pnpm --filter @flight-sim/client build" or open Vite on :5173`,
  );
});
