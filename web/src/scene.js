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
      const changed = resetCamera || previous.floorplan !== this.state.floorplan || previous.activeRoomId !== this.state.activeRoomId || previous.campusLayout !== this.state.campusLayout || previous.selected !== this.state.selected || previous.layers !== this.state.layers;
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
    mesh.position.set(position[0] - (parent.userData.originX ?? 0), position[1], position[2] - (parent.userData.originZ ?? 0));
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
    if (this.state.view === "room") this.buildRoomView();
    else if (this.state.view === "floor") this.buildFloor();
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
    return row?.position ?? this.state.site?.buildings?.[0]?.centerOffsetMeters ?? [0, 0];
  }

  buildCampus() {
    const layout = this.state.campusLayout;
    if (!layout) return;
    const { width, depth } = layout.bounds;
    const [cx, cz] = layout.bounds.center ?? [0, 0];
    const floor = this.addBox(this.root, [width + 90, 1, depth + 90], [cx, -1.2, cz], mat(0x17372e), false);
    floor.receiveShadow = true;
    this.addBox(this.root, [width + 20, 0.9, depth + 20], [cx, -0.25, cz], mat(0x23423a), false);

    for (const block of layout.surroundings) this.buildContextBlock(block);
    for (const road of layout.roads) this.buildRoad(road);
    for (const patch of layout.landscape) this.buildGarden(patch);
    for (const path of layout.paths) {
      const walk = this.addBox(this.root, [path.size[0], 0.22, path.size[1]], [path.position[0], 0.15, path.position[1]], mat(0x9aaea7));
      const paving = this.addBox(this.root, [path.size[0] * 0.96, 0.08, path.size[1] * 0.62], [path.position[0], 0.3, path.position[1]], mat(0xc7d4cc));
      walk.rotation.y = paving.rotation.y = THREE.MathUtils.degToRad(path.rotation ?? 0);
    }

    for (const row of layout.buildings) this.buildCampusBuilding(row, row.id === "building-06");
    this.addTreeRows();
    this.addCompass();
  }

  buildRoad(road) {
    const points = road.points ?? [];
    for (let segment = 0; segment < points.length - 1; segment++) {
      const [x1, z1] = points[segment];
      const [x2, z2] = points[segment + 1];
      const length = Math.hypot(x2 - x1, z2 - z1);
      const group = new THREE.Group();
      group.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2);
      group.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      this.root.add(group);
      this.addBox(group, [length + 0.5, 0.24, road.width + 2.4], [0, 0.06, 0], mat(0x778c89));
      this.addBox(group, [length + 0.5, 0.18, road.width], [0, 0.19, 0], mat(road.class === "main" ? 0x263943 : 0x30444a));
      for (let along = -length / 2 + 6; along < length / 2 - 3; along += 12) {
        this.addBox(group, [5.2, 0.025, 0.14], [along, 0.3, 0], mat(0x9bafa9, { emissive: 0x304444, emissiveIntensity: 0.18 }), false);
      }
      for (const side of [-1, 1]) {
        this.addBox(group, [length + 0.5, 0.25, 0.35], [0, 0.16, side * (road.width / 2 + 0.58)], mat(0xd0d9cf));
      }
      if (road.id === "road-north") {
        const texture = this.makeFlowTexture();
        this.flowTextures.push(texture);
        const flow = new THREE.Mesh(new THREE.PlaneGeometry(length * 0.82, 0.62), new THREE.MeshBasicMaterial({ map: texture, color: 0x77fff1, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        flow.rotation.x = -Math.PI / 2;
        flow.position.y = 0.34;
        group.add(flow);
      }
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
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = -Math.PI / 4;
    group.userData.originX = x;
    group.userData.originZ = z;
    this.root.add(group);
    const height = row.floors * 3.45;
    const baseMaterial = mat(selected ? 0x267c78 : 0x425b5d, { emissive: selected ? 0x0b3d3e : 0x102225, emissiveIntensity: selected ? 0.38 : 0.18 });
    this.addBox(group, [w + 7, 0.75, d + 7], [x, 0.42, z], mat(selected ? 0x327f76 : 0x778e83));
    this.addBox(group, [w + 2.5, 0.46, d + 2.5], [x, 0.96, z], mat(selected ? 0x173a42 : 0x253e45));

    for (let floor = 0; floor < row.floors; floor++) {
      const y = 1.45 + floor * 3.35;
      const glass = mat(selected ? (floor % 2 ? 0x317b83 : 0x28636f) : (floor % 2 ? 0x3a6672 : 0x315866), { roughness: 0.25, metalness: 0.42, emissive: selected ? 0x0a292e : 0x081920, emissiveIntensity: selected ? 0.28 : 0.16 });
      this.addBox(group, [w, 3.08, d], [x, y, z], glass);
      const band = mat(selected && floor === 6 ? 0x72e8da : 0x93b7b5, { emissive: selected && floor === 6 ? 0x179e93 : 0x153336, emissiveIntensity: selected && floor === 6 ? 0.65 : 0.2 });
      this.addBox(group, [w + 0.7, 0.14, d + 0.7], [x, y - 1.5, z], band, false);
      const windowRows = Math.max(3, Math.floor(w / 5.6));
      for (let col = 0; col < windowRows; col++) {
        const wx = x - w / 2 + (col + 0.5) * w / windowRows;
        this.addBox(group, [0.16, 2.25, 0.09], [wx, y, z + d / 2 + 0.06], mat(0x9cded7, { emissive: 0x297b79, emissiveIntensity: 0.26 }), false);
      }
    }

    this.addBox(group, [w + 2.4, 0.68, d + 2.4], [x, height + 0.92, z], mat(selected ? 0x4b9392 : 0x547981));
    if (this.state.layers.heat && this.state.view === "site") {
      const heat = row.id === "building-06" ? 0.78 : 0.24 + (Number(row.id.slice(-2)) % 5) * 0.12;
      const heatColor = new THREE.Color().setHSL(0.55 - heat * 0.48, 0.86, 0.53);
      const roofHeat = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, 0.1, d + 1.4), new THREE.MeshBasicMaterial({ color: heatColor, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending }));
      roofHeat.position.set(0, height + 1.31, 0);
      group.add(roofHeat);
    }
    const roofUnitMat = mat(0x192c36, { metalness: 0.28 });
    this.addBox(group, [w * 0.36, 1.25, d * 0.28], [x, height + 1.85, z], roofUnitMat);
    this.addBox(group, [w * 0.22, 0.8, d * 0.2], [x - w * 0.28, height + 1.6, z + d * 0.2], roofUnitMat);

    if (selected) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.91, 1, 72), new THREE.MeshBasicMaterial({ color: C.cyan, transparent: true, opacity: 0.88, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.91, 0);
      ring.scale.set(w / 2 + 11, d / 2 + 11, 1);
      group.add(ring);
      const scanMaterial = new THREE.MeshBasicMaterial({ color: 0x6bfff0, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      this.scanBand = new THREE.Mesh(new THREE.PlaneGeometry(w + 3, d + 3), scanMaterial);
      this.scanBand.rotation.x = -Math.PI / 2;
      this.scanBand.position.set(0, 2, 0);
      this.scanBand.userData.maxHeight = height;
      group.add(this.scanBand);
    }

    const label = this.makeBuildingLabel(row.name, row.floors, selected);
    label.position.set(0, height + 8, 0);
    label.scale.set(selected ? 25 : 19, selected ? 5.9 : 4.5, 1);
    group.add(label);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(w + 2, height + 5, d + 2), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.set(0, height / 2 + 1, 0);
    hit.userData = { kind: "building", id: row.id, title: row.name, subtitle: `${row.floors}层 · ${row.usage}` };
    group.add(hit);
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
    const positions = this.state.campusLayout?.treePositions ?? [];
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
    const origin = new THREE.Vector3(-339, 0.8, -131);
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
    this.addFloorBadges(row.floors * 3.45, x, z, row.floors);
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

  addFloorBadges(height, x, z, count = 8) {
    for (let i = 0; i < count; i++) {
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
    const [w, d] = item.size.map(value => value / 1000);
    const wood = mat(0xb5d8d5, { metalness: 0.1 });
    const dark = mat(0x356276);
    if (item.kind === "chair") {
      this.addBox(parent, [Math.min(w, 0.66), 0.14, Math.min(d, 0.66)], [x, 0.48, z], dark);
      this.addBox(parent, [Math.min(w, 0.66), 0.6, 0.12], [x, 0.83, z + d * 0.35], dark);
    } else if (item.kind === "shelf") {
      this.addBox(parent, [w, 1.8, d], [x, 1.0, z], mat(0x5e8790));
      for (const height of [0.7, 1.2, 1.7]) this.addBox(parent, [w + 0.06, 0.08, d + 0.06], [x, height, z], wood);
    } else if (item.kind === "cabinet") {
      this.addBox(parent, [w, 1.15, d], [x, 0.62, z], mat(0x547b85));
      for (let i = 1; i < 5; i++) this.addBox(parent, [0.045, 0.7, d + 0.03], [x - w / 2 + i * w / 5, 0.66, z], mat(0x91bfc1));
    } else if (item.kind === "printer") {
      this.addBox(parent, [w + 0.25, 0.28, d + 0.25], [x, 0.16, z], wood);
      for (let i = 0; i < 6; i++) {
        const px = x - w / 2 + (i + 0.5) * w / 6;
        this.addBox(parent, [Math.min(1.2, w / 7), 1.05, d * 0.72], [px, 0.84, z], mat(0x557f89));
        this.addBox(parent, [Math.min(0.8, w / 8), 0.42, d * 0.35], [px, 1.4, z], mat(0x9be4dc));
      }
    } else if (item.kind === "sofa") {
      this.addBox(parent, [w, 0.48, d], [x, 0.4, z], mat(0x477e82));
      this.addBox(parent, [w, 0.75, 0.22], [x, 0.78, z + d * 0.42], mat(0x477e82));
    } else {
      const surfaceHeight = item.kind === "conference" ? 0.84 : 0.76;
      this.addBox(parent, [w, 0.16, d], [x, surfaceHeight, z], wood);
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
        this.addBox(parent, [0.14, surfaceHeight - 0.1, 0.14], [x + dx * (w / 2 - 0.24), (surfaceHeight - 0.1) / 2, z + dz * (d / 2 - 0.2)], dark);
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

  buildFloor() {
    const data = this.state.floorplan;
    const width = data.bounds.width / 1000;
    const depth = data.bounds.depth / 1000;
    this.addBox(this.root, [width + 3.5, 0.4, depth + 3.5], [0, -0.45, 0], mat(0x193b43), false);
    this.addBox(this.root, [width + 0.3, 0.24, depth + 0.3], [0, -0.09, 0], mat(0xb7d0d1), false);
    for (const room of (this.state.layers.spaces ? data.rooms : [])) {
      const b = this.roomBounds(room);
      const roomWidth = b.maxX - b.minX, roomDepth = b.maxY - b.minY;
      const cx = (b.minX + b.maxX) / 2 - width / 2;
      const cz = depth / 2 - (b.minY + b.maxY) / 2;
      const intensity = Math.min(1, room.occupancy / Math.max(1, room.areaM2 / 6));
      const heat = new THREE.Color(0x43c494).lerp(new THREE.Color(0xe8ad56), intensity);
      const color = this.state.layers.heat ? heat : new THREE.Color(room.id === this.state.selected.id ? 0x73f2e5 : room.enclosed ? 0x5297aa : 0x42798f);
      const floor = this.addBox(this.root, [roomWidth - 0.13, 0.08, roomDepth - 0.13], [cx, 0.1, cz], mat(color, { emissive: color, emissiveIntensity: 0.2, transparent: true, opacity: room.enclosed ? 0.91 : 0.72 }), false);
      floor.userData = { kind: "room", id: room.id, title: room.name, subtitle: `${room.areaM2} m² · 点击进入` };
      this.clickable.push(floor);
      this.addRoomWalls(this.root, b, cx, cz, room);
    }
    for (const item of data.furnishings ?? []) {
      const [x, z] = this.floorPosition(item.position[0], item.position[1], width, depth);
      this.addFurniture(this.root, item, [x, z]);
    }
    if (this.state.layers.equipment) for (const device of data.equipments) {
      const [x, z] = this.floorPosition(device.position[0], device.position[1], width, depth);
      const color = device.status === "warning" ? C.warning : C.equipment;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 }));
      dot.position.set(x, 1.82, z);
      dot.userData = { kind: "equipment", id: device.id, title: device.label, subtitle: `${device.reading}${device.unit}` };
      this.root.add(dot);
      this.clickable.push(dot);
    }
  }

  buildRoomView() {
    const data = this.state.floorplan;
    const room = data.rooms.find(item => item.id === this.state.activeRoomId) ?? data.rooms[0];
    const b = this.roomBounds(room);
    const width = b.maxX - b.minX, depth = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.addBox(this.root, [width + 4, 0.35, depth + 4], [0, -0.43, 0], mat(0x18373f), false);
    this.addBox(this.root, [width, 0.18, depth], [0, 0, 0], mat(0x73b6c0, { emissive: 0x1a5a6b, emissiveIntensity: 0.25 }));
    this.addRoomWalls(this.root, b, 0, 0, room);
    for (const item of (data.furnishings ?? []).filter(value => value.roomId === room.id)) {
      const x = item.position[0] / 1000 - cx;
      const z = cy - item.position[1] / 1000;
      this.addFurniture(this.root, item, [x, z]);
    }
    for (const device of data.equipments.filter(value => value.roomId === room.id)) {
      const color = device.status === "warning" ? C.warning : C.equipment;
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), new THREE.MeshBasicMaterial({ color }));
      sphere.position.set(device.position[0] / 1000 - cx, 2.1, cy - device.position[1] / 1000);
      sphere.userData = { kind: "equipment", id: device.id, title: device.label, subtitle: `${device.reading}${device.unit}` };
      this.root.add(sphere);
      this.clickable.push(sphere);
    }
  }

  applyCamera() {
    let target;
    let position;
    const isFloor = this.state.view === "floor";
    if (this.state.view === "room") {
      const room = this.state.floorplan?.rooms.find(item => item.id === this.state.activeRoomId) ?? this.state.floorplan?.rooms[0];
      const b = room ? this.roomBounds(room) : { minX: 0, maxX: 12, minY: 0, maxY: 12 };
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
      target = new THREE.Vector3(0, 0.4, 0);
      position = this.state.mode === "2d" ? new THREE.Vector3(0.1, span * 2.1, 0.12) : new THREE.Vector3(span * 0.72, span * 1.03, span * 1.18);
      this.camera.fov = 43;
      this.controls.minDistance = 3;
      this.controls.maxDistance = span * 4;
      this.controls.maxPolarAngle = this.state.mode === "2d" ? 0.02 : Math.PI * 0.48;
    } else if (isFloor) {
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
        position = this.state.mode === "2d" ? new THREE.Vector3(x + 0.1, 950, z + 0.12) : new THREE.Vector3(x + 365, 515, z + 625);
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
    if (item.kind === "room") { this.onSelect(item); this.store.update({ activeRoomId: item.id, view: "room" }); }
    if (item.kind === "equipment") this.onSelect(item);
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
