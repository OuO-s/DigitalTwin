export async function api(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

export function connectTwin(onEvent, onStatus) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws/twin`);
  socket.addEventListener("open", () => onStatus(true));
  socket.addEventListener("close", () => onStatus(false));
  socket.addEventListener("error", () => onStatus(false));
  socket.addEventListener("message", event => {
    try { onEvent(JSON.parse(event.data)); } catch { /* 忽略无效消息 */ }
  });
  return socket;
}

