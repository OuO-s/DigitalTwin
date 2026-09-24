import { api, connectTwin } from "./api.js";
import { TwinStore } from "./store.js";
import { TwinScene } from "./scene.js";

const store = new TwinStore();
const $ = selector => document.querySelector(selector);
let scene;
let toastTimer;
let liveSocket;
let renderedView = store.state.view;
let renderedSelection = store.state.selected;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2100);
}

function roomById(id) { return store.state.floorplan?.rooms.find(room => room.id === id); }
function equipmentById(id) { return store.state.floorplan?.equipments.find(item => item.id === id); }

function selectObject(item) {
  const detail = item.kind === "room" ? roomById(item.id) : item.kind === "equipment" ? equipmentById(item.id) : null;
  if (detail) {
    store.setSelected({ ...item, ...detail, title: detail.name || detail.label });
    return;
  }
  store.setSelected(item);
  renderSelection();
}

function renderSelection() {
  const selected = store.state.selected;
  const detail = selected.kind === "room" ? roomById(selected.id) : selected.kind === "equipment" ? equipmentById(selected.id) : null;
  const title = detail?.name || detail?.label || selected.title || "6号楼 · 7楼";
  $("#detail-title").textContent = title;
  $("#detail-type").textContent = selected.kind === "room" ? "房间空间" : selected.kind === "equipment" ? "设备资产" : selected.kind === "floor" ? "楼层空间" : "楼宇空间";
  $("#detail-id").textContent = selected.kind === "room" ? selected.id.toUpperCase() : selected.kind === "equipment" ? selected.id.toUpperCase() : "BUILDING-06 / F07";
  const floorArea = store.state.floorplan ? store.state.floorplan.bounds.width * store.state.floorplan.bounds.depth / 1000000 : 0;
  const area = detail?.areaM2 ?? (selected.kind === "equipment" ? null : Math.round(floorArea));
  const utilization = selected.kind === "room" ? Math.min(99, Math.round((detail.occupancy / Math.max(1, detail.areaM2 / 6)) * 100)) : 86;
  const values = document.querySelectorAll(".selected-summary > div");
  values[0].querySelector("b").innerHTML = area ? `${area.toLocaleString()} <em>m²</em>` : `${detail.reading} <em>${detail.unit}</em>`;
  values[0].querySelector("small").textContent = selected.kind === "equipment" ? "当前读数" : "建筑面积";
  values[1].querySelector("b").innerHTML = selected.kind === "room" ? `${utilization} <em>%</em>` : selected.kind === "equipment" ? (detail.status === "warning" ? "需关注" : "运行中") : `86 <em>%</em>`;
  values[1].querySelector("small").textContent = selected.kind === "equipment" ? "设备状态" : "空间利用率";
  const status = values[2].querySelector("b");
  status.className = detail?.status === "warning" ? "status-warning" : "status-ok";
  status.innerHTML = `<i></i>${detail?.status === "warning" ? "需关注" : "正常"}`;
  $("#open-floorplan").textContent = selected.kind === "room" && store.state.view === "floor" ? "进入房间布局  ↗" : selected.kind === "equipment" ? "查看设备详情  ↗" : selected.kind === "room" ? "房间布局已展开  ↗" : "查看楼层详情  ↗";
}

function renderSummary(summary) {
  $("#stat-rooms").innerHTML = `${String(summary.roomCount).padStart(2, "0")} <em>间</em>`;
  $("#stat-equipment").innerHTML = `${String(summary.equipmentCount).padStart(2, "0")} <em>台</em>`;
  $("#stat-online").innerHTML = `${String(summary.onlineCount).padStart(2, "0")} <em>/ ${String(summary.equipmentCount).padStart(2, "0")}</em>`;
  $("#stat-occupancy").innerHTML = `${String(summary.occupancy).padStart(2, "0")} <em>人</em>`;
  $("#energy-value").textContent = Number(summary.energyKwh).toFixed(1);
  $("#alert-count").textContent = String(summary.warningCount).padStart(2, "0");
  renderChart(store.state.timeWindow);
  renderAlerts(summary.alerts);
}

function renderChart(windowName = store.state.timeWindow) {
  const svg = $("#energy-chart");
  const series = {
    today: [8,12,9,14,11,15,12,17,14,21,16,19,14,17,12,18,15,22,18,20,15,18,13,17],
    week: [7,10,12,11,15,13,18,16,20,17,15,19,22,18,21,16,14,18,20,24,21,19,16,18],
    month: [10,13,11,16,15,19,17,14,18,21,20,16,19,23,18,22,17,15,20,24,19,22,18,21],
  };
  const values = series[windowName] ?? series.today;
  const axisLabels = windowName === "week" ? ["周一", "周二", "周三", "周四", "周五"] : windowName === "month" ? ["01日", "08日", "15日", "22日", "30日"] : ["00:00", "06:00", "12:00", "18:00", "24:00"];
  document.querySelectorAll(".chart-x span").forEach((node, index) => { node.textContent = axisLabels[index]; });
  const max = Math.max(...values);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 300},${86 - value / max * 72}`).join(" ");
  const peak = values.indexOf(max);
  svg.innerHTML = `<defs><linearGradient id="energy-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#42d5cc" stop-opacity=".28"/><stop offset="1" stop-color="#42d5cc" stop-opacity="0"/></linearGradient></defs><polygon points="0,92 ${points} 300,92" fill="url(#energy-fill)"/><polyline points="${points}" fill="none" stroke="#48d4cc" stroke-width="2" vector-effect="non-scaling-stroke"/><circle cx="${(peak / (values.length - 1)) * 300}" cy="${86 - max / max * 72}" r="3.6" fill="#c5fff5" stroke="#36bfb8" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
}

