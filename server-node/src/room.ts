import {
  CRASH_COOLDOWN_MS,
  CRASH_DAMAGE,
  CRASH_SPEED_THRESHOLD,
  FIRE_COOLDOWN_MS,
  FLAG_ALIVE,
  FLAG_GEAR,
  FLAG_INVULN,
  FLAG_ONGROUND,
  GROUND_Y,
  HISTORY_MS,
  IDLE_TIMEOUT_MS,
  LAG_COMP_MS_DEFAULT,
  MAX_HP,
  MAX_SPEED_HARD,
  MG_DAMAGE,
  MG_RANGE,
  MsgType,
  NET_HZ_DEFAULT,
  ORIGIN_SLACK_MIN_M,
  PLAYER_RADIUS_LAG,
  PLANE_GROUND_OFFSET,
  PROTOCOL_VERSION,
  RESPAWN_MS,
  RESPAWN_POINTS,
  SCOREBOARD_INTERVAL_MS,
  SPAWN_INVULN_MS,
  SPAWN_POINTS,
  STRIKE_KICK_THRESHOLD,
  clamp,
  clampPoseToBounds,
  decodeMessage,
  encodeMessage,
  packSnapshotPlayers,
  raySphere,
  unwrapAngle,
  type C2SFire,
  type C2SJoin,
  type C2SState,
  type GameMode,
  type PlayerId,
  type PlayerPhase,
  type SnapshotPlayer,
  validatePose,
} from '@flight-sim/shared';
import type { WebSocket } from 'ws';
import { isFreshSeatClaim, verifyToken } from './auth.js';

interface PosSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

interface Player {
  id: PlayerId;
  uuid: string;
  displayName: string;
  requestedNickname: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  throttle: number;
  speed: number;
  hp: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  flags: number;
  lastFireAt: number;
  lastCrashAt: number;
  updatedAt: number;
  lastInputAt: number;
  phase: PlayerPhase;
  respawnAt?: number;
  invulnUntil?: number;
  history: PosSample[];
  invalidStrikes: number;
  needsState: boolean;
  rttEmaMs: number | null;
  pongSamples: number;
  ws: WebSocket;
  bufferedAmountWarn: number;
}

export class GameRoom {
  readonly roomId: string;
  mode: GameMode;
  maxPlayers: number;
  private players = new Map<PlayerId, Player>();
  private byUuid = new Map<string, PlayerId>();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastScoreboardAt = 0;
  private onHeartbeat: (count: number, mode: GameMode, max: number) => void;
  private usePackedSnapshots: boolean;

  constructor(
    roomId: string,
    mode: GameMode,
    maxPlayers: number,
    onHeartbeat: (count: number, mode: GameMode, max: number) => void,
    usePackedSnapshots = false,
  ) {
    this.roomId = roomId;
    this.mode = mode;
    this.maxPlayers = maxPlayers;
    this.onHeartbeat = onHeartbeat;
    this.usePackedSnapshots = usePackedSnapshots;
  }

  get count(): number {
    return this.players.size;
  }

  setConfig(mode: GameMode, max: number): void {
    this.mode = mode;
    this.maxPlayers = max;
  }

  ensureTicking(): void {
    if (this.tickTimer) return;
    const ms = 1000 / NET_HZ_DEFAULT;
    this.tickTimer = setInterval(() => this.tick(), ms);
  }

  stopIfEmpty(): void {
    if (this.players.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  handleConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      try {
        let u8: Uint8Array;
        if (Buffer.isBuffer(data)) {
          u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (data instanceof ArrayBuffer) {
          u8 = new Uint8Array(data);
        } else if (Array.isArray(data)) {
          u8 = new Uint8Array(Buffer.concat(data));
        } else {
          u8 = new Uint8Array(Buffer.from(data as ArrayBuffer));
        }
        const msg = decodeMessage(u8);
        this.onMessage(ws, msg.type, msg.payload);
      } catch {
        this.send(ws, MsgType.S2C_REJECT, { code: 'MALFORMED' });
      }
    });
    ws.on('close', () => this.onSocketClose(ws));
  }

  private findByWs(ws: WebSocket): Player | undefined {
    for (const p of this.players.values()) if (p.ws === ws) return p;
    return undefined;
  }

