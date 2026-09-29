import * as THREE from "three";
import { OrbitControls } from "../lib/OrbitControls.js";

const C = {
  cyan: 0x52ddd3,
  green: 0x49bd92,
  room: 0x42c9c2,
  selected: 0x73f2e5,
  equipment: 0x68aee3,
  warning: 0xf1b958,
};
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.72, ...extra });
const GROUND_Y = 0.16;

/* ------------------------------------------------------------------ *
 * 程序化贴图：立面、屋面、铺装
 * ------------------------------------------------------------------ */

function canvasTexture(width, height, draw, repeatX = 1, repeatY = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 4;
  return texture;
}

/** 一层高的立面贴片：下部实体墙裙 + 上部玻璃与竖向分格。 */
function facadeTile({ wall = "#93a7ad", glass = "#31505d", mullion = "#cfe0e2", lit = "#f2d79a", litChance = 0.16 }) {
  return canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);
    const sill = Math.round(h * 0.30);
    ctx.fillStyle = glass;
    ctx.fillRect(0, 0, w, h - sill);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let bay = 0; bay < 8; bay++) {
      const x = bay * 32;
      ctx.fillStyle = `rgba(190,225,235,${0.10 + rand() * 0.14})`;
      ctx.fillRect(x + 3, 12, 26, h - sill - 24);
      if (rand() < litChance) {
        ctx.fillStyle = lit;
        ctx.globalAlpha = 0.5 + rand() * 0.4;
        ctx.fillRect(x + 4, 14, 24, h - sill - 28);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = mullion;
      ctx.fillRect(x, 0, 3, h - sill);
    }
    ctx.fillStyle = mullion;
    ctx.fillRect(w - 3, 0, 3, h - sill);
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    ctx.fillRect(0, 0, w, 8);
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(0, h - sill, w, 3);
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(0, h - sill - 3, w, 3);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, 0, 3, h - sill);
  });
}

/** 浅灰金属屋面：直立锁边板 + 检修带。 */
function roofTile() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#c9d3d2";
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 10) {
      ctx.fillStyle = x % 20 === 0 ? "rgba(255,255,255,0.42)" : "rgba(120,140,144,0.24)";
      ctx.fillRect(x, 0, 2, h);
    }
    for (let y = 32; y < h; y += 64) {
      ctx.fillStyle = "rgba(120,140,144,0.20)";
      ctx.fillRect(0, y, w, 3);
    }
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(0, 0, w, h);
  });
}

function stoneTile() {
  return canvasTexture(256, 128, (ctx, w, h) => {
    ctx.fillStyle = "#b7c2c3";
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) {
      ctx.fillStyle = "rgba(120,138,142,0.30)";
      ctx.fillRect(x, 0, 2, h);
      ctx.fillStyle = "rgba(255,255,255,0.30)";
      ctx.fillRect(x + 2, 0, 1, h);
    }
    for (let y = 0; y < h; y += 32) {
      ctx.fillStyle = "rgba(120,138,142,0.22)";
      ctx.fillRect(0, y, w, 2);
    }
  });
}

function pavingTile(base = "#8f9c96", fleck = "rgba(255,255,255,0.35)") {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) {
      ctx.fillStyle = "rgba(70,86,84,0.22)";
      ctx.fillRect(x, 0, 1.5, h);
    }
    for (let y = 0; y < h; y += 32) {
      ctx.fillStyle = "rgba(70,86,84,0.22)";
      ctx.fillRect(0, y, w, 1.5);
    }
    ctx.fillStyle = fleck;
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 260; i++) ctx.fillRect((i * 37) % w, (i * 61) % h, 2, 2);
    ctx.globalAlpha = 1;
  });
}

/* ------------------------------------------------------------------ *
 * 几何工具：折线/曲线 → 带宽度的带状面
 * ------------------------------------------------------------------ */

function resample(points, step = 2.5) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[i + 1];
    const length = Math.hypot(x2 - x1, z2 - z1);
    const count = Math.max(1, Math.round(length / step));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      out.push([x1 + (x2 - x1) * t, z1 + (z2 - z1) * t]);
    }
  }
  const last = points[points.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

function curvePoints(points, closed = false) {
  if (points.length < 3) return resample(points);
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)), closed, "catmullrom", 0.4);
  return curve.getPoints(Math.max(24, points.length * 14)).map(point => [point.x, point.z]);
}

/** 由折线生成水平带状网格（含斜接），返回 BufferGeometry。 */
function ribbonGeometry(points, width, y) {
  const line = points;
  const half = width / 2;
  const positions = [];
  const normals = [];
  const uvs = [];
  const left = [];
  const right = [];
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const nx = -dz;
    const nz = dx;
    left.push([line[i][0] + nx * half, line[i][1] + nz * half]);
    right.push([line[i][0] - nx * half, line[i][1] - nz * half]);
  }
  let travelled = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const segment = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    const u0 = travelled / 4;
    const u1 = (travelled + segment) / 4;
    travelled += segment;
    const quad = [
      [left[i], 0], [right[i], 1], [right[i + 1], 1],
      [left[i], 0], [right[i + 1], 1], [left[i + 1], 0],
    ];
    const uu = [u0, u0, u1, u0, u1, u1];
    quad.forEach(([point, side], index) => {
      positions.push(point[0], y, point[1]);
      normals.push(0, 1, 0);
      uvs.push(uu[index], side);
    });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/** 由折线生成竖直带状网格（玻璃幕墙、栏板等）。 */
