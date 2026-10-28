/* global window, document, URLSearchParams, performance, requestAnimationFrame */
// Standalone test harness for src/planet/Planet.js (see planet.html).
import * as THREE from 'three';
import { Planet } from '../src/planet/Planet.js';
import { getPlanetSpec } from '../src/physics/planets.js';

const params = new URLSearchParams(window.location.search);
const bodyName = (params.get('body') || 'earth').toLowerCase();
const view = params.get('view') || 'far';
const fov = Number(params.get('fov') || 50);

const SITES = {
  // Near Hilo, looking west towards Mauna Kea.
  earth: { lat: 19.62, lon: -155.20, targetLat: 19.8207, targetLon: -155.4681 },
  // Apollo 11 landing site region.
  moon: { lat: 0.67, lon: 23.20, targetLat: 0.67, targetLon: 23.60 },
};
const site = SITES[bodyName] || SITES.earth;
const ALTITUDE_ABOVE_TERRAIN = 2000;

const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(new THREE.AmbientLight(0xffffff, 0.35));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
// Sun roughly overhead the test site (set once the planet exists, below).
scene.add(sun);

const planetSpec = getPlanetSpec(bodyName);
const planet = new Planet(planetSpec, {
  renderer,
  showAtmosphere: bodyName === 'earth',
  locationInterests: view === 'near' ? [{ name: 'site', lat: site.lat, lon: site.lon, radiusKm: 60, lodBoost: 2 }] : [],
  surfaceDetail: bodyName === 'moon' ? { enabled: true } : undefined,
});

// Mimic the app: the planet lives in a (possibly transformed) planetCoordSys,
// and the camera lives in a cameraGroup that is offset (as in VR).
const planetCoordSys = new THREE.Group();
planetCoordSys.add(planet.surface, planet.atmosphere);
scene.add(planetCoordSys);

const cameraGroup = new THREE.Group();
cameraGroup.position.set(1234.5, -567.25, 890.125);
scene.add(cameraGroup);
const camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 1, 1e9);
cameraGroup.add(camera);

const _v = new THREE.Vector3();

function geodeticToWorld(latDeg, lonDeg, h, out = new THREE.Vector3()) {
  const { a, f = 0 } = planetSpec.ellipsoid;
  const e2 = 2 * f - f * f;
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  out.set((N + h) * Math.cos(lat) * Math.cos(lon), (N * (1 - e2) + h) * Math.sin(lat), -(N + h) * Math.cos(lat) * Math.sin(lon));
  planet.surface.updateWorldMatrix(true, false);
  return out.applyMatrix4(planet.surface.matrixWorld);
}

function upAt(latDeg, lonDeg, out = new THREE.Vector3()) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  out.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
  planet.surface.updateWorldMatrix(true, false);
  return out.transformDirection(planet.surface.matrixWorld);
}

// Morning sun: up at the site, tilted towards the east.
sun.position.copy(upAt(site.lat, site.lon)).add(upAt(site.lat, site.lon + 90).multiplyScalar(0.6)).multiplyScalar(1e8);

// Places the camera (world position) even though it sits in cameraGroup.
function setCameraWorld(worldPos, lookAtWorld, up) {
  cameraGroup.updateWorldMatrix(true, false);
  camera.position.copy(worldPos).sub(cameraGroup.position);
  camera.up.copy(up);
  camera.lookAt(lookAtWorld);
  camera.updateMatrixWorld();
}

let terrainUnderCamera = null;
let targetTerrain = null;
let freezeCamera = false;

