import {
  FLAG_ALIVE,
  FLAG_GEAR,
  LOBBY_ROOM_DEATHMATCH,
  LOBBY_ROOM_PEACEFUL,
  MAX_HP,
  createAirborneState,
  createFlightState,
  forwardFromEuler,
  integrateArcadeFlight,
  quatFromYawPitchRoll,
  setFlightPose,
  toggleGear,
  type FlightState,
  type GameMode,
  type S2CWelcome,
} from '@flight-sim/shared';
import * as THREE from 'three';
import { applyPose, colorForId, createPlaneMesh } from './entities/plane.js';
import { InputManager } from './input.js';
import { GameNet } from './net/client.js';
import { loadNickname, saveNickname } from './net/session.js';
import { Radar, type RadarContact } from './ui/radar.js';
import { createWorld, updateCamera } from './world/scene.js';

type PlayMode = 'solo' | 'online';

const app = document.getElementById('app')!;
const menu = document.getElementById('menu')!;
const nickInput = document.getElementById('nick') as HTMLInputElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const roomInput = document.getElementById('room') as HTMLInputElement;
const hudTl = document.getElementById('hud-tl')!;
const hudTr = document.getElementById('hud-tr')!;
const killfeedEl = document.getElementById('killfeed')!;
const scoreboardEl = document.getElementById('scoreboard')!;
const scoreBody = document.getElementById('score-body')!;
const toastEl = document.getElementById('toast')!;
const radarWrap = document.getElementById('radar-wrap')!;
const radarCanvas = document.getElementById('radar') as HTMLCanvasElement;
const radar = new Radar(radarCanvas, { rangeM: 1400, size: 168 });
const RADAR_RANGES = [700, 1400, 2800, 4500];
let radarRangeIdx = 1;

nickInput.value = loadNickname() || 'Pilot';

const { scene, camera, renderer } = createWorld();
app.appendChild(renderer.domElement);

const input = new InputManager();
let playMode: PlayMode = 'solo';
let running = false;
let flight = createFlightState();
let localMesh = createPlaneMesh(0x4f7cff);
scene.add(localMesh);
const remoteMeshes = new Map<number, THREE.Group>();
let alive = true;
let hp = MAX_HP;
let kills = 0;
let deaths = 0;
let displayName = 'Pilot';
let roomLabel = 'solo';
let gameMode: GameMode = 'peaceful';
let invulnUntil = 0;
let deathCamUntil = 0;
const killFeed: Array<{ text: string; at: number }> = [];
let scoreEntries: Array<{ id: number; n: string; k: number; d: number }> = [];
let tracers: Array<{ mesh: THREE.Line; until: number }> = [];
let deathPos = { x: 0, y: 80, z: 0, yaw: 0 };

