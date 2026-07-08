import {
  FLAG_ALIVE,
  FLAG_GEAR,
  FLAG_ONGROUND,
  KEEPALIVE_MS,
  MsgType,
  NET_HZ_DEFAULT,
  PING_INTERVAL_MS,
  asUint8Array,
  decodeMessage,
  encodeMessage,
  unpackSnapshotPlayers,
  unwrapAngle,
  type C2SState,
  type GameMode,
  type S2CWelcome,
  type SnapshotPlayer,
} from '@flight-sim/shared';
import type { FlightState } from '@flight-sim/shared';
import { httpUrl, wsUrl } from '../config.js';
import { NetClock } from './clock.js';
import { RemoteBuffer } from './interp.js';
import { getOrCreateUuid } from './session.js';

export type KillEvent = { killerName: string; victimName: string; at: number };

export interface NetHandlers {
  onWelcome: (w: S2CWelcome) => void;
  onReject: (code: string, message?: string) => void;
  onDamage: (targetId: number, attackerId: number, amount: number, hp: number) => void;
  onKill: (ev: KillEvent & { killerId: number; victimId: number }) => void;
  onSpawn: (id: number, x: number, y: number, z: number, ya: number, hp: number, invulnMs?: number) => void;
  onSelfSnapshot?: (p: {
    x: number;
    y: number;
    z: number;
    ya: number;
    pi: number;
    ro: number;
    hp: number;
    fl: number;
  }) => void;
  onScoreboard: (entries: Array<{ id: number; n: string; k: number; d: number }>) => void;
  onPlayerJoined: (id: number, name: string) => void;
  onPlayerLeft: (id: number) => void;
  onCorrect: (pose: C2SState) => void;
  onDisconnected: (reason: string) => void;
  onHitConfirm?: (targetId: number, amount: number) => void;
}

/**
 * Network layer: fixed-rate send loop independent of rAF so background tabs
 * still publish pose (Chrome throttles rAF hard when unfocused).
 */
export class GameNet {
  clock = new NetClock();
  remotes = new Map<number, RemoteBuffer>();
  localId: number | null = null;
  roomId: string | null = null;
  mode: GameMode = 'deathmatch';
  displayName = '';
  connected = false;
  /** Incremented every received snapshot — for debugging */
  snapshotsReceived = 0;
  private ws: WebSocket | null = null;
  private fireSeq = 0;
  private token = '';
  private playerUuid = '';
  private handlers: NetHandlers;
  private joinResolve: (() => void) | null = null;
  private joinReject: ((e: Error) => void) | null = null;
  private netTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlight: FlightState | null = null;
  private lastAlive = true;
  private lastPingAt = 0;

  constructor(handlers: NetHandlers) {
    this.handlers = handlers;
  }

  /** Call every sim tick so sender has fresh pose. */
  setLocalState(flight: FlightState, alive: boolean): void {
    this.lastFlight = flight;
    this.lastAlive = alive;
  }

  reset(): void {
    this.close();
    this.remotes.clear();
    this.localId = null;
    this.roomId = null;
    this.displayName = '';
    this.fireSeq = 0;
    this.token = '';
    this.clock = new NetClock();
    this.lastFlight = null;
    this.snapshotsReceived = 0;
  }

  private startNetLoop(): void {
    this.stopNetLoop();
    const period = Math.round(1000 / NET_HZ_DEFAULT);
    // Fixed-rate: ALWAYS send pose (no dirty-bit). Background tabs keep publishing.
    this.netTimer = setInterval(() => this.netTick(), period);
  }

  private stopNetLoop(): void {
    if (this.netTimer) {
      clearInterval(this.netTimer);
      this.netTimer = null;
    }
  }

  private netTick(): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();

    if (now - this.lastPingAt >= PING_INTERVAL_MS) {
      this.lastPingAt = now;
      this.send(MsgType.C2S_PING, {
        clientTime: performance.now(),
        rttMs: this.clock.rttMs,
        lastServerTime: this.clock.lastServerTime || undefined,
      });
    }

