import {
  GLOBAL_MAX_PLAYERS_FREE,
  GLOBAL_MAX_PLAYERS_PUBLIC,
  GLOBAL_MAX_ROOMS_FREE,
  GLOBAL_MAX_ROOMS_PUBLIC,
  LOBBY_ROOM_DEATHMATCH,
  LOBBY_ROOM_PEACEFUL,
  MAX_PLAYERS_DOGFOOD,
  MAX_PLAYERS_PUBLIC,
  type GameMode,
} from '@flight-sim/shared';
import { randomBytes } from 'node:crypto';

export function defaultLobbyRoomId(mode: GameMode): string {
  return mode === 'peaceful' ? LOBBY_ROOM_PEACEFUL : LOBBY_ROOM_DEATHMATCH;
}

export interface LobbyRoomMeta {
  roomId: string;
  mode: GameMode;
  count: number;
  max: number;
  lastBeat: number;
  disabled: boolean;
}

const TIER = (process.env.TIER ?? 'public') as 'free' | 'public';

export class Lobby {
  rooms = new Map<string, LobbyRoomMeta>();

  get globalPlayers(): number {
    let s = 0;
    for (const r of this.rooms.values()) s += r.count;
    return s;
  }

  get globalMaxPlayers(): number {
    return TIER === 'free' ? GLOBAL_MAX_PLAYERS_FREE : GLOBAL_MAX_PLAYERS_PUBLIC;
  }

  get globalMaxRooms(): number {
    return TIER === 'free' ? GLOBAL_MAX_ROOMS_FREE : GLOBAL_MAX_ROOMS_PUBLIC;
  }

  get tierMaxPlayers(): number {
    // STRESS_MAX_PLAYERS env for load tests (e.g. 64)
    const stress = Number(process.env.STRESS_MAX_PLAYERS ?? 0);
    if (stress > 0) return Math.min(stress, 128);
    return TIER === 'free' ? MAX_PLAYERS_DOGFOOD : MAX_PLAYERS_PUBLIC;
  }

  pruneStale(now = Date.now()): void {
    for (const [id, r] of this.rooms) {
      if (now - r.lastBeat > 15_000 && r.count === 0) this.rooms.delete(id);
    }
  }

  heartbeat(roomId: string, count: number, mode: GameMode, max: number, disabled = false): void {
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.count = count;
      existing.mode = mode;
      existing.max = max;
      existing.lastBeat = Date.now();
      existing.disabled = disabled;
    } else {
      this.rooms.set(roomId, {
        roomId,
        mode,
        count,
        max,
        lastBeat: Date.now(),
        disabled,
      });
    }
  }

  allocate(opts: {
    mode: GameMode;
    preferredRoomId?: string;
    excludeRoomIds?: string[];
  }): { roomId: string; max: number; created: boolean } | { error: 'WORLD_FULL' } {
    this.pruneStale();
    const exclude = new Set(opts.excludeRoomIds ?? []);
    const globalPlayers = this.globalPlayers;
    if (globalPlayers >= this.globalMaxPlayers) return { error: 'WORLD_FULL' };

    // Always try the shared public lobby first (unless excluded / full)
    const mainId = defaultLobbyRoomId(opts.mode);
    const preferred = opts.preferredRoomId?.trim() || mainId;

    const tryRoom = (roomId: string): { roomId: string; max: number; created: boolean } | null => {
      if (exclude.has(roomId)) return null;
      const existing = this.rooms.get(roomId);
      if (existing) {
        if (existing.disabled || existing.count >= existing.max) return null;
        if (existing.mode !== opts.mode) return null;
        return { roomId: existing.roomId, max: existing.max, created: false };
      }
      if (this.rooms.size >= this.globalMaxRooms) return null;
      const max = Math.min(this.tierMaxPlayers, this.globalMaxPlayers - globalPlayers);
      if (max <= 0) return null;
      this.rooms.set(roomId, {
        roomId,
        mode: opts.mode,
        count: 0,
        max,
        lastBeat: Date.now(),
        disabled: false,
      });
      return { roomId, max, created: true };
    };

    // 1) Preferred / default public lobby
    const prefHit = tryRoom(preferred);
    if (prefHit) return prefHit;

    // 2) If preferred was custom and failed, fall back to main lobby
    if (preferred !== mainId) {
      const mainHit = tryRoom(mainId);
      if (mainHit) return mainHit;
    }

    // 3) Pack any existing non-full room of this mode
    let best: LobbyRoomMeta | null = null;
    for (const r of this.rooms.values()) {
      if (r.mode !== opts.mode || r.disabled || exclude.has(r.roomId) || r.count >= r.max) continue;
      if (!best || r.count > best.count) best = r;
    }
    if (best) return { roomId: best.roomId, max: best.max, created: false };

    // 4) Overflow room (rare)
    if (this.rooms.size >= this.globalMaxRooms) return { error: 'WORLD_FULL' };
    const max = Math.min(this.tierMaxPlayers, this.globalMaxPlayers - globalPlayers);
    if (max <= 0) return { error: 'WORLD_FULL' };
    const roomId = `${opts.mode}-${randomBytes(3).toString('hex')}`;
    this.rooms.set(roomId, {
      roomId,
      mode: opts.mode,
      count: 0,
      max,
      lastBeat: Date.now(),
      disabled: false,
    });
    return { roomId, max, created: true };
  }

  list(): LobbyRoomMeta[] {
    this.pruneStale();
    return [...this.rooms.values()].slice(0, 50);
  }
}
