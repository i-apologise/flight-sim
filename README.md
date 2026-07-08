# Flight Combat Sim

Browser multiplayer **arcade flight combat** (Three.js) — public lobbies, radar, landing, deathmatch.

## Quick start

```bash
pnpm install
pnpm dev:all          # client :5173 + server :8787
# or single process:
pnpm start            # builds client, serves on :8787
```

Open **http://localhost:5173** (dev) or **http://localhost:8787** (production build).

### Multiplayer test (same machine)

1. Open **two browser tabs** (each tab = separate pilot via `sessionStorage` UUID)
2. Both pick **Deathmatch** → **Join public multiplayer**
3. You land in room **`arena`** near the runway (yellow ◆ on radar)

## Controls

| Input | Action |
|-------|--------|
| WASD / arrows | Pitch / roll |
| Q E | Rudder |
| Shift / Ctrl | Throttle |
| **Hold Space** | Fire (air) / brake (ground) |
| B | Brake |
| F / L | Landing assist |
| G | Gear |
| W + speed ≥ 38 | Takeoff rotate |
| Tab | Scoreboard |
| [ ] | Radar range |
| Esc | Menu |

## Architecture

| Package | Role |
|---------|------|
| `client/` | Three.js game, HUD, radar, netcode |
| `shared/` | Protocol, flight model, validation |
| `server-node/` | Lobby + rooms + combat authority |
| `server/` | Cloudflare DO scaffold (optional later) |
| `docs/DESIGN.md` | Full system design |

## Scripts

```bash
pnpm test              # shared protocol + flight tests
pnpm loadtest          # 8 fake clients (server must be up)
pnpm --filter @flight-sim/client build
```

## Deploy (later)

Build client, run `server-node` with `SESSION_SECRET` and optional `TIER=free|public`.
Static assets can live on Pages; set `VITE_API_BASE` / `VITE_WS_BASE` if split.

## License

MIT

## Flight controls (updated)

| Key | Action |
|-----|--------|
| **1–9** | Set speed/throttle 10–90% |
| **0** | Idle (0%) |
| Shift / Ctrl | Fine throttle up/down |
| WASD | Pitch / roll |
| Q E | Yaw |
| **On ground** | Throttle up (5–9) until SPD ≥ 32, then **W** to takeoff |
| B / Space (ground) | Brake |
| Space (air) | Fire |
| G | Gear |
| F | Landing assist |

## Concurrency (500 players)

One Node process can serve **~500 concurrent** if:
- Players are sharded into rooms of ≤24 (default)
- Packed binary snapshots @ ~15 Hz
- No server-side physics

Not supported: 500 in a single shared sky. Scale further with multiple server processes + sticky room IDs.
