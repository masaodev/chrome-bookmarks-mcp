#!/usr/bin/env node
// chrome-bookmarks-mcp — an MCP server that lets Claude Code (or any MCP client)
// read and write Chrome bookmarks through a companion Chrome extension.
//
// Architecture:
//   MCP client ──(stdio / MCP)── this server ──(WebSocket 127.0.0.1)── Chrome extension ──(chrome.bookmarks)── Chrome
//
// stdout is reserved for MCP. All logging goes to stderr.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const { version: VERSION } = createRequire(import.meta.url)("../package.json");

const PORTS = [17870, 17871, 17872, 17873, 17874]; // must match extension/background.js (multi-session support)
const CALL_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 20000; // application-level ping to keep the MV3 service worker awake

const log = (...a) => console.error("[chrome-bookmarks-mcp]", ...a);

// ---------------------------------------------------------------------------
// Bridge to the extension
// ---------------------------------------------------------------------------
class Bridge {
  constructor() {
    this.clients = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.port = null;
  }

  async listen() {
    for (const port of PORTS) {
      try {
        this.wss = await this.#tryListen(port);
        this.port = port;
        log(`listening ws://127.0.0.1:${port}`);
        return port;
      } catch (e) {
        if (e.code === "EADDRINUSE") continue;
        throw e;
      }
    }
    throw new Error(`No free port (${PORTS[0]}-${PORTS.at(-1)})`);
  }

