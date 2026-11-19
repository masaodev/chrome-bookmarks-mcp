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
import { z } from "zod";
import { Bridge, createOps, makeLog, resolvePorts } from "./bridge.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json");
const log = makeLog("chrome-bookmarks-mcp");

const text = (s) => ({ content: [{ type: "text", text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const out = ({ data, text: t }, format) =>
  format === "json" ? json(data) : text(t);
const errorResult = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message || e}` }],
  isError: true,
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const bridge = new Bridge({ ports: resolvePorts(), log });
const ops = createOps((api, args) => bridge.call(api, args));
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
  async ({ id, format }) => out(await ops.getTree({ id }), format),
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
  async ({ id, format }) => out(await ops.getChildren({ id }), format),
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
  async ({ ids, format }) => out(await ops.get({ ids }), format),
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
  async ({ format, ...q }) => out(await ops.search(q), format),
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
  async ({ count, format }) => out(await ops.getRecent({ count }), format),
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
  async (args) => text((await ops.create(args)).text),
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
  async (args) => text((await ops.update(args)).text),
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
  async (args) => text((await ops.move(args)).text),
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
  async ({ id }) => text((await ops.remove({ id })).text),
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
  async ({ id }) => text((await ops.removeTree({ id })).text),
);

// ---------------------------------------------------------------------------
async function main() {
  await bridge.listen();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Exit when the client closes our stdin (the SDK transport does not watch for EOF, and the
  // WebSocket server would otherwise keep an orphaned process alive and hold a port forever).
  process.stdin.on("end", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });
  log(`MCP server v${VERSION} ready`);
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