function verticalRibbonGeometry(points, y0, y1) {
  const positions = [];
  const normals = [];
  const uvs = [];
  let travelled = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[i + 1];
    const segment = Math.hypot(x2 - x1, z2 - z1);
    let nx = -(z2 - z1) / (segment || 1);
    let nz = (x2 - x1) / (segment || 1);
    const u0 = travelled / 4;
    const u1 = (travelled + segment) / 4;
    travelled += segment;
    const quad = [
      [[x1, z1], y0, u0, 0], [[x2, z2], y0, u1, 0], [[x2, z2], y1, u1, 1],
      [[x1, z1], y0, u0, 0], [[x2, z2], y1, u1, 1], [[x1, z1], y1, u0, 1],
    ];
    for (const [point, y, u, v] of quad) {
      positions.push(point[0], y, point[1]);
      normals.push(nx, 0, nz);
      uvs.push(u, v);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/* ------------------------------------------------------------------ */

export class TwinScene {
  constructor(host, store, onSelect) {
    this.host = host;
    this.selectionMarker = host.parentElement?.querySelector("#selection-marker");
    this.store = store;
    this.onSelect = onSelect;
    this.clickable = [];
    this.state = store.state;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x061722);
    this.scene.fog = null;
    this.flowTextures = [];
    this.scanBand = null;
    this.deviceHalo = null;
    this.patrolRoot = null;
    this.patrolDistance = null;
    this.patrolSpeed = 1.5;
    this.textures = [];
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.34;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute("aria-label", "可交互的园区和楼层示意模型");
    host.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 4000);
    this.camera.position.set(148, 180, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 900;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.worldRoot = new THREE.Group();
    this.root = this.worldRoot;
    this.scene.add(this.worldRoot);
    this.qualityTier = null;
    this.qualitySample = { frames: 0, started: performance.now(), lowSince: 0, highSince: 0 };
    this.setQualityTier((navigator.hardwareConcurrency ?? 8) <= 4 || (navigator.deviceMemory ?? 8) <= 4 ? "low" : "medium");
    this.addLights();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.pointerDown = null;
    this.renderer.domElement.addEventListener("pointerdown", event => this.handlePointerDown(event));
    this.renderer.domElement.addEventListener("pointerup", event => this.handlePointerUp(event));
    this.renderer.domElement.addEventListener("pointercancel", () => { this.pointerDown = null; });
    this.renderer.domElement.addEventListener("pointerleave", () => { if (this.pointerDown) this.pointerDown.cancelled = true; });
    this.resize();
    this.unsubscribe = () => store.removeEventListener("change", this.handleChange);
    this.handleChange = event => {
      const previous = this.state;
      this.state = event.detail;
      const markers = alerts => alerts.filter(alert => alert.level !== "info").map(alert => alert.twinId).sort().join("|");
      const alertMarkersChanged = this.state.layers.alerts && markers(previous.alerts ?? []) !== markers(this.state.alerts ?? []);
      const geometryChanged = previous.floorplan !== this.state.floorplan || previous.campusLayout !== this.state.campusLayout || previous.layers !== this.state.layers || alertMarkersChanged;
      if (geometryChanged) {
        this.rebuild(false);
        return;
      }
      if (previous.activeRoomId !== this.state.activeRoomId) this.buildRoomFocus();
      if (previous.activeDeviceId !== this.state.activeDeviceId && this.state.activeDeviceId) this.buildDeviceFocus();
      if (previous.selected !== this.state.selected) this.updateRoomHighlight();
      if (previous.view !== this.state.view || previous.mode !== this.state.mode || previous.activeRoomId !== this.state.activeRoomId || previous.activeDeviceId !== this.state.activeDeviceId) {
        this.transitionToView(previous.view, this.state.view);
      }
    };
    store.addEventListener("change", this.handleChange);
    this.rebuild();
    this.animate();
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight(0xd2f0f2, 0x1d3a33, 2.4));
    const key = new THREE.DirectionalLight(0xfff4e2, 3.5);
    key.position.set(-210, 330, 250);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -340;
    key.shadow.camera.right = 340;
    key.shadow.camera.top = 340;
    key.shadow.camera.bottom = -340;
    key.shadow.camera.far = 1100;
    this.scene.add(key);
    this.keyLight = key;
    this.setQualityTier(this.qualityTier ?? "medium");
    const rim = new THREE.DirectionalLight(0x3d90ad, 1.5);
    rim.position.set(260, 160, -230);
    this.scene.add(rim);
    const bounce = new THREE.DirectionalLight(0x2f6f66, 0.7);
    bounce.position.set(60, -120, -60);
    this.scene.add(bounce);
  }

  addBox(parent, size, position, material, cast = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(position[0] - (parent.userData.originX ?? 0), position[1], position[2] - (parent.userData.originZ ?? 0));
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  disposeChildren(group) {
    if (!group) return;
    for (const object of [...group.children]) {
      group.remove(object);
      object.traverse(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(material => material.dispose?.());
        else child.material?.dispose?.();
      });
    }
  }

  clearScene() {
    this.finishTransition();
    this.patrolRoot = null;
    this.patrolPath = null;
    this.patrolRouteLine = null;
    for (const texture of [...this.flowTextures, ...this.textures]) texture.dispose?.();
    this.disposeChildren(this.worldRoot);
    this.root = this.worldRoot;
    this.clickable = [];
    this.flowTextures = [];
    this.textures = [];
    this.scanBand = null;
    this.facadeTemplates = null;
    this.roofTexture = null;
    this.stoneTexture = null;
    this.pavingTexture = null;
    this.roomFloorMeshes = new Map();
    this.floorSlabs = [];
    this._treeGroup = null;
  }

  mountGroup(group, build) {
    const previous = this.root;
    this.root = group;
    try { build(); } finally { this.root = previous; }
  }

  rebuild(resetCamera = true) {
    const oldPosition = this.camera.position.clone();
    const oldTarget = this.controls.target.clone();
    this.clearScene();
    if (!this.state.floorplan || !this.state.campusLayout) return;
    this.campusRoot = new THREE.Group();
    this.floorRoot = new THREE.Group();
    this.roomRoot = new THREE.Group();
    this.deviceRoot = new THREE.Group();
    this.slabRoot = new THREE.Group();
    this.markerRoot = new THREE.Group();
    this.worldRoot.add(this.campusRoot, this.slabRoot, this.floorRoot, this.roomRoot, this.deviceRoot, this.markerRoot);
    this.buildingGroups = new Map();
    this.mountGroup(this.campusRoot, () => this.buildCampus());
    this.mountGroup(this.floorRoot, () => this.buildFloor());
    const row = this.buildingRow();
    if (row) {
      this.mountGroup(this.markerRoot, () => this.addFloorBadges(row.floors * (row.floorHeight ?? 3.6), row.position[0], row.position[1], row.floors, row.footprint[0]));
      this.buildFloorSlabs(row);
    }
    this.buildRoomFocus();
    this.buildDeviceFocus();
    this.updateRoomHighlight();
    this.setPoseImmediate(this.state.view);
    const frame = this.cameraFrame(this.state.view);
    if (resetCamera) {
      this.camera.position.copy(frame.position);
      this.controls.target.copy(frame.target);
    } else {
      this.camera.position.copy(oldPosition);
      this.controls.target.copy(oldTarget);
    }
    this.controls.update();
  }

  buildingRow() {
    return this.state.campusLayout?.buildings.find(row => row.id === "building-06");
  }

  buildFloorSlabs(row) {
    const [x, z] = row.position;
    const [w, d] = row.footprint;
    const step = row.floorHeight ?? 3.6;
    for (let index = 0; index < row.floors; index++) {
      const selected = index === 6;
      const material = new THREE.MeshStandardMaterial({ color: selected ? 0x70e7dc : 0x96b8bd, emissive: selected ? 0x1d746f : 0x17343d, emissiveIntensity: selected ? 0.4 : 0.1, transparent: true, opacity: selected ? 0.32 : 0.07, depthWrite: false, side: THREE.DoubleSide });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 2, 0.38, d + 2), material);
      slab.position.set(x, GROUND_Y + 3.4 + (index + 0.5) * step, z);
      slab.userData.floorIndex = index;
      slab.userData.kind = "background-building";
      this.slabRoot.add(slab);
      this.floorSlabs.push(slab);
      this.clickable.push(slab);
    }
  }

  buildRoomFocus() {
    if (!this.roomRoot || !this.state.floorplan) return;
    this.clickable = this.clickable.filter(object => !object.userData.focusDevice && !object.userData.roomFocusHit);
    this.disposeChildren(this.roomRoot);
    if (!this.state.activeRoomId) return;
    this.mountGroup(this.roomRoot, () => this.buildRoomView());
  }

  buildDeviceFocus() {
    if (!this.deviceRoot || !this.state.floorplan) return;
    this.clickable = this.clickable.filter(object => !object.userData.deviceFocusHit);
    this.disposeChildren(this.deviceRoot);
    if (!this.state.activeDeviceId) return;
    this.mountGroup(this.deviceRoot, () => this.buildDeviceView());
  }

  updateRoomHighlight() {
    if (!this.roomFloorMeshes) return;
    for (const [id, mesh] of this.roomFloorMeshes) {
      const selected = this.state.selected.kind === "room" && this.state.selected.id === id;
      if (this.state.layers.heat) continue;
      const color = selected ? 0x73f2e5 : mesh.userData.floorColor ?? (mesh.userData.enclosed ? 0x5297aa : 0x42798f);
      mesh.material.color.setHex(color);
      mesh.material.emissive.setHex(color);
    }
  }

  setQualityTier(tier) {
    const levels = { low: { pixelRatio: 1, shadows: false, shadowSize: 512 }, medium: { pixelRatio: 1.5, shadows: true, shadowSize: 1024 }, high: { pixelRatio: 2, shadows: true, shadowSize: 2048 } };
    const profile = levels[tier] ?? levels.medium;
    this.qualityTier = tier;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, profile.pixelRatio));
    this.renderer.shadowMap.enabled = profile.shadows;
    if (this.keyLight) {
      this.keyLight.castShadow = profile.shadows;
      this.keyLight.shadow.mapSize.set(profile.shadowSize, profile.shadowSize);
      this.keyLight.shadow.map?.dispose?.();
      this.keyLight.shadow.map = null;
    }
    this.resize();
  }

  sampleQuality(now) {
    const sample = this.qualitySample;
    sample.frames++;
    const elapsed = now - sample.started;
    if (elapsed < 5000) return;
    const fps = sample.frames * 1000 / elapsed;
    sample.frames = 0;
    sample.started = now;
    const tiers = ["low", "medium", "high"];
    const index = tiers.indexOf(this.qualityTier);
    if (fps < 25 && index > 0) this.setQualityTier(tiers[index - 1]);
    else if (fps > 56 && index < 2) {
      sample.highSince += elapsed;
      if (sample.highSince >= 30000) { this.setQualityTier(tiers[index + 1]); sample.highSince = 0; }
    } else sample.highSince = 0;
  }

  scenePose() {
    // 7 楼以用户俯视图为准；镜头位于负 z 一侧时，展示层需反转 x 才能保持办公室在左。
    const row = this.buildingRow();
    const [x, z] = row?.position ?? [0, 0];
    const height = row?.floorHeight ?? 3.6;
    const floorRest = new THREE.Vector3(x, GROUND_Y + 3.4 + 6.5 * height, z);
    const floorFocus = new THREE.Vector3(x + 60, 27, z + 22);
    const floorBackground = new THREE.Vector3(x + 48, 25, z + 75);
    const roomFocus = new THREE.Vector3(x + 75, 36, z + 43);
    const roomBackground = new THREE.Vector3(x + 75, 34, z + 81);
    const deviceFocus = new THREE.Vector3(x + 97, 42, z + 58);
    const device = this.state.floorplan?.equipments.find(item => item.id === this.state.activeDeviceId);
    const room = this.state.floorplan?.rooms.find(item => item.id === (this.state.activeRoomId ?? device?.roomId));
    const bounds = room ? this.roomBounds(room) : null;
    const width = this.state.floorplan?.bounds.width / 1000 || 28.4;
    const depth = this.state.floorplan?.bounds.depth / 1000 || 38;
    const roomLocal = bounds ? new THREE.Vector3((bounds.minX + bounds.maxX) / 2 - width / 2, 0.4, depth / 2 - (bounds.minY + bounds.maxY) / 2) : new THREE.Vector3();
    const roomOrigin = floorFocus.clone().add(new THREE.Vector3(-roomLocal.x, roomLocal.y, roomLocal.z));
    const roomSpan = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 12;
    const roomScale = THREE.MathUtils.clamp(18 / roomSpan, 1, 2.2);
    const deviceLocal = device ? new THREE.Vector3(device.position[0] / 1000 - width / 2, 0.8, depth / 2 - device.position[1] / 1000) : new THREE.Vector3();
    const deviceFloorOrigin = floorFocus.clone().add(new THREE.Vector3(-deviceLocal.x, deviceLocal.y, deviceLocal.z));
    const roomCenterX = bounds ? (bounds.minX + bounds.maxX) / 2 : width / 2;
    const roomCenterY = bounds ? (bounds.minY + bounds.maxY) / 2 : depth / 2;
    const deviceRoomOrigin = roomFocus.clone().add(device ? new THREE.Vector3(-(device.position[0] / 1000 - roomCenterX) * roomScale, 0.8, (roomCenterY - device.position[1] / 1000) * roomScale) : new THREE.Vector3());
    return { row, x, z, floorRest, floorFocus, floorBackground, roomFocus, roomBackground, roomOrigin, roomSpan, roomScale, deviceFocus, deviceFloorOrigin, deviceRoomOrigin };
  }

  slabPosition(index, exploded, pose) {
    const floorStep = pose.row?.floorHeight ?? 3.6;
    if (!exploded) return new THREE.Vector3(pose.x, GROUND_Y + 3.4 + (index + 0.5) * floorStep, pose.z);
    return new THREE.Vector3(pose.x + 25, GROUND_Y + 5 + index * 4.7, pose.z + 65);
  }

  setPoseImmediate(view) {
    const pose = this.scenePose();
    const expanded = view === "floor" || view === "room" || view === "device";
    this.campusRoot.visible = !expanded;
    this.markerRoot.visible = view === "building";
    if (this.buildingGroups.has("building-06")) this.buildingGroups.get("building-06").visible = !expanded;
    this.slabRoot.visible = view === "floor";
    this.floorRoot.visible = view === "floor" || view === "room";
    this.roomRoot.visible = view === "room" || view === "device";
    this.deviceRoot.visible = view === "device";
    this.floorRoot.position.copy(view === "room" ? pose.floorBackground : view === "floor" ? pose.floorFocus : pose.floorRest);
    const floorScale = view === "room" ? 0.38 : view === "floor" ? 1 : 0.55;
    this.floorRoot.scale.set(-floorScale, floorScale, floorScale);
    this.roomRoot.position.copy(view === "device" ? pose.roomBackground : view === "room" ? pose.roomFocus : pose.roomOrigin);
    const roomScale = view === "device" ? Math.min(1, pose.roomScale * 0.55) : view === "room" ? pose.roomScale : 0.55;
    this.roomRoot.scale.set(-roomScale, roomScale, roomScale);
    this.deviceRoot.position.copy(view === "device" ? pose.deviceFocus : pose.deviceRoomOrigin);
    this.deviceRoot.scale.setScalar(view === "device" ? 1.5 : 0.25);
    this.floorSlabs.forEach((slab, index) => { slab.position.copy(this.slabPosition(index, expanded, pose)); slab.scale.setScalar(view === "floor" ? 0.45 : expanded ? 0.3 : 1); });
  }

  cameraFrame(view) {
    const pose = this.scenePose();
    const mode2d = this.state.mode === "2d";
    let target, position, fov, minDistance, maxDistance;
    if (view === "site") {
      const { width, depth } = this.state.campusLayout?.bounds ?? { width: 400, depth: 400 };
      const [cx, cz] = this.state.campusLayout?.bounds?.center ?? [0, 0];
      const span = Math.max(width, depth);
      target = new THREE.Vector3(cx, 6, cz);
      position = mode2d ? new THREE.Vector3(cx, span * 1.45, cz + span * 0.045) : new THREE.Vector3(cx + span * 0.4, span * 0.44, cz + span * 0.48);
      fov = 40; minDistance = 4; maxDistance = span * 2.4;
    } else if (view === "building") {
      const height = (pose.row?.floors ?? 8) * (pose.row?.floorHeight ?? 3.6);
      const span = Math.max(pose.row?.footprint?.[0] ?? 58, height);
      target = new THREE.Vector3(pose.x, height * 0.55, pose.z);
      position = mode2d ? new THREE.Vector3(pose.x, span * 2.45, pose.z + span * 0.1) : new THREE.Vector3(pose.x + span * 0.82, height + span * 0.72, pose.z + span * 1.5);
      fov = 40; minDistance = 4; maxDistance = span * 5.5;
    } else if (view === "floor") {
      target = pose.floorFocus.clone();
      position = mode2d ? target.clone().add(new THREE.Vector3(0, 62, -2)) : target.clone().add(new THREE.Vector3(-2, 40, -40));
      fov = mode2d ? 36 : 43; minDistance = 14; maxDistance = 180;
    } else if (view === "room") {
      target = pose.roomFocus.clone().add(new THREE.Vector3(-5, 0, -3));
      position = mode2d ? target.clone().add(new THREE.Vector3(0, Math.max(36, pose.roomSpan * 1.7), -1.5)) : target.clone().add(new THREE.Vector3(-3, Math.max(30, pose.roomSpan * 1.35), -Math.max(33, pose.roomSpan * 1.4)));
      fov = 43; minDistance = 4; maxDistance = 150;
    } else {
      target = pose.deviceFocus.clone().add(new THREE.Vector3(-3, 1, -1));
      position = mode2d ? target.clone().add(new THREE.Vector3(0, 35, -1.5)) : target.clone().add(new THREE.Vector3(-2, 27, -31));
      fov = 42; minDistance = 5; maxDistance = 130;
    }
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = minDistance;
    this.controls.maxDistance = maxDistance;
    this.controls.maxPolarAngle = mode2d ? 0.14 : Math.PI * 0.49;
    return { target, position };
  }

  finishTransition() {
    this.transition = null;
    if (this.controls) this.controls.enabled = true;
  }

  transitionToView(previousView, nextView) {
    if (!this.floorRoot || !this.state.campusLayout) return;
    this.finishTransition();
    const pose = this.scenePose();
    const expanded = ["floor", "room", "device"].includes(nextView);
    const wasExpanded = ["floor", "room", "device"].includes(previousView);
    const duration = nextView === "device" || previousView === "device" ? 720 : nextView === "room" || previousView === "room" ? 650 : nextView === "floor" || previousView === "floor" ? 900 : previousView !== nextView ? 700 : 480;
    this.campusRoot.visible = !expanded || !wasExpanded;
    this.markerRoot.visible = nextView === "building";
    if (this.buildingGroups.has("building-06")) this.buildingGroups.get("building-06").visible = !expanded || !wasExpanded;
    if (expanded) {
      this.floorRoot.visible = nextView === "floor" || nextView === "room";
      this.slabRoot.visible = nextView === "floor";
      if (!wasExpanded) {
        this.floorRoot.position.copy(pose.floorRest);
        this.floorRoot.scale.set(-0.55, 0.55, 0.55);
        this.floorSlabs.forEach((slab, index) => slab.position.copy(this.slabPosition(index, false, pose)));
      }
    }
    if (["room", "device"].includes(nextView) || ["room", "device"].includes(previousView)) {
      this.roomRoot.visible = true;
      if (!["room", "device"].includes(previousView)) {
        this.roomRoot.position.copy(pose.roomOrigin);
        this.roomRoot.scale.set(-0.55, 0.55, 0.55);
      }
    }
    if (nextView === "device" || previousView === "device") {
      this.deviceRoot.visible = true;
      if (previousView !== "device") {
        this.deviceRoot.position.copy(previousView === "room" ? pose.deviceRoomOrigin : pose.deviceFloorOrigin);
        this.deviceRoot.scale.setScalar(0.25);
      }
    }
    const track = (object, position, scale, delay = 0) => ({ object, startPosition: object.position.clone(), endPosition: position.clone(), startScale: object.scale.clone(), endScale: new THREE.Vector3(object === this.floorRoot || object === this.roomRoot ? -scale : scale, scale, scale), delay });
    const floorPosition = nextView === "room" ? pose.floorBackground : nextView === "floor" ? pose.floorFocus : pose.floorRest;
    const floorScale = nextView === "room" ? 0.38 : nextView === "floor" ? 1 : 0.55;
    const tracks = [track(this.floorRoot, floorPosition, floorScale, nextView === "floor" && !wasExpanded ? 180 : 0)];
    if (["room", "device"].includes(nextView) || ["room", "device"].includes(previousView)) tracks.push(track(this.roomRoot, nextView === "device" ? pose.roomBackground : nextView === "room" ? pose.roomFocus : pose.roomOrigin, nextView === "device" ? Math.min(1, pose.roomScale * 0.55) : nextView === "room" ? pose.roomScale : 0.55));
    if (nextView === "device" || previousView === "device") tracks.push(track(this.deviceRoot, nextView === "device" ? pose.deviceFocus : nextView === "room" ? pose.deviceRoomOrigin : pose.deviceFloorOrigin, nextView === "device" ? 1.5 : 0.25));
    this.floorSlabs.forEach((slab, index) => tracks.push(track(slab, this.slabPosition(index, expanded, pose), nextView === "floor" ? 0.45 : expanded ? 0.3 : 1)));
    const frame = this.cameraFrame(nextView);
    this.transition = { started: performance.now(), duration, tracks, startCamera: this.camera.position.clone(), endCamera: frame.position, startTarget: this.controls.target.clone(), endTarget: frame.target, endView: nextView, hideBuildingAt: expanded && !wasExpanded ? 220 : null };
    this.controls.enabled = false;
  }

  advanceTransition(now) {
    const animation = this.transition;
    if (!animation) return;
    const elapsed = now - animation.started;
    if (animation.hideBuildingAt !== null && elapsed >= animation.hideBuildingAt) {
      const building = this.buildingGroups.get("building-06");
      if (building) building.visible = false;
      this.campusRoot.visible = false;
      animation.hideBuildingAt = null;
    }
    const ease = value => value * value * (3 - 2 * value);
    const cameraT = ease(THREE.MathUtils.clamp(elapsed / animation.duration, 0, 1));
    this.camera.position.lerpVectors(animation.startCamera, animation.endCamera, cameraT);
    this.controls.target.lerpVectors(animation.startTarget, animation.endTarget, cameraT);
    for (const item of animation.tracks) {
      const fraction = ease(THREE.MathUtils.clamp((elapsed - item.delay) / Math.max(1, animation.duration - item.delay), 0, 1));
      item.object.position.lerpVectors(item.startPosition, item.endPosition, fraction);
      item.object.scale.lerpVectors(item.startScale, item.endScale, fraction);
    }
    if (elapsed >= animation.duration) {
      this.floorRoot.visible = animation.endView === "floor" || animation.endView === "room";
      this.slabRoot.visible = animation.endView === "floor";
      this.roomRoot.visible = animation.endView === "room" || animation.endView === "device";
      this.deviceRoot.visible = animation.endView === "device";
      if (!this.state.activeDeviceId && animation.endView !== "device") this.buildDeviceFocus();
      this.finishTransition();
    }
  }

  buildingPosition(id = "building-06") {
    const row = this.state.campusLayout?.buildings.find(item => item.id === id);
    return row?.position ?? this.state.site?.buildings?.[0]?.centerOffsetMeters ?? [0, 0];
  }

  /* ---------------------------------------------------------------- *
   * 园区场景
   * ---------------------------------------------------------------- */

  buildCampus() {
    const layout = this.state.campusLayout;
    if (!layout) return;
    const { width, depth } = layout.bounds;
    const [cx, cz] = layout.bounds.center ?? [0, 0];

    const ground = this.addBox(this.root, [width + 260, 2, depth + 260], [cx, -1.0, cz], mat(0x13252a), false);
    ground.receiveShadow = true;
    const campus = this.addBox(this.root, [width, 0.42, depth], [cx, -0.05, cz], mat(0x3a4a44, { roughness: 0.95 }), false);
    campus.receiveShadow = true;
    const apron = new THREE.Mesh(ribbonGeometry([[cx - width / 2, cz - depth / 2], [cx + width / 2, cz - depth / 2], [cx + width / 2, cz + depth / 2], [cx - width / 2, cz + depth / 2], [cx - width / 2, cz - depth / 2]], 0.6, GROUND_Y - 0.02), new THREE.MeshBasicMaterial({ color: 0x3f6f68, transparent: true, opacity: 0.5 }));
    this.root.add(apron);

    for (const body of layout.water ?? []) this.buildWater(body);
    for (const block of layout.surroundings ?? []) this.buildContextBlock(block);
    for (const patch of layout.landscape ?? []) this.buildLandscape(patch);
    for (const lot of layout.parking ?? []) this.buildParking(lot);
    for (const road of layout.roads ?? []) this.buildRoad(road);
    for (const path of layout.paths ?? []) this.buildWalkPath(path);
    for (const walk of layout.walkways ?? []) this.buildWalkway(walk);

    for (const row of layout.buildings) this.buildCampusBuilding(row, row.id === "building-06");
    this.addTrees();
    this.addCompass();
  }

  buildPatrolRobot() {
    const path = this.state.floorplan?.patrolRoute;
    if (!path?.points || path.points.length < 3) return;
    const width = this.state.floorplan.bounds.width / 1000;
    const depth = this.state.floorplan.bounds.depth / 1000;
    const points = path.points.map(([x, y]) => {
      const [localX, localZ] = this.floorPosition(x, y, width, depth);
      return new THREE.Vector3(localX, 0.13, localZ);
    });
    if (points[0].distanceTo(points.at(-1)) > 0.01) points.push(points[0].clone());
    const lengths = [];
    let total = 0;
    for (let index = 0; index < points.length - 1; index++) {
      const length = points[index].distanceTo(points[index + 1]);
      lengths.push(length);
      total += length;
    }
    this.patrolPath = { points, lengths, total };
    this.patrolSpeed = path.speedMps ?? 1.5;
    if (this.patrolDistance === null) this.patrolDistance = total * 0.25;
    this.patrolDistance %= total;

    const routeLine = new THREE.Mesh(
      ribbonGeometry(points.map(point => [point.x, point.z]), 0.12, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x6ef0cf, transparent: true, opacity: 0.58, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.patrolRouteLine = routeLine;
    this.root.add(routeLine);

    const robot = new THREE.Group();
    robot.name = "robot-01-patrol";
    robot.userData.patrolRobot = true;
    robot.scale.setScalar(0.43);
    const body = mat(0x183542, { metalness: 0.52, roughness: 0.38 });
    const armor = mat(0x56c9c4, { metalness: 0.38, roughness: 0.34, emissive: 0x0b3536, emissiveIntensity: 0.32 });
    const glass = mat(0x071b25, { metalness: 0.34, roughness: 0.2, emissive: 0x174e58, emissiveIntensity: 0.4 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x9bfff0, emissive: 0x2bcbb9, emissiveIntensity: 1.3, roughness: 0.24 });
    const wheel = mat(0x0b151c, { metalness: 0.25, roughness: 0.72 });
    this.addBox(robot, [1.85, 0.46, 2.7], [0, 0.42, 0], body);
    this.addBox(robot, [1.62, 0.5, 2.25], [0, 0.82, -0.05], armor);
    this.addBox(robot, [1.2, 0.34, 0.08], [0, 0.8, 1.1], glass, false);
    for (const x of [-0.36, 0.36]) {
      const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 10), lamp);
      sensor.position.set(x, 0.82, 1.17);
      robot.add(sensor);
    }
    for (const x of [-0.97, 0.97]) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.17, 18), wheel);
      roller.rotation.z = Math.PI / 2;
      roller.position.set(x, 0.36, 0);
      robot.add(roller);
    }
    const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.17, 20), body);
    lidar.position.set(0, 1.17, -0.2);
    robot.add(lidar);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 12), lamp);
    beacon.position.set(0, 1.34, -0.2);
    robot.add(beacon);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(2.4, 14, 12), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.y = 0.75;
    hit.userData = { kind: "patrol-robot", id: "robot-01", title: "楼层巡逻机器人", subtitle: "7楼中央通道 · robot-01" };
    robot.add(hit);
    this.clickable.push(hit);
    this.patrolRoot = robot;
    this.root.add(robot);
    this.updatePatrolRobot(0);
  }

  updatePatrolRobot(deltaSeconds) {
    const route = this.patrolPath;
    const robot = this.patrolRoot;
    if (!route || !robot) return;
    robot.visible = this.state.view === "floor" && this.state.layers.equipment;
    if (this.patrolRouteLine) this.patrolRouteLine.visible = robot.visible;
    if (!this.state.patrolPaused) this.patrolDistance = (this.patrolDistance + this.patrolSpeed * deltaSeconds) % route.total;
    let distance = this.patrolDistance;
    for (let index = 0; index < route.lengths.length; index++) {
      const length = route.lengths[index];
      if (distance <= length || index === route.lengths.length - 1) {
        const from = route.points[index], to = route.points[index + 1];
        const fraction = THREE.MathUtils.clamp(distance / length, 0, 1);
        robot.position.set(THREE.MathUtils.lerp(from.x, to.x, fraction), 0.13, THREE.MathUtils.lerp(from.z, to.z, fraction));
        robot.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
        break;
      }
      distance -= length;
    }
  }

  updateSelectionMarker() {
    const marker = this.selectionMarker;
    if (!marker) return;
    const selected = this.state.selected;
    let point;
    let title;
    let subtitle;
    if (selected.kind === "patrol-robot" && this.state.view === "floor" && this.patrolRoot?.visible) {
      point = this.patrolRoot.getWorldPosition(new THREE.Vector3());
      point.y += 1.6;
      title = "ROBOT-01";
      subtitle = "7楼巡检";
    } else if (selected.kind === "equipment" && this.state.view === "device" && this.deviceRoot?.visible && selected.id === this.state.activeDeviceId) {
      const device = this.state.floorplan?.equipments.find(item => item.id === selected.id);
      if (device) {
        const heights = { "robot-arm": 7, "humanoid-robot": 5.3, sensor: 5.5, hvac: 4.5, "paper-printer": 2.7 };
        point = this.deviceRoot.getWorldPosition(new THREE.Vector3());
        point.y += (heights[device.category] ?? 4.2) * this.deviceRoot.scale.y + 0.7;
        title = device.label;
        subtitle = device.id.toUpperCase();
      }
    }
    if (!point) {
      marker.hidden = true;
      return;
    }
    const markerKey = `${title}|${subtitle}`;
    if (this.selectionMarkerKey !== markerKey) {
      marker.querySelector("b").textContent = title;
      marker.querySelector("small").textContent = subtitle;
      this.selectionMarkerKey = markerKey;
    }
    this.camera.updateMatrixWorld();
    point.project(this.camera);
    if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 1.05 || Math.abs(point.y) > 1.05) {
      marker.hidden = true;
      return;
    }
    const frame = this.host.parentElement.getBoundingClientRect();
    marker.hidden = false;
    marker.style.left = `${(point.x + 1) * 0.5 * frame.width}px`;
    marker.style.top = `${(1 - point.y) * 0.5 * frame.height}px`;
  }

  buildWater(body) {
    const shape = new THREE.Shape();
    body.points.forEach(([x, z], index) => (index ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0x0d2532, roughness: 0.2, metalness: 0.32, emissive: 0x08202c, emissiveIntensity: 0.35 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = GROUND_Y + 0.03;
    mesh.receiveShadow = true;
    this.root.add(mesh);

    const bankPoints = [...body.points, body.points[0]];
    const bank = new THREE.Mesh(verticalRibbonGeometry(bankPoints, GROUND_Y - 0.2, GROUND_Y + 0.2), mat(0x6f8f7c, { roughness: 0.9 }));
    this.root.add(bank);
  }

  buildRoad(road) {
    const line = curvePoints(road.points, false);
    const median = road.median && road.width >= 14;
    const carriage = median ? road.width * 0.34 : road.width;

    const shoulder = new THREE.Mesh(ribbonGeometry(line, road.width + 16, GROUND_Y + 0.2), mat(0x8d9a8e, { roughness: 0.95 }));
    shoulder.receiveShadow = true;
    this.root.add(shoulder);

    const curbMaterial = mat(0xbfcbc0, { roughness: 0.72 });
    const roadMaterial = mat(road.class === "main" ? 0x505a62 : 0x59636b, { roughness: 0.62, metalness: 0.06 });
    const edgeMaterial = new THREE.MeshBasicMaterial({ color: 0x6ff0e2, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    if (median) {
      for (const side of [-1, 1]) {
        const offset = line.map(([x, z], index) => {
          const prev = line[Math.max(0, index - 1)];
          const next = line[Math.min(line.length - 1, index + 1)];
          let dx = next[0] - prev[0];
          let dz = next[1] - prev[1];
          const len = Math.hypot(dx, dz) || 1;
          dx /= len; dz /= len;
          return [x - dz * side * (road.width * 0.33), z + dx * side * (road.width * 0.33)];
        });
        const surface = new THREE.Mesh(ribbonGeometry(offset, carriage + 3, GROUND_Y + 0.34), curbMaterial);
        surface.receiveShadow = true;
        this.root.add(surface);
        const lane = new THREE.Mesh(ribbonGeometry(offset, carriage, GROUND_Y + 0.44), roadMaterial);
        lane.receiveShadow = true;
        this.root.add(lane);
        this.addLaneMarks(offset, carriage, GROUND_Y + 0.5);
      }
      const medianStrip = new THREE.Mesh(ribbonGeometry(line, road.width * 0.24, GROUND_Y + 0.6), mat(0x2f6046));
      medianStrip.receiveShadow = true;
      this.root.add(medianStrip);
      this.addRoadEdges(line, road.width, GROUND_Y + 0.52, edgeMaterial);
      for (let i = 6; i < line.length - 6; i += 16) this.addTree(line[i][0], line[i][1], 1);
    } else {
      const surface = new THREE.Mesh(ribbonGeometry(line, road.width + 3.4, GROUND_Y + 0.34), curbMaterial);
      surface.receiveShadow = true;
      this.root.add(surface);
      const lane = new THREE.Mesh(ribbonGeometry(line, road.width, GROUND_Y + 0.44), roadMaterial);
      lane.receiveShadow = true;
      this.root.add(lane);
      this.addLaneMarks(line, road.width, GROUND_Y + 0.5);
      this.addRoadEdges(line, road.width, GROUND_Y + 0.55, edgeMaterial);
    }

    if (road.id === "road-east") {
      const texture = this.makeFlowTexture();
      this.flowTextures.push(texture);
      for (const side of [-1, 1]) {
        const offset = line.map(([x, z], index) => {
          const prev = line[Math.max(0, index - 1)];
          const next = line[Math.min(line.length - 1, index + 1)];
          let dx = next[0] - prev[0];
          let dz = next[1] - prev[1];
          const len = Math.hypot(dx, dz) || 1;
          dx /= len; dz /= len;
          return [x - dz * side * road.width * 0.165, z + dx * side * road.width * 0.165];
        });
        const flow = new THREE.Mesh(ribbonGeometry(offset, 1.1, GROUND_Y + 0.58), new THREE.MeshBasicMaterial({ map: texture, color: 0x77fff1, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        this.root.add(flow);
      }
    }
  }

  addLaneMarks(line, width, y) {
    const style = { roughness: 0.5, emissive: 0x7d8f8f, emissiveIntensity: 0.85, color: 0xf4faf4 };
    for (const ratio of width > 12 ? [-0.22, 0.22] : [0]) {
      const offset = line.map(([x, z], index) => {
        const prev = line[Math.max(0, index - 1)];
        const next = line[Math.min(line.length - 1, index + 1)];
        let dx = next[0] - prev[0];
        let dz = next[1] - prev[1];
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        return [x - dz * width * ratio, z + dx * width * ratio];
      });
      const marks = new THREE.Mesh(ribbonGeometry(offset, 0.55, y), new THREE.MeshStandardMaterial(style));
      this.root.add(marks);
    }
  }

  /** 道路两侧的发光边线，让路网在深色底图上依然可读。 */
  addRoadEdges(line, width, y, material) {
    for (const side of [-1, 1]) {
      const offset = line.map(([x, z], index) => {
        const prev = line[Math.max(0, index - 1)];
        const next = line[Math.min(line.length - 1, index + 1)];
        let dx = next[0] - prev[0];
        let dz = next[1] - prev[1];
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        return [x - dz * side * (width / 2 + 0.6), z + dx * side * (width / 2 + 0.6)];
      });
      this.root.add(new THREE.Mesh(ribbonGeometry(offset, 1.5, y), material));
    }
  }

  makeFlowTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 16;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 256, 0);
    gradient.addColorStop(0, "rgba(60,235,220,0)");
    gradient.addColorStop(0.36, "rgba(60,235,220,.08)");
    gradient.addColorStop(0.52, "rgba(110,255,240,.95)");
    gradient.addColorStop(0.66, "rgba(60,235,220,.08)");
    gradient.addColorStop(1, "rgba(60,235,220,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 16);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.set(6, 1);
    return texture;
  }

  buildWalkPath(path) {
    const line = curvePoints(path.points, path.points.length > 3);
    const border = new THREE.Mesh(ribbonGeometry(line, path.width + 1.1, GROUND_Y + 0.14), mat(0xbcc9c0, { roughness: 0.82 }));
    border.receiveShadow = true;
    this.root.add(border);
    const surface = new THREE.Mesh(ribbonGeometry(line, path.width, GROUND_Y + 0.24), mat(0xdfe6dd, { roughness: 0.86 }));
    surface.receiveShadow = true;
    this.root.add(surface);
  }

  buildLandscape(patch) {
    const [x, z] = patch.position;
    const [w, d] = patch.size;
    const rotation = THREE.MathUtils.degToRad(patch.rotation ?? 0);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotation;
    group.userData.originX = x;
    group.userData.originZ = z;
    this.root.add(group);
    const base = patch.kind === "plaza" ? 0x8b968f : patch.kind === "lawn" ? 0x2f6f4f : 0x2b6347;
    const lawn = this.addBox(group, [w, 0.26, d], [x, GROUND_Y - 0.16, z], mat(base, { roughness: 0.95 }), false);
    lawn.receiveShadow = true;
    if (patch.kind === "plaza") {
      this.addBox(group, [w * 0.8, 0.14, d * 0.7], [x, GROUND_Y + 0.06, z], mat(0x9fb0a6), false);
      return;
    }
    for (let i = 0; i < 9; i++) {
      const px = x + (((i * 53) % 100) / 100 - 0.5) * (w - 8);
      const pz = z + (((i * 97) % 100) / 100 - 0.5) * (d - 8);
      if (Math.hypot(px - x, pz - z) < 6) continue;
      this.addShrub(group, px, pz, 0.7 + ((i * 31) % 7) * 0.06);
    }
  }

  buildParking(lot) {
    const [x, z] = lot.position;
    const [w, d] = lot.size;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = THREE.MathUtils.degToRad(lot.rotation ?? 0);
    group.userData.originX = x;
    group.userData.originZ = z;
    this.root.add(group);
    this.addBox(group, [w, 0.24, d], [x, GROUND_Y - 0.06, z], mat(0x59635f, { roughness: 0.92 }), false);
    const rows = Math.floor(d / 5.4);
    for (let row = 0; row < rows; row++) {
      const pz = z - d / 2 + 2.7 + row * 5.4;
      this.addBox(group, [w - 2, 0.06, 0.16], [x, GROUND_Y + 0.1, pz], mat(0xc7d2c9), false);
      for (let slot = 1; slot < Math.floor((w - 2) / 2.6); slot++) {
        const px = x - w / 2 + 1 + slot * 2.6;
        this.addBox(group, [0.14, 0.06, 4.6], [px, GROUND_Y + 0.1, pz], mat(0xa9b6ae), false);
      }
      for (let car = 0; car < Math.floor((w - 3) / 2.6); car++) {
        if ((car + row * 3) % 3 === 0) continue;
        const px = x - w / 2 + 2.3 + car * 2.6;
        const colors = [0x8fa7ad, 0x5d7486, 0xa9b0a4, 0x76828d];
        this.addBox(group, [1.8, 0.62, 4.2], [px, GROUND_Y + 0.36, pz], mat(colors[(car + row) % 4], { metalness: 0.35, roughness: 0.4 }), false);
        this.addBox(group, [1.5, 0.5, 2.1], [px, GROUND_Y + 0.86, pz - 0.2], mat(0x243642, { metalness: 0.3, roughness: 0.25 }), false);
      }
    }
  }

  /** 一层高的风雨连廊：细柱 + 半透光顶 + 玻璃侧墙，连接相邻楼栋。 */
  buildWalkway(walk) {
    const line = resample(walk.points, 3);
    const y = walk.height;
    const columns = [];
    const wallLeft = [];
    const wallRight = [];
    for (let i = 0; i < line.length; i++) {
      const prev = line[Math.max(0, i - 1)];
      const next = line[Math.min(line.length - 1, i + 1)];
      let dx = next[0] - prev[0];
      let dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const nx = -dz, nz = dx;
      const half = walk.width / 2 - 0.55;
      wallLeft.push([line[i][0] + nx * half, line[i][1] + nz * half]);
      wallRight.push([line[i][0] - nx * half, line[i][1] - nz * half]);
      if (i % 2 === 0) {
        for (const side of [1, -1]) columns.push([line[i][0] + nx * half * side, line[i][1] + nz * half * side]);
      }
    }
    const columnGeometry = new THREE.CylinderGeometry(0.32, 0.36, y, 10);
    const columnMesh = new THREE.InstancedMesh(columnGeometry, mat(0xb6c6c4, { roughness: 0.55, metalness: 0.2 }), columns.length);
    const dummy = new THREE.Object3D();
    columns.forEach(([x, z], index) => {
      dummy.position.set(x, GROUND_Y + y / 2, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      columnMesh.setMatrixAt(index, dummy.matrix);
    });
    columnMesh.castShadow = true;
    this.root.add(columnMesh);

    const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x9fe0e2, transparent: true, opacity: 0.22, roughness: 0.12, metalness: 0.35, side: THREE.DoubleSide, depthWrite: false });
    for (const side of [wallLeft, wallRight]) {
      const glass = new THREE.Mesh(verticalRibbonGeometry(side, GROUND_Y + 0.35, GROUND_Y + y - 0.55), glassMaterial);
      this.root.add(glass);
    }

    const roof = new THREE.Mesh(ribbonGeometry(line, walk.width + 1.4, GROUND_Y + y), mat(0xc8d3d2, { roughness: 0.55, metalness: 0.18 }));
    roof.castShadow = true;
    roof.receiveShadow = true;
    this.root.add(roof);
    const fascia = new THREE.Mesh(verticalRibbonGeometry(line, GROUND_Y + y - 0.5, GROUND_Y + y + 0.14), mat(0x5d7f81, { roughness: 0.5 }));
    this.root.add(fascia);
    const beam = new THREE.Mesh(ribbonGeometry(line, walk.width - 0.2, GROUND_Y + y - 0.62), mat(0x9fb3b2, { roughness: 0.6 }));
    this.root.add(beam);
  }

  buildContextBlock(block) {
    const [x, z] = block.position;
    const [w, d] = block.size;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = THREE.MathUtils.degToRad(block.rotation ?? 0);
    group.userData.originX = x;
    group.userData.originZ = z;
    this.root.add(group);
    this.addBox(group, [w + 4, 0.5, d + 4], [x, GROUND_Y, z], mat(0x2c4a4c, { roughness: 0.9 }), false);
    const body = mat(0x2b4652, { roughness: 0.45, metalness: 0.25 });
    this.addBox(group, [w, block.height, d], [x, block.height / 2 + GROUND_Y, z], body);
    const roof = this.addBox(group, [w + 1, 0.6, d + 1], [x, block.height + GROUND_Y + 0.3, z], mat(0x6d8b8c, { roughness: 0.6 }));
    roof.castShadow = true;
    for (let y = 3.2; y < block.height; y += 3.6) {
      this.addBox(group, [w + 0.14, 0.9, d + 0.14], [x, y + GROUND_Y, z], mat(0x3d7681, { emissive: 0x123c44, emissiveIntensity: 0.35, transparent: true, opacity: 0.85 }), false);
    }
  }

  /* ---------------------------------------------------------------- *
   * 楼栋
   * ---------------------------------------------------------------- */

  facadeMaterialTemplates() {
    if (!this.facadeTemplates) {
      this.facadeTemplates = {
        glass: facadeTile({ wall: "#9fb0b2", glass: "#2f4f5e", mullion: "#d7e6e6", lit: "#f4dda6", litChance: 0.18 }),
        stone: facadeTile({ wall: "#b3bfbe", glass: "#3a5a63", mullion: "#e0e9e6", lit: "#f6e2b4", litChance: 0.12 }),
      };
      this.textures.push(this.facadeTemplates.glass, this.facadeTemplates.stone);
      this.roofTexture = roofTile();
      this.textures.push(this.roofTexture);
      this.stoneTexture = stoneTile();
      this.textures.push(this.stoneTexture);
      this.pavingTexture = pavingTile();
      this.textures.push(this.pavingTexture);
    }
    return this.facadeTemplates;
  }

  buildCampusBuilding(row, selected) {
    const templates = this.facadeMaterialTemplates();
    const [x, z] = row.position;
    const [w, d] = row.footprint;
    const height = row.floors * (row.floorHeight ?? 3.6);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = THREE.MathUtils.degToRad(row.rotation ?? 0);
    group.userData.originX = x;
    group.userData.originZ = z;
    this.root.add(group);
    this.buildingGroups?.set(row.id, group);

    const accent = selected ? 0x3f9d95 : 0x7d918f;
    const base = mat(selected ? 0x2f7a74 : 0x63787a, { roughness: 0.72 });

    // 基座与入口
    const podiumWidth = w + 7;
    const podiumDepth = d + 7;
    this.addBox(group, [podiumWidth, 0.5, podiumDepth], [x, GROUND_Y + 0.1, z], mat(0x8a9a91, { roughness: 0.92 }), false);
    this.addBox(group, [w + 3.4, 1.1, d + 3.4], [x, GROUND_Y + 0.62, z], base);
    const lobby = this.addBox(group, [Math.min(w * 0.5, 16), 2.1, 3.2], [x, GROUND_Y + 1.15, z + d / 2 + 2.4], mat(0x2a3d44, { roughness: 0.25, metalness: 0.35, emissive: 0x11333a, emissiveIntensity: 0.5 }));
    lobby.castShadow = true;
    this.addBox(group, [Math.min(w * 0.5, 16) + 1.2, 0.36, 4.6], [x, GROUND_Y + 2.4, z + d / 2 + 3.2], mat(0x9fb0ae, { roughness: 0.5 }));

    // 竖向体量：贴图立面 + 逐层腰线
    const template = templates[row.facade === "stone" ? "stone" : "glass"];
    const faceMaterial = (faceWidth, offset) => {
      const map = template.clone();
      map.needsUpdate = true;
      map.repeat.set(Math.max(1, faceWidth / 27.2), row.floors);
      map.offset.x = offset;
      this.textures.push(map);
      return new THREE.MeshStandardMaterial({
        map,
        color: selected ? 0xd8f2ee : 0xffffff,
        roughness: row.facade === "stone" ? 0.6 : 0.34,
        metalness: row.facade === "stone" ? 0.16 : 0.34,
        emissive: selected ? 0x0d3f42 : 0x081c22,
        emissiveIntensity: selected ? 0.45 : 0.22,
      });
    };
    const roofMaterial = new THREE.MeshStandardMaterial({ map: this.roofTexture, color: 0xf2f6f4, roughness: 0.5, metalness: 0.25 });
    const sideX = faceMaterial(d, 0.12);
    const sideZ = faceMaterial(w, 0.37);
    const core = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), [sideX, sideX, roofMaterial, base, sideZ, sideZ]);
    core.position.set(0, GROUND_Y + 3.4 + height / 2, 0);
    core.castShadow = true;
    core.receiveShadow = true;
    group.add(core);

    const bandMaterial = mat(selected ? 0x63b6ae : 0x9db0ad, { roughness: 0.5, metalness: 0.22 });
    const shadowBand = mat(0x4d6367, { roughness: 0.7 });
    for (let floor = 0; floor < row.floors; floor++) {
      const y = GROUND_Y + 3.4 + floor * (row.floorHeight ?? 3.6);
      this.addBox(group, [w + 0.34, 0.28, d + 0.34], [x, y + 0.16, z], bandMaterial, false);
      this.addBox(group, [w + 0.2, 0.16, d + 0.2], [x, y + (row.floorHeight ?? 3.6) - 0.18, z], shadowBand, false);
    }

    // 首层（挑高门厅）
    this.addBox(group, [w + 0.5, 3.4, d + 0.5], [x, GROUND_Y + 1.7, z], mat(0x33505a, { roughness: 0.2, metalness: 0.4, emissive: 0x0d2b33, emissiveIntensity: 0.4 }));
    for (let i = 0; i < Math.max(3, Math.round(w / 6)); i++) {
      const px = x - w / 2 + (i + 0.5) * w / Math.max(3, Math.round(w / 6));
      this.addBox(group, [0.9, 2.6, 0.3], [px, GROUND_Y + 1.6, z + d / 2 + 0.36], mat(0xbfe6e2, { roughness: 0.2, metalness: 0.3, emissive: 0x2c6f70, emissiveIntensity: 0.35 }), false);
    }

    // 女儿墙 + 屋面
    const roofY = GROUND_Y + 3.4 + height;
    const parapet = new THREE.MeshStandardMaterial({ color: selected ? 0x9fd8d1 : 0xb9c6c3, roughness: 0.62 });
    this.addBox(group, [w + 0.9, 1.15, d + 0.9], [x, roofY + 0.5, z], parapet);
    const deck = this.addBox(group, [w - 0.5, 0.24, d - 0.5], [x, roofY + 1.0, z], new THREE.MeshStandardMaterial({ map: this.roofTexture.clone(), color: 0xffffff, roughness: 0.52, metalness: 0.28 }), false);
    deck.material.map.repeat.set(Math.max(1, w / 12), Math.max(1, d / 12));
    this.textures.push(deck.material.map);

    // 屋面设备与楼梯间
    const unit = mat(0x53686d, { roughness: 0.5, metalness: 0.28 });
    const count = 3 + (row.floors % 2);
    for (let i = 0; i < count; i++) {
      const px = x + (((i * 71) % 100) / 100 - 0.5) * (w - 12);
      const pz = z + (((i * 43) % 100) / 100 - 0.5) * (d - 12);
      const size = 3 + ((i * 17) % 5) * 0.7;
      this.addBox(group, [size, 1.6, size * 0.75], [px, roofY + 1.9, pz], unit);
      this.addBox(group, [size + 0.5, 0.22, size * 0.75 + 0.5], [px, roofY + 2.7, pz], mat(0x8fa0a2, { metalness: 0.35 }), false);
    }
    this.addBox(group, [w * 0.26, 3.1, d * 0.24], [x - w * 0.24, roofY + 2.3, z - d * 0.26], mat(0x6f8286, { roughness: 0.6 }));
    this.addBox(group, [w * 0.3, 0.4, d * 0.28], [x - w * 0.24, roofY + 4.0, z - d * 0.26], mat(0x9aabab, { metalness: 0.3 }));
    for (let i = 0; i < 3; i++) {
      const px = x + w * 0.3;
      const pz = z - d * 0.3 + i * (d * 0.3);
      this.addBox(group, [2.2, 2.2, 2.2], [px, roofY + 2.2, pz], mat(0x7d8f8e, { roughness: 0.55 }), false);
    }

    if (this.state.layers.heat && this.state.view === "site") {
      const heat = row.id === "building-06" ? 0.78 : 0.24 + (Number(row.id.slice(-2)) % 5) * 0.12;
      const heatColor = new THREE.Color().setHSL(0.55 - heat * 0.48, 0.86, 0.53);
      const roofHeat = new THREE.Mesh(new THREE.BoxGeometry(w - 1, 0.1, d - 1), new THREE.MeshBasicMaterial({ color: heatColor, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
      roofHeat.position.set(0, roofY + 1.2, 0);
      group.add(roofHeat);
    }

    if (selected) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 96), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, GROUND_Y + 1.3, 0);
      ring.scale.set(w / 2 + 15, d / 2 + 15, 1);
      group.add(ring);
      const scanMaterial = new THREE.MeshBasicMaterial({ color: 0x6bfff0, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      this.scanBand = new THREE.Mesh(new THREE.PlaneGeometry(w + 6, d + 6), scanMaterial);
      this.scanBand.rotation.x = -Math.PI / 2;
      this.scanBand.position.set(0, GROUND_Y + 2, 0);
      this.scanBand.userData.maxHeight = roofY;
      group.add(this.scanBand);
    }

    if (selected) {
      const label = this.makeBuildingLabel(row, true);
      label.position.set(0, roofY + 10, 0);
      label.scale.set(26, 6, 1);
      group.add(label);
    }

    const hit = new THREE.Mesh(new THREE.BoxGeometry(w + 3, roofY + 6, d + 3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.set(0, (roofY + 6) / 2, 0);
    hit.userData = { kind: "building", id: row.id, title: row.name, subtitle: `${row.floors}层 · ${row.usage}` };
    group.add(hit);
    this.clickable.push(hit);
  }

  makeBuildingLabel(row, selected) {
    const name = typeof row === "string" ? row : row.name;
    const floors = typeof row === "string" ? 0 : row.floors;
    const unverified = typeof row === "object" && row.confidence === "unverified-numbering";
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 116;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = selected ? "rgba(8,37,49,.94)" : "rgba(9,29,39,.92)";
    ctx.strokeStyle = selected ? "#69e4d5" : "#3c6870";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 108, 15);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = selected ? "#66e4d5" : "#91c8d3";
    ctx.font = "bold 43px Microsoft YaHei, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 26, 43);
    ctx.fillStyle = unverified ? "#d8b779" : "#96b2bc";
    ctx.font = "24px Microsoft YaHei, sans-serif";
    ctx.fillText(selected ? "智萃科技中心" : unverified ? "编号待核对" : "智萃园区组团", 27, 82);
    ctx.textAlign = "right";
    ctx.fillStyle = selected ? "#b8eee8" : "#91b2bc";
    ctx.font = "25px Microsoft YaHei, sans-serif";
    if (floors) ctx.fillText(`${floors}F`, 484, 62);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.renderOrder = 8;
    return sprite;
  }

  /* ---------------------------------------------------------------- *
   * 绿化
   * ---------------------------------------------------------------- */

  addTrees() {
    const layout = this.state.campusLayout ?? {};
    const positions = [...(layout.treePositions ?? [])];
    for (const row of layout.treeRows ?? []) {
      const [x1, z1] = row.from;
      const [x2, z2] = row.to;
      let dx = x2 - x1;
      let dz = z2 - z1;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const nx = -dz;
      const nz = dx;
      for (let i = 0; i < row.count; i++) {
        const t = row.count === 1 ? 0.5 : i / (row.count - 1);
        const jitter = row.jitter ?? 1;
        const j1 = (Math.sin(i * 12.9898) * 43758.5453 % 1) * jitter;
        const j2 = (Math.sin(i * 78.233) * 12345.6789 % 1) * jitter;
        positions.push([
          x1 + dx * len * t + nx * (row.offset ?? 0) + j1,
          z1 + dz * len * t + nz * (row.offset ?? 0) + j2,
        ]);
      }
    }
    this.treeData = positions;
    if (!positions.length) return;
    const trunkGeometry = new THREE.CylinderGeometry(0.34, 0.5, 3.4, 7);
    const crownGeometry = new THREE.IcosahedronGeometry(2.4, 1);
    const warm = positions.filter((_, i) => i % 3 === 0);
    const cool = positions.filter((_, i) => i % 3 !== 0);
    const trunk = new THREE.InstancedMesh(trunkGeometry, mat(0x6d5644, { roughness: 0.9 }), positions.length);
    const crown = new THREE.InstancedMesh(crownGeometry, mat(0x2f8365, { roughness: 0.92 }), cool.length);
    const crownWarm = new THREE.InstancedMesh(crownGeometry, mat(0x3f9160, { roughness: 0.92 }), warm.length);
    const dummy = new THREE.Object3D();
    positions.forEach(([x, z], i) => {
      const scale = 0.78 + ((i * 17) % 7) * 0.07;
      dummy.position.set(x, GROUND_Y + 1.7 * scale, z);
      dummy.scale.setScalar(scale);
      dummy.rotation.set(0, (i % 7) * 0.5, 0);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
    });
    const place = (mesh, list) => list.forEach(([x, z], i) => {
      const scale = 0.78 + ((i * 17) % 7) * 0.07;
      dummy.position.set(x, GROUND_Y + 4.1 * scale, z);
      dummy.scale.set(scale * 1.05, scale * 0.82, scale * 1.05);
      dummy.rotation.set(0, (i % 7) * 0.5, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    place(crown, cool);
    place(crownWarm, warm);
    trunk.castShadow = true;
    crown.castShadow = true;
    crownWarm.castShadow = true;
    this.root.add(trunk, crown, crownWarm);
  }

  addTree(x, z, scale = 1) {
    if (!this._treeGroup) {
      this._treeGroup = new THREE.Group();
      this.root.add(this._treeGroup);
    }
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 3, 7), mat(0x6d5644));
    trunk.position.set(x, GROUND_Y + 1.5 * scale, z);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 1), mat(0x2f8365));
    crown.position.set(x, GROUND_Y + 3.7 * scale, z);
    crown.scale.setScalar(scale);
    crown.castShadow = true;
    this._treeGroup.add(trunk, crown);
  }

  addShrub(parent, x, z, scale) {
    const shrub = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), mat(0x357a55, { roughness: 0.95 }));
    shrub.position.set(x - (parent.userData.originX ?? 0), GROUND_Y + 0.7 * scale, z - (parent.userData.originZ ?? 0));
    shrub.scale.set(scale * 1.2, scale * 0.75, scale * 1.2);
    shrub.castShadow = true;
    parent.add(shrub);
  }

  addCompass() {
    const { width, depth } = this.state.campusLayout?.bounds ?? { width: 400, depth: 400 };
    const [cx, cz] = this.state.campusLayout?.bounds?.center ?? [0, 0];
    const origin = new THREE.Vector3(cx - width / 2 + 22, GROUND_Y + 0.6, cz - depth / 2 + 26);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), origin, 18, C.cyan, 4.2, 2.4);
    this.root.add(arrow);
  }

  /* ---------------------------------------------------------------- *
   * 单栋 / 楼层 / 房间
   * ---------------------------------------------------------------- */

  buildBuildingView() {
    const row = this.state.campusLayout?.buildings.find(item => item.id === "building-06") ?? {
      id: "building-06", name: "6号楼", position: this.buildingPosition(), footprint: [42, 26], floors: 8, floorHeight: 3.6, usage: "智萃科技中心 · 7楼", facade: "glass",
    };
    this.facadeMaterialTemplates();
    const [x, z] = row.position;
    const [w, d] = row.footprint;
    const podium = this.addBox(this.root, [w + 46, 0.9, d + 42], [x, -0.5, z], mat(0x1f4a3c), false);
    podium.receiveShadow = true;
    const apron = this.addBox(this.root, [w + 24, 0.3, d + 22], [x, GROUND_Y - 0.14, z], new THREE.MeshStandardMaterial({ map: this.pavingTexture.clone(), color: 0xffffff, roughness: 0.9 }), false);
    apron.material.map.repeat.set(4, 4);
    this.textures.push(apron.material.map);
    this.buildCampusBuilding(row, true);
    this.addBox(this.root, [18, 4, 12], [x + w / 2 + 22, 2, z - d / 2 - 12], mat(0x2f5556));
    this.addBox(this.root, [14, 3, 10], [x - w / 2 - 20, 1.5, z + d / 2 + 12], mat(0x2f5556));
    this.addTreeCluster(x - w / 2 - 14, z + d / 2 + 16);
    this.addTreeCluster(x + w / 2 + 16, z - d / 2 - 14);
    for (let i = -2; i <= 2; i++) {
      this.addBox(this.root, [1.7, 0.28, 3.6], [x + i * 4, GROUND_Y - 0.1, z + d / 2 + 14], mat(0xcbd4c8), false);
    }
    this.addFloorBadges(row.floors * (row.floorHeight ?? 3.6), x, z, row.floors);
  }

  addTreeCluster(x, z) {
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      this.addTree(x + Math.cos(a) * 7, z + Math.sin(a) * 7, 0.9);
    }
  }

  addFloorBadges(height, x, z, count = 8, footprintWidth = 58) {
    const offset = footprintWidth / 2 + 11;
    for (let i = 0; i < count; i++) {
      const y = GROUND_Y + 3.4 + (i + 0.5) * (height / count);
      const active = i === 6;
      const marker = new THREE.Mesh(new THREE.SphereGeometry(active ? 1.7 : 1.05, 16, 12), new THREE.MeshBasicMaterial({ color: active ? C.cyan : 0x78959a, depthTest: false }));
      marker.position.set(x + offset, y, z);
      marker.renderOrder = 8;
      this.root.add(marker);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hit.position.copy(marker.position);
      hit.userData = { kind: "floor", id: `f${String(i + 1).padStart(2, "0")}`, title: `${i + 1}楼`, subtitle: active ? "点击展开 7 楼" : "楼层资料待接入" };
      this.root.add(hit);
      this.clickable.push(hit);
    }
  }

  floorPosition(x, y, width, depth, originX = 0, originY = 0) {
    return [x / 1000 - width / 2 - originX, depth / 2 - y / 1000 - originY];
  }

  roomBounds(room) {
    const xs = room.polygon.map(point => point[0] / 1000);
    const ys = room.polygon.map(point => point[1] / 1000);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  addFurniture(parent, item, position) {
    const [x, z] = position;
    const furniture = new THREE.Group();
    furniture.position.set(x, 0, z);
    furniture.rotation.y = THREE.MathUtils.degToRad(item.rotationDegrees ?? 0);
    furniture.userData.originX = x;
    furniture.userData.originZ = z;
    parent.add(furniture);
    const [w, d] = item.size.map(value => value / 1000);
    const wood = mat(0xb5d8d5, { metalness: 0.1 });
    const dark = mat(0x356276);
    if (item.kind === "chair") {
      this.addBox(furniture, [Math.min(w, 0.66), 0.14, Math.min(d, 0.66)], [x, 0.48, z], dark);
      this.addBox(furniture, [Math.min(w, 0.66), 0.6, 0.12], [x, 0.83, z + d * 0.35], dark);
    } else if (item.kind === "shelf") {
      this.addBox(furniture, [w, 1.8, d], [x, 1.0, z], mat(0x5e8790));
      for (const height of [0.7, 1.2, 1.7]) this.addBox(furniture, [w + 0.06, 0.08, d + 0.06], [x, height, z], wood);
    } else if (item.kind === "cabinet") {
      this.addBox(furniture, [w, 1.15, d], [x, 0.62, z], mat(0x547b85));
      for (let i = 1; i < 5; i++) this.addBox(furniture, [0.045, 0.7, d + 0.03], [x - w / 2 + i * w / 5, 0.66, z], mat(0x91bfc1));
    } else if (item.kind === "printer") {
      this.addBox(furniture, [w + 0.25, 0.28, d + 0.25], [x, 0.16, z], wood);
      for (let i = 0; i < 6; i++) {
        const px = x - w / 2 + (i + 0.5) * w / 6;
        this.addBox(furniture, [Math.min(1.2, w / 7), 1.05, d * 0.72], [px, 0.84, z], mat(0x557f89));
        this.addBox(furniture, [Math.min(0.8, w / 8), 0.42, d * 0.35], [px, 1.4, z], mat(0x9be4dc));
      }
    } else if (item.kind === "sofa") {
      this.addBox(furniture, [w, 0.48, d], [x, 0.4, z], mat(0x477e82));
      this.addBox(furniture, [w, 0.75, 0.22], [x, 0.78, z + d * 0.42], mat(0x477e82));
    } else if (item.kind === "coffee-table") {
      const top = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.48, Math.min(w, d) * 0.48, 0.16, 32), wood);
      top.position.set(0, 0.56, 0);
      furniture.add(top);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.23, 0.48, 16), dark);
      foot.position.set(0, 0.28, 0);
      furniture.add(foot);
    } else if (item.kind === "bar-counter") {
      this.addBox(furniture, [w, 0.98, d], [x, 0.58, z], mat(0x456f78));
      this.addBox(furniture, [w + 0.12, 0.14, d + 0.12], [x, 1.13, z], wood);
      this.addBox(furniture, [w * 0.38, 0.08, 0.06], [x, 0.76, z + d / 2 + 0.04], mat(0x92d4ce));
    } else if (["water-tank", "water-dispenser", "fridge"].includes(item.kind)) {
      const color = item.kind === "water-tank" ? 0x80bdc2 : 0x8bbfc3;
      this.addBox(furniture, [w, item.kind === "water-tank" ? 1.35 : 1.8, d], [x, item.kind === "water-tank" ? 0.78 : 1.0, z], mat(color, { metalness: 0.14 }));
      this.addBox(furniture, [w * 0.72, item.kind === "water-tank" ? 0.72 : 0.96, 0.07], [x, item.kind === "water-tank" ? 0.82 : 1.05, z + d / 2 + 0.04], mat(0x315a66, { emissive: 0x123744, emissiveIntensity: 0.18 }));
      if (item.kind === "water-tank") {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.28, w * 0.28, 0.9, 20), mat(0xb4e5e3, { transparent: true, opacity: 0.82 }));
        tank.position.set(0, 1.95, 0);
        furniture.add(tank);
      } else if (item.kind === "water-dispenser") {
        this.addBox(furniture, [w * 0.28, 0.08, 0.2], [x, 0.95, z + d / 2 + 0.16], mat(0x65d8ce, { emissive: 0x17847d, emissiveIntensity: 0.3 }));
      } else {
        this.addBox(furniture, [0.04, 1.5, 0.06], [x, 1.0, z + d / 2 + 0.04], mat(0xd1e5e1));
      }
    } else if (item.kind === "armchair") {
      const upholstery = mat(0x477e82);
      this.addBox(furniture, [w * 0.78, 0.42, d * 0.72], [x, 0.42, z], upholstery);
      this.addBox(furniture, [w * 0.78, 0.75, 0.2], [x, 0.78, z + d * 0.38], upholstery);
      for (const dx of [-1, 1]) this.addBox(furniture, [0.18, 0.48, d * 0.76], [x + dx * w * 0.41, 0.52, z], upholstery);
    } else {
      const surfaceHeight = item.kind === "conference" ? 0.84 : 0.76;
      this.addBox(furniture, [w, 0.16, d], [x, surfaceHeight, z], wood);
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
        this.addBox(furniture, [0.14, surfaceHeight - 0.1, 0.14], [x + dx * (w / 2 - 0.24), (surfaceHeight - 0.1) / 2, z + dz * (d / 2 - 0.2)], dark);
      }
    }
  }

  addRoomWalls(parent, bounds, cx, cz, room) {
    if (!room.enclosed) return;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxY - bounds.minY;
    const wall = mat(0xb4e4e7, { transparent: true, opacity: 0.86, metalness: 0.1 });
    const left = cx - width / 2, right = cx + width / 2;
    const north = cz - depth / 2, south = cz + depth / 2;
    this.addBox(parent, [width, 1.45, 0.13], [cx, 0.81, south], wall);
    this.addBox(parent, [0.13, 1.45, depth], [left, 0.81, cz], wall);
    this.addBox(parent, [0.13, 1.45, depth], [right, 0.81, cz], wall);
    const opening = 1.2;
    this.addBox(parent, [width * 0.58, 1.45, 0.13], [left + width * 0.29, 0.81, north], wall);
    this.addBox(parent, [Math.max(0.4, width * 0.42 - opening), 1.45, 0.13], [right - (width * 0.42 - opening) / 2, 0.81, north], wall);
  }

  deviceHasAlert(twinId) {
    return this.state.layers.alerts && this.state.alerts.some(alert => alert.twinId === twinId && alert.level !== "info");
  }

  buildFloor() {
    const data = this.state.floorplan;
    const width = data.bounds.width / 1000;
    const depth = data.bounds.depth / 1000;
    const footprintDepth = (data.footprint?.depth ?? data.bounds.depth) / 1000;
    const footprintOffsetZ = (depth - footprintDepth) / 2;
    this.addBox(this.root, [width + 3.5, 0.4, footprintDepth + 3.5], [0, -0.45, footprintOffsetZ], mat(0x193b43), false);
    const floorBackdrop = this.addBox(this.root, [width + 0.3, 0.24, footprintDepth + 0.3], [0, -0.09, footprintOffsetZ], mat(0xb7d0d1), false);
    floorBackdrop.userData = { kind: "background-floor", id: "building-06-f07", title: "7 楼" };
    this.clickable.push(floorBackdrop);
    for (const room of (this.state.layers.spaces ? data.rooms : [])) {
      const b = this.roomBounds(room);
      const roomWidth = b.maxX - b.minX, roomDepth = b.maxY - b.minY;
      const cx = (b.minX + b.maxX) / 2 - width / 2;
      const cz = depth / 2 - (b.minY + b.maxY) / 2;
      const intensity = Math.min(1, room.occupancy / Math.max(1, room.areaM2 / 6));
      const heat = new THREE.Color(0x43c494).lerp(new THREE.Color(0xe8ad56), intensity);
      const color = this.state.layers.heat ? heat : new THREE.Color(room.id === this.state.selected.id ? 0x73f2e5 : room.floorColor ?? (room.enclosed ? 0x5297aa : 0x42798f));
      if (room.floorColor) this.addBox(this.root, [roomWidth + 0.62, 0.28, roomDepth + 0.62], [cx, -0.13, cz], mat(0x315c3d), false);
      const floor = this.addBox(this.root, [roomWidth - 0.13, 0.08, roomDepth - 0.13], [cx, 0.1, cz], mat(color, { emissive: color, emissiveIntensity: 0.2, transparent: true, opacity: room.enclosed ? 0.91 : 0.72 }), false);
      floor.userData = { kind: "room", id: room.id, title: room.name, subtitle: `${room.areaM2} m² · 点击进入`, enclosed: Boolean(room.enclosed), floorColor: room.floorColor };
      this.roomFloorMeshes?.set(room.id, floor);
      this.clickable.push(floor);
      this.addRoomWalls(this.root, b, cx, cz, room);
    }
    for (const item of data.furnishings ?? []) {
      const [x, z] = this.floorPosition(item.position[0], item.position[1], width, depth);
      this.addFurniture(this.root, item, [x, z]);
    }
    if (this.state.layers.equipment) for (const device of data.equipments) {
      const [x, z] = this.floorPosition(device.position[0], device.position[1], width, depth);
      const color = this.deviceHasAlert(device.id) ? C.warning : C.equipment;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 }));
      dot.position.set(x, 1.82, z);
      this.root.add(dot);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hit.position.copy(dot.position);
      hit.userData = { kind: "equipment", id: device.id, title: device.label, subtitle: `${device.reading}${device.unit}` };
      this.root.add(hit);
      this.clickable.push(hit);
    }
    this.buildPatrolRobot();
  }

  buildRoomView() {
    const data = this.state.floorplan;
    const room = data.rooms.find(item => item.id === this.state.activeRoomId) ?? data.rooms[0];
    const b = this.roomBounds(room);
    const width = b.maxX - b.minX, depth = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.addBox(this.root, [width + 4, 0.35, depth + 4], [0, -0.43, 0], mat(0x18373f), false);
    const roomSurface = this.addBox(this.root, [width, 0.18, depth], [0, 0, 0], mat(0x73b6c0, { emissive: 0x1a5a6b, emissiveIntensity: 0.25 }));
    roomSurface.userData = { kind: "room-surface", id: room.id, roomFocusHit: true };
    this.clickable.push(roomSurface);
    this.addRoomWalls(this.root, b, 0, 0, room);
    for (const item of (data.furnishings ?? []).filter(value => value.roomId === room.id)) {
      const x = item.position[0] / 1000 - cx;
      const z = cy - item.position[1] / 1000;
      this.addFurniture(this.root, item, [x, z]);
    }
    for (const device of data.equipments.filter(value => value.roomId === room.id)) {
      const color = this.deviceHasAlert(device.id) ? C.warning : C.equipment;
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), new THREE.MeshBasicMaterial({ color }));
      sphere.position.set(device.position[0] / 1000 - cx, 2.1, cy - device.position[1] / 1000);
      this.root.add(sphere);
      const hit = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hit.position.copy(sphere.position);
      hit.userData = { kind: "equipment", id: device.id, title: device.label, subtitle: `${device.reading}${device.unit}`, focusDevice: true };
      this.root.add(hit);
      this.clickable.push(hit);
    }
  }

  buildDeviceView() {
    const device = this.state.floorplan.equipments.find(item => item.id === this.state.activeDeviceId);
    if (!device) return;
    const accent = this.deviceHasAlert(device.id) ? 0xf1b958 : 0x66e5dc;
    const dark = mat(0x183b48, { metalness: 0.42, roughness: 0.4 });
    const shell = mat(0xa8d6d8, { metalness: 0.25, roughness: 0.4 });
    const glow = mat(accent, { emissive: accent, emissiveIntensity: 0.9, metalness: 0.2 });
    this.addBox(this.root, [9.8, 0.32, 7.8], [0, -0.24, 0], mat(0x1b424c, { metalness: 0.32 }), false);
    this.addBox(this.root, [8.6, 0.12, 6.6], [0, -0.02, 0], mat(0x4f8992, { emissive: 0x145b68, emissiveIntensity: 0.32 }), false);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(4.7, 0.035, 8, 72), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.56, depthWrite: false }));
    halo.rotation.x = Math.PI / 2;
    halo.position.y = 0.07;
    this.root.add(halo);
    this.deviceHalo = halo;

    if (device.category === "paper-printer") {
      const body = mat(0xd7e1df, { metalness: 0.12, roughness: 0.62 });
      const trim = mat(0x55727a, { metalness: 0.16, roughness: 0.48 });
      const black = mat(0x19343d, { metalness: 0.18, roughness: 0.4 });
      const paper = mat(0xf0f4eb, { roughness: 0.9 });
      this.addBox(this.root, [2.8, 1.38, 2.0], [0, 0.78, 0], body);
      this.addBox(this.root, [2.72, 0.18, 1.94], [0, 1.48, 0], body);
      this.addBox(this.root, [2.15, 0.24, 1.05], [0, 1.58, -0.36], trim);
      this.addBox(this.root, [1.52, 0.09, 0.74], [0, 1.74, -0.36], paper);
      this.addBox(this.root, [1.85, 0.28, 0.16], [0, 1.26, 1.02], black);
      this.addBox(this.root, [1.4, 0.045, 0.11], [0, 1.43, 1.12], paper);
      this.addBox(this.root, [0.72, 0.13, 0.46], [0.88, 1.61, 0.57], trim);
      this.addBox(this.root, [0.45, 0.045, 0.25], [0.88, 1.7, 0.57], glow, false);
      this.addBox(this.root, [2.18, 0.56, 0.12], [0, 0.48, 1.02], body);
      this.addBox(this.root, [2.0, 0.08, 0.14], [0, 0.74, 1.1], trim);
    } else if (device.category === "printer") {
      for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
        const x = (col - 1) * 2.6, z = (row - 0.5) * 2.6;
        this.addBox(this.root, [2.05, 2.35, 2.1], [x, 1.28, z], dark);
        this.addBox(this.root, [1.56, 1.22, 0.08], [x, 1.42, z + 1.08], mat(0x84c9d0, { transparent: true, opacity: 0.72, emissive: 0x1b5966, emissiveIntensity: 0.35 }), false);
        this.addBox(this.root, [1.82, 0.12, 1.88], [x, 2.5, z], shell);
        this.addBox(this.root, [0.32, 0.12, 0.12], [x + 0.7, 2.07, z + 1.14], glow, false);
      }
    } else if (device.category === "hvac") {
      this.addBox(this.root, [7, 3.5, 2], [0, 2.3, 0], shell);
      this.addBox(this.root, [6.3, 2.5, 0.12], [0, 2.25, 1.05], dark);
      for (let index = 0; index < 7; index++) this.addBox(this.root, [5.7, 0.09, 0.1], [0, 1.25 + index * 0.31, 1.13], glow, false);
      this.addBox(this.root, [0.55, 0.18, 0.13], [2.55, 3.42, 1.1], glow, false);
    } else if (device.category === "sensor") {
      this.addBox(this.root, [0.55, 3.6, 0.55], [0, 1.8, 0], dark);
      this.addBox(this.root, [3.2, 2.25, 1.1], [0, 3.25, 0], shell);
      this.addBox(this.root, [2.45, 1.38, 0.1], [0, 3.28, 0.62], dark);
      for (let index = -1; index <= 1; index++) this.addBox(this.root, [0.42, 0.42, 0.12], [index * 0.74, 3.28, 0.7], glow, false);
      const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 16), glow);
      sensor.position.set(0, 5.08, 0);
      this.root.add(sensor);
    } else if (device.category === "lighting") {
      for (const x of [-2.05, 2.05]) for (const z of [-1.35, 1.35]) {
        this.addBox(this.root, [3.2, 0.16, 1.7], [x, 3.25, z], shell);
        this.addBox(this.root, [2.85, 0.06, 1.34], [x, 3.12, z], glow, false);
        this.addBox(this.root, [0.12, 3.05, 0.12], [x, 1.55, z], dark);
      }
    } else if (device.category === "access") {
      for (const x of [-2.35, 2.35]) {
        this.addBox(this.root, [1.15, 2.7, 2.6], [x, 1.35, 0], shell);
        this.addBox(this.root, [0.64, 0.18, 0.72], [x, 2.76, -0.5], glow, false);
      }
      this.addBox(this.root, [3.5, 0.12, 0.2], [0, 1.25, 0], glow, false);
    } else if (device.category === "humanoid-robot") {
      const joint = new THREE.MeshStandardMaterial({ color: 0x315d69, metalness: 0.52, roughness: 0.32 });
      const limb = (start, end, radiusTop, radiusBottom, material) => {
        const direction = new THREE.Vector3().subVectors(end, start);
        const segment = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, direction.length(), 18), material);
        segment.position.copy(start).add(end).multiplyScalar(0.5);
        segment.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
        this.root.add(segment);
        return segment;
      };
      const ball = (x, y, z, radius, material) => {
        const part = new THREE.Mesh(new THREE.SphereGeometry(radius, 18, 14), material);
        part.position.set(x, y, z);
        this.root.add(part);
      };
      this.addBox(this.root, [1.34, 0.34, 0.88], [0, 0.27, 0.04], dark);
      this.addBox(this.root, [0.54, 0.08, 0.12], [0, 0.46, 0.46], glow, false);
      this.addBox(this.root, [0.96, 0.52, 0.7], [0, 2.13, 0], dark);
      this.addBox(this.root, [1.23, 1.34, 0.78], [0, 3.02, 0], shell);
      this.addBox(this.root, [0.46, 0.16, 0.07], [0, 3.13, 0.42], glow, false);
      this.addBox(this.root, [0.7, 0.26, 0.72], [0, 3.86, 0], joint);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.48, 24, 20), shell);
      head.scale.set(0.9, 1.08, 0.92);
      head.position.set(0, 4.43, 0.02);
      this.root.add(head);
      this.addBox(this.root, [0.56, 0.2, 0.15], [0, 4.48, 0.42], dark, false);
      for (const x of [-0.14, 0.14]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10), glow);
        eye.position.set(x, 4.49, 0.51);
        this.root.add(eye);
      }
      for (const side of [-1, 1]) {
        const hip = new THREE.Vector3(side * 0.34, 1.92, 0);
        const knee = new THREE.Vector3(side * 0.38, 1.08, 0.02);
        const ankle = new THREE.Vector3(side * 0.39, 0.48, 0.04);
        limb(hip, knee, 0.22, 0.28, dark);
        limb(knee, ankle, 0.16, 0.21, shell);
        ball(knee.x, knee.y, knee.z, 0.21, joint);
        this.addBox(this.root, [0.47, 0.2, 0.73], [side * 0.39, 0.13, 0.18], dark);

        const shoulder = new THREE.Vector3(side * 0.78, 3.55, 0);
        const elbow = new THREE.Vector3(side * 1.02, 2.73, 0.05);
        const wrist = new THREE.Vector3(side * 1.04, 2.02, 0.13);
        ball(shoulder.x, shoulder.y, shoulder.z, 0.29, joint);
        limb(shoulder, elbow, 0.18, 0.23, shell);
        ball(elbow.x, elbow.y, elbow.z, 0.18, joint);
        limb(elbow, wrist, 0.13, 0.17, dark);
        ball(wrist.x, wrist.y, wrist.z, 0.15, glow);
        ball(side * 1.04, 1.81, 0.15, 0.16, shell);
      }
    } else if (device.category === "robot-arm") {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.55, 0.46, 32), dark);
      base.position.y = 0.32;
      this.root.add(base);
      const swivel = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 1.05, 0.7, 24), glow);
      swivel.position.y = 0.86;
      this.root.add(swivel);
      this.addBox(this.root, [1.15, 0.5, 1.15], [0, 1.42, 0], shell);
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.64, 20, 16), glow);
      shoulder.position.set(0, 1.85, 0);
      this.root.add(shoulder);
      const upper = this.addBox(this.root, [0.72, 2.65, 0.76], [0.58, 3.2, 0]);
      upper.rotation.z = -0.34;
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 18, 14), dark);
      elbow.position.set(1.02, 4.45, 0);
      this.root.add(elbow);
      const forearm = this.addBox(this.root, [0.58, 2.05, 0.62], [1.56, 5.25, 0]);
      forearm.rotation.z = 0.55;
      const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), glow);
      wrist.position.set(2.1, 6.05, 0);
      this.root.add(wrist);
      this.addBox(this.root, [1.25, 0.26, 0.34], [2.56, 6.22, 0], shell);
      for (const z of [-0.24, 0.24]) this.addBox(this.root, [0.18, 0.76, 0.12], [3.13, 6.56, z], dark);
    } else {
      this.addBox(this.root, [5.4, 3.4, 2.8], [0, 1.8, 0], shell);
      this.addBox(this.root, [4.2, 2.25, 0.1], [0, 1.8, 1.46], dark);
      this.addBox(this.root, [2.8, 0.16, 0.1], [0, 1.8, 1.53], glow, false);
    }
    const hit = this.addBox(this.root, [10, 8, 8], [0, 3.5, 0], new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), false);
    hit.userData = { kind: "device-focus", id: device.id, deviceFocusHit: true };
    this.clickable.push(hit);
  }

  /* ---------------------------------------------------------------- */

  applyCamera() { this.transitionToView(this.state.view, this.state.view); }

  setZoom(direction) {
    if (this.transition) return;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    offset.multiplyScalar(direction < 0 ? 1.18 : 0.84);
    this.camera.position.copy(target.clone().add(offset));
    this.controls.update();
    this.updateSelectionMarker();
  }

  resetCamera() { this.transitionToView(this.state.view, this.state.view); }

  handlePointerDown(event) {
    if (event.button !== 0) return;
    this.pointerDown = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera: this.camera.position.clone(),
      target: this.controls.target.clone(),
      cancelled: Boolean(this.transition),
    };
  }

  handlePointerUp(event) {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start || start.id !== event.pointerId || start.cancelled || this.transition) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    if (this.camera.position.distanceTo(start.camera) > 0.035 || this.controls.target.distanceTo(start.target) > 0.035) return;
    this.pick(event);
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const view = this.state.view;
    const allowed = view === "site" ? ["building"] : view === "building" ? ["floor"] : view === "floor" ? ["equipment", "patrol-robot", "room", "background-building"] : view === "room" ? ["equipment", "room-surface", "background-floor"] : ["equipment", "device-focus", "room-surface"];
    const visible = object => { for (let node = object; node; node = node.parent) if (!node.visible) return false; return true; };
    const targets = this.clickable.filter(object => allowed.includes(object.userData.kind) && visible(object) && (view !== "room" && view !== "device" || object.userData.kind !== "equipment" || object.userData.focusDevice));
    const matches = this.raycaster.intersectObjects(targets, false);
    if (!matches.length) return;
    matches.sort((a, b) => a.distance - b.distance);
    const item = matches[0].object.userData;
    if (item.kind === "device-focus" || item.kind === "room-surface" && view === "room") return;
    if (item.kind === "room-surface") {
      const room = this.state.floorplan.rooms.find(value => value.id === this.state.activeRoomId);
      this.store.update({ view: "room", activeDeviceId: null, selected: { kind: "room", id: room?.id ?? item.id, title: room?.name ?? "房间" } });
      return;
    }
    if (item.kind === "background-floor") {
      this.store.update({ view: "floor", activeDeviceId: null, selected: { kind: "floor", id: "building-06-f07", title: "6号楼 · 7楼" } });
      return;
    }
    if (item.kind === "background-building") {
      this.store.update({ view: "building", activeDeviceId: null, selected: { kind: "building", id: "building-06", title: "6号楼" } });
      return;
    }
    if (item.kind === "building") {
      if (item.id === "building-06") {
        this.store.setSelected(item);
        this.store.setView("building");
      } else this.onSelect(item);
      return;
    }
    if (item.kind === "floor") {
      if (item.id === "f07") this.store.update({ floorId: "f07", view: "floor", selected: { ...item, kind: "floor" } });
      else this.onSelect(item);
      return;
    }
    if (item.kind === "room") {
      this.onSelect(item);
      this.store.update({ activeRoomId: item.id, activeDeviceId: null, view: "room" });
      return;
    }
    if (item.kind === "equipment" || item.kind === "patrol-robot") this.onSelect(item);
  }

  resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate = () => {
    this._frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const deltaSeconds = Math.min(0.05, Math.max(0, (now - (this._lastFrame ?? now)) / 1000));
    this._lastFrame = now;
    this.updatePatrolRobot(deltaSeconds);
    if (this.transition) this.advanceTransition(now);
    for (const texture of this.flowTextures) texture.offset.x = (texture.offset.x - 0.0022 + 1) % 1;
    if (this.scanBand) {
      const height = this.scanBand.userData.maxHeight;
      this.scanBand.position.y = GROUND_Y + 1.5 + ((Math.sin(now * 0.00065) + 1) / 2) * Math.max(2, height - 3);
      this.scanBand.material.opacity = 0.08 + (Math.sin(now * 0.0015) + 1) * 0.025;
    }
    if (this.deviceHalo?.parent?.visible) this.deviceHalo.rotation.z += 0.004;
    this.controls.update();
    this.updateSelectionMarker();
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.sampleQuality(now);
  };

  dispose() {
    cancelAnimationFrame(this._frame);
    this.resizeObserver.disconnect();
    this.unsubscribe?.();
    this.clearScene();
    this.renderer.dispose();
  }
}
