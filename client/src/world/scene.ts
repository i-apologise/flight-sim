import * as THREE from 'three';
import { MAP_HALF_EXTENT, forwardFromEuler } from '@flight-sim/shared';
import { addRunway } from './runway.js';

export function createWorld(): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5e8);
  scene.fog = new THREE.Fog(0x87b5e8, 400, 3500);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.5, 8000);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: false,
  });
  // Cap DPR for performance — looks fine, much cheaper on retina
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const hemi = new THREE.HemisphereLight(0xb1d0ff, 0x3a2a18, 1.05);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.15);
  sun.position.set(200, 400, 120);
  scene.add(sun);

  const groundGeo = new THREE.PlaneGeometry(MAP_HALF_EXTENT * 2, MAP_HALF_EXTENT * 2, 40, 40);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x2d5a34,
    roughness: 0.95,
    metalness: 0.02,
    flatShading: true,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  const grid = new THREE.GridHelper(MAP_HALF_EXTENT * 2, 80, 0x4a7a52, 0x35603c);
  grid.position.y = 0.2;
  scene.add(grid);

  const rockMat = new THREE.MeshStandardMaterial({ color: 0x5a6a5e, flatShading: true, roughness: 1 });
  for (let i = 0; i < 24; i++) {
    const h = 40 + Math.random() * 120;
    const m = new THREE.Mesh(new THREE.ConeGeometry(30 + Math.random() * 60, h, 5), rockMat);
    const ang = (i / 24) * Math.PI * 2;
    const r = 1800 + Math.random() * 1200;
    m.position.set(Math.cos(ang) * r, h / 2, Math.sin(ang) * r);
    scene.add(m);
  }

  const skyGeo = new THREE.SphereGeometry(5000, 16, 12);
  const skyMat = new THREE.MeshBasicMaterial({ color: 0x6aa8e8, side: THREE.BackSide, fog: false });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  addRunway(scene);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer };
}

/** Chase cam: sit behind the nose, look along flight path. */
export function updateCamera(
  camera: THREE.PerspectiveCamera,
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
  roll = 0,
  onGround = false,
): void {
  // On ground: ignore pitch for camera (stable chase) — fixes W-key shake while taxiing
  const camPitch = onGround ? 0 : pitch;
  const forward = forwardFromEuler(yaw, camPitch, onGround ? 0 : roll);
  const dist = onGround ? 22 : 20;
  const height = onGround ? 7 : 5.5;
  // Snappy camera — less lag behind the plane
  const smooth = onGround ? 0.28 : 0.28;

  const desired = new THREE.Vector3(
    x - forward.x * dist,
    y - forward.y * dist + height,
    z - forward.z * dist,
  );

  camera.position.lerp(desired, smooth);

  const look = new THREE.Vector3(
    x + forward.x * 24,
    y + (onGround ? 2 : forward.y * 24 + 1.5),
    z + forward.z * 24,
  );
  camera.lookAt(look);
}
