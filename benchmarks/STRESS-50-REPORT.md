# Stress benchmark: 50 flying bots + 1 standing spectator

**Date:** 2026-07-08  
**Server:** Node `server-node` on localhost:8787, `STRESS_MAX_PLAYERS=64`  
**Room:** `arena` (deathmatch)  
**Bot tick:** 15 Hz continuous state  
**Snapshot encoding:** MessagePack short-key (unpacked) @ server 15 Hz  

---

## Setup

| Role | Count | Behavior |
|------|-------|----------|
| Bots | 50 | Circling formation, continuous C2S_STATE |
| Spectator | 1 | Browser client, fixed near (0, 50–60, −200), watching arena |
| **Total** | **51** | Single room |

---

## Server / bot metrics (30s run)

| Metric | Value |
|--------|-------|
| Joined | **50/50** |
| Errors | **0** |
| Peak players (health) | **51** |
| Peak in snapshot | **51** |
| Duration | 30 s |
| Downlink (all bots sum) | **100.3 MB** (~**3.4 MB/s**) |
| Uplink (all bots sum) | **1.9 MB** (~**65 KB/s**) |
| Downlink per bot | ~**68.5 KB/s** |
| Snapshots received (sum) | 22 436 |
| Bot process RSS | ~**114 MB** |

### Load ramp

| t | players | ~down KB/s |
|---|---------|------------|
| 0s | 1 | — |
| 1s | 26 | 328 |
| 2s | **51** | 2118 |
| 3–30s | **51** | **~3490** steady |

---

## Browser / spectator metrics (under peak load)

Measured with `window.__flightSim.getPerf()` while **remotes = 50**.

| Metric | Value |
|--------|-------|
| Peak remotes rendered | **50** |
| Avg FPS | **~60.0** |
| Min FPS | **~56.5** |
| p05 FPS | **~56.8** |
| p50 FPS | **~59.9** |
| p95 FPS | **~63.3** |
| RTT | **&lt; 1 ms** (localhost) |
| FPS samples | 300+ |

**Performance drop:** effectively **none** on this machine for client FPS (display refresh locked ~60). Min dipped ~3–4 FPS only.

---

## What it looked like / bottlenecks

### Bandwidth (main cost today)
With **unpacked** MessagePack snapshots of 51 players @ 15 Hz to every client:

```
~3.4 MB/s aggregate bot downlink
~68 KB/s per client
```

At **500 players** in many rooms of 24 (not one room of 500):
- Per full room (~24p): roughly scale by (24/51)² for fan-out × clients… better estimate:
  - Snapshot size ∝ N players
  - Each of N clients receives one snapshot/tick  
  - Room bandwidth ∝ N² × Hz × bytes/player
- **One room of 50 is already ~3.4 MB/s** on the bot side alone — that is the warning sign.
- **Packed binary (~24 B/player)** would cut snapshot body ~3–5× → target ~**15–25 KB/s/client** at 24p.

### CPU
- Node held **51** connections with 0 errors; RSS stable ~110 MB for bot process (not including server separately).
- Server is thin (no physics) — OK at this scale.

### Client GPU/CPU
- 50 remote low-poly planes @ 60 FPS — **comfortable** on this hardware.
- Bottleneck at 50 is **network payload size**, not triangle count.

---

## Conclusions

| Question | Answer |
|----------|--------|
| Does 50+1 work in one room? | **Yes** (with raised room cap) |
| FPS impact for spectator? | **Negligible** (~60 → min ~56) |
| Ready for 500 in one sky? | **No** — O(N²) bandwidth |
| Ready for 500 sharded (rooms ≤24)? | **Plausible** after re-enabling **packed snapshots** + multi-process if needed |

### Recommended next optimizations (for scale)
1. Re-enable **packed binary S2C_SNAPSHOT** (Appendix G) for production  
2. Keep **room hard max 24** for public matchmaking  
3. Dirty-bit uplink (already optional) once remotes stay smooth  
4. Multiple Node processes / sticky rooms past ~200–500 concurrent  

---

## How to reproduce

```bash
# Terminal 1 — server with high cap
cd server-node && STRESS_MAX_PLAYERS=64 npx tsx src/index.ts

# Terminal 2 — browser
# open http://127.0.0.1:8787 → Join public multiplayer (stand still)

# Terminal 3 — bots
cd tools/loadtest && PLAYERS=50 DURATION_MS=30000 HZ=15 npx tsx stress-50.ts

# In browser console during load:
window.__flightSim.getPerf()
```

Raw JSON from this run: `benchmarks/stress-50-1783499811532.json`