const net = new GameNet({
  onWelcome(w: S2CWelcome) {
    // Join spawns are mid-air near arena — use airborne state so controls work immediately
    flight = createAirborneState(w.spawn.x, w.spawn.y, w.spawn.z, w.spawn.ya, 60, 0.55);
    if (w.spawn.pi != null || w.spawn.ro != null) {
      setFlightPose(
        flight,
        w.spawn.x,
        Math.max(w.spawn.y, 40),
        w.spawn.z,
        w.spawn.ya,
        w.spawn.pi ?? 0.05,
        w.spawn.ro ?? 0,
      );
      flight.onGround = false;
    }
    displayName = w.displayName;
    roomLabel = w.roomId;
    gameMode = w.mode;
    hp = MAX_HP;
    alive = true;
    invulnUntil = performance.now() + 1500;
    kills = 0;
    deaths = 0;
    const self = w.players.find((p) => p.id === w.playerId);
    if (self) {
      kills = self.kills ?? 0;
      deaths = self.deaths ?? 0;
    }
    syncRemoteMeshes();
  },
  onReject(code, message) {
    toast(`${code}${message ? `: ${message}` : ''}`);
    if (code === 'ROOM_FULL' || code === 'BAD_TOKEN' || code === 'WORLD_FULL') {
      leaveToMenu();
    }
  },
  onDamage(targetId, _attackerId, amount, newHp) {
    if (targetId === net.localId) {
      hp = newHp;
      flashDamage();
      if (newHp > 0) toast(`Hit −${amount} HP`);
    }
  },
  onKill(ev) {
    killFeed.unshift({ text: `${ev.killerName} ☠ ${ev.victimName}`, at: performance.now() });
    if (killFeed.length > 5) killFeed.pop();
    if (ev.killerId === net.localId) {
      kills++;
      toast('Kill!');
    }
    if (ev.victimId === net.localId) {
      deaths++;
      alive = false;
      deathCamUntil = performance.now() + 3000;
      deathPos = { x: flight.x, y: flight.y, z: flight.z, yaw: flight.yaw };
      flight.speed = 0;
      flight.throttle = 0;
      toast('Destroyed — respawning…');
    }
  },
  onSpawn(id, x, y, z, ya, newHp, invulnMs) {
    if (id === net.localId) {
      applyLocalRespawn(x, y, z, ya, newHp, invulnMs);
    }
  },
  onSelfSnapshot(p) {
    // Recover if we think we're dead but server says we're alive (missed S2C_SPAWN)
    const serverAlive = p.hp > 0 && (p.fl & FLAG_ALIVE) !== 0;
    if (!alive && serverAlive) {
      applyLocalRespawn(p.x, p.y, p.z, p.ya, p.hp, 1500);
      return;
    }
    // If stuck in taxi while server has us high up, force airborne
    if (alive && flight.onGround && p.y > 20) {
      flight.onGround = false;
      flight.y = Math.max(flight.y, p.y);
      flight.speed = Math.max(flight.speed, 50);
    }
    if (alive && serverAlive) {
      hp = p.hp;
    }
  },
  onScoreboard(entries) {
    scoreEntries = entries;
    const me = entries.find((e) => e.id === net.localId || e.n === displayName);
    if (me) {
      kills = me.k;
      deaths = me.d;
    }
  },
  onPlayerJoined(_id, name) {
    toast(`${name} joined`);
  },
  onPlayerLeft(id) {
    const m = remoteMeshes.get(id);
    if (m) {
      scene.remove(m);
      remoteMeshes.delete(id);
    }
  },
  onCorrect(pose) {
    setFlightPose(flight, pose.x, pose.y, pose.z, pose.ya, pose.pi, pose.ro);
    flight.throttle = pose.th;
  },
  onDisconnected(reason) {
    if (playMode === 'online' && running) {
      toast(`Disconnected: ${reason}`);
      leaveToMenu();
    }
  },
  onHitConfirm() {
    // subtle hit marker
    flashHit();
  },
});

function applyLocalRespawn(
  x: number,
  y: number,
  z: number,
  ya: number,
  newHp: number,
  invulnMs?: number,
): void {
  flight = createAirborneState(x, y, z, ya, 65, 0.65);
  hp = newHp;
  alive = true;
  invulnUntil = performance.now() + (invulnMs ?? 1500);
  toast('Respawned — airborne, full control');
}

let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2400);
}

function flashDamage(): void {
  scene.background = new THREE.Color(0x662222);
  setTimeout(() => {
    scene.background = new THREE.Color(0x87b5e8);
  }, 80);
}

function flashHit(): void {
  const prev = (document.getElementById('hud-tr') as HTMLElement).style.color;
  hudTr.style.color = '#ffee66';
  setTimeout(() => {
    hudTr.style.color = prev || '';
  }, 60);
}

function clearRemoteMeshes(): void {
  for (const [, m] of remoteMeshes) scene.remove(m);
  remoteMeshes.clear();
}

function syncRemoteMeshes(): void {
  for (const [id] of net.remotes) {
    if (!remoteMeshes.has(id)) {
      const m = createPlaneMesh(colorForId(id));
      scene.add(m);
      remoteMeshes.set(id, m);
    }
  }
  for (const [id, m] of remoteMeshes) {
    if (!net.remotes.has(id)) {
      scene.remove(m);
      remoteMeshes.delete(id);
    }
  }
}

function leaveToMenu(): void {
  running = false;
  playMode = 'solo';
  net.reset();
  clearRemoteMeshes();
  scoreEntries = [];
  killFeed.length = 0;
  menu.classList.remove('hidden');
  radarWrap.classList.remove('visible');
}

function startSolo(): void {
  net.reset();
  clearRemoteMeshes();
  playMode = 'solo';
  gameMode = modeSelect.value as GameMode;
  displayName = nickInput.value.trim() || 'Pilot';
  saveNickname(displayName);
  roomLabel = 'solo';
  flight = createFlightState(0, 2, -200, 0);
  flight.onGround = true;
  flight.gearDown = true;
  flight.throttle = 0;
  flight.speed = 0;
  hp = MAX_HP;
  alive = true;
  kills = 0;
  deaths = 0;
  scoreEntries = [];
  menu.classList.add('hidden');
  radarWrap.classList.add('visible');
  running = true;
  toast('Runway — Shift throttle, W rotate · F land assist · G gear');
}

