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

export class TwinScene {
  constructor(host, store, onSelect) {
    this.host = host;
    this.store = store;
    this.onSelect = onSelect;
    this.clickable = [];
    this.state = store.state;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x061722);
    this.scene.fog = new THREE.Fog(0x061722, 300, 820);
    this.flowTextures = [];
    this.scanBand = null;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute("aria-label", "可交互的园区和楼层示意模型");
    host.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
    this.camera.position.set(148, 180, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 900;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.addLights();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.renderer.domElement.addEventListener("pointerup", event => this.pick(event));
    this.renderer.domElement.addEventListener("pointerdown", () => { this.cameraGoal = null; this.targetGoal = null; });
    this.resize();
    this.unsubscribe = () => store.removeEventListener("change", this.handleChange);
    this.handleChange = event => {
      const previous = this.state;
      this.state = event.detail;
      const resetCamera = previous.view !== this.state.view || previous.mode !== this.state.mode;
      const changed = resetCamera || previous.floorplan !== this.state.floorplan || previous.campusLayout !== this.state.campusLayout || previous.selected !== this.state.selected || previous.layers !== this.state.layers;
      if (changed) this.rebuild(resetCamera);
    };
    store.addEventListener("change", this.handleChange);
    this.rebuild();
    this.animate();
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight(0xb9e9ec, 0x12271f, 2.0));
    const key = new THREE.DirectionalLight(0xb7f1eb, 3.3);
    key.position.set(-180, 300, 240);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -340;
    key.shadow.camera.right = 340;
    key.shadow.camera.top = 340;
    key.shadow.camera.bottom = -340;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x3285a2, 1.8);
    rim.position.set(230, 150, -210);
    this.scene.add(rim);
  }

  addBox(parent, size, position, material, cast = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  clearScene() {
    for (const texture of this.flowTextures) texture.dispose();
    for (const object of [...this.root.children]) {
      this.root.remove(object);
      object.traverse(child => {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach(m => { m.map?.dispose?.(); m.dispose?.(); });
        else { child.material?.map?.dispose?.(); child.material?.dispose?.(); }
      });
    }
    this.clickable = [];
    this.flowTextures = [];
    this.scanBand = null;
  }

  rebuild(resetCamera = true) {
    const oldPosition = this.camera.position.clone();
    const oldTarget = this.controls.target.clone();
    this.clearScene();
    if (!this.state.floorplan) return;
    if (this.state.view === "floor") this.buildFloor();
    else if (this.state.view === "site") this.buildCampus();
    else this.buildBuildingView();
    if (resetCamera) this.applyCamera();
    else {
      this.camera.position.copy(oldPosition);
      this.controls.target.copy(oldTarget);
      this.controls.update();
    }
  }

  buildingPosition(id = "building-06") {
    const row = this.state.campusLayout?.buildings.find(item => item.id === id);
    return row?.position ?? this.state.site?.buildings?.[0]?.centerOffsetMeters ?? [-100, 0];
  }

  buildCampus() {
    const layout = this.state.campusLayout;
    if (!layout) return;
    const { width, depth } = layout.bounds;
    const floor = this.addBox(this.root, [width + 230, 1, depth + 220], [-100, -1.2, 0], mat(0x17372e), false);
    floor.receiveShadow = true;
    this.addBox(this.root, [width + 45, 0.9, depth + 42], [-100, -0.25, 0], mat(0x23423a), false);

    for (const block of layout.surroundings) this.buildContextBlock(block);
    for (const road of layout.roads) this.buildRoad(road);
    for (const patch of layout.landscape) this.buildGarden(patch);
    for (const path of layout.paths) {
      this.addBox(this.root, [path.size[0], 0.22, path.size[1]], [path.position[0], 0.15, path.position[1]], mat(0x9aaea7));
      this.addBox(this.root, [path.size[0] * 0.96, 0.08, path.size[1] * 0.62], [path.position[0], 0.3, path.position[1]], mat(0xc7d4cc));
    }

    for (const row of layout.buildings) this.buildCampusBuilding(row, row.id === "building-06");
    this.addTreeRows();
    this.addAnchorMarker();
    this.addCompass();
  }

  buildRoad(road) {
    const xRoad = road.axis === "x";
    const center = xRoad ? [-100, road.at] : [road.at, -5];
    const sidewalkSize = xRoad ? [road.length, 0.24, road.width + 2.4] : [road.width + 2.4, 0.24, road.length];
    const roadSize = xRoad ? [road.length, 0.18, road.width] : [road.width, 0.18, road.length];
    this.addBox(this.root, sidewalkSize, [center[0], 0.06, center[1]], mat(0x778c89));
    this.addBox(this.root, roadSize, [center[0], 0.19, center[1]], mat(road.class === "main" ? 0x263943 : 0x30444a));
    const dashCount = Math.floor(road.length / 12);
    for (let i = 0; i < dashCount; i++) {
      const along = -road.length / 2 + 6 + i * 12;
      const p = xRoad ? [center[0] + along, 0.3, center[1]] : [center[0], 0.3, center[1] + along];
      const sz = xRoad ? [5.2, 0.025, 0.14] : [0.14, 0.025, 5.2];
      this.addBox(this.root, sz, p, mat(0x9bafa9, { emissive: 0x304444, emissiveIntensity: 0.18 }), false);
    }
    const curbColor = mat(0xd0d9cf);
    const offset = road.width / 2 + 0.58;
    for (const side of [-1, 1]) {
      if (xRoad) this.addBox(this.root, [road.length, 0.25, 0.35], [center[0], 0.16, center[1] + side * offset], curbColor);
      else this.addBox(this.root, [0.35, 0.25, road.length], [center[0] + side * offset, 0.16, center[1]], curbColor);
    }
    if (road.id === "road-west-east") {
      const texture = this.makeFlowTexture();
      this.flowTextures.push(texture);
      const flow = new THREE.Mesh(new THREE.PlaneGeometry(road.length * 0.82, 0.62), new THREE.MeshBasicMaterial({ map: texture, color: 0x77fff1, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      flow.rotation.x = -Math.PI / 2;
      flow.position.set(center[0], 0.34, center[1]);
      this.root.add(flow);
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
    texture.repeat.set(5, 1);
    return texture;
  }

  buildGarden(patch) {
    const [x, z] = patch.position;
    const [w, d] = patch.size;
    const garden = patch.kind === "garden";
    this.addBox(this.root, [w, 0.45, d], [x, 0.35, z], mat(garden ? 0x286b58 : 0x2e604a));
    if (garden) {
      const plaza = this.addBox(this.root, [Math.min(w * 0.72, 42), 0.18, Math.min(d * 0.68, 20)], [x, 0.64, z], mat(0x9dbbb1));
      const pond = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 0.22, 32), new THREE.MeshStandardMaterial({ color: 0x238c93, emissive: 0x0c535b, emissiveIntensity: 0.55, metalness: 0.25, roughness: 0.28 }));
      pond.position.set(x, 0.85, z);
      pond.receiveShadow = true;
      this.root.add(pond);
      this.addBox(this.root, [w * 0.86, 0.08, 1.2], [x, 0.77, z - d * 0.39], mat(0xd6dfd4), false);
      plaza.userData.kind = "plaza";
    }
    const edge = mat(0x8bafa0);
    this.addBox(this.root, [w + 1, 0.12, 0.35], [x, 0.62, z - d / 2], edge, false);
    this.addBox(this.root, [w + 1, 0.12, 0.35], [x, 0.62, z + d / 2], edge, false);
  }

  buildContextBlock(block) {
    const [x, z] = block.position;
    const [w, d] = block.size;
    this.addBox(this.root, [w + 5, 0.55, d + 5], [x, 0.05, z], mat(0x34494b));
    const building = this.addBox(this.root, [w, block.height, d], [x, block.height / 2 + 0.36, z], mat(0x294650, { roughness: 0.44, metalness: 0.22 }));
    const roof = this.addBox(this.root, [w + 1, 0.45, d + 1], [x, block.height + 0.58, z], mat(0x56716f));
    building.castShadow = true;
    roof.castShadow = true;
    for (let y = 1.6; y < block.height; y += 2.8) {
      this.addBox(this.root, [w + 0.1, 0.1, d + 0.1], [x, y, z], mat(0x458087, { emissive: 0x143c41, emissiveIntensity: 0.25 }), false);
    }
  }

  buildCampusBuilding(row, selected) {
    const [x, z] = row.position;
    const [w, d] = row.footprint;
    const height = row.floors * 3.45;
    const baseMaterial = mat(selected ? 0x267c78 : 0x425b5d, { emissive: selected ? 0x0b3d3e : 0x102225, emissiveIntensity: selected ? 0.38 : 0.18 });
    this.addBox(this.root, [w + 7, 0.75, d + 7], [x, 0.42, z], mat(selected ? 0x327f76 : 0x778e83));
    this.addBox(this.root, [w + 2.5, 0.46, d + 2.5], [x, 0.96, z], mat(selected ? 0x173a42 : 0x253e45));

    for (let floor = 0; floor < row.floors; floor++) {
      const y = 1.45 + floor * 3.35;
      const glass = mat(selected ? (floor % 2 ? 0x317b83 : 0x28636f) : (floor % 2 ? 0x3a6672 : 0x315866), { roughness: 0.25, metalness: 0.42, emissive: selected ? 0x0a292e : 0x081920, emissiveIntensity: selected ? 0.28 : 0.16 });
      this.addBox(this.root, [w, 3.08, d], [x, y, z], glass);
      const band = mat(selected && floor === 6 ? 0x72e8da : 0x93b7b5, { emissive: selected && floor === 6 ? 0x179e93 : 0x153336, emissiveIntensity: selected && floor === 6 ? 0.65 : 0.2 });
      this.addBox(this.root, [w + 0.7, 0.14, d + 0.7], [x, y - 1.5, z], band, false);
      const windowRows = Math.max(3, Math.floor(w / 5.6));
      for (let col = 0; col < windowRows; col++) {
        const wx = x - w / 2 + (col + 0.5) * w / windowRows;
        this.addBox(this.root, [0.16, 2.25, 0.09], [wx, y, z + d / 2 + 0.06], mat(0x9cded7, { emissive: 0x297b79, emissiveIntensity: 0.26 }), false);
      }
    }

    this.addBox(this.root, [w + 2.4, 0.68, d + 2.4], [x, height + 0.92, z], mat(selected ? 0x4b9392 : 0x547981));
    if (this.state.layers.heat && this.state.view === "site") {
      const heat = row.id === "building-06" ? 0.78 : 0.24 + (Number(row.id.slice(-2)) % 5) * 0.12;
      const heatColor = new THREE.Color().setHSL(0.55 - heat * 0.48, 0.86, 0.53);
      const roofHeat = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, 0.1, d + 1.4), new THREE.MeshBasicMaterial({ color: heatColor, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending }));
      roofHeat.position.set(x, height + 1.31, z);
      this.root.add(roofHeat);
    }
    const roofUnitMat = mat(0x192c36, { metalness: 0.28 });
    this.addBox(this.root, [w * 0.36, 1.25, d * 0.28], [x, height + 1.85, z], roofUnitMat);
    this.addBox(this.root, [w * 0.22, 0.8, d * 0.2], [x - w * 0.28, height + 1.6, z + d * 0.2], roofUnitMat);

    if (selected) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.91, 1, 72), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.88, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.91, z);
      ring.scale.set(w / 2 + 11, d / 2 + 11, 1);
      this.root.add(ring);
      const scanMaterial = new THREE.MeshBasicMaterial({ color: 0x6bfff0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      this.scanBand = new THREE.Mesh(new THREE.PlaneGeometry(w + 3, d + 3), scanMaterial);
      this.scanBand.rotation.x = -Math.PI / 2;
      this.scanBand.position.set(x, 2, z);
      this.scanBand.userData.maxHeight = height;
      this.root.add(this.scanBand);
    }

    const label = this.makeBuildingLabel(row.name, row.floors, selected);
    label.position.set(x, height + 8, z);
    label.scale.set(selected ? 25 : 19, selected ? 5.9 : 4.5, 1);
    this.root.add(label);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(w + 2, height + 5, d + 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.set(x, height / 2 + 1, z);
    hit.userData = { kind: "building", id: row.id, title: row.name, subtitle: `${row.floors}层 · ${row.usage}` };
    this.root.add(hit);
    this.clickable.push(hit);
  }

  makeBuildingLabel(name, floors, selected) {
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
    ctx.fillStyle = "#96b2bc";
    ctx.font = "24px Microsoft YaHei, sans-serif";
    ctx.fillText(selected ? "智萃科技中心" : "创新研发空间", 27, 82);
    ctx.textAlign = "right";
    ctx.fillStyle = selected ? "#b8eee8" : "#91b2bc";
    ctx.font = "25px Microsoft YaHei, sans-serif";
    ctx.fillText(`${floors}F`, 484, 62);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.renderOrder = 8;
    return sprite;
  }

  addTreeRows() {
    const positions = [];
    for (let x = -218; x <= 18; x += 15) {
      positions.push([x, -83], [x + 6, 91]);
    }
    for (let z = -75; z <= 75; z += 15) {
      positions.push([-224, z], [24, z + 5]);
    }
    for (let x = -182; x <= -26; x += 19) {
      positions.push([x, -24], [x + 7, 31]);
    }
    const trunkGeometry = new THREE.CylinderGeometry(0.42, 0.62, 4.2, 7);
    const crownGeometry = new THREE.IcosahedronGeometry(2.25, 1);
    const trunk = new THREE.InstancedMesh(trunkGeometry, mat(0x725b46), positions.length);
    const crown = new THREE.InstancedMesh(crownGeometry, mat(0x277c64, { roughness: 0.9 }), positions.length);
    const dummy = new THREE.Object3D();
    positions.forEach(([x, z], i) => {
      const scale = 0.8 + ((i * 17) % 7) * 0.07;
      dummy.position.set(x, 2.5, z);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, 5.3 * scale, z);
      dummy.scale.set(scale, scale * 0.88, scale);
      dummy.updateMatrix();
      crown.setMatrixAt(i, dummy.matrix);
    });
    trunk.castShadow = true;
    crown.castShadow = true;
    this.root.add(trunk, crown);
  }

  addAnchorMarker() {
    const [x, z] = [0, 0];
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.24, 24), new THREE.MeshBasicMaterial({ color: 0xf0b951 }));
    pin.position.set(x, 0.9, z);
    this.root.add(pin);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 5, 10), new THREE.MeshBasicMaterial({ color: 0xf0b951 }));
    pole.position.set(x, 3.35, z);
    this.root.add(pole);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.82, 18, 12), new THREE.MeshBasicMaterial({ color: 0xffca61, emissive: 0xa4520d, emissiveIntensity: 0.65 }));
    beacon.position.set(x, 6.1, z);
    this.root.add(beacon);
    const tag = this.makeBuildingLabel("园区锚点", 0, false);
    tag.scale.set(18, 4.2, 1);
    tag.position.set(x + 5, 9, z);
    this.root.add(tag);
  }

  addCompass() {
    const origin = new THREE.Vector3(-211, 0.8, -69);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), origin, 14, C.cyan, 3.2, 1.8);
    this.root.add(arrow);
  }

  buildBuildingView() {
    const row = this.state.campusLayout?.buildings.find(item => item.id === "building-06") ?? {
      id: "building-06", name: "6号楼", position: this.buildingPosition(), footprint: [42, 26], floors: 9, usage: "智萃科技中心 · 7楼",
    };
    const [x, z] = row.position;
    this.addBox(this.root, [118, 0.9, 100], [x, -0.6, z], mat(0x1c493d), false);
    this.addBox(this.root, [72, 0.3, 60], [x, 0.05, z], mat(0x677e79), false);
    this.addBox(this.root, [44, 0.24, 30], [x, 0.28, z], mat(0x9dbbb1), false);
    this.buildCampusBuilding(row, true);
    this.addBox(this.root, [18, 4, 12], [x + 55, 2, z - 22], mat(0x2f5556));
    this.addBox(this.root, [14, 3, 10], [x - 52, 1.5, z + 23], mat(0x2f5556));
    this.addTreeCluster(x - 40, z + 34);
    this.addTreeCluster(x + 48, z - 32);
    for (let i = -2; i <= 2; i++) {
      this.addBox(this.root, [1.7, 0.28, 3.6], [x + i * 4, 0.26, z + 20], mat(0xcbd4c8), false);
    }
    this.addFloorBadges(row.floors * 3.45, x, z);
  }

  addTreeCluster(x, z) {
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5;
      const tx = x + Math.cos(a) * 7;
      const tz = z + Math.sin(a) * 7;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 2.4, 7), mat(0x725b46));
      trunk.position.set(tx, 1.4, tz);
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), mat(0x2d8a6c));
      leaves.position.set(tx, 3.1, tz);
      leaves.castShadow = true;
      this.root.add(trunk, leaves);
    }
  }

  addFloorBadges(height, x, z) {
    for (let i = 0; i < 9; i++) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(i === 6 ? 1.2 : 0.58, 16, 12), new THREE.MeshBasicMaterial({ color: i === 6 ? C.cyan : 0x78959a }));
      marker.position.set(x + 25, 2 + i * 3.6, z);
      marker.userData = { kind: "floor", id: `f${String(i + 1).padStart(2, "0")}`, title: `${i + 1}楼`, subtitle: i === 6 ? "当前演示楼层" : "楼层资料待接入" };
      this.root.add(marker);
      this.clickable.push(marker);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 72), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.76, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, height * 0.78, z);
    ring.scale.set(27, 18, 1);
    this.root.add(ring);
  }

  buildFloor() {
    const data = this.state.floorplan;
    const g = new THREE.Group();
    const w = data.bounds.width / 1000;
    const d = data.bounds.depth / 1000;
    this.addBox(g, [w + 1.8, 0.55, d + 1.8], [0, -0.48, 0], mat(0x183d3f), false);
    this.addBox(g, [w + 24, 0.2, d + 24], [0, -0.86, 0], mat(0x142d2a), false);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.06, d)), new THREE.LineBasicMaterial({ color: 0x61e0d6, transparent: true, opacity: 0.9 }));
    outline.position.y = -0.14;
    g.add(outline);

    const selected = this.state.selected;
    for (const room of (this.state.layers.spaces ? data.rooms : [])) {
      const xs = room.polygon.map(p => p[0] / 1000);
      const zs = room.polygon.map(p => p[1] / 1000);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const use = Math.max(0, Math.min(1, room.occupancy / Math.max(1, room.areaM2 / 6)));
      const heatColor = new THREE.Color(0x32d38d).lerp(new THREE.Color(0xf3a64a), use);
      const roomColor = this.state.layers.heat ? heatColor : new THREE.Color(C.room);
      const roomMesh = new THREE.Mesh(
        new THREE.BoxGeometry(maxX - minX - 0.12, 0.16, maxZ - minZ - 0.12),
        new THREE.MeshStandardMaterial({ color: room.id === selected.id ? C.selected : roomColor, emissive: this.state.layers.heat ? heatColor : new THREE.Color(0x125b5b), emissiveIntensity: room.id === selected.id ? 0.72 : this.state.layers.heat ? 0.35 : 0.4, transparent: true, opacity: room.id === selected.id ? 0.84 : 0.62, roughness: 0.42 }),
      );
      roomMesh.position.set((minX + maxX) / 2 - w / 2, 0.1, d / 2 - (minZ + maxZ) / 2);
      roomMesh.userData = { kind: "room", id: room.id, title: room.name, subtitle: `${room.areaM2} m² · ${room.occupancy} 人` };
      g.add(roomMesh);
      this.clickable.push(roomMesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(roomMesh.geometry), new THREE.LineBasicMaterial({ color: 0x9dece4, transparent: true, opacity: 0.55 }));
      edges.position.copy(roomMesh.position);
      g.add(edges);
    }

    if (this.state.layers.equipment) {
      for (const device of data.equipments) {
        const [mx, my] = device.position;
        const color = device.status === "warning" ? C.warning : C.equipment;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.44, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
        stem.position.set(mx / 1000 - w / 2, 0.34, d / 2 - my / 1000);
        g.add(stem);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 }));
        dot.position.set(mx / 1000 - w / 2, 0.62, d / 2 - my / 1000);
        dot.userData = { kind: "equipment", id: device.id, title: device.label, subtitle: `${device.status === "warning" ? "需关注" : "在线"} · ${device.reading}${device.unit}` };
        g.add(dot);
        this.clickable.push(dot);
        if (device.status === "warning" && this.state.layers.alerts) {
          const alertRing = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 28), new THREE.MeshBasicMaterial({ color: C.warning, transparent: true, opacity: 0.78, side: THREE.DoubleSide }));
          alertRing.rotation.x = -Math.PI / 2;
          alertRing.position.set(mx / 1000 - w / 2, 0.16, d / 2 - my / 1000);
          g.add(alertRing);
        }
      }
    }
    const border = new THREE.GridHelper(30, 24, 0x28616d, 0x1d4552);
    border.position.y = -0.03;
    border.material.transparent = true;
    border.material.opacity = 0.17;
    g.add(border);
    this.root.add(g);
  }

  applyCamera() {
    let target;
    let position;
    const isFloor = this.state.view === "floor";
    if (isFloor) {
      target = new THREE.Vector3(0, 0, 0);
      position = new THREE.Vector3(0.1, this.state.mode === "2d" ? 54 : 35, this.state.mode === "2d" ? 0.12 : 43);
      this.camera.fov = this.state.mode === "2d" ? 36 : 43;
      this.controls.maxDistance = 90;
      this.controls.minDistance = 14;
      this.controls.maxPolarAngle = this.state.mode === "2d" ? 0.02 : Math.PI * 0.48;
    } else {
      const [x, z] = this.buildingPosition();
      if (this.state.view === "site") {
        target = new THREE.Vector3(x, 5, z);
        position = this.state.mode === "2d" ? new THREE.Vector3(x + 0.1, 490, z + 0.12) : new THREE.Vector3(x + 248, 286, z + 326);
        this.controls.maxDistance = 900;
      } else {
        target = new THREE.Vector3(x, 14, z);
        position = this.state.mode === "2d" ? new THREE.Vector3(x + 0.1, 145, z + 0.12) : new THREE.Vector3(x + 92, 118, z + 144);
        this.controls.maxDistance = 360;
      }
      this.camera.fov = 40;
      this.controls.minDistance = 4;
      this.controls.maxPolarAngle = this.state.mode === "2d" ? 0.02 : Math.PI * 0.49;
    }
    this.camera.updateProjectionMatrix();
    this.cameraGoal = position;
    this.targetGoal = target;
  }

  setZoom(direction) {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    offset.multiplyScalar(direction < 0 ? 1.18 : 0.84);
    this.camera.position.copy(target.clone().add(offset));
    this.controls.update();
  }

  resetCamera() { this.applyCamera(); }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const matches = this.raycaster.intersectObjects(this.clickable, false);
    if (!matches.length) return;
    const item = matches[0].object.userData;
    if (item.kind === "building") {
      if (item.id === "building-06") {
        this.store.setSelected(item);
        this.store.setView("building");
      } else this.onSelect(item);
    }
    if (item.kind === "floor") {
      if (item.id === "f07") this.store.setView("floor");
      else this.onSelect({ ...item, kind: "floor" });
    }
    if (item.kind === "room" || item.kind === "equipment") this.onSelect(item);
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
    if (this.cameraGoal && this.targetGoal) {
      this.camera.position.lerp(this.cameraGoal, 0.095);
      this.controls.target.lerp(this.targetGoal, 0.095);
      if (this.camera.position.distanceTo(this.cameraGoal) < 0.15 && this.controls.target.distanceTo(this.targetGoal) < 0.08) {
        this.camera.position.copy(this.cameraGoal);
        this.controls.target.copy(this.targetGoal);
        this.cameraGoal = null;
        this.targetGoal = null;
      }
    }
    if (this.flowTextures.length) {
      for (const texture of this.flowTextures) texture.offset.x = (texture.offset.x - 0.0022 + 1) % 1;
    }
    if (this.scanBand) {
      const height = this.scanBand.userData.maxHeight;
      this.scanBand.position.y = 1.5 + ((Math.sin(performance.now() * 0.00065) + 1) / 2) * Math.max(2, height - 3);
      this.scanBand.material.opacity = 0.11 + (Math.sin(performance.now() * 0.0015) + 1) * 0.045;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this._frame);
    this.resizeObserver.disconnect();
    this.unsubscribe?.();
    this.renderer.dispose();
  }
}
