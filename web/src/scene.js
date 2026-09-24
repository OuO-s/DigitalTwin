import * as THREE from "three";
import { OrbitControls } from "../lib/OrbitControls.js";

const COLORS = {
  cyan: 0x41d2c9,
  room: 0x42c9c2,
  selected: 0x73f2e5,
  equipment: 0x68aee3,
  warning: 0xf1b958,
  floor: 0x122b37,
};

export class TwinScene {
  constructor(host, store, onSelect) {
    this.host = host;
    this.store = store;
    this.onSelect = onSelect;
    this.clickable = [];
    this.pickables = [];
    this.state = store.state;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x081722);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.domElement.setAttribute("aria-label", "可交互的园区与楼层三维场景");
    host.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 6000);
    this.camera.position.set(380, 480, 520);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 1800;
    this.controls.target.set(0, 0, 0);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.addLights();
    this.loadMap();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.renderer.domElement.addEventListener("pointerup", event => this.pick(event));
    this.resize();
    this.unsubscribe = () => store.removeEventListener("change", this.handleChange);
    this.handleChange = event => {
      const previous = this.state;
      this.state = event.detail;
      const resetCamera = previous.view !== this.state.view || previous.mode !== this.state.mode;
      const sceneChanged = resetCamera || previous.floorplan !== this.state.floorplan || previous.selected !== this.state.selected || previous.layers !== this.state.layers;
      if (sceneChanged) this.rebuild(resetCamera);
    };
    store.addEventListener("change", this.handleChange);
    this.rebuild();
    this.animate();
  }

  addLights() {
    this.scene.add(new THREE.HemisphereLight(0xb8e8ef, 0x071019, 2.25));
    const key = new THREE.DirectionalLight(0x91f3ee, 3.2);
    key.position.set(-200, 420, 250);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x2a7ea5, 2.1);
    rim.position.set(340, 180, -260);
    this.scene.add(rim);
  }

  async loadMap() {
    try {
      const [texture, metadata] = await Promise.all([
        new THREE.TextureLoader().loadAsync("/assets/maps/site.png"),
        fetch("/assets/maps/site.json").then(r => r.ok ? r.json() : Promise.reject(new Error("map metadata unavailable"))),
      ]);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.mapMetadata = metadata;
      this.mapTexture = texture;
      this.buildGround();
      document.querySelector("#map-loading")?.classList.add("hidden");
      this.rebuild();
    } catch (error) {
      console.error("实景底图载入失败", error);
      const loading = document.querySelector("#map-loading");
      if (loading) loading.innerHTML = '<span class="loading-ring"></span><span>底图未就绪，可运行 python server/fetch_map.py 获取</span>';
    }
  }

  buildGround() {
    if (!this.mapTexture) return;
    this.root.children.filter(x => x.userData.kind === "ground").forEach(x => this.root.remove(x));
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800),
      new THREE.MeshBasicMaterial({ map: this.mapTexture, color: 0x91b7bb, side: THREE.DoubleSide }),
    );
    ground.rotation.x = -Math.PI / 2;
    const offset = this.mapMetadata.centerOffsetMeters ?? [0, 0];
    ground.position.set(offset[0], -0.4, -offset[1]);
    ground.userData.kind = "ground";
    this.root.add(ground);
    const veil = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800),
      new THREE.MeshBasicMaterial({ color: 0x061824, transparent: true, opacity: 0.44, side: THREE.DoubleSide }),
    );
    veil.rotation.x = -Math.PI / 2;
    veil.position.set(offset[0], -0.38, -offset[1]);
    veil.userData.kind = "ground";
    this.root.add(veil);
  }

  clearScene() {
    for (const object of [...this.root.children]) {
      if (object.userData.kind !== "ground") {
        this.root.remove(object);
        object.traverse(child => {
          child.geometry?.dispose?.();
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
          else child.material?.dispose?.();
        });
      }
    }
    this.clickable = [];
    this.pickables = [];
  }

  rebuild(resetCamera = true) {
    const oldPosition = this.camera.position.clone();
    const oldTarget = this.controls.target.clone();
    this.clearScene();
    if (!this.state.floorplan) return;
    if (this.state.view === "floor") this.buildFloor();
    else this.buildSiteAndBuilding();
    if (resetCamera) this.applyCamera();
    else {
      this.camera.position.copy(oldPosition);
      this.controls.target.copy(oldTarget);
      this.controls.update();
    }
  }

  buildSiteAndBuilding() {
    const group = new THREE.Group();
    group.userData.kind = "buildingGroup";
    const width = 42;
    const depth = 26;
    const height = 32.4;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(width + 9, 0.5, depth + 9),
      new THREE.MeshStandardMaterial({ color: 0x0b4b55, emissive: 0x0b5559, emissiveIntensity: 0.55, transparent: true, opacity: 0.58 }),
    );
    base.position.y = 0.15;
    group.add(base);
    for (let floor = 0; floor < 9; floor++) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(width, 3.45, depth),
        new THREE.MeshStandardMaterial({ color: floor % 2 ? 0x23505e : 0x1b414e, roughness: 0.38, metalness: 0.3, transparent: true, opacity: 0.86 }),
      );
      slab.position.y = 1.9 + floor * 3.6;
      group.add(slab);
      const band = new THREE.Mesh(new THREE.BoxGeometry(width + 0.8, 0.11, depth + 0.8), new THREE.MeshBasicMaterial({ color: floor === 6 ? COLORS.cyan : 0x488496, transparent: true, opacity: floor === 6 ? 0.95 : 0.48 }));
      band.position.y = 3.68 + floor * 3.6;
      group.add(band);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width + 2, 0.6, depth + 2), new THREE.MeshStandardMaterial({ color: 0x347180, emissive: 0x124b53, emissiveIntensity: 0.7 }));
    roof.position.y = height + 2.5;
    group.add(roof);
    const pick = new THREE.Mesh(new THREE.BoxGeometry(width + 10, height + 8, depth + 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    pick.position.y = height / 2 + 1;
    pick.userData = { kind: "building", id: "building-06", title: "6号楼", subtitle: "7楼 · 5 个空间 · 7 台演示设备" };
    group.add(pick);
    this.clickable.push(pick);
    this.root.add(group);
    if (this.state.view === "building") {
      this.addHalo(0, width / 2 + 12, depth / 2 + 12);
      this.addFloorBadges(height);
    }
    this.addNorthMark();
  }

  addHalo(y, width, depth) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 72), new THREE.MeshBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.72, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, y + 0.08, 0);
    ring.scale.set(width, depth, 1);
    this.root.add(ring);
  }

  addFloorBadges(height) {
    for (let i = 0; i < 9; i++) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(i === 6 ? 1.15 : 0.54, 12, 10), new THREE.MeshBasicMaterial({ color: i === 6 ? COLORS.cyan : 0x61818a }));
      marker.position.set(25, 2 + i * 3.6, 0);
      marker.userData = { kind: "floor", id: `f${String(i + 1).padStart(2, "0")}`, title: `${i + 1}楼`, subtitle: i === 6 ? "当前演示楼层" : "楼层资料待接入" };
      this.root.add(marker);
      this.clickable.push(marker);
    }
    this.addHalo(height * 0.78, 26, 18);
  }

  addNorthMark() {
    const helper = new THREE.GridHelper(800, 32, 0x3b7f86, 0x2a5a65);
    helper.position.y = -0.31;
    helper.material.transparent = true;
    helper.material.opacity = 0.12;
    this.root.add(helper);
    const axis = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(360, 0, 325), 34, COLORS.cyan, 9, 4);
    this.root.add(axis);
  }

  buildFloor() {
    const data = this.state.floorplan;
    const g = new THREE.Group();
    const w = data.bounds.width / 1000;
    const d = data.bounds.depth / 1000;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 1.5, 0.6, d + 1.5), new THREE.MeshStandardMaterial({ color: 0x0a2836, emissive: 0x0b3941, emissiveIntensity: 0.7, metalness: 0.25, roughness: 0.46 }));
    slab.position.y = -0.38;
    g.add(slab);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.06, d)), new THREE.LineBasicMaterial({ color: 0x61e0d6, transparent: true, opacity: 0.8 }));
    outline.position.y = -0.02;
    g.add(outline);

    const selected = this.state.selected;
    for (const room of (this.state.layers.spaces ? data.rooms : [])) {
      const xs = room.polygon.map(p => p[0] / 1000);
      const zs = room.polygon.map(p => p[1] / 1000);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const roomMesh = new THREE.Mesh(
        new THREE.BoxGeometry(maxX - minX - 0.12, 0.16, maxZ - minZ - 0.12),
        new THREE.MeshStandardMaterial({ color: room.id === selected.id ? COLORS.selected : COLORS.room, emissive: room.id === selected.id ? 0x248f8c : 0x125b5b, emissiveIntensity: room.id === selected.id ? 0.75 : 0.44, transparent: true, opacity: room.id === selected.id ? 0.72 : 0.46, roughness: 0.42 }),
      );
      roomMesh.position.set((minX + maxX) / 2 - w / 2, 0.08, d / 2 - (minZ + maxZ) / 2);
      roomMesh.userData = { kind: "room", id: room.id, title: room.name, subtitle: `${room.areaM2} m² · ${room.occupancy} 人` };
      g.add(roomMesh);
      this.clickable.push(roomMesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(roomMesh.geometry), new THREE.LineBasicMaterial({ color: 0x9dece4, transparent: true, opacity: 0.44 }));
      edges.position.copy(roomMesh.position);
      g.add(edges);
    }

    if (this.state.layers.equipment) {
      for (const device of data.equipments) {
        const [mx, my] = device.position;
        const color = device.status === "warning" ? COLORS.warning : COLORS.equipment;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.44, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
        stem.position.set(mx / 1000 - w / 2, 0.34, d / 2 - my / 1000);
        g.add(stem);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2 }));
        dot.position.set(mx / 1000 - w / 2, 0.62, d / 2 - my / 1000);
        dot.userData = { kind: "equipment", id: device.id, title: device.label, subtitle: `${device.status === "warning" ? "需关注" : "在线"} · ${device.reading}${device.unit}` };
        g.add(dot);
        this.clickable.push(dot);
        if (device.status === "warning" && this.state.layers.alerts) {
          const alertRing = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 28), new THREE.MeshBasicMaterial({ color: COLORS.warning, transparent: true, opacity: 0.78, side: THREE.DoubleSide }));
          alertRing.rotation.x = -Math.PI / 2;
          alertRing.position.set(mx / 1000 - w / 2, 0.16, d / 2 - my / 1000);
          g.add(alertRing);
        }
      }
    }
    const border = new THREE.GridHelper(30, 24, 0x28616d, 0x1d4552);
    border.position.y = -0.035;
    border.material.transparent = true;
    border.material.opacity = 0.22;
    g.add(border);
    this.root.add(g);
  }

  applyCamera() {
    const isFloor = this.state.view === "floor";
    if (isFloor) {
      this.controls.target.set(0, 0, 0);
      this.camera.position.set(0.1, this.state.mode === "2d" ? 54 : 35, this.state.mode === "2d" ? 0.12 : 43);
      this.camera.fov = this.state.mode === "2d" ? 36 : 43;
      this.controls.maxDistance = 90;
      this.controls.minDistance = 14;
      this.controls.maxPolarAngle = this.state.mode === "2d" ? 0.02 : Math.PI * 0.48;
    } else {
      this.controls.target.set(0, this.state.view === "building" ? 14 : 5, 0);
      this.camera.position.set(this.state.view === "site" ? 400 : 95, this.state.view === "site" ? 430 : 105, this.state.view === "site" ? 470 : 120);
      if (this.state.mode === "2d") this.camera.position.set(0, this.state.view === "site" ? 970 : 130, 0.1);
      this.camera.fov = 43;
      this.controls.maxDistance = this.state.view === "site" ? 1800 : 360;
      this.controls.minDistance = 4;
      this.controls.maxPolarAngle = this.state.mode === "2d" ? 0.02 : Math.PI * 0.49;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
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
    if (item.kind === "building") this.store.setView("building");
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this._frame);
    this.resizeObserver.disconnect();
    this.unsubscribe?.();
    this.mapTexture?.dispose();
    this.renderer.dispose();
  }
}