async function startOnline(): Promise<void> {
  const nickname = nickInput.value.trim() || 'Pilot';
  saveNickname(nickname);
  displayName = nickname;
  playMode = 'online';
  const mode = modeSelect.value as GameMode;
  const roomId =
    roomInput.value.trim() ||
    (mode === 'peaceful' ? LOBBY_ROOM_PEACEFUL : LOBBY_ROOM_DEATHMATCH);
  menu.classList.add('hidden');
  toast(`Joining ${roomId}…`);
  try {
    await net.join({ nickname, mode, roomId });
    radarWrap.classList.add('visible');
    running = true;
    // single toast after join
    toast(`${displayName} in ${roomLabel} · yellow ◆ = runway · 2 tabs = 2 pilots`);
  } catch (e) {
    menu.classList.remove('hidden');
    radarWrap.classList.remove('visible');
    toast(e instanceof Error ? e.message : 'Join failed');
  }
}

document.getElementById('btn-solo')!.addEventListener('click', startSolo);
document.getElementById('btn-online')!.addEventListener('click', () => void startOnline());

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (running) leaveToMenu();
  }
  if (running && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    radarRangeIdx = Math.max(
      0,
      Math.min(RADAR_RANGES.length - 1, radarRangeIdx + (e.code === 'BracketRight' ? 1 : -1)),
    );
    radar.setRange(RADAR_RANGES[radarRangeIdx]!);
  }
});

window.addEventListener('resize', () => radar.resize());

/**
 * Split loops:
 * - SIM_MS interval: physics + feed net (survives background better than rAF alone)
 * - rAF: render only (interpolation of remotes)
 * Net send runs at 20 Hz inside GameNet independent of both.
 */

// Keep multiplayer alive across tabs: SharedWorker ticks even when this tab is backgrounded
// (as long as another tab of this game is focused).
let __swPort: MessagePort | null = null;
try {
  const sw = new SharedWorker('/tab-heartbeat.js');
  __swPort = sw.port;
  __swPort.start();
  __swPort.onmessage = (ev) => {
    if (ev.data?.type !== 'tick' || !running) return;
    // Extra sim+net push when page is hidden (Chrome throttles this tab's timers)
    if (document.visibilityState === 'hidden' && alive) {
      integrateArcadeFlight(flight, input.sampleFlight(!!flight.onGround), 1 / 20);
      if (playMode === 'online') net.setLocalState(flight, alive);
    } else if (playMode === 'online') {
      net.setLocalState(flight, alive);
    }
  };
} catch {
  /* SharedWorker unavailable — single-tab still works */
}

const SIM_MS = 1000 / 60;
let lastSim = performance.now();
let hudAcc = 0;

setInterval(() => {
  if (!running) return;
  const now = performance.now();
  lastSim = now;
  // Fixed timestep — kills wobble from setInterval jitter
  const dt = 1 / 60;

  if (alive) {
    if (input.consumeGearToggle()) {
      toggleGear(flight);
      toast(flight.gearDown ? 'Gear DOWN' : 'Gear UP');
    }
    integrateArcadeFlight(flight, input.sampleFlight(!!flight.onGround), dt);
  }

  if (alive && gameMode === 'deathmatch' && input.pollFire(!!flight.onGround, now)) {
    const fwd = forwardFromEuler(flight.yaw, flight.pitch, flight.roll);
    if (playMode === 'online') {
      net.sendFire(fwd.x, fwd.y, fwd.z, flight.x, flight.y, flight.z);
    }
    spawnTracer(flight, fwd);
  }

  // Always publish latest pose to net layer (sender loop picks it up at 20 Hz)
  if (playMode === 'online') {
    net.setLocalState(flight, alive);
  }
}, SIM_MS);

