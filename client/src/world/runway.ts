import * as THREE from 'three';
import { RUNWAY_HALF_LENGTH, RUNWAY_HALF_WIDTH, RUNWAY_SURFACE_Y } from '@flight-sim/shared';

/** Visual runway + lights at world origin (along +Z). */
export function addRunway(scene: THREE.Scene): void {
  const len = RUNWAY_HALF_LENGTH * 2;
  const wid = RUNWAY_HALF_WIDTH * 2;

  const asphalt = new THREE.Mesh(
    new THREE.BoxGeometry(wid, 0.4, len),
    new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.92, metalness: 0.05 }),
  );
  asphalt.position.set(0, RUNWAY_SURFACE_Y, 0);
  scene.add(asphalt);

  // Centerline dashes
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xf5f0c8 });
  for (let z = -RUNWAY_HALF_LENGTH + 20; z < RUNWAY_HALF_LENGTH - 10; z += 28) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 12), dashMat);
    dash.position.set(0, RUNWAY_SURFACE_Y + 0.25, z);
    scene.add(dash);
  }

  // Edge lines
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const x of [-RUNWAY_HALF_WIDTH + 1.5, RUNWAY_HALF_WIDTH - 1.5]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, len - 10), edgeMat);
    edge.position.set(x, RUNWAY_SURFACE_Y + 0.22, 0);
    scene.add(edge);
  }

  // Threshold bars both ends
  const threshMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const z of [-RUNWAY_HALF_LENGTH + 8, RUNWAY_HALF_LENGTH - 8]) {
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 10), threshMat);
      bar.position.set(i * 3.2, RUNWAY_SURFACE_Y + 0.24, z);
      scene.add(bar);
    }
  }

  // Approach lights
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xffee66 });
  for (let i = 1; i <= 8; i++) {
    const z = -RUNWAY_HALF_LENGTH - i * 18;
    for (const x of [-8, 0, 8]) {
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 6, 6), lightMat);
      bulb.position.set(x, 1.2, z);
      scene.add(bulb);
    }
  }

  // Control tower near runway
  const tower = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.BoxGeometry(8, 28, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.8 }),
  );
  shaft.position.y = 14;
  tower.add(shaft);
  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(14, 6, 14),
    new THREE.MeshStandardMaterial({ color: 0xb0c4d8, metalness: 0.3, roughness: 0.35 }),
  );
  cab.position.y = 31;
  tower.add(cab);
  tower.position.set(RUNWAY_HALF_WIDTH + 40, 0, -40);
  scene.add(tower);

  // Windsock pole
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.25, 12, 6),
    new THREE.MeshStandardMaterial({ color: 0xcccccc }),
  );
  pole.position.set(-RUNWAY_HALF_WIDTH - 25, 6, 0);
  scene.add(pole);
}
