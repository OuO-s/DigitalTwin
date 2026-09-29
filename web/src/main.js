import { api, connectTwin } from "./api.js";
import { AlertPanel } from "./alert_panel.js";
import { TwinStore } from "./store.js";
import { TwinScene } from "./scene.js";

const store = new TwinStore();
const $ = selector => document.querySelector(selector);
let scene;
let toastTimer;
let liveSocket;
let alertPanel;
let socketOnline = false;
let showAllDevices = false;
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
function hasActiveAlert(id) { return store.state.alerts.some(alert => alert.twinId === id && alert.level !== "info"); }
function liveReading(item) {
  const live = store.state.telemetry.get(item.id);
  return [[live?.temperature, "°C"], [live?.humidity, "%RH"], [live?.brightness, "%"], [live?.count, "台"]]
    .find(([value]) => typeof value === "number" && Number.isFinite(value)) ?? [item.reading, item.unit];
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function selectObject(item) {
  if (item.kind === "patrol-robot") {
    store.update({ selected: { ...item, title: "楼层巡逻机器人" } });
    renderSelection();
    renderPatrolPanel();
    return;
  }
  const detail = item.kind === "room" ? roomById(item.id) : item.kind === "equipment" ? equipmentById(item.id) : null;
  if (detail) {
    const selected = { ...item, ...detail, title: detail.name || detail.label };
    if (item.kind === "equipment") store.update({ selected, activeRoomId: detail.roomId, activeDeviceId: detail.id, view: "device" });
    else store.setSelected(selected);
    return;
  }
  store.setSelected(item);
  renderSelection();
}

function renderSelection() {
  const selected = store.state.selected;
  const isPatrolRobot = selected.kind === "patrol-robot";
  const detail = selected.kind === "room" ? roomById(selected.id) : selected.kind === "equipment" ? equipmentById(selected.id) : null;
  const title = isPatrolRobot ? "楼层巡逻机器人" : detail?.name || detail?.label || selected.title || "6号楼 · 7楼";
  $("#detail-title").textContent = title;
  $("#detail-type").textContent = isPatrolRobot ? "楼层巡逻设备" : selected.kind === "room" ? "房间空间" : selected.kind === "equipment" ? "设备资产" : selected.kind === "floor" ? "楼层空间" : "楼宇空间";
  $("#detail-id").textContent = isPatrolRobot ? "ROBOT-01" : selected.kind === "room" ? selected.id.toUpperCase() : selected.kind === "equipment" ? selected.id.toUpperCase() : "BUILDING-06 / F07";
  const floorArea = store.state.floorplan ? store.state.floorplan.bounds.width * store.state.floorplan.bounds.depth / 1000000 : 0;
  const area = detail?.areaM2 ?? (selected.kind === "equipment" ? null : Math.round(floorArea));
  const utilization = selected.kind === "room" ? Math.min(99, Math.round((detail.occupancy / Math.max(1, detail.areaM2 / 6)) * 100)) : 86;
  const warning = selected.kind === "equipment" && hasActiveAlert(selected.id);
  const [reading, unit] = selected.kind === "equipment" ? liveReading(detail) : [null, null];
  const values = document.querySelectorAll(".selected-summary > div");
  values[0].querySelector("b").innerHTML = isPatrolRobot ? "92 <em>%</em>" : area ? `${area.toLocaleString()} <em>m²</em>` : `${escapeHtml(reading)} <em>${escapeHtml(unit)}</em>`;
  values[0].querySelector("small").textContent = isPatrolRobot ? "当前电量" : selected.kind === "equipment" ? "当前读数" : "建筑面积";
  values[1].querySelector("b").innerHTML = isPatrolRobot ? (store.state.patrolPaused ? "已暂停" : "巡逻中") : selected.kind === "room" ? `${utilization} <em>%</em>` : selected.kind === "equipment" ? (warning ? "需关注" : "运行中") : `86 <em>%</em>`;
  values[1].querySelector("small").textContent = isPatrolRobot ? "设备状态" : selected.kind === "equipment" ? "设备状态" : "空间利用率";
  const status = values[2].querySelector("b");
  status.className = warning ? "status-warning" : "status-ok";
  status.innerHTML = `<i></i>${isPatrolRobot ? (store.state.patrolPaused ? "待命" : "在线") : warning ? "需关注" : "正常"}`;
  $("#open-floorplan").textContent = isPatrolRobot ? "楼层机器人控制面板  ↗" : selected.kind === "room" && store.state.view === "floor" ? "进入房间布局  ↗" : selected.kind === "equipment" && store.state.view === "device" ? "返回所在房间  ↗" : selected.kind === "equipment" ? "聚焦设备  ↗" : selected.kind === "room" ? "房间布局已展开  ↗" : "查看楼层详情  ↗";
  renderPatrolPanel();
}

function renderPatrolPanel() {
  const selected = store.state.view === "floor" && store.state.selected.kind === "patrol-robot";
  const paused = store.state.patrolPaused;
  const panel = $("#patrol-panel");
  if (!panel) return;
  panel.hidden = !selected;
  $("#patrol-state-label").textContent = paused ? "巡逻已暂停" : "正在巡逻";
  $("#patrol-speed").innerHTML = paused ? "0.0<em> m/s</em>" : "1.5<em> m/s</em>";
  $("#patrol-route-label").textContent = paused ? "路线已暂停" : "路线运行中";
  $("#patrol-toggle").innerHTML = paused ? "<span>▶</span><b>继续巡逻</b>" : "<span>Ⅱ</span><b>暂停巡逻</b>";
  $("#patrol-toggle").setAttribute("aria-pressed", String(paused));
  $("#patrol-toggle").classList.toggle("paused", paused);
  $("#patrol-panel .patrol-panel-subtitle").classList.toggle("paused", paused);
}

function renderSummary(summary) {
  $("#stat-rooms").innerHTML = `${String(summary.roomCount).padStart(2, "0")} <em>间</em>`;
  $("#stat-equipment").innerHTML = `${String(summary.equipmentCount).padStart(2, "0")} <em>台</em>`;
  $("#stat-online").innerHTML = `${String(summary.onlineCount).padStart(2, "0")} <em>/ ${String(summary.equipmentCount).padStart(2, "0")}</em>`;
  $("#stat-occupancy").innerHTML = `${String(summary.occupancy).padStart(2, "0")} <em>人</em>`;
  $("#energy-value").textContent = Number(summary.energyKwh).toFixed(1);
  setActiveAlerts(summary.alerts ?? []);
  renderChart(store.state.timeWindow);
}

function setActiveAlerts(alerts) {
  store.update({ alerts });
  const offline = new Set(alerts.filter(item => item.ruleId === "device-offline").map(item => item.twinId));
  const offlineKnown = store.state.floorplan?.equipments.filter(item => offline.has(item.id) && item.status === "online").length ?? 0;
  const online = Math.max(0, (store.state.summary?.onlineCount ?? 0) - offlineKnown);
  const total = store.state.summary?.equipmentCount ?? store.state.floorplan?.equipments.length ?? 0;
  $("#stat-online").innerHTML = `${String(online).padStart(2, "0")} <em>/ ${String(total).padStart(2, "0")}</em>`;
  $("#alert-count").textContent = String(alerts.length).padStart(2, "0");
  $("#alert-badge").textContent = String(alerts.length);
  $("#alert-badge").hidden = alerts.length === 0;
  renderAlerts(alerts);
  renderDevices();
  renderSelection();
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
  const icons = { hvac: "◌", lighting: "☼", sensor: "⌁", power: "ϟ", access: "⌑", printer: "▣", "paper-printer": "▤", robot: "◉", "humanoid-robot": "♙", "robot-arm": "⌁" };
  $("#equipment-count").textContent = String(floor.equipments.length).padStart(2, "0");
  const featuredIds = new Set(["eq-printer-01", "eq-robot-01", "eq-robot-arm-01"]);
  const allDevices = [...floor.equipments.filter(item => featuredIds.has(item.id)), ...floor.equipments.filter(item => !featuredIds.has(item.id))];
  const visibleDevices = showAllDevices ? allDevices : allDevices.slice(0, 4);
  const toggleAssets = $("#toggle-all-assets");
  toggleAssets.setAttribute("aria-expanded", String(showAllDevices));
  toggleAssets.innerHTML = showAllDevices ? '收起列表 <span>↑</span>' : '查看全部 <span>→</span>';
  $("#device-list").innerHTML = visibleDevices.map(item => {
    const live = telemetry.get(item.id);
    const status = hasActiveAlert(item.id) ? "warning" : "online";
    const reading = [
      [live?.temperature, "°C"], [live?.humidity, "%RH"],
      [live?.brightness, "%"], [live?.count, "台"],
    ].find(([value]) => typeof value === "number" && Number.isFinite(value));
    const value = reading?.[0] ?? item.reading;
    const unit = reading?.[1] ?? item.unit;
    const room = floor.rooms.find(x => x.id === item.roomId)?.name ?? "公共区域";
    return `<button class="device-row" data-equipment="${item.id}"><span class="device-icon">${icons[item.category] ?? "⌁"}</span><span class="device-main"><span class="device-name">${item.label}</span><span class="device-room">${room}</span></span><span class="device-reading">${value}<small>${unit || ""}</small></span><i class="device-status ${status === "warning" ? "warning" : ""}"></i></button>`;
  }).join("");
  document.querySelectorAll("[data-equipment]").forEach(button => button.addEventListener("click", () => selectObject({ kind: "equipment", id: button.dataset.equipment })));
  renderRoomPanel();
}

function renderRoomPanel() {
  const host = $("#room-detail-panel");
  const { view, activeRoomId, activeDeviceId, floorplan, telemetry } = store.state;
  if (!host || !floorplan || !["room", "device"].includes(view)) {
    if (host) host.hidden = true;
    return;
  }

  const room = roomById(activeRoomId ?? equipmentById(activeDeviceId)?.roomId);
  if (!room) { host.hidden = true; return; }
  const assets = floorplan.equipments.filter(item => item.roomId === room.id);
  const area = `${Number(room.areaM2 ?? 0).toLocaleString()} m²`;
  const roomUtilization = Math.min(99, Math.round((room.occupancy / Math.max(1, room.areaM2 / 6)) * 100));
  const icons = { hvac: "◌", lighting: "☼", sensor: "⌁", power: "ϟ", access: "⌑", printer: "▣", "paper-printer": "▤", robot: "◉", "humanoid-robot": "♙", "robot-arm": "⌁" };
  const categoryNames = { hvac: "暖通空调", lighting: "照明设备", sensor: "环境传感器", power: "电力设备", access: "门禁设备", printer: "3D打印设备", "paper-printer": "纸张打印设备", robot: "移动机器人", "humanoid-robot": "人形服务机器人", "robot-arm": "工业机械臂" };
  const selectedAsset = view === "device" ? equipmentById(activeDeviceId) : null;
  host.hidden = false;

  if (selectedAsset) {
    const live = telemetry.get(selectedAsset.id);
    const liveReading = [[live?.temperature, "°C"], [live?.humidity, "%RH"], [live?.brightness, "%"], [live?.count, "台"]]
      .find(([value]) => typeof value === "number" && Number.isFinite(value));
    const reading = liveReading?.[0] ?? selectedAsset.reading;
    const unit = liveReading?.[1] ?? selectedAsset.unit;
    const warning = hasActiveAlert(selectedAsset.id);
    host.innerHTML = `
      <div class="room-panel-head">
        <div><span class="section-kicker">ASSET DETAILS</span><h2>${escapeHtml(selectedAsset.label)}</h2></div>
        <span class="asset-status ${warning ? "warning" : ""}"><i></i>${warning ? "需关注" : "运行正常"}</span>
      </div>
      <div class="room-panel-subtitle">${escapeHtml(room.name)} · ${escapeHtml(selectedAsset.id)}</div>
      <div class="room-panel-metrics">
        <div><small>当前读数</small><b>${escapeHtml(reading)} <em>${escapeHtml(unit)}</em></b></div>
        <div><small>设备类型</small><b>${escapeHtml(categoryNames[selectedAsset.category] ?? selectedAsset.category)}</b></div>
      </div>
      <div class="room-panel-section-label">设备信息</div>
      <dl class="asset-detail-list">
        <div><dt>资产编号</dt><dd>${escapeHtml(selectedAsset.id)}</dd></div>
        <div><dt>所属房间</dt><dd>${escapeHtml(room.name)}</dd></div>
        <div><dt>安装位置</dt><dd>${escapeHtml(selectedAsset.position?.slice(0, 2).map(value => `${(value / 1000).toFixed(1)} m`).join(" · ") ?? "待补充")}</dd></div>
      </dl>
      <button class="room-panel-back" data-room-panel-back>← 返回房间资产</button>`;
  } else {
    host.innerHTML = `
      <div class="room-panel-head">
        <div><span class="section-kicker">ROOM OVERVIEW</span><h2>${escapeHtml(room.name)}</h2></div>
        <span class="asset-status"><i></i>空间正常</span>
      </div>
      <div class="room-panel-subtitle">7 楼房间 · ${escapeHtml(room.id)}</div>
      <div class="room-panel-metrics">
        <div><small>建筑面积</small><b>${escapeHtml(area)}</b></div>
        <div><small>实时在场</small><b>${escapeHtml(room.occupancy)} <em>人</em></b></div>
        <div><small>空间利用率</small><b>${roomUtilization} <em>%</em></b></div>
      </div>
      <div class="room-panel-section-label">房间资产 <small>${assets.length} 项</small></div>
      ${assets.length ? `<div class="room-asset-list">${assets.map(item => {
        const live = telemetry.get(item.id);
        const warning = hasActiveAlert(item.id);
        const reading = [[live?.temperature, "°C"], [live?.humidity, "%RH"], [live?.brightness, "%"], [live?.count, "台"]]
          .find(([value]) => typeof value === "number" && Number.isFinite(value));
        return `<button class="room-asset-row" data-room-asset="${escapeHtml(item.id)}">
          <span class="room-asset-icon">${icons[item.category] ?? "⌁"}</span>
          <span class="room-asset-copy"><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.id)}</small></span>
          <span class="room-asset-reading">${escapeHtml(reading?.[0] ?? item.reading)}<small>${escapeHtml(reading?.[1] ?? item.unit)}</small></span>
          <i class="device-status ${warning ? "warning" : ""}"></i>
        </button>`;
      }).join("")}</div>` : `<div class="room-assets-empty">该房间暂无登记资产</div>`}`;
  }

  host.querySelectorAll("[data-room-asset]").forEach(button => button.addEventListener("click", () => {
    selectObject({ kind: "equipment", id: button.dataset.roomAsset });
  }));
  host.querySelector("[data-room-panel-back]")?.addEventListener("click", () => {
    store.update({ activeDeviceId: null, view: "room", selected: { kind: "room", id: room.id, title: room.name } });
    renderPage();
  });
}

async function refreshConnectionLabel() {
  const label = $("#connection-label");
  const pulse = $(".connection .pulse");
  if (!socketOnline) {
    label.textContent = "平台连接中断";
    pulse.style.background = "var(--amber)";
    return;
  }
  try {
    const health = await api("/api/v1/health");
    label.textContent = health.mqtt.enabled ? health.mqtt.connected ? "MQTT 设备已连接" : "MQTT 设备未连接"
      : health.http?.enabled ? "HTTP 设备接入已启用" : "演示数据已连接";
    pulse.style.background = health.mqtt.enabled && !health.mqtt.connected ? "var(--amber)" : "var(--green)";
  } catch {
    label.textContent = "平台状态待确认";
    pulse.style.background = "var(--amber)";
  }
}

function renderAlerts(alerts = []) {
  const host = $("#alert-list");
  host.innerHTML = alerts.length ? alerts.slice(0, 4).map(item => {
    const equipment = equipmentById(item.twinId);
    const time = new Date(item.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `<button class="alert-row ${item.level === "info" ? "info" : ""}" data-alert-target="${escapeHtml(equipment?.id ?? "building-06")}" data-alert-kind="${equipment ? "equipment" : "building"}"><span class="alert-marker">${item.level === "info" ? "i" : "!"}</span><span class="alert-copy"><b>${escapeHtml(item.ruleName)}</b><small>${escapeHtml(item.message)}</small></span><span class="alert-time">${escapeHtml(time)}</span></button>`;
  }).join("") : `<div class="alert-empty">当前没有未恢复的告警</div>`;
  host.querySelectorAll("[data-alert-target]").forEach(button => button.addEventListener("click", () => {
    const kind = button.dataset.alertKind;
    const id = button.dataset.alertTarget;
    if (kind === "equipment") selectObject({ kind, id });
    else { store.setView("building"); selectObject({ kind: "building", id, title: "6号楼" }); }
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
  $("[data-floor='f07']")?.addEventListener("click", () => store.update({ view: "floor", activeDeviceId: null, selected: { kind: "floor", id: "building-06-f07", title: "6号楼 · 7楼" } }));
}

function renderRoomDirectory() {
  const host = $("#room-directory");
  const floor = store.state.floorplan;
  const visible = floor && ["floor", "room", "device"].includes(store.state.view);
  host.hidden = !visible;
  if (!visible) return;
  host.innerHTML = `<div class="room-directory-title"><span>7 楼空间</span><small>${floor.rooms.length} ZONES</small></div>${floor.rooms.map(room => `<button class="room-directory-row ${store.state.activeRoomId === room.id && ["room", "device"].includes(store.state.view) ? "active" : ""}" data-room-id="${room.id}"><span class="room-number">${room.id.slice(-3)}</span><span>${room.name}</span><span class="room-arrow">↗</span></button>`).join("")}`;
  host.querySelectorAll("[data-room-id]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.roomId;
    selectObject({ kind: "room", id });
    store.update({ activeRoomId: id, activeDeviceId: null, view: "room" });
    renderPage();
  }));
}

function renderPage() {
  const view = store.state.view;
  const roomName = roomById(store.state.activeRoomId)?.name ?? "房间";
  const deviceName = equipmentById(store.state.activeDeviceId)?.label ?? "设备";
  const titles = {
    site: ["智萃科技中心 · 园区总览", "海基六路99弄 · 园区空间模型示意"],
    building: ["6号楼 · 建筑空间", "智萃科技中心 · 楼层结构与运行状态"],
    floor: ["6号楼 · 7楼空间", "按手绘布局重建 · 点击房间进入查看"],
    room: [`7楼 · ${roomName}`, "房间布局与设备位置 · 演示示意"],
    device: [`${roomName} · ${deviceName}`, "设备聚焦与所在房间 · 演示示意"],
  };
  $("#page-title").textContent = titles[view][0];
  $("#page-subtitle").textContent = titles[view][1];
  $("#scene-context-label").textContent = view === "site" ? "按标注影像重绘 · 6号楼已定位" : view === "building" ? "6号楼 · 建筑结构示意" : view === "room" ? `${roomName} · 室内布局示意` : view === "device" ? `${deviceName} · 设备聚焦示意` : "7楼手绘布局 · 房间与设备";
  $("#back-to-floor").hidden = view !== "room" && view !== "device";
  $("#patrol-open").hidden = view !== "floor";
  $("#back-to-floor").textContent = view === "device" ? "← 返回房间" : "← 返回 7 楼";
  $("#open-floorplan").classList.toggle("hidden-link", view === "floor" && store.state.selected.kind !== "room");
  renderRoomDirectory();
  renderRoomPanel();
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
  $("#patrol-open").addEventListener("click", () => selectObject({ kind: "patrol-robot", id: "robot-01", title: "楼层巡逻机器人" }));
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    const view = button.dataset.view;
    store.setView(view);
    if (view !== "floor" && view !== "room" && view !== "device") store.setSelected({ kind: view === "site" ? "site" : "building", id: view === "site" ? "zhicui-lingang" : "building-06", title: view === "site" ? "智萃科技中心" : "6号楼" });
    renderPage();
  }));
  document.querySelectorAll("[data-section]").forEach(button => button.addEventListener("click", () => {
    const section = button.dataset.section;
    if (section === "space") store.setView("floor");
    if (section === "assets") {
      showAllDevices = button.id === "toggle-all-assets" ? !showAllDevices : true;
      renderDevices();
      document.querySelectorAll(".rail-item").forEach(item => item.classList.toggle("active", item.dataset.section === "assets"));
      $(".equipment-section").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (section === "alerts") alertPanel.open();
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
  $("#focus-btn").addEventListener("click", () => { if (store.state.view === "building") scene.resetCamera(); else store.setView("building"); renderPage(); });
  $("#open-floorplan").addEventListener("click", () => {
    if (store.state.selected.kind === "patrol-robot") renderPatrolPanel();
    else if (store.state.selected.kind === "room" && store.state.view === "floor") store.update({ activeRoomId: store.state.selected.id, view: "room" });
    else if (store.state.selected.kind === "equipment" && store.state.view === "device") store.update({ activeDeviceId: null, view: "room", selected: { kind: "room", id: store.state.activeRoomId, title: roomById(store.state.activeRoomId)?.name ?? "房间" } });
    else if (store.state.selected.kind === "equipment") selectObject({ kind: "equipment", id: store.state.selected.id });
    else store.setView("floor");
    renderPage();
  });
  $("#back-to-floor").addEventListener("click", () => {
    if (store.state.view === "device") store.update({ activeDeviceId: null, view: "room", selected: { kind: "room", id: store.state.activeRoomId, title: roomById(store.state.activeRoomId)?.name ?? "房间" } });
    else store.update({ activeDeviceId: null, view: "floor", selected: { kind: "floor", id: "building-06-f07", title: "6号楼 · 7楼" } });
    renderPage();
  });
  $("#patrol-toggle").addEventListener("click", () => {
    store.update({ patrolPaused: !store.state.patrolPaused });
    renderSelection();
    toast(store.state.patrolPaused ? "robot-01 已暂停" : "robot-01 已恢复巡逻");
  });
  $("#patrol-panel-close").addEventListener("click", () => {
    store.setSelected({ kind: "floor", id: "building-06-f07", title: "6号楼 · 7楼" });
    renderSelection();
  });
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
    try { const summary = await api("/api/v1/summary"); store.update({ summary }); renderSummary(summary); await alertPanel.refresh(); toast("状态已刷新"); }
    catch { toast("服务暂不可用，请确认后端已启动"); }
  });
}

async function start() {
  try {
    alertPanel = new AlertPanel({
      drawer: $("#alert-drawer"), body: $("#alert-drawer-body"), badge: $("#alert-badge"),
      fetchJson: api, onChange: setActiveAlerts,
    });
    const [site, campusLayout, floorplan, summary] = await Promise.all([
      api("/api/v1/site"), api("/api/v1/campus-layout"), api("/api/v1/floorplans/f07"), api("/api/v1/summary"),
    ]);
    store.update({ site, campusLayout, floorplan, summary });
    renderFloorButtons(site);
    renderSummary(summary);
    renderDevices();
    renderPage();
    scene = new TwinScene($("#scene-root"), store, selectObject);
    await alertPanel.refresh();
    store.addEventListener("change", event => {
      if (event.detail.view !== renderedView) {
        renderedView = event.detail.view;
        renderPage();
      } else if (event.detail.selected !== renderedSelection) {
        renderedSelection = event.detail.selected;
        renderSelection();
      }
      renderPatrolPanel();
    });
    liveSocket = connectTwin(event => {
      if (event.type === "alert") { alertPanel.onAlert(); return; }
      if (event.type === "snapshot") {
        for (const item of event.data ?? []) if (item.twinId && item.payload) store.setTelemetry(item);
        renderDevices();
        return;
      }
      if (!event.twinId) return;
      store.setTelemetry(event);
      renderDevices();
      const active = equipmentById(event.twinId);
      if (active && event.payload.temperature != null) active.reading = event.payload.temperature;
    }, online => {
      socketOnline = online;
      refreshConnectionLabel();
      if (online) alertPanel.refresh();
    });
    setInterval(refreshConnectionLabel, 10000);
    wireUi();
    setClock();
    setInterval(setClock, 1000);
  } catch (error) {
    console.error("孪生工作台启动失败", error);
    toast("服务连接失败，请运行 python -m uvicorn server.app.main:app --reload");
  }
}

start();