  private onSocketClose(ws: WebSocket): void {
    const p = this.findByWs(ws);
    if (!p) return;
    if (p.ws !== ws) return;
    this.removePlayer(p.id, false);
  }

  private onMessage(ws: WebSocket, type: number, payload: unknown): void {
    if (type === MsgType.C2S_JOIN) {
      this.handleJoin(ws, payload as C2SJoin);
      return;
    }
    const player = this.findByWs(ws);
    if (!player) return;

    switch (type) {
      case MsgType.C2S_STATE:
        this.handleState(player, payload as C2SState);
        break;
      case MsgType.C2S_FIRE:
        this.handleFire(player, payload as C2SFire);
        break;
      case MsgType.C2S_PING: {
        const { clientTime } = payload as { clientTime: number };
        const now = Date.now();
        player.lastInputAt = now;
        // Approximate one-way: clientTime is performance.now()-based; we can't get true RTT
        // without client echo of previous serverTime. Use client-provided clientTime delta if present.
        // Protocol: client sends clientTime = performance.now(). We store and on next ping estimate.
        // Better: if payload has lastServerTime, compute RTT.
        const pongPayload = payload as { clientTime: number; lastServerTime?: number; rttMs?: number };
        if (typeof pongPayload.rttMs === 'number' && Number.isFinite(pongPayload.rttMs)) {
          const r = clamp(pongPayload.rttMs, 10, 800);
          player.rttEmaMs = player.rttEmaMs === null ? r : player.rttEmaMs * 0.75 + r * 0.25;
          player.pongSamples++;
        } else if (typeof pongPayload.lastServerTime === 'number') {
          const rtt = now - pongPayload.lastServerTime;
          if (rtt > 0 && rtt < 5000) {
            player.rttEmaMs = player.rttEmaMs === null ? rtt : player.rttEmaMs * 0.75 + rtt * 0.25;
            player.pongSamples++;
          }
        } else {
          player.pongSamples++;
          if (player.rttEmaMs === null) player.rttEmaMs = 80;
        }
        this.send(ws, MsgType.S2C_PONG, { clientTime, serverTime: now });
        break;
      }
      case MsgType.C2S_RESPAWN:
        this.tryRespawn(player, Date.now());
        break;
      case MsgType.C2S_LEAVE:
        this.removePlayer(player.id, true);
        break;
      default:
        break;
    }
  }

  private handleJoin(ws: WebSocket, join: C2SJoin): void {
    if (join.protocolVersion !== PROTOCOL_VERSION) {
      this.send(ws, MsgType.S2C_REJECT, { code: 'BAD_VERSION' });
      ws.close(4003, 'BAD_VERSION');
      return;
    }
    const tok = verifyToken(join.token, this.roomId);
    if (!tok || tok.playerUuid !== join.playerUuid) {
      this.send(ws, MsgType.S2C_REJECT, { code: 'BAD_TOKEN' });
      ws.close(4003, 'BAD_TOKEN');
      return;
    }

    const existingId = this.byUuid.get(join.playerUuid);
    if (existingId !== undefined) {
      const existing = this.players.get(existingId)!;
      try {
        existing.ws.close(4002, 'superseded');
      } catch {
        /* ignore */
      }
      existing.ws = ws;
      existing.lastInputAt = Date.now();
      this.sendWelcome(existing);
      this.heartbeat();
      return;
    }

    if (!isFreshSeatClaim(tok.iatMs)) {
      this.send(ws, MsgType.S2C_REJECT, { code: 'BAD_TOKEN', message: 'seat claim expired — rejoin' });
      ws.close(4003, 'BAD_TOKEN');
      return;
    }
    if (this.players.size >= this.maxPlayers) {
      this.send(ws, MsgType.S2C_ROOM_FULL, { count: this.players.size, max: this.maxPlayers });
      ws.close(4001, 'ROOM_FULL');
      return;
    }

    const id = this.nextId++;
    const spawn = this.pickSpawn(false);
    let displayName = tok.requestedNickname;
    const used = new Set([...this.players.values()].map((p) => p.displayName.toLowerCase()));
    if (used.has(displayName.toLowerCase())) {
      displayName = `${tok.requestedNickname}#${id.toString(16).toUpperCase()}`;
    }

    const now = Date.now();
    const player: Player = {
      id,
      uuid: join.playerUuid,
      displayName,
      requestedNickname: tok.requestedNickname,
      x: spawn[0],
      y: spawn[1],
      z: spawn[2],
      yaw: unwrapAngle(spawn[3]),
      pitch: 0,
      roll: 0,
      throttle: 0.55,
      speed: 60,
      hp: MAX_HP,
      kills: 0,
      deaths: 0,
      damageDealt: 0,
      flags: FLAG_ALIVE | FLAG_INVULN,
      lastFireAt: 0,
      lastCrashAt: 0,
      updatedAt: now,
      lastInputAt: now,
      phase: 'Alive',
      invulnUntil: now + SPAWN_INVULN_MS,
      history: [],
      invalidStrikes: 0,
      needsState: true,
      rttEmaMs: null,
      pongSamples: 0,
      ws,
      bufferedAmountWarn: 0,
    };
    this.players.set(id, player);
    this.byUuid.set(join.playerUuid, id);
    this.ensureTicking();
    this.sendWelcome(player);
    this.broadcast(
      MsgType.S2C_PLAYER_JOINED,
      {
        id: player.id,
        n: player.displayName,
        x: player.x,
        y: player.y,
        z: player.z,
        ya: player.yaw,
        pi: player.pitch,
        ro: player.roll,
        hp: player.hp,
        fl: player.flags,
      },
      player.id,
    );
    this.heartbeat();
  }

