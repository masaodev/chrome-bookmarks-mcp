// Chrome Bookmarks MCP Bridge — service worker (MV3)
//
// Connects over WebSocket to MCP servers listening on a fixed set of ports on 127.0.0.1,
// executes {id, api, args} requests as chrome.bookmarks[api](...args) and returns the result.
// It connects to all ports at once, so several MCP clients (e.g. several Claude Code sessions)
// can be served at the same time.

const PORTS = [17870, 17871, 17872, 17873, 17874]; // must match server/index.js
const ALLOWED_API = new Set([
  "get",
  "getChildren",
  "getRecent",
  "getTree",
  "getSubTree",
  "search",
  "create",
  "update",
  "move",
  "remove",
  "removeTree",
]);

const sockets = new Map(); // port -> WebSocket

function updateBadge() {
  const n = [...sockets.values()].filter(
    (ws) => ws.readyState === WebSocket.OPEN,
  ).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: n ? "#2e7d32" : "#9e9e9e" });
}

async function handle(msg, ws) {
  const { id, api, args } = msg;
  try {
    if (!ALLOWED_API.has(api)) throw new Error(`API not allowed: ${api}`);
    const result = await chrome.bookmarks[api](
      ...(Array.isArray(args) ? args : []),
    );
    ws.send(
      JSON.stringify({ id, result: result === undefined ? null : result }),
    );
  } catch (e) {
    ws.send(JSON.stringify({ id, error: String((e && e.message) || e) }));
  }
}

function connect(port) {
  const existing = sockets.get(port);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN ||
      existing.readyState === WebSocket.CONNECTING)
  )
    return;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.set(port, ws);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        hello: { extensionVersion: chrome.runtime.getManifest().version },
      }),
    );
    updateBadge();
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.ping) {
      ws.send(JSON.stringify({ pong: true }));
      return;
    }
    if (msg.id !== undefined && msg.api) handle(msg, ws);
  };
  ws.onclose = () => {
    if (sockets.get(port) === ws) sockets.delete(port);
    updateBadge();
  };
  ws.onerror = () => {
    /* Ports without a server fail every time; the next alarm retries. */
  };
}

function connectAll() {
  for (const port of PORTS) connect(port);
}

// Reconnect whenever the service worker wakes up (startup, install, every 30 s, icon click).
chrome.runtime.onInstalled.addListener(connectAll);
chrome.runtime.onStartup.addListener(connectAll);
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "reconnect") connectAll();
});
chrome.action.onClicked.addListener(connectAll);
connectAll();
