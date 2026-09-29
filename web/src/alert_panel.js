/** 告警面板：服务端负责评估，浏览器只负责查询、展示与确认。 */

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const levelName = { critical: "严重", warning: "警告", info: "提示" };
const timeText = stamp => stamp ? new Date(stamp).toLocaleString("zh-CN", { hour12: false }) : "—";
function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

export class AlertPanel {
  constructor({ drawer, body, badge, fetchJson, onChange }) {
    this.drawer = drawer;
    this.body = body;
    this.badge = badge;
    this.fetchJson = fetchJson;
    this.onChange = onChange;
    this.tab = "active";
    this.data = { active: [], history: [], stats: null };
    this.sequence = 0;

    drawer.querySelectorAll("[data-alert-tab]").forEach(button => button.addEventListener("click", () => {
      this.tab = button.dataset.alertTab;
      drawer.querySelectorAll("[data-alert-tab]").forEach(item => item.classList.toggle("active", item === button));
      this.refresh();
    }));
    drawer.querySelector("#alert-close").addEventListener("click", () => this.close());
    body.addEventListener("click", async event => {
      const button = event.target.closest("[data-alert-ack]");
      if (!button) return;
      button.disabled = true;
      try {
        await this.fetchJson(`/api/v1/alerts/${button.dataset.alertAck}/ack`, { method: "POST" });
        await this.refresh();
      } catch (error) {
        this.error(error.message);
        button.disabled = false;
      }
    });
  }

  get isOpen() { return this.drawer.classList.contains("open"); }
  open() { this.drawer.classList.add("open"); this.drawer.setAttribute("aria-hidden", "false"); return this.refresh(); }
  close() { this.drawer.classList.remove("open"); this.drawer.setAttribute("aria-hidden", "true"); }
  onAlert() { return this.refresh(); }

  async refresh() {
    const sequence = ++this.sequence;
    try {
      const requests = [this.fetchJson("/api/v1/alerts?active=1")];
      if (this.tab === "history") requests.push(this.fetchJson("/api/v1/alerts?limit=100"));
      if (this.tab === "report") requests.push(this.fetchJson("/api/v1/alerts/stats"));
      const [active, extra] = await Promise.all(requests);
      if (sequence !== this.sequence) return;
      this.data.active = active.alerts ?? [];
      if (this.tab === "history") this.data.history = extra.history ?? [];
      if (this.tab === "report") this.data.stats = extra;
      this.badge.textContent = String(this.data.active.length);
      this.badge.hidden = this.data.active.length === 0;
      this.onChange(this.data.active);
      this.render();
    } catch (error) {
      if (sequence === this.sequence) this.error(`告警数据加载失败：${error.message}`);
    }
  }

  error(message) { if (this.isOpen) this.body.innerHTML = `<div class="alert-empty">${escapeHtml(message)}</div>`; }

  render() {
    if (this.tab === "report") { this.body.innerHTML = this.reportHtml(); return; }
    const items = this.tab === "history" ? this.data.history : this.data.active;
    this.body.innerHTML = items.length ? items.map(item => this.itemHtml(item)).join("")
      : `<div class="alert-empty">${this.tab === "active" ? "当前没有未恢复的告警" : "暂无告警历史"}</div>`;
  }

  itemHtml(alert) {
    const resolved = alert.resolvedAt != null;
    const elapsed = duration((alert.resolvedAt ?? Date.now()) - alert.startedAt);
    const ack = !alert.acknowledged && !resolved
      ? `<button class="alert-ack" data-alert-ack="${Number(alert.id)}">确认</button>` : "";
    return `<article class="alert-item level-${escapeHtml(alert.level)}${resolved ? " resolved" : ""}">
      <div class="alert-item-head"><span class="alert-level">${escapeHtml(levelName[alert.level] ?? alert.level)}</span>
        <b>${escapeHtml(alert.ruleName)}</b><time>${escapeHtml(timeText(alert.startedAt))}</time></div>
      <div class="alert-item-device">${escapeHtml(alert.twinId)}</div>
      <p>${escapeHtml(alert.message)}</p>
      <div class="alert-item-foot"><span>${resolved ? "已恢复" : "进行中"} · ${elapsed}</span>
        ${alert.acknowledged ? `<span>已确认 · ${escapeHtml(alert.acknowledgedBy)}</span>` : ""}${ack}</div>
    </article>`;
  }

  reportHtml() {
    const stats = this.data.stats;
    if (!stats) return `<div class="alert-empty">报表加载中…</div>`;
    const levels = ["critical", "warning", "info"].map(level => `<div class="alert-report-row"><span>${levelName[level]}</span><b>${stats.byLevel[level] ?? 0}</b></div>`).join("");
    const ranked = (items, key) => {
      if (!items.length) return `<p>暂无数据</p>`;
      const max = Math.max(...items.map(item => item.count));
      return items.map(item => `<div class="alert-report-row"><span>${escapeHtml(item[key])}</span><b>${item.count}</b></div><div class="alert-report-bar"><i style="width:${item.count / max * 100}%"></i></div>`).join("");
    };
    return `<section class="alert-report-block"><h4>总览</h4>
        <div class="alert-report-row"><span>告警总数</span><b>${stats.total}</b></div>
        <div class="alert-report-row"><span>当前未恢复</span><b>${stats.active}</b></div>
        <div class="alert-report-row"><span>已确认</span><b>${stats.acknowledged}</b></div>
        <div class="alert-report-row"><span>平均恢复时长</span><b>${stats.avgDurationSec == null ? "—" : `${stats.avgDurationSec} 秒`}</b></div>
      </section><section class="alert-report-block"><h4>按级别</h4>${levels}</section>
      <section class="alert-report-block"><h4>按设备</h4>${ranked(stats.byTwin, "twinId")}</section>
      <section class="alert-report-block"><h4>按规则</h4>${ranked(stats.byRule, "ruleName")}</section>`;
  }
}
