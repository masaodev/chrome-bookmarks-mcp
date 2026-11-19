// Shared parts of the MCP server (index.js) and the CLI (cli.js):
// the WebSocket bridge to the Chrome extension, output formatting and the bookmark operations.

import http from "node:http";
import { WebSocketServer } from "ws";

export const DEFAULT_PORTS = [17870, 17871, 17872, 17873, 17874]; // must match extension/background.js (multi-session support)

/**
 * Candidate ports. CHROME_BOOKMARKS_MCP_PORTS="17879" (comma-separated) overrides them.
 * Used by the tests so that a test server never shares a port range with real sessions or the real extension.
 */
export function resolvePorts(env = process.env) {
  const ports = (env.CHROME_BOOKMARKS_MCP_PORTS || "")
    .split(",")
    .map((v) => Number.parseInt(v.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ports.length ? ports : [...DEFAULT_PORTS];
}

const CALL_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 20000; // application-level ping to keep the MV3 service worker awake

export const makeLog =
  (name) =>
  (...a) =>
    console.error(`[${name}]`, ...a);

// ---------------------------------------------------------------------------
// Bridge to the extension
// ---------------------------------------------------------------------------
export class Bridge {
  /**
   * @param {object} opts
   * @param {number[]} opts.ports candidate ports, tried in order
   * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} [opts.onHttp]
   *   handler for plain (non-WebSocket) HTTP requests on the same port
   * @param {(...a: any[]) => void} [opts.log]
   */
  constructor({ ports, onHttp, log = makeLog("chrome-bookmarks-mcp") }) {
    this.ports = ports;
    this.onHttp = onHttp;
    this.log = log;
    this.clients = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.port = null;
  }

  async listen() {
    for (const port of this.ports) {
      try {
        await this.#tryListen(port);
        this.port = port;
        this.log(`listening ws://127.0.0.1:${port}`);
        return port;
      } catch (e) {
        if (e.code === "EADDRINUSE") continue;
        throw e;
      }
    }
    throw new Error(`No free port (${this.ports[0]}-${this.ports.at(-1)})`);
  }

  #tryListen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (this.onHttp) return this.onHttp(req, res);
        // Same answer as a bare WebSocketServer; the extension's probe only needs some response.
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });
      const wss = new WebSocketServer({ server });
      // ws re-emits the HTTP server's errors (e.g. EADDRINUSE) on the WebSocketServer;
      // without a listener that would crash the process before we can try the next port.
      let listening = false;
      wss.on("error", (e) => {
        if (listening) this.log("wss error", e);
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        listening = true;
        server.off("error", reject);
        server.on("error", (e) => this.log("http error", e));
        wss.on("connection", (ws, req) => this.#onConnection(ws, req));
        this.server = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  #onConnection(ws, req) {
    const origin = req.headers.origin || "";
    if (!origin.startsWith("chrome-extension://")) {
      this.log(`reject origin=${origin}`);
      ws.close(4003, "origin not allowed");
      return;
    }
    const client = { ws, origin, hello: null, connectedAt: new Date() };
    this.clients.add(client);
    this.log(`extension connected (${this.clients.size})`);

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.hello) {
        client.hello = msg.hello;
        return;
      }
      if (msg.pong) return;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error !== undefined) reject(new Error(msg.error));
        else resolve(msg.result);
      }
    });
    ws.on("close", () => {
      this.clients.delete(client);
      this.log(`extension disconnected (${this.clients.size})`);
      // Fail calls that were sent to this socket right away instead of waiting for the timeout.
      for (const [id, p] of this.pending) {
        if (p.client !== client) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(
          new Error(
            "Chrome extension disconnected while the call was in flight",
          ),
        );
      }
    });
    ws.on("error", (e) => this.log("ws error", e.message));

    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ping: true }));
      else clearInterval(ping);
    }, PING_INTERVAL_MS);
    ws.once("close", () => clearInterval(ping));
  }

  #openClient() {
    return [...this.clients]
      .reverse()
      .find((c) => c.ws.readyState === c.ws.OPEN);
  }

  get connected() {
    return Boolean(this.#openClient());
  }

  /** Resolve once an extension is connected; reject after timeoutMs. */
  async waitForClient(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (!this.connected) {
      if (Date.now() >= until)
        throw new Error(
          `Chrome extension did not connect within ${Math.round(timeoutMs / 1000)} s (ws://127.0.0.1:${this.port}). ` +
            'Check that Chrome is running and "Chrome Bookmarks MCP Bridge" is enabled at chrome://extensions.',
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Send chrome.bookmarks.<api>(...args) to the most recently connected extension (normally the active profile). */
  call(api, args = []) {
    const client = this.#openClient();
    if (!client) {
      throw new Error(
        `Chrome extension is not connected (ws://127.0.0.1:${this.port}). ` +
          'Check that Chrome is running and "Chrome Bookmarks MCP Bridge" is enabled at chrome://extensions.',
      );
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `No response from the extension (${api}, ${CALL_TIMEOUT_MS}ms)`,
          ),
        );
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, client });
      client.ws.send(JSON.stringify({ id, api, args }), (err) => {
        if (!err || !this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Failed to send to the extension: ${err.message}`));
      });
    });
  }

  get busy() {
    return this.pending.size > 0;
  }

  status() {
    return {
      port: this.port,
      connected: this.clients.size,
      clients: [...this.clients].map((c) => ({
        origin: c.origin,
        connectedAt: c.connectedAt.toISOString(),
        ...(c.hello || {}),
      })),
    };
  }

  close() {
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    this.server?.close();
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function formatTree(nodes, depth = 0, lines = []) {
  for (const n of nodes) {
    const pad = "  ".repeat(depth);
    if (n.url) {
      lines.push(`${pad}[${n.id}] ${n.title || "(untitled)"}  ${n.url}`);
    } else {
      const count = n.children ? ` (${n.children.length})` : "";
      lines.push(`${pad}[${n.id}] 📁 ${n.title || "(root)"}${count}`);
      if (n.children) formatTree(n.children, depth + 1, lines);
    }
  }
  return lines;
}

export function formatList(nodes) {
  return nodes.map((n) =>
    n.url
      ? `[${n.id}] ${n.title || "(untitled)"}  ${n.url}  (parent=${n.parentId}, index=${n.index})`
      : `[${n.id}] 📁 ${n.title || "(root)"}  (parent=${n.parentId ?? "-"}, index=${n.index ?? "-"})`,
  );
}

// ---------------------------------------------------------------------------
// Operations shared by the MCP tools and the CLI commands.
// Each returns { data, text }: data = raw chrome.bookmarks result, text = human-readable output.
// `call(api, args)` runs chrome.bookmarks.<api>(...args) in the extension.
// ---------------------------------------------------------------------------
export function createOps(call) {
  return {
    async getTree({ id } = {}) {
      const data = id ? await call("getSubTree", [id]) : await call("getTree");
      return { data, text: formatTree(data).join("\n") };
    },
    async getChildren({ id }) {
      const data = await call("getChildren", [id]);
      return { data, text: formatList(data).join("\n") || "(empty)" };
    },
    async get({ ids }) {
      const data = await call("get", [ids]);
      return { data, text: formatList(data).join("\n") };
    },
    async search({ query, title, url }) {
      let arg;
      if (title !== undefined || url !== undefined) {
        arg = {};
        if (query !== undefined) arg.query = query;
        if (title !== undefined) arg.title = title;
        if (url !== undefined) arg.url = url;
      } else if (query !== undefined) {
        arg = query;
      } else {
        throw new Error("Specify at least one of query / title / url");
      }
      const data = await call("search", [arg]);
      return { data, text: formatList(data).join("\n") || "(no matches)" };
    },
    async getRecent({ count = 20 }) {
      const data = await call("getRecent", [count]);
      return { data, text: formatList(data).join("\n") || "(none)" };
    },
    async create({ parentId, title, url, index }) {
      const data = await call("create", [{ parentId, title, url, index }]);
      return { data, text: `Created: ${formatList([data])[0]}` };
    },
    async update({ id, title, url }) {
      const changes = {};
      if (title !== undefined) changes.title = title;
      if (url !== undefined) changes.url = url;
      if (!Object.keys(changes).length)
        throw new Error("Specify title and/or url");
      const data = await call("update", [id, changes]);
      return { data, text: `Updated: ${formatList([data])[0]}` };
    },
    async move({ id, parentId, index }) {
      const dest = {};
      if (parentId !== undefined) dest.parentId = parentId;
      if (index !== undefined) dest.index = index;
      const data = await call("move", [id, dest]);
      return { data, text: `Moved: ${formatList([data])[0]}` };
    },
    async remove({ id }) {
      const [data] = await call("get", [[id]]);
      await call("remove", [id]);
      return { data, text: `Removed: ${formatList([data])[0]}` };
    },
    async removeTree({ id }) {
      const [data] = await call("getSubTree", [id]);
      const lines = formatTree([data]);
      await call("removeTree", [id]);
      return {
        data,
        text: `Removed (${lines.length} lines):\n${lines.join("\n")}`,
      };
    },
  };
}