  private sendWelcome(player: Player): void {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      n: p.displayName,
      x: p.x,
      y: p.y,
      z: p.z,
      ya: unwrapAngle(p.yaw),
      pi: p.pitch,
      ro: unwrapAngle(p.roll),
      th: p.throttle,
      hp: p.hp,
      fl: p.flags,
      kills: p.kills,
      deaths: p.deaths,
    }));
    this.send(player.ws, MsgType.S2C_WELCOME, {
      playerId: player.id,
      roomId: this.roomId,
      mode: this.mode,
      maxPlayers: this.maxPlayers,
      protocolVersion: PROTOCOL_VERSION,
      displayName: player.displayName,
      spawn: {
        x: player.x,
        y: player.y,
        z: player.z,
        ya: unwrapAngle(player.yaw),
        pi: player.pitch,
        ro: unwrapAngle(player.roll),
      },
      players,
      serverTime: Date.now(),
      tickHz: NET_HZ_DEFAULT,
    });
  }

  private handleState(player: Player, s: C2SState): void {
    const now = Date.now();
    player.lastInputAt = now;
    if (player.phase !== 'Alive') return;

    const pose = {
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.ya,
      pitch: s.pi,
      roll: s.ro,
      throttle: s.th,
    };
    const prev = {
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      roll: player.roll,
      throttle: player.throttle,
    };
    const dt = Math.max(0.01, (now - player.updatedAt) / 1000);
    // First accepted state after join/spawn: skip speed check
    const fail = player.needsState ? validatePose(pose) : validatePose(pose, prev, dt);
    if (fail) {
      player.invalidStrikes++;
      if (player.invalidStrikes > STRIKE_KICK_THRESHOLD) {
        this.send(player.ws, MsgType.S2C_REJECT, { code: 'MALFORMED', message: 'invalid movement' });
        player.ws.close(4004, 'kicked');
        this.removePlayer(player.id, true);
      }
      return;
    }
    player.invalidStrikes = Math.max(0, player.invalidStrikes - 1);
    const clamped = clampPoseToBounds(pose);
    const dist = Math.hypot(clamped.x - player.x, clamped.y - player.y, clamped.z - player.z);
    player.speed = player.needsState ? player.speed : dist / dt;
    player.x = clamped.x;
    player.y = clamped.y;
    player.z = clamped.z;
    player.yaw = unwrapAngle(clamped.yaw);
    player.pitch = clamped.pitch;
    player.roll = unwrapAngle(clamped.roll);
    player.throttle = clamped.throttle;
    player.updatedAt = now;
    player.needsState = false;

    const inv = player.invulnUntil && now < player.invulnUntil;
    const nearGround = player.y <= GROUND_Y + PLANE_GROUND_OFFSET + 2.5;
    // Trust client taxi flag — runway takeoff is NOT a crash
    const clientOnGround = ((s.fl ?? 0) & FLAG_ONGROUND) !== 0;
    const onGround = clientOnGround || player.y <= GROUND_Y + PLANE_GROUND_OFFSET + 1.0;
    player.flags =
      FLAG_ALIVE |
      (inv ? FLAG_INVULN : 0) |
      (onGround ? FLAG_ONGROUND : 0) |
      ((s.fl ?? 0) & FLAG_GEAR);

    // Vertical speed from last sample (for crash detection)
    let sinkRate = 0;
    if (player.history.length > 0) {
      const prev = player.history[player.history.length - 1]!;
      const dth = Math.max(0.02, (now - prev.t) / 1000);
      sinkRate = Math.max(0, (prev.y - player.y) / dth); // positive = falling
    }

    this.pushHistory(player, now);

    // Crash = smashing into ground from the air (nose-down / high sink), NOT taxi or takeoff roll
    const divingIn =
      !clientOnGround &&
      nearGround &&
      player.speed > CRASH_SPEED_THRESHOLD &&
      (player.pitch < -0.25 || sinkRate > 22);
    if (
      this.mode === 'deathmatch' &&
      divingIn &&
      now - player.lastCrashAt >= CRASH_COOLDOWN_MS
    ) {
      player.lastCrashAt = now;
      this.applyDamage(player, null, CRASH_DAMAGE, now);
    }
  }

  private pushHistory(player: Player, t: number): void {
    player.history.push({ t, x: player.x, y: player.y, z: player.z });
    const cutoff = t - HISTORY_MS;
    while (player.history.length > 2 && player.history[0]!.t < cutoff) player.history.shift();
  }

  private handleFire(attacker: Player, fire: C2SFire): void {
    const now = Date.now();
    if (this.mode !== 'deathmatch') return;
    if (attacker.phase !== 'Alive') return;
    // Allow fire during invuln (spawn protection only blocks *receiving* damage)
    // Allow fire even if needsState — attacker can still shoot
    if (now - attacker.lastFireAt < FIRE_COOLDOWN_MS * 0.85) return;
    attacker.lastFireAt = now;

    const dir = normalize(fire.dx, fire.dy, fire.dz);
    if (!dir) return;

    const rttSec = (attacker.rttEmaMs ?? LAG_COMP_MS_DEFAULT) / 1000;
    // Generous origin slack — client prediction + desync
    const slack = Math.min(MAX_SPEED_HARD * rttSec + ORIGIN_SLACK_MIN_M + 20, 60);
    let ox = attacker.x;
    let oy = attacker.y;
    let oz = attacker.z;
    if (fire.ox !== undefined && fire.oy !== undefined && fire.oz !== undefined) {
      const d = Math.hypot(fire.ox - attacker.x, fire.oy - attacker.y, fire.oz - attacker.z);
      if (d <= slack) {
        ox = fire.ox;
        oy = fire.oy;
        oz = fire.oz;
      }
    }
    // Nose offset along aim
    ox += dir.x * 4;
    oy += dir.y * 4;
    oz += dir.z * 4;

    const rewindMs =
      attacker.pongSamples >= 2
        ? clamp((attacker.rttEmaMs ?? LAG_COMP_MS_DEFAULT) / 2, 40, 180)
        : LAG_COMP_MS_DEFAULT;
    const rewindT = now - rewindMs;

    let best: { player: Player; t: number } | null = null;
    for (const victim of this.players.values()) {
      if (victim.id === attacker.id) continue;
      if (victim.phase !== 'Alive') continue;
      if (victim.invulnUntil && now < victim.invulnUntil) continue;
      // needsState only blocks for first ~200ms; still allow hits on current pose

      // Prefer lag-comp history; also test current pose for arcade forgiveness
      const posHist = sampleHistory(victim, rewindT);
      const posNow = { x: victim.x, y: victim.y, z: victim.z };
      let hitT = raySphere(
        ox, oy, oz, dir.x, dir.y, dir.z,
        posHist.x, posHist.y, posHist.z,
        PLAYER_RADIUS_LAG,
      );
      if (hitT === null || hitT > MG_RANGE) {
        hitT = raySphere(
          ox, oy, oz, dir.x, dir.y, dir.z,
          posNow.x, posNow.y, posNow.z,
          PLAYER_RADIUS_LAG,
        );
      }
      if (hitT === null || hitT > MG_RANGE) continue;
      if (!best || hitT < best.t) best = { player: victim, t: hitT };
    }

    if (!best) return;
    const amount = MG_DAMAGE;
    this.send(attacker.ws, MsgType.S2C_HIT_CONFIRM, {
      seq: fire.seq,
      targetId: best.player.id,
      amount,
    });
    this.applyDamage(best.player, attacker, amount, now);
  }

  private applyDamage(victim: Player, attacker: Player | null, amount: number, now: number): void {
    if (victim.phase !== 'Alive') return;
    if (victim.invulnUntil && now < victim.invulnUntil) return;
    victim.hp = Math.max(0, victim.hp - amount);
    if (attacker) attacker.damageDealt += amount;

    this.broadcast(MsgType.S2C_DAMAGE, {
      targetId: victim.id,
      attackerId: attacker?.id ?? 0,
      amount,
      hp: victim.hp,
      x: victim.x,
      y: victim.y,
      z: victim.z,
    });

    if (victim.hp <= 0) {
      victim.phase = 'Dead';
      victim.flags = 0;
      victim.deaths++;
      victim.respawnAt = now + RESPAWN_MS;
      if (attacker) attacker.kills++;
      this.broadcast(MsgType.S2C_KILL, {
        killerId: attacker?.id ?? 0,
        victimId: victim.id,
        killerName: attacker?.displayName ?? 'World',
        victimName: victim.displayName,
        killerKills: attacker?.kills ?? 0,
        victimDeaths: victim.deaths,
      });
      this.broadcastScoreboard();
    }
  }

  private tryRespawn(player: Player, now: number): void {
    if (player.phase !== 'Dead') return;
    if (player.respawnAt && now < player.respawnAt) return;
    this.doSpawn(player, now);
  }

  private doSpawn(player: Player, now: number): void {
    const spawn = this.pickSpawn(true);
    player.x = spawn[0];
    // Always mid-air — never respawn on the runway surface
    player.y = Math.max(spawn[1], 80);
    player.z = spawn[2];
    player.yaw = unwrapAngle(spawn[3]);
    player.pitch = 0.05;
    player.roll = 0;
    player.hp = MAX_HP;
    player.phase = 'Alive';
    player.flags = FLAG_ALIVE | FLAG_INVULN;
    player.invulnUntil = now + SPAWN_INVULN_MS;
    player.respawnAt = undefined;
    player.history = [];
    player.needsState = true;
    player.speed = 65;
    player.throttle = 0.65;
    player.updatedAt = now;
    player.lastInputAt = now;
    const payload = {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      ya: player.yaw,
      pi: player.pitch,
      ro: player.roll,
      hp: player.hp,
      invulnMs: SPAWN_INVULN_MS,
    };
    // Send directly to the player first (critical), then broadcast for others
    this.send(player.ws, MsgType.S2C_SPAWN, payload);
    this.broadcast(MsgType.S2C_SPAWN, payload, player.id);
  }

  private pickSpawn(respawn: boolean): readonly [number, number, number, number] {
    const pool = respawn ? RESPAWN_POINTS : SPAWN_POINTS;
    let best = pool[0]!;
    let bestScore = -Infinity;
    for (const sp of pool) {
      let minDist = Infinity;
      for (const p of this.players.values()) {
        if (p.phase !== 'Alive') continue;
        const d = Math.hypot(sp[0] - p.x, sp[1] - p.y, sp[2] - p.z);
        minDist = Math.min(minDist, d);
      }
      if (minDist === Infinity) minDist = 200;
      const score = minDist + Math.random() * 25;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    return best;
  }

  private tick(): void {
    const now = Date.now();
    for (const p of [...this.players.values()]) {
      if (now - p.lastInputAt > IDLE_TIMEOUT_MS) {
        this.send(p.ws, MsgType.S2C_REJECT, { code: 'MALFORMED', message: 'idle timeout' });
        try {
          p.ws.close(4004, 'idle');
        } catch {
          /* ignore */
        }
        this.removePlayer(p.id, false);
        continue;
      }
      if (p.phase === 'Dead' && p.respawnAt && now >= p.respawnAt) {
        this.doSpawn(p, now);
      }
      if (p.invulnUntil && now >= p.invulnUntil && p.phase === 'Alive') {
        p.flags = p.flags & ~FLAG_INVULN;
        if (!(p.flags & FLAG_ALIVE)) p.flags |= FLAG_ALIVE;
      }
      // Auto-clear needsState after 2s so players are always hittable
      if (p.needsState && now - p.updatedAt > 2000) {
        p.needsState = false;
      }
    }

    const list: SnapshotPlayer[] = [...this.players.values()].map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      ya: unwrapAngle(p.yaw),
      pi: p.pitch,
      ro: unwrapAngle(p.roll),
      th: p.throttle,
      hp: p.hp,
      fl: p.flags,
    }));

    if (this.usePackedSnapshots) {
      const bin = packSnapshotPlayers(list);
      this.broadcastRaw(encodeMessage(MsgType.S2C_SNAPSHOT, { t: now, f: 1, b: bin }));
    } else {
      this.broadcast(MsgType.S2C_SNAPSHOT, { t: now, f: 0, p: list });
    }

    if (now - this.lastScoreboardAt > SCOREBOARD_INTERVAL_MS) {
      this.broadcastScoreboard();
    }
  }

  private broadcastScoreboard(): void {
    this.lastScoreboardAt = Date.now();
    const entries = [...this.players.values()]
      .map((p) => ({ id: p.id, n: p.displayName, k: p.kills, d: p.deaths, dmg: p.damageDealt }))
      .sort((a, b) => b.k - a.k || a.d - b.d);
    this.broadcast(MsgType.S2C_SCOREBOARD, { entries });
  }

  private removePlayer(id: PlayerId, notify: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.byUuid.delete(p.uuid);
    if (notify) {
      try {
        p.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.broadcast(MsgType.S2C_PLAYER_LEFT, { id });
    this.heartbeat();
    this.stopIfEmpty();
  }

  private heartbeat(): void {
    this.onHeartbeat(this.players.size, this.mode, this.maxPlayers);
  }

  private send(ws: WebSocket, type: number, payload: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 512 * 1024) return; // backpressure drop
    try {
      ws.send(encodeMessage(type, payload));
    } catch {
      /* ignore */
    }
  }

  private broadcast(type: number, payload: unknown, exceptId?: PlayerId): void {
    const bytes = encodeMessage(type, payload);
    this.broadcastRaw(bytes, exceptId);
  }

  private broadcastRaw(bytes: Uint8Array, exceptId?: PlayerId): void {
    for (const p of this.players.values()) {
      if (exceptId !== undefined && p.id === exceptId) continue;
      if (p.ws.readyState !== p.ws.OPEN) continue;
      if (p.ws.bufferedAmount > 512 * 1024) {
        p.bufferedAmountWarn++;
        if (p.bufferedAmountWarn > 50) {
          try {
            p.ws.close(4004, 'slow client');
          } catch {
            /* ignore */
          }
          this.removePlayer(p.id, false);
        }
        continue;
      }
      p.bufferedAmountWarn = Math.max(0, p.bufferedAmountWarn - 1);
      try {
        p.ws.send(bytes);
      } catch {
        /* ignore */
      }
    }
  }
}

function normalize(x: number, y: number, z: number): { x: number; y: number; z: number } | null {
  const len = Math.hypot(x, y, z);
  if (!Number.isFinite(len) || len < 1e-8) return null;
  return { x: x / len, y: y / len, z: z / len };
}

function sampleHistory(p: Player, t: number): { x: number; y: number; z: number } {
  const h = p.history;
  if (h.length < 2) return { x: p.x, y: p.y, z: p.z };
  if (t <= h[0]!.t) return { x: h[0]!.x, y: h[0]!.y, z: h[0]!.z };
  if (t >= h[h.length - 1]!.t) {
    const last = h[h.length - 1]!;
    return { x: last.x, y: last.y, z: last.z };
  }
  let i = 0;
  while (i < h.length - 1 && h[i + 1]!.t < t) i++;
  const a = h[i]!;
  const b = h[i + 1]!;
  const u = (t - a.t) / (b.t - a.t);
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
  };
}
