export class TwinStore extends EventTarget {
  constructor() {
    super();
    this.state = {
      view: "site",
      floorId: "f07",
      mode: "3d",
      selected: { kind: "floor", id: "building-06-f07", title: "6号楼 · 7楼" },
      layers: { spaces: true, equipment: true, alerts: true, heat: false },
      timeWindow: "today",
      site: null,
      campusLayout: null,
      floorplan: null,
      summary: null,
      telemetry: new Map(),
    };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.dispatchEvent(new CustomEvent("change", { detail: this.state }));
  }

  setView(view) { this.update({ view }); }
  setMode(mode) { this.update({ mode }); }
  setSelected(selected) { this.update({ selected }); }
  setLayer(name, visible) {
    this.update({ layers: { ...this.state.layers, [name]: visible } });
  }
  setTelemetry(event) {
    const next = new Map(this.state.telemetry);
    next.set(event.twinId, event.payload);
    this.update({ telemetry: next });
  }
}