function renderDevices() {
  const floor = store.state.floorplan;
  if (!floor) return;
  const telemetry = store.state.telemetry;
  const icons = { hvac: "◌", lighting: "☼", sensor: "⌁", power: "ϟ", access: "⌑", printer: "▣" };
  $("#equipment-count").textContent = String(floor.equipments.length).padStart(2, "0");
  $("#device-list").innerHTML = floor.equipments.slice(0, 4).map(item => {
    const live = telemetry.get(item.id);
    const status = live?.status === "warning" ? "warning" : item.status;
    const value = live?.temperature ?? item.reading;
    const unit = live?.temperature ? "°C" : item.unit;
    const room = floor.rooms.find(x => x.id === item.roomId)?.name ?? "公共区域";
    return `<button class="device-row" data-equipment="${item.id}"><span class="device-icon">${icons[item.category] ?? "⌁"}</span><span class="device-main"><span class="device-name">${item.label}</span><span class="device-room">${room}</span></span><span class="device-reading">${value}<small>${unit || ""}</small></span><i class="device-status ${status === "warning" ? "warning" : ""}"></i></button>`;
  }).join("");
  document.querySelectorAll("[data-equipment]").forEach(button => button.addEventListener("click", () => selectObject({ kind: "equipment", id: button.dataset.equipment })));
}

function renderAlerts(alerts = []) {
  const host = $("#alert-list");
  host.innerHTML = alerts.map((item, index) => `<button class="alert-row ${item.level === "info" ? "info" : ""}" data-alert-target="${item.target ?? (index === 0 ? "room-704" : "building-06")}" data-alert-kind="${item.targetKind ?? (index === 0 ? "room" : "building")}"><span class="alert-marker">${item.level === "info" ? "i" : "!"}</span><span class="alert-copy"><b>${item.title}</b><small>${item.detail}</small></span><span class="alert-time">${item.time}</span></button>`).join("");
  host.querySelectorAll("[data-alert-target]").forEach(button => button.addEventListener("click", () => {
    const kind = button.dataset.alertKind;
    const id = button.dataset.alertTarget;
    store.setView(kind === "room" ? "floor" : "building");
    selectObject(kind === "room" ? { kind, id } : { kind: "building", id, title: "6号楼" });
    renderPage();
  }));
}

function renderFloorButtons(site) {
  const count = site.buildings.find(x => x.id === "building-06")?.floorCount ?? 8;
  document.querySelector(".floor-browser-head small").innerHTML = `6号楼 <b>·</b> ${count}F`;
  $("#floor-buttons").innerHTML = Array.from({ length: count }, (_, index) => {
    const number = count - index;
    const active = number === 7;
    return `<button class="floor-button ${active ? "selected" : "disabled"}" ${active ? "data-floor='f07'" : "disabled"} aria-label="${number}楼${active ? "，当前层" : "，待接入"}">${String(number).padStart(2, "0")}</button>`;
  }).join("");
  $("[data-floor='f07']")?.addEventListener("click", () => store.setView("floor"));
}

function renderRoomDirectory() {
  const host = $("#room-directory");
  const floor = store.state.floorplan;
  const visible = floor && ["floor", "room"].includes(store.state.view);
  host.hidden = !visible;
  if (!visible) return;
  host.innerHTML = `<div class="room-directory-title"><span>7 楼空间</span><small>${floor.rooms.length} ZONES</small></div>${floor.rooms.map(room => `<button class="room-directory-row ${store.state.activeRoomId === room.id && store.state.view === "room" ? "active" : ""}" data-room-id="${room.id}"><span class="room-number">${room.id.slice(-3)}</span><span>${room.name}</span><span class="room-arrow">↗</span></button>`).join("")}`;
  host.querySelectorAll("[data-room-id]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.roomId;
    selectObject({ kind: "room", id });
    store.update({ activeRoomId: id, view: "room" });
    renderPage();
  }));
}

function renderPage() {
  const view = store.state.view;
  const roomName = roomById(store.state.activeRoomId)?.name ?? "房间";
  const titles = {
    site: ["智萃科技中心 · 园区总览", "海基六路99弄 · 园区空间模型示意"],
    building: ["6号楼 · 建筑空间", "智萃科技中心 · 楼层结构与运行状态"],
    floor: ["6号楼 · 7楼空间", "按手绘布局重建 · 点击房间进入查看"],
    room: [`7楼 · ${roomName}`, "房间布局与设备位置 · 演示示意"],
  };
  $("#page-title").textContent = titles[view][0];
  $("#page-subtitle").textContent = titles[view][1];
  $("#scene-context-label").textContent = view === "site" ? "按标注影像重绘 · 6号楼已定位" : view === "building" ? "6号楼 · 建筑结构示意" : view === "room" ? `${roomName} · 室内布局示意` : "7楼手绘布局 · 房间与设备";
  $("#back-to-floor").hidden = view !== "room";
  $("#open-floorplan").classList.toggle("hidden-link", view === "floor" && store.state.selected.kind !== "room");
  renderRoomDirectory();
  renderSelection();
}