  #tryListen(port) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port });
      wss.once("error", reject);
      wss.once("listening", () => {
        wss.off("error", reject);
        wss.on("error", (e) => log("wss error", e));
        wss.on("connection", (ws, req) => this.#onConnection(ws, req));
        resolve(wss);
      });
    });
  }

  #onConnection(ws, req) {
    const origin = req.headers.origin || "";
    if (!origin.startsWith("chrome-extension://")) {
      log(`reject origin=${origin}`);
      ws.close(4003, "origin not allowed");
      return;
    }
    const client = { ws, origin, hello: null, connectedAt: new Date() };
    this.clients.add(client);
    log(`extension connected (${this.clients.size})`);

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
      log(`extension disconnected (${this.clients.size})`);
    });
    ws.on("error", (e) => log("ws error", e.message));

    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ping: true }));
      else clearInterval(ping);
    }, PING_INTERVAL_MS);
    ws.once("close", () => clearInterval(ping));
  }

  /** Send chrome.bookmarks.<api>(...args) to the most recently connected extension (normally the active profile). */
  call(api, args = []) {
    const client = [...this.clients].at(-1);
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
      this.pending.set(id, { resolve, reject, timer });
      client.ws.send(JSON.stringify({ id, api, args }));
    });
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
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function formatTree(nodes, depth = 0, lines = []) {
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

function formatList(nodes) {
  return nodes.map((n) =>
    n.url
      ? `[${n.id}] ${n.title || "(untitled)"}  ${n.url}  (parent=${n.parentId}, index=${n.index})`
      : `[${n.id}] 📁 ${n.title || "(root)"}  (parent=${n.parentId ?? "-"}, index=${n.index ?? "-"})`,
  );
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const errorResult = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message || e}` }],
  isError: true,
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const bridge = new Bridge();
const server = new McpServer({ name: "chrome-bookmarks", version: VERSION });

const fmtSchema = z
  .enum(["text", "json"])
  .default("text")
  .describe(
    "Output format: text = human-readable list, json = raw BookmarkTreeNode data",
  );

function tool(name, config, fn) {
  server.registerTool(name, config, async (args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return errorResult(e);
    }
  });
}

tool(
  "bookmarks_status",
  {
    title: "Connection status",
    description:
      "Return the connection status with the Chrome extension. Check this first when a bookmark operation fails.",
    annotations: { readOnlyHint: true },
  },
  async () => json(bridge.status()),
);

tool(
  "bookmarks_get_tree",
  {
    title: "Get tree",
    description:
      "Return the whole bookmark tree (or the subtree under id). Use it to find folder ids. " +
      "The ids of the top-level folders (Bookmarks bar / Other bookmarks) differ per Chrome profile, " +
      "so call bookmarks_get_children with id 0 to look them up.",
    inputSchema: {
      id: z
        .string()
        .optional()
        .describe(
          "Return only the subtree under this id (omit for the whole tree)",
        ),
      format: fmtSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ id, format }) => {
    const nodes = id
      ? await bridge.call("getSubTree", [id])
      : await bridge.call("getTree");
    return format === "json" ? json(nodes) : text(formatTree(nodes).join("\n"));
  },
);

tool(
  "bookmarks_get_children",
  {
    title: "Get children",
    description:
      "Return the direct children (folders and bookmarks) of a folder, in display order.",
    inputSchema: { id: z.string().describe("Folder id"), format: fmtSchema },
    annotations: { readOnlyHint: true },
  },
  async ({ id, format }) => {
    const nodes = await bridge.call("getChildren", [id]);
    return format === "json"
      ? json(nodes)
      : text(formatList(nodes).join("\n") || "(empty)");
  },
);

tool(
  "bookmarks_get",
  {
    title: "Get by id",
    description: "Return the nodes with the given ids.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("Array of node ids"),
      format: fmtSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ ids, format }) => {
    const nodes = await bridge.call("get", [ids]);
    return format === "json" ? json(nodes) : text(formatList(nodes).join("\n"));
  },
);

tool(
  "bookmarks_search",
  {
    title: "Search",
    description:
      "Search bookmarks. query = word match against title and URL (Chrome's built-in search). title / url = exact match.",
    inputSchema: {
      query: z.string().optional().describe("Free-text query"),
      title: z.string().optional().describe("Exact title"),
      url: z.string().optional().describe("Exact URL"),
      format: fmtSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, title, url, format }) => {
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
    const nodes = await bridge.call("search", [arg]);
    return format === "json"
      ? json(nodes)
      : text(formatList(nodes).join("\n") || "(no matches)");
  },
);

tool(
  "bookmarks_get_recent",
  {
    title: "Recently added",
    description: "Return recently added bookmarks, newest first.",
    inputSchema: {
      count: z.number().int().min(1).max(200).default(20),
      format: fmtSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ count, format }) => {
    const nodes = await bridge.call("getRecent", [count]);
    return format === "json"
      ? json(nodes)
      : text(formatList(nodes).join("\n") || "(none)");
  },
);

tool(
  "bookmarks_create",
  {
    title: "Create",
    description:
      'Create a bookmark or a folder. Omit url to create a folder. If parentId is omitted, Chrome puts it in "Other bookmarks".',
    inputSchema: {
      parentId: z.string().optional().describe("Parent folder id"),
      title: z.string().describe("Title"),
      url: z.string().optional().describe("URL (omit to create a folder)"),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Position within the parent (omit to append)"),
    },
  },
  async ({ parentId, title, url, index }) => {
    const node = await bridge.call("create", [{ parentId, title, url, index }]);
    return text(`Created: ${formatList([node])[0]}`);
  },
);

tool(
  "bookmarks_update",
  {
    title: "Update",
    description: "Change the title and/or URL (only the fields given).",
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      url: z.string().optional().describe("Not allowed for folders"),
    },
  },
  async ({ id, title, url }) => {
    const changes = {};
    if (title !== undefined) changes.title = title;
    if (url !== undefined) changes.url = url;
    if (!Object.keys(changes).length)
      throw new Error("Specify title and/or url");
    const node = await bridge.call("update", [id, changes]);
    return text(`Updated: ${formatList([node])[0]}`);
  },
);

tool(
  "bookmarks_move",
  {
    title: "Move",
    description:
      "Move a node to another folder, or reorder it within the same folder.",
    inputSchema: {
      id: z.string(),
      parentId: z
        .string()
        .optional()
        .describe("Destination folder id (omit to stay in the same folder)"),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Destination position (omit to append)"),
    },
  },
  async ({ id, parentId, index }) => {
    const dest = {};
    if (parentId !== undefined) dest.parentId = parentId;
    if (index !== undefined) dest.index = index;
    const node = await bridge.call("move", [id, dest]);
    return text(`Moved: ${formatList([node])[0]}`);
  },
);

tool(
  "bookmarks_remove",
  {
    title: "Remove (single)",
    description:
      "Remove one bookmark or an empty folder. For a non-empty folder use bookmarks_remove_tree. " +
      "This cannot be undone; confirm the target with the user before calling.",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ id }) => {
    const [node] = await bridge.call("get", [[id]]);
    await bridge.call("remove", [id]);
    return text(`Removed: ${formatList([node])[0]}`);
  },
);

tool(
  "bookmarks_remove_tree",
  {
    title: "Remove folder recursively",
    description:
      "Remove a folder and everything inside it. This cannot be undone; inspect the subtree with " +
      "bookmarks_get_tree and get the user's approval before calling.",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ id }) => {
    const [sub] = await bridge.call("getSubTree", [id]);
    const lines = formatTree([sub]);
    await bridge.call("removeTree", [id]);
    return text(`Removed (${lines.length} lines):\n${lines.join("\n")}`);
  },
);

// ---------------------------------------------------------------------------
async function main() {
  await bridge.listen();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server v${VERSION} ready`);
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
