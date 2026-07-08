import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeMessage, decodeMessage, packSnapshotPlayers, unpackSnapshotPlayers, packedSnapshotByteLength } from './schema.js';
import { MsgType } from './protocol.js';
import type { SnapshotPlayer } from './protocol.js';

function makePlayers(n: number): SnapshotPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    x: i * 10,
    y: 50,
    z: -i * 5,
    ya: 0.1 * i,
    pi: 0.01,
    ro: -0.02,
    th: 0.5,
    hp: 100,
    fl: 1,
  }));
}

test('envelope roundtrip', () => {
  const bytes = encodeMessage(MsgType.C2S_STATE, { x: 1, y: 2, z: 3, ya: 0, pi: 0, ro: 0, th: 0.5 });
  const msg = decodeMessage(bytes);
  assert.equal(msg.type, MsgType.C2S_STATE);
  const p = msg.payload as { x: number };
  assert.equal(p.x, 1);
});

test('32-player msgpack snapshot under 4KB', () => {
  const players = makePlayers(32);
  const bytes = encodeMessage(MsgType.S2C_SNAPSHOT, { t: Date.now(), p: players });
  assert.ok(bytes.byteLength <= 4096, `snapshot too large: ${bytes.byteLength}`);
  console.log('32p msgpack snapshot bytes:', bytes.byteLength);
});

test('packed snapshot layout 24B/player', () => {
  const players = makePlayers(24);
  const bin = packSnapshotPlayers(players);
  assert.equal(bin.byteLength, packedSnapshotByteLength(24));
  const back = unpackSnapshotPlayers(bin);
  assert.equal(back.length, 24);
  assert.equal(back[0]!.id, 1);
  assert.ok(Math.abs(back[5]!.x - 50) < 0.01);
});

import { quatFromYawPitchRoll, quatForward, yawPitchRollFromQuat } from './math.js';
import { createAirborneState, createFlightState, integrateArcadeFlight } from './flight.js';

test('quat yaw/pitch/roll matches nose-up forward', () => {
  const q = quatFromYawPitchRoll(0, Math.PI / 6, 0);
  const f = quatForward(q);
  assert.ok(f.y > 0.4, `expected nose up, got y=${f.y}`);
  assert.ok(Math.abs(f.x) < 0.05);
  assert.ok(f.z > 0.8);
});

test('euler roundtrip roughly stable', () => {
  const yaw = 0.7;
  const pitch = 0.3;
  const roll = -0.4;
  const q = quatFromYawPitchRoll(yaw, pitch, roll);
  const e = yawPitchRollFromQuat(q);
  assert.ok(Math.abs(e.yaw - yaw) < 0.05, `yaw ${e.yaw}`);
  assert.ok(Math.abs(e.pitch - pitch) < 0.05, `pitch ${e.pitch}`);
  assert.ok(Math.abs(e.roll - roll) < 0.08, `roll ${e.roll}`);
});

test('pitch input raises altitude over time', () => {
  const s = createFlightState(0, 100, 0, 0);
  const y0 = s.y;
  for (let i = 0; i < 60; i++) {
    integrateArcadeFlight(s, { pitch: 1, roll: 0, yaw: 0, throttleDelta: 0.2 }, 1 / 60);
  }
  assert.ok(s.y > y0 + 5, `expected climb, y0=${y0} y=${s.y}`);
  assert.ok(s.pitch > 0.1, `expected positive pitch ${s.pitch}`);
});

test('roll left then holds bank and turns heading', () => {
  const s = createFlightState(0, 100, 0, 0);
  const yaw0 = s.yaw;
  for (let i = 0; i < 45; i++) {
    integrateArcadeFlight(s, { pitch: 0, roll: 1, yaw: 0, throttleDelta: 0 }, 1 / 60);
  }
  assert.ok(s.roll > 0.3, `expected left bank roll=${s.roll}`);
  for (let i = 0; i < 90; i++) {
    integrateArcadeFlight(s, { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 }, 1 / 60);
  }
  // bank-induced turn should change heading (left = negative yaw in our world)
  assert.ok(Math.abs(s.yaw - yaw0) > 0.15, `expected turn, yaw0=${yaw0} yaw=${s.yaw}`);
});