function setClock() {
  const now = new Date();
  $("#clock").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
  const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(now);
  $(".top-date small").textContent = date.replaceAll("/", ".");
  $("#updated-at").textContent = $("#clock").textContent;
}

function wireUi() {
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    const view = button.dataset.view;
    store.setView(view);
    if (view !== "floor" && view !== "room") store.setSelected({ kind: view === "site" ? "site" : "building", id: view === "site" ? "zhicui-lingang" : "building-06", title: view === "site" ? "智萃科技中心" : "6号楼" });
    renderPage();
  }));
  document.querySelectorAll("[data-section]").forEach(button => button.addEventListener("click", () => {
    const section = button.dataset.section;
    if (section === "space") store.setView("floor");
    if (section === "assets") { store.setView("floor"); $(".equipment-section").scrollIntoView({ behavior: "smooth", block: "center" }); }
    if (section === "alerts") { store.setView("floor"); $(".alerts-section").scrollIntoView({ behavior: "smooth", block: "center" }); }
    document.querySelectorAll(".rail-item").forEach(item => item.classList.toggle("active", item.dataset.section === section));
    renderPage();
  }));
  document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => {
    store.setMode(button.dataset.mode);
    document.querySelectorAll("[data-mode]").forEach(item => item.classList.toggle("selected", item === button));
  }));
  document.querySelectorAll("[data-layer]").forEach(button => button.addEventListener("click", () => {
    const visible = !store.state.layers[button.dataset.layer];
    store.setLayer(button.dataset.layer, visible);
    button.classList.toggle("active", visible);
  }));
  $("#focus-btn").addEventListener("click", () => { store.setView("building"); renderPage(); scene.resetCamera(); });
  $("#open-floorplan").addEventListener("click", () => {
    if (store.state.selected.kind === "room" && store.state.view === "floor") store.update({ activeRoomId: store.state.selected.id, view: "room" });
    else store.setView("floor");
    renderPage();
  });
  $("#back-to-floor").addEventListener("click", () => { store.setView("floor"); renderPage(); });
  $("#reset-camera").addEventListener("click", () => scene.resetCamera());
  const windows = ["today", "week", "month"];
  const windowLabels = { today: "今日⌄", week: "近7日⌄", month: "近30日⌄" };
  $("#time-window").addEventListener("click", () => {
    const index = windows.indexOf(store.state.timeWindow);
    const next = windows[(index + 1) % windows.length];
    store.update({ timeWindow: next });
    $("#time-window").textContent = windowLabels[next];
    renderChart(next);
    const totals = { today: "18.6", week: "132.4", month: "548.9" };
    $("#energy-value").textContent = totals[next];
  });
  $("#zoom-in").addEventListener("click", () => scene.setZoom(1));
  $("#zoom-out").addEventListener("click", () => scene.setZoom(-1));
  $("#refresh-btn").addEventListener("click", async () => {
    try { const summary = await api("/api/v1/summary"); store.update({ summary }); renderSummary(summary); renderDevices(); toast("演示状态已刷新"); }
    catch { toast("服务暂不可用，请确认后端已启动"); }
  });
}

async function start() {
  try {
    const [site, campusLayout, floorplan, summary] = await Promise.all([
      api("/api/v1/site"), api("/api/v1/campus-layout"), api("/api/v1/floorplans/f07"), api("/api/v1/summary"),
    ]);
    store.update({ site, campusLayout, floorplan, summary });
    renderFloorButtons(site);
    renderSummary(summary);
    renderDevices();
    renderPage();
    scene = new TwinScene($("#scene-root"), store, selectObject);
    store.addEventListener("change", event => {
      if (event.detail.view !== renderedView) {
        renderedView = event.detail.view;
        renderPage();
      } else if (event.detail.selected !== renderedSelection) {
        renderedSelection = event.detail.selected;
        renderSelection();
      }
    });
    liveSocket = connectTwin(event => {
      if (!event.twinId) return;
      store.setTelemetry(event);
      renderDevices();
      const active = equipmentById(event.twinId);
      if (active && event.payload.temperature != null) active.reading = event.payload.temperature;
    }, online => {
      $("#connection-label").textContent = online ? "演示数据已连接" : "正在重连演示数据";
      $(".connection .pulse").style.background = online ? "var(--green)" : "var(--amber)";
    });
    wireUi();
    setClock();
    setInterval(setClock, 1000);
  } catch (error) {
    console.error("孪生工作台启动失败", error);
    toast("服务连接失败，请运行 python -m uvicorn server.app.main:app --reload");
  }
}

start();
