import * as THREE from 'three';
import { quatFromYawPitchRoll } from '@flight-sim/shared';

const COLORS = [0x4f7cff, 0xff6b4a, 0x3dd68c, 0xf0c14e, 0xc77dff, 0xff9f1c, 0x2ec4b6, 0xe71d36];

export type PlaneVisual = THREE.Group & {
  userData: {
    gear: THREE.Group;
    body: THREE.Group;
  };
};

/**
 * Low-poly plane with nose +Z, wings ±X, up +Y, plus retractable-looking gear.
 */
export function createPlaneMesh(color = 0x4f7cff): PlaneVisual {
  const root = new THREE.Group() as PlaneVisual;
  const body = new THREE.Group();
  root.add(body);

  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.25,
    roughness: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1a2233,
    metalness: 0.45,
    roughness: 0.4,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x88c8ff,
    metalness: 0.1,
    roughness: 0.15,
    transparent: true,
    opacity: 0.75,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.9,
    metalness: 0.05,
  });
  const strutMat = new THREE.MeshStandardMaterial({
    color: 0x888890,
    metalness: 0.6,
    roughness: 0.35,
  });

  // Fuselage along +Z
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.7, 4.2, 8), bodyMat);
  fuselage.rotation.x = Math.PI / 2;
  fuselage.position.z = 0.2;
  body.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 8), bodyMat);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 2.7;
  body.add(nose);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.12, 1.4), bodyMat);
  wing.position.set(0, 0, 0.1);
  body.add(wing);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.8), bodyMat);
  tailWing.position.set(0, 0.15, -1.7);
  body.add(tailWing);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.9), bodyMat);
  fin.position.set(0, 0.7, -1.8);
  body.add(fin);

  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    glassMat,
  );
  canopy.position.set(0, 0.45, 0.6);
  canopy.scale.set(0.8, 0.7, 1.2);
  body.add(canopy);

  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.5, 8), darkMat);
  engine.rotation.x = Math.PI / 2;
  engine.position.z = -2.2;
  body.add(engine);

  const tipL = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.08, 0.4),
    new THREE.MeshStandardMaterial({ color: 0xff3344, roughness: 0.6 }),
  );
  tipL.position.set(-2.7, 0, 0.1);
  body.add(tipL);
  const tipR = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.08, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x33ff66, roughness: 0.6 }),
  );
  tipR.position.set(2.7, 0, 0.1);
  body.add(tipR);

  // ——— Landing gear (wheels) ———
  const gear = new THREE.Group();
  gear.name = 'landingGear';

  function makeWheel(x: number, z: number, strutLen = 1.1): THREE.Group {
    const g = new THREE.Group();
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, strutLen, 6), strutMat);
    strut.position.y = -strutLen * 0.45;
    g.add(strut);
    const tireY = -strutLen * 0.9;
    const tire = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.12, 6, 14), tireMat);
    tire.rotation.y = Math.PI / 2;
    tire.position.y = tireY;
    g.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 8), strutMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.y = tireY;
    g.add(hub);
    g.position.set(x, 0, z);
    return g;
  }

  // Main gear under wings + nose — hang below fuselage so tires touch runway
  gear.add(makeWheel(-1.15, 0.2, 1.15));
  gear.add(makeWheel(1.15, 0.2, 1.15));
  gear.add(makeWheel(0, 1.55, 1.0));

  root.add(gear);
  root.userData = { gear, body };

  return root;
}

export function setGearVisible(obj: THREE.Object3D, down: boolean): void {
  const gear = (obj as PlaneVisual).userData?.gear;
  if (gear) gear.visible = down;
}

export function colorForId(id: number): number {
  return COLORS[(Math.max(1, id) - 1) % COLORS.length]!;
}

export function applyPose(
  obj: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll: number,
  gearDown = true,
): void {
  obj.position.set(x, y, z);
  const q = quatFromYawPitchRoll(yaw, pitch, roll);
  obj.quaternion.set(q.x, q.y, q.z, q.w);
  setGearVisible(obj, gearDown);
}