import { unwrapAngle } from './math.js';
import { packSnapshotPlayers, unpackSnapshotPlayers } from './schema.js';
import { createAirborneState, createFlightState, integrateArcadeFlight } from './flight.js';

test('packed yaw wraps large angles', () => {
  const players = [
    {
      id: 1,
      x: 0,
      y: 50,
      z: 0,
      ya: 100, // huge
      pi: 0.1,
      ro: 0.2,
      th: 0.5,
      hp: 100,
      fl: 1,
    },
  ];
  const bin = packSnapshotPlayers(players);
  const back = unpackSnapshotPlayers(bin);
  assert.ok(Math.abs(back[0]!.ya) <= Math.PI + 0.05, `yaw ${back[0]!.ya}`);
});

test('hard ground contact sets onGround', () => {
  const s = createFlightState(0, 10, 0, 0);
  s.onGround = false;
  s.gearDown = false;
  s.speed = 80;
  s.pitch = -0.5;
  // dive into ground
  for (let i = 0; i < 120; i++) {
    integrateArcadeFlight(s, { pitch: -1, roll: 0, yaw: 0, throttleDelta: -1 }, 1 / 60);
    if (s.onGround) break;
  }
  assert.ok(s.onGround, 'expected onGround after ground contact');
  assert.ok(s.y <= 3, `y=${s.y}`);
});

test('unwrapAngle stable', () => {
  assert.ok(Math.abs(unwrapAngle(Math.PI * 3) - Math.PI) < 0.01 || Math.abs(unwrapAngle(Math.PI * 3) + Math.PI) < 0.01);
});

test('takeoff is gradual not instant teleport', () => {
  const s = createFlightState(0, 2, 0, 0);
  s.onGround = true;
  s.gearDown = true;
  s.throttle = 1;
  s.speed = 0;
  for (let i = 0; i < 180; i++) {
    integrateArcadeFlight(s, { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0 }, 1 / 60);
  }
  assert.ok(s.speed >= 32, `taxi speed too low: ${s.speed}`);
  const y0 = s.y;
  // Hold W: nose rotates then lifts — first frames still near ground
  let leftGroundAt = -1;
  const alts: number[] = [];
  for (let i = 0; i < 180; i++) {
    integrateArcadeFlight(s, { pitch: 1, roll: 0, yaw: 0, throttleDelta: 0 }, 1 / 60);
    alts.push(s.y);
    if (leftGroundAt < 0 && !s.onGround) leftGroundAt = i;
  }
  assert.ok(leftGroundAt >= 0, 'should eventually leave ground');
  assert.ok(leftGroundAt > 5, `lift-off too instant at frame ${leftGroundAt}`);
  // No single-frame +8m teleport at lift-off
  for (let i = 1; i < alts.length; i++) {
    assert.ok(alts[i]! - alts[i - 1]! < 4, `altitude jump ${alts[i]! - alts[i - 1]!} at ${i}`);
  }
  assert.ok(s.y > y0 + 8, `should climb over time, y0=${y0} y=${s.y}`);
});

test('throttle set 0-9 controls speed', () => {
  const s = createAirborneState(0, 100, 0, 0, 50, 0.5);
  for (let i = 0; i < 120; i++) {
    integrateArcadeFlight(s, { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, throttleSet: 0.3 }, 1 / 60);
  }
  assert.ok(s.throttle === 0.3 || Math.abs(s.throttle - 0.3) < 0.01);
  assert.ok(s.speed < 50, `speed should settle lower with thr 30%, got ${s.speed}`);
});