function frame(now: number): void {
  requestAnimationFrame(frame);

  // FPS sample (instantaneous)
  const dtf = now - __lastFpsT;
  if (dtf > 0 && dtf < 1000) {
    __fpsSamples.push(1000 / dtf);
    if (__fpsSamples.length > 600) __fpsSamples.shift();
  }
  __lastFpsT = now;

  if (running) {
    if (playMode === 'online') {
      syncRemoteMeshes();
      // Latest-state smoother — no server-clock dependency (fixes "frozen remote")
      const dt = Math.min(0.05, 1 / 60);
      for (const [id, buf] of net.remotes) {
        const pose = buf.tick(dt);
        const mesh = remoteMeshes.get(id);
        if (pose && mesh) {
          const gearDown = (pose.fl & FLAG_GEAR) !== 0;
          applyPose(mesh, pose.x, pose.y, pose.z, pose.ya, pose.pi, pose.ro, gearDown);
          mesh.visible = !(pose.hp <= 0 || (pose.fl & FLAG_ALIVE) === 0);
        }
      }
    }

    if (alive) {
      applyPose(
        localMesh,
        flight.x,
        flight.y,
        flight.z,
        flight.yaw,
        flight.pitch,
        flight.roll,
        flight.gearDown,
      );
      localMesh.visible = true;
      updateCamera(
        camera,
        flight.x,
        flight.y,
        flight.z,
        flight.yaw,
        flight.pitch,
        flight.roll,
        !!flight.onGround,
      );
    } else {
      localMesh.visible = false;
      updateCamera(camera, deathPos.x, deathPos.y + 15, deathPos.z, deathPos.yaw, -0.2, 0, false);
    }

    tracers = tracers.filter((t) => {
      if (now > t.until) {
        scene.remove(t.mesh);
        return false;
      }
      return true;
    });
  }

  // HUD/radar cheaper than every frame — ~15 Hz is enough
  hudAcc += 1;
  if (hudAcc >= 4) {
    hudAcc = 0;
    updateHud(now);
    if (running) updateRadar();
  }
  scoreboardEl.classList.toggle('visible', input.showScores && running);
  if (input.showScores) renderScoreboard();

  renderer.render(scene, camera);
}

function updateRadar(): void {
  const contacts: RadarContact[] = [];
  if (playMode === 'online') {
    const hostile = gameMode === 'deathmatch';
    for (const [, buf] of net.remotes) {
      const pose = buf.latestPose() ?? buf.tick(0);
      if (!pose) continue;
      const dead = pose.hp <= 0 || (pose.fl & FLAG_ALIVE) === 0;
      contacts.push({
        x: pose.x,
        z: pose.z,
        yaw: pose.ya,
        kind: hostile ? 'enemy' : 'ally',
        label: buf.name,
        dead,
      });
    }
  }
  radar.draw(flight.x, flight.z, flight.yaw, contacts);
}

function spawnTracer(f: FlightState, fwd: { x: number; y: number; z: number }): void {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(f.x, f.y, f.z),
    new THREE.Vector3(f.x + fwd.x * 120, f.y + fwd.y * 120, f.z + fwd.z * 120),
  ]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffee88, transparent: true, opacity: 0.85 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ mesh: line, until: performance.now() + 80 });
}

function updateHud(now: number): void {
  if (!running) {
    hudTl.textContent = '';
    hudTr.textContent = '';
    killfeedEl.innerHTML = '';
    return;
  }
  const alt = Math.max(0, flight.y).toFixed(0);
  const spd = flight.speed.toFixed(0);
  const thr = Math.round(flight.throttle * 100);
  const gear = flight.gearDown ? 'GEAR↓' : 'GEAR↑';
  const phase = !alive ? 'DEAD' : flight.onGround ? 'GND' : 'AIR';
  const inv = now < invulnUntil ? ' · INVULN' : '';
  const nearest = nearestPilotInfo();
  const players = playMode === 'online' ? net.remotes.size + 1 : 1;
  const takeoffHint =
    flight.onGround && alive
      ? flight.speed < 32
        ? ' · thr up to SPD 32+'
        : flight.pitch < 0.15
          ? ' · hold W to raise nose'
          : ' · hold W — climbing…'
      : '';

  hudTl.innerHTML = [
    `<b>${escapeHtml(displayName)}</b> · <b>${escapeHtml(roomLabel)}</b> · ${players} online`,
    `SPD ${spd} · ALT ${alt}m · THR ${thr}% · ${phase} · ${gear}${inv}${takeoffHint}`,
    playMode === 'online'
      ? `RTT ${net.clock.rttMs.toFixed(0)}ms · net ${net.snapshotsReceived} · ${gameMode} · ${nearest}`
      : `${gameMode} solo · ${nearest}`,
  ].join('<br/>');

  hudTr.innerHTML = [
    alive ? `HP ${Math.max(0, Math.round(hp))}` : 'DESTROYED',
    `K ${kills} / D ${deaths}`,
  ].join('<br/>');

  killfeedEl.innerHTML = killFeed
    .filter((k) => now - k.at < 6000)
    .map((k) => `<div>${escapeHtml(k.text)}</div>`)
    .join('');
}