function placeCamera() {
  if (freezeCamera) return;
  if (view === 'far') {
    const r = planetSpec.ellipsoid.a * 3.2;
    const dir = upAt(site.lat, site.lon);
    setCameraWorld(_v.copy(dir).multiplyScalar(r), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    return;
  }
  const s = planet.sampleTerrainHeight(site.lat, site.lon);
  if (s) terrainUnderCamera = s;
  const t = planet.sampleTerrainHeight(site.targetLat, site.targetLon);
  if (t) targetTerrain = t;
  const h = (terrainUnderCamera ? terrainUnderCamera.heightMeters : 0) + ALTITUDE_ABOVE_TERRAIN;
  const th = targetTerrain ? targetTerrain.heightMeters : 0;
  const pos = geodeticToWorld(site.lat, site.lon, h);
  setCameraWorld(pos, geodeticToWorld(site.targetLat, site.targetLon, th), upAt(site.lat, site.lon));
}

const hud = document.getElementById('hud');
let frames = 0;
function getStats() {
  const s = planet.getDebugStats();
  const camWorld = camera.getWorldPosition(new THREE.Vector3());
  return {
    body: bodyName,
    view,
    assets: planet.assetNames,
    frames,
    loadedTiles: s.loadedTiles,
    visibleTiles: s.visibleTiles,
    queue: s.queue,
    inflight: s.inflight,
    loadStarted: s.loadStarted,
    loadSucceeded: s.loadSucceeded,
    loadFailed: s.loadFailed,
    loadRetries: s.loadRetries,
    loadSuperseded: s.loadSuperseded,
    evictedTiles: s.evictedTiles,
    gpuMB: +(s.gpuBytes / 1048576).toFixed(1),
    maxVisibleLod: maxVisibleLod(),
    terrainUnderCamera: terrainUnderCamera && { h: +terrainUnderCamera.heightMeters.toFixed(1), lod: terrainUnderCamera.lod, tile: terrainUnderCamera.tileId },
    cameraDistanceFromCentre: Math.round(camWorld.length()),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
}

function maxVisibleLod() {
  let m = -1;
  for (const t of planet.lod.visibleList) m = Math.max(m, t.lod);
  return m;
}

function animate() {
  placeCamera();
  planet.update(camera);
  renderer.render(scene, camera);
  frames++;
  if (frames % 30 === 0) hud.textContent = JSON.stringify(getStats(), null, 1);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// ---------------------------------------------------------------------------
// Jitter test
// ---------------------------------------------------------------------------
// 1. CPU emulation of the GPU vertex transform in float32 for a vertex of the
//    nearest visible tile, with the real relative-to-centre data and with the
//    old absolute-coordinate layout, while the camera moves in 2 cm steps.
// 2. GPU: renders the real scene into a render target for each step (narrow
//    FOV so sub-metre errors span pixels) and measures the image change between
//    consecutive steps. A smooth camera move gives uniform small changes;
//    float32 quantisation gives a staircase (mostly-zero changes with spikes).
//    The same is repeated with an "absolute coordinates" copy of the visible
//    tiles to show the test detects jitter.

const f32 = Math.fround;

function projectF32(mvElements, projElements, p) {
  // gl_Position = P * (MV * vec4(p, 1)) with float32 arithmetic.
  const m = mvElements.map(f32);
  const P = projElements.map(f32);
  const x = f32(p[0]), y = f32(p[1]), z = f32(p[2]);
  const ex = f32(f32(f32(f32(m[0] * x) + f32(m[4] * y)) + f32(m[8] * z)) + m[12]);
  const ey = f32(f32(f32(f32(m[1] * x) + f32(m[5] * y)) + f32(m[9] * z)) + m[13]);
  const ez = f32(f32(f32(f32(m[2] * x) + f32(m[6] * y)) + f32(m[10] * z)) + m[14]);
  const cx = f32(f32(P[0] * ex) + f32(P[8] * ez));
  const cy = f32(f32(P[5] * ey) + f32(P[9] * ez));
  const cw = f32(P[11] * ez + P[15]);
  return [(cx / cw) * 0.5 * renderer.domElement.width, (cy / cw) * 0.5 * renderer.domElement.height];
}

function linearFitResidual(xs) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += xs[i]; sxx += i * i; sxy += i * xs[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  let maxRes = 0;
  for (let i = 0; i < n; i++) maxRes = Math.max(maxRes, Math.abs(xs[i] - (a + b * i)));
  return { slopePxPerStep: b, maxResidualPx: maxRes };
}

function nearestVisibleTile() {
  const camWorld = camera.getWorldPosition(new THREE.Vector3());
  let best = null, bestD = Infinity;
  for (const t of planet.lod.visibleList) {
    if (!t.mesh || !t.ready) continue;
    const d = t.mesh.getWorldPosition(new THREE.Vector3()).distanceTo(camWorld);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function makeAbsoluteCopy() {
  // Old layout: vertices in absolute planet coordinates (float32), mesh at the
  // planet origin.
  const group = new THREE.Group();
  group.rotation.copy(planet.surface.rotation);
  for (const t of planet.lod.visibleList) {
    if (!t.mesh) continue;
    const g = t.mesh.geometry.clone();
    const pos = g.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = pos[i] + t.center.x; pos[i + 1] = pos[i + 1] + t.center.y; pos[i + 2] = pos[i + 2] + t.center.z;
    }
    const mesh = new THREE.Mesh(g, t.mesh.material);
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}

function imageSeries(stepVec, steps, start, target, up, rt, buf, prev) {
  const diffs = [];
  for (let k = 0; k <= steps; k++) {
    setCameraWorld(_v.copy(start).addScaledVector(stepVec, k), _v2.copy(target).addScaledVector(stepVec, k), up);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
    renderer.setRenderTarget(null);
    if (k > 0) {
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) {
        sum += Math.abs(buf[i] - prev[i]) + Math.abs(buf[i + 1] - prev[i + 1]) + Math.abs(buf[i + 2] - prev[i + 2]);
      }
      diffs.push(sum / (buf.length / 4));
    }
    prev.set(buf);
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const nearZero = diffs.filter((d) => d < 0.25 * (diffs.reduce((s, d2) => s + d2, 0) / diffs.length)).length;
  return { median: +median.toFixed(3), max: +max.toFixed(3), maxOverMedian: +(max / Math.max(1e-9, median)).toFixed(2), nearZeroSteps: nearZero, steps: diffs.length, diffs: diffs.map((d) => +d.toFixed(3)) };
}
const _v2 = new THREE.Vector3();

async function runJitterTest({ stepMeters = 0.02, steps = 100, testFov = 3, pitchDown = 0.8 } = {}) {
  freezeCamera = true;
  const oldFov = camera.fov;
  camera.fov = testFov;
  camera.updateProjectionMatrix();

  const start = camera.getWorldPosition(new THREE.Vector3());
  const up = camera.up.clone();
  // Look ahead and down (pitchDown = tan of the depression angle) so nearby
  // terrain fills the view.
  const forward = camera.getWorldDirection(new THREE.Vector3());
  forward.addScaledVector(up, -forward.dot(up)).normalize().addScaledVector(up, -pitchDown).normalize();
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const stepVec = right.clone().multiplyScalar(stepMeters);

  // Aim at the terrain in front of the camera.
  const ray = new THREE.Raycaster(start, forward);
  const hits = planet.raycast(ray);
  const target = hits.length ? hits[0].point.clone() : start.clone().addScaledVector(forward, 3000);
  const targetDistance = hits.length ? hits[0].distance : null;

  // --- CPU float32 emulation --------------------------------------------
  setCameraWorld(start, target, up);
  const tile = nearestVisibleTile();
  const cpu = {};
  if (tile) {
    const posAttr = tile.mesh.geometry.attributes.position;
    // Vertex nearest the look-at point.
    const localTarget = tile.mesh.worldToLocal(target.clone());
    let bi = 0, bd = Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const d = _v.fromBufferAttribute(posAttr, i).distanceToSquared(localTarget);
      if (d < bd) { bd = d; bi = i; }
    }
    const rel = [posAttr.getX(bi), posAttr.getY(bi), posAttr.getZ(bi)];
    const abs = [f32(rel[0] + tile.center.x), f32(rel[1] + tile.center.y), f32(rel[2] + tile.center.z)];
    const rtcX = [], absX = [];
    const mv = new THREE.Matrix4();
    for (let k = 0; k <= steps; k++) {
      setCameraWorld(_v.copy(start).addScaledVector(stepVec, k), target, up);
      tile.mesh.updateWorldMatrix(true, false);
      mv.multiplyMatrices(camera.matrixWorldInverse, tile.mesh.matrixWorld);
      rtcX.push(projectF32(mv.elements, camera.projectionMatrix.elements, rel)[0]);
      mv.multiplyMatrices(camera.matrixWorldInverse, planet.surface.matrixWorld);
      absX.push(projectF32(mv.elements, camera.projectionMatrix.elements, abs)[0]);
    }
    cpu.tile = tile.id;
    cpu.vertexDistanceM = Math.round(tile.mesh.localToWorld(new THREE.Vector3(...rel)).distanceTo(start));
    cpu.relativeToCentre = linearFitResidual(rtcX);
    cpu.absoluteCoords = linearFitResidual(absX);
  }

  // --- GPU rendered frames ------------------------------------------------
  const rt = new THREE.WebGLRenderTarget(640, 360);
  const buf = new Uint8Array(640 * 360 * 4);
  const prev = new Uint8Array(buf.length);
  const aspect = camera.aspect;
  camera.aspect = 640 / 360;
  camera.updateProjectionMatrix();
  // Make sure everything is resident and compiled before measuring.
  setCameraWorld(start, target, up);
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);

  // Wireframe tile borders give sharp 1-px features, so sub-pixel motion shows.
  planet.setDebugMode('tileBorders');
  planet.lod._applyDebugColors();
  const gpuRtc = imageSeries(stepVec, steps, start, target, up, rt, buf, prev);
  const absGroup = makeAbsoluteCopy();
  planetCoordSys.add(absGroup);
  planet.surface.visible = false;
  renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(null);
  const gpuAbs = imageSeries(stepVec, steps, start, target, up, rt, buf, prev);
  planet.surface.visible = true;
  planetCoordSys.remove(absGroup);
  absGroup.traverse((o) => o.geometry?.dispose());
  rt.dispose();
  planet.setDebugMode('none');

  camera.aspect = aspect;
  camera.fov = oldFov;
  camera.updateProjectionMatrix();
  setCameraWorld(start, target, up);
  freezeCamera = false;
  return {
    stepMeters, steps, testFov, targetDistance: targetDistance && Math.round(targetDistance),
    cpu,
    gpuRelativeToCentre: gpuRtc,
    gpuAbsoluteCoords: gpuAbs,
  };
}

// Raycast sanity check: only visible tiles, sorted.
function raycastCheck() {
  const start = camera.getWorldPosition(new THREE.Vector3());
  const down = start.clone().normalize().negate();
  const hits = planet.raycast(new THREE.Raycaster(start, down));
  return {
    hits: hits.length,
    allVisible: hits.every((h) => h.object.visible),
    sorted: hits.every((h, i) => i === 0 || hits[i - 1].distance <= h.distance),
    nearestDistance: hits[0] ? +hits[0].distance.toFixed(2) : null,
  };
}

// Exercise the public setters (used by the eval smoke test).
function apiCheck() {
  const out = {};
  const before = planet.sampleTerrainHeight(site.lat, site.lon);
  planet.setDisplacementScale(2);
  const after = planet.sampleTerrainHeight(site.lat, site.lon);
  out.displacement = before && after ? { before: +before.heightMeters.toFixed(1), after: +after.heightMeters.toFixed(1) } : null;
  planet.setDisplacementScale(1);
  planet.setOpacity(0.5);
  out.opacityMaterials = planet.lod.visibleList.every((t) => t.material.transparent && !t.material.depthWrite && t.material.opacity === 0.5);
  planet.setOpacity(1);
  out.opaqueAgain = planet.lod.visibleList.every((t) => !t.material.transparent && t.material.depthWrite);
  planet.setDoubleSided(true);
  out.doubleSided = planet.lod.visibleList.every((t) => t.material.side === THREE.DoubleSide);
  planet.setDoubleSided(false);
  planet.setVisible(false);
  const started = planet.getDebugStats().loadStarted;
  planet.update(camera);
  out.hiddenNoStreaming = planet.getDebugStats().loadStarted === started && !planet.surface.visible;
  planet.setVisible(true);
  return out;
}

window.planetTest = { planet, camera, cameraGroup, renderer, scene, getStats, runJitterTest, raycastCheck, apiCheck, startedAt: performance.now() };