    if (this.lastFlight) {
      this.forceSendState(this.lastFlight, this.lastAlive);
    }
  }

  forceSendState(flight: FlightState, alive: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastFlight = flight;
    this.lastAlive = alive;
    let fl = alive ? FLAG_ALIVE : 0;
    if (flight.gearDown) fl |= FLAG_GEAR;
    if (flight.onGround) fl |= FLAG_ONGROUND;
    const state: C2SState = {
      x: flight.x,
      y: flight.y,
      z: flight.z,
      ya: unwrapAngle(flight.yaw),
      pi: flight.pitch,
      ro: unwrapAngle(flight.roll),
      th: flight.throttle,
      fl,
    };
    this.send(MsgType.C2S_STATE, state);
  }

  async join(opts: {
    nickname: string;
    mode: GameMode;
    roomId?: string;
  }): Promise<void> {
    this.close();
    this.remotes.clear();
    this.playerUuid = getOrCreateUuid();
    const res = await fetch(httpUrl('/api/rooms/join'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nickname: opts.nickname,
        playerUuid: this.playerUuid,
        mode: opts.mode,
        roomId: opts.roomId || undefined,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `join failed ${res.status}`);
    }
    const data = (await res.json()) as {
      roomId: string;
      token: string;
      playerUuid: string;
      mode: GameMode;
    };
    this.token = data.token;
    this.playerUuid = data.playerUuid;
    this.roomId = data.roomId;
    this.mode = data.mode;
    await this.openWs(data.roomId, opts.nickname);
  }

  private openWs(roomId: string, nickname: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      const ws = new WebSocket(wsUrl(roomId));
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error('ws timeout'));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, 8000);

      ws.onopen = () => {
        this.send(MsgType.C2S_JOIN, {
          protocolVersion: 1,
          playerUuid: this.playerUuid,
          nickname,
          token: this.token,
        });
      };

      ws.onmessage = (ev) => {
        try {
          const msg = decodeMessage(ev.data as ArrayBuffer);
          if (msg.type === MsgType.S2C_WELCOME) {
            clearTimeout(timeout);
            this.connected = true;
            const w = msg.payload as S2CWelcome;
            this.localId = w.playerId;
            this.displayName = w.displayName;
            this.mode = w.mode;
            this.roomId = w.roomId;
            this.clock.seedFromWelcome(w.serverTime);
            this.remotes.clear();
            for (const p of w.players) {
              if (p.id === w.playerId) continue;
              const buf = new RemoteBuffer();
              buf.name = p.n;
              buf.kills = p.kills;
              buf.deaths = p.deaths;
              buf.push({
                t: w.serverTime,
                x: p.x,
                y: p.y,
                z: p.z,
                ya: p.ya,
                pi: p.pi,
                ro: p.ro,
                th: p.th,
                hp: p.hp,
                fl: p.fl,
              });
              this.remotes.set(p.id, buf);
            }
            this.handlers.onWelcome(w);
            this.startNetLoop();
            this.joinResolve?.();
            this.joinResolve = null;
            this.joinReject = null;
          } else {
            this.handleServerMessage(msg.type, msg.payload);
          }
        } catch (e) {
          console.warn('bad message', e);
        }
      };

      ws.onclose = (ev) => {
        clearTimeout(timeout);
        const was = this.connected;
        this.connected = false;
        this.stopNetLoop();
        if (this.joinReject) {
          this.joinReject(new Error(`ws closed ${ev.code}`));
          this.joinReject = null;
          this.joinResolve = null;
        } else if (was) {
          let reason = `closed ${ev.code}`;
          if (ev.code === 4002) reason = 'session taken by another tab';
          else if (ev.code === 4004) reason = 'kicked (idle)';
          else if (ev.code === 4001) reason = 'room full';
          this.handlers.onDisconnected(reason);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        if (this.joinReject) {
          this.joinReject(new Error('ws error'));
          this.joinReject = null;
          this.joinResolve = null;
        }
      };
    });
  }

  private handleServerMessage(type: number, payload: unknown): void {
    switch (type) {
      case MsgType.S2C_SNAPSHOT: {
        const snap = payload as { t: number; f?: number; p?: SnapshotPlayer[]; b?: unknown };
        let players: SnapshotPlayer[] | null = null;
        if (snap.f === 1 && snap.b != null) {
          const bin = asUint8Array(snap.b);
          if (bin) {
            try {
              players = unpackSnapshotPlayers(bin);
            } catch (e) {
              console.warn('packed snapshot fail', e);
              // Do NOT prune remotes on decode failure
              return;
            }
          }
        } else if (snap.p) {
          players = snap.p;
        }
        if (!players) return;

        this.snapshotsReceived++;
        const seen = new Set<number>();
        for (const p of players) {
          if (p.id === this.localId) {
            this.handlers.onSelfSnapshot?.({
              x: p.x,
              y: p.y,
              z: p.z,
              ya: p.ya,
              pi: p.pi,
              ro: p.ro,
              hp: p.hp,
              fl: p.fl,
            });
            continue;
          }
          seen.add(p.id);
          let buf = this.remotes.get(p.id);
          if (!buf) {
            buf = new RemoteBuffer();
            this.remotes.set(p.id, buf);
          }
          buf.push({
            t: snap.t,
            x: p.x,
            y: p.y,
            z: p.z,
            ya: p.ya,
            pi: p.pi,
            ro: p.ro,
            th: p.th,
            hp: p.hp,
            fl: p.fl,
          });
        }
        // Only prune if we got a full snapshot with players list (not empty glitch)
        if (players.length > 0 || this.remotes.size === 0) {
          for (const id of [...this.remotes.keys()]) {
            if (!seen.has(id)) {
              this.remotes.delete(id);
              this.handlers.onPlayerLeft(id);
            }
          }
        }
        break;
      }
      case MsgType.S2C_PLAYER_JOINED: {
        const p = payload as SnapshotPlayer & { n: string };
        const buf = new RemoteBuffer();
        buf.name = p.n;
        buf.push({
          t: this.clock.serverNow(),
          x: p.x,
          y: p.y,
          z: p.z,
          ya: p.ya,
          pi: p.pi,
          ro: p.ro,
          th: p.th ?? 0.5,
          hp: p.hp,
          fl: p.fl,
        });
        this.remotes.set(p.id, buf);
        this.handlers.onPlayerJoined(p.id, p.n);
        break;
      }
      case MsgType.S2C_PLAYER_LEFT: {
        const { id } = payload as { id: number };
        this.remotes.delete(id);
        this.handlers.onPlayerLeft(id);
        break;
      }
      case MsgType.S2C_PONG: {
        const p = payload as { clientTime: number; serverTime: number };
        this.clock.onPong(p.clientTime, p.serverTime);
        break;
      }
      case MsgType.S2C_DAMAGE: {
        const p = payload as { targetId: number; attackerId: number; amount: number; hp: number };
        this.handlers.onDamage(p.targetId, p.attackerId, p.amount, p.hp);
        break;
      }
      case MsgType.S2C_KILL: {
        const p = payload as {
          killerId: number;
          victimId: number;
          killerName: string;
          victimName: string;
          killerKills?: number;
          victimDeaths?: number;
        };
        const kb = this.remotes.get(p.killerId);
        if (kb) kb.kills = p.killerKills ?? kb.kills + 1;
        const vb = this.remotes.get(p.victimId);
        if (vb) vb.deaths = p.victimDeaths ?? vb.deaths + 1;
        this.handlers.onKill({
          killerId: p.killerId,
          victimId: p.victimId,
          killerName: p.killerName,
          victimName: p.victimName,
          at: performance.now(),
        });
        break;
      }
      case MsgType.S2C_SPAWN: {
        const p = payload as {
          id: number;
          x: number;
          y: number;
          z: number;
          ya: number;
          hp: number;
          invulnMs?: number;
        };
        this.handlers.onSpawn(p.id, p.x, p.y, p.z, p.ya, p.hp, p.invulnMs);
        break;
      }
      case MsgType.S2C_SCOREBOARD: {
        const p = payload as { entries: Array<{ id: number; n: string; k: number; d: number }> };
        this.handlers.onScoreboard(p.entries);
        break;
      }
      case MsgType.S2C_CORRECT: {
        this.handlers.onCorrect(payload as C2SState);
        break;
      }
      case MsgType.S2C_REJECT: {
        const p = payload as { code: string; message?: string };
        this.handlers.onReject(p.code, p.message);
        break;
      }
      case MsgType.S2C_ROOM_FULL: {
        this.handlers.onReject('ROOM_FULL', 'Room full');
        break;
      }
      case MsgType.S2C_HIT_CONFIRM: {
        const p = payload as { targetId: number; amount: number };
        this.handlers.onHitConfirm?.(p.targetId, p.amount);
        break;
      }
      default:
        break;
    }
  }

  /** @deprecated use setLocalState + net loop */
  maybeSendState(flight: FlightState, alive: boolean, _now: number): void {
    this.setLocalState(flight, alive);
  }

  sendFire(dx: number, dy: number, dz: number, ox?: number, oy?: number, oz?: number): void {
    if (this.lastFlight) this.forceSendState(this.lastFlight, this.lastAlive);
    this.fireSeq++;
    this.send(MsgType.C2S_FIRE, {
      dx,
      dy,
      dz,
      seq: this.fireSeq,
      t: this.clock.serverNow(),
      ox,
      oy,
      oz,
    });
  }

  close(): void {
    this.stopNetLoop();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.send(MsgType.C2S_LEAVE, {});
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
    this.connected = false;
  }

  private send(type: number, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeMessage(type, payload));
    } catch {
      /* ignore */
    }
  }
}

// silence unused import if tree-shaken
void KEEPALIVE_MS;