function nearestPilotInfo(): string {
  if (playMode !== 'online') return 'MP: keep both windows visible';
  if (net.remotes.size === 0) return 'waiting for pilots…';
  let best = Infinity;
  let name = '';
  let updates = 0;
  for (const [, buf] of net.remotes) {
    const pose = buf.latestPose();
    if (!pose) continue;
    updates += buf.updates;
    const d = Math.hypot(pose.x - flight.x, pose.y - flight.y, pose.z - flight.z);
    if (d < best) {
      best = d;
      name = buf.name;
    }
  }
  if (!Number.isFinite(best)) return 'no contacts';
  return `nearest ${name}: ${best.toFixed(0)}m · upd ${updates}`;
}

function renderScoreboard(): void {
  let rows = scoreEntries;
  if (rows.length === 0) {
    rows = [{ id: net.localId ?? 0, n: displayName, k: kills, d: deaths }];
    for (const [id, buf] of net.remotes) {
      rows.push({ id, n: buf.name, k: buf.kills, d: buf.deaths });
    }
    rows.sort((a, b) => b.k - a.k || a.d - b.d);
  }
  scoreBody.innerHTML = rows
    .map((e) => {
      const me = e.id === net.localId || e.n === displayName;
      return `<tr${me ? ' style="color:#7dff9a"' : ''}><td>${escapeHtml(e.n)}</td><td>${e.k}</td><td>${e.d}</td></tr>`;
    })
    .join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

requestAnimationFrame(frame);

// Automation / stress-test hook (browser MCP)
declare global {
  interface Window {
    __flightSim?: {
      getState: () => Record<string, unknown>;
      getPerf: () => Record<string, unknown>;
      resetPerf: () => void;
      setPos: (x: number, y: number, z: number, ya?: number) => void;
      fire: () => void;
    };
  }
}
// Lightweight FPS / frame-time ring buffer for benchmarks
const __fpsSamples: number[] = [];
let __lastFpsT = performance.now();

window.__flightSim = {
  getState: () => ({
    alive,
    hp,
    kills,
    deaths,
    x: flight.x,
    y: flight.y,
    z: flight.z,
    yaw: flight.yaw,
    onGround: flight.onGround,
    speed: flight.speed,
    room: roomLabel,
    remotes: net.remotes.size,
    localId: net.localId,
    snapshots: net.snapshotsReceived,
    rtt: net.clock.rttMs,
    fps: __fpsSamples.length
      ? __fpsSamples.reduce((a, b) => a + b, 0) / __fpsSamples.length
      : 0,
    fpsMin: __fpsSamples.length ? Math.min(...__fpsSamples) : 0,
    fpsMax: __fpsSamples.length ? Math.max(...__fpsSamples) : 0,
    fpsSamples: __fpsSamples.length,
  }),
  getPerf: () => {
    const sorted = [...__fpsSamples].sort((a, b) => a - b);
    const p = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
    return {
      avgFps: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
      minFps: sorted.length ? sorted[0]! : 0,
      maxFps: sorted.length ? sorted[sorted.length - 1]! : 0,
      p50: p(0.5),
      p05: p(0.05),
      p95: p(0.95),
      samples: sorted.length,
      remotes: net.remotes.size,
      snapshots: net.snapshotsReceived,
      rtt: net.clock.rttMs,
    };
  },
  resetPerf: () => {
    __fpsSamples.length = 0;
  },
  setPos: (x, y, z, ya = 0) => {
    flight.x = x;
    flight.y = y;
    flight.z = z;
    flight.yaw = ya;
    flight.pitch = 0;
    flight.roll = 0;
    flight.q = quatFromYawPitchRoll(ya, 0, 0);
    flight.onGround = false;
    flight.speed = 60;
    flight.throttle = 0.6;
    // Push pose to server immediately so combat uses real positions
    net.forceSendState(flight, alive);
  },
  fire: () => {
    const fwd = forwardFromEuler(flight.yaw, flight.pitch, flight.roll);
    if (playMode === 'online' && alive) {
      // Force state first so server origin matches client aim
      net.forceSendState(flight, true);
      net.sendFire(fwd.x, fwd.y, fwd.z, flight.x, flight.y, flight.z);
    }
  },
};
