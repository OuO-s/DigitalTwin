export async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...options.headers };
  if (options.body && typeof options.body !== "string") {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function connectTwin(onEvent, onStatus) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  let timer;
  let stopped = false;
  let delay = 1000;
  function connect() {
    if (stopped) return;
    socket = new WebSocket(`${protocol}//${location.host}/ws/twin`);
    socket.addEventListener("open", () => { delay = 1000; onStatus(true); });
    socket.addEventListener("close", event => {
      onStatus(false);
      if (!stopped) {
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      }
    });
    socket.addEventListener("error", () => onStatus(false));
    socket.addEventListener("message", event => {
      try { onEvent(JSON.parse(event.data)); } catch { /* 忽略无效消息 */ }
    });
  }
  connect();
  return { close() { stopped = true; clearTimeout(timer); socket?.close(); } };
}
