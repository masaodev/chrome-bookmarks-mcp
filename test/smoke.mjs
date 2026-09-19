// Smoke test: start the server as an MCP client, attach the fake extension and exercise every tool.
//   node test/smoke.mjs
// The server is started on a test-only port (outside 17870-17874) so that the fake extension never
// reaches a real session's server and the real Chrome extension never reaches this test server.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeExtension } from "./fake-extension.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORTS = [17879, 17878];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "server", "index.js")],
  env: { ...process.env, CHROME_BOOKMARKS_MCP_PORTS: TEST_PORTS.join(",") },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.map((c) => c.text).join("\n");
  console.log(`\n== ${name} ${JSON.stringify(args)}\n${t}`);
  return { ...r, text: t };
};

let fake;
try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));
  assert.equal(tools.length, 11);

  // Errors while no extension is connected
  const r0 = await call("bookmarks_get_tree");
  assert.equal(r0.isError, true);
  assert.match(r0.text, /not connected/);

  fake = startFakeExtension(TEST_PORTS);
  for (let i = 0; i < 20 && fake.connected === 0; i++) await sleep(100);
  assert.ok(fake.connected >= 1, "fake extension could not connect");
  await sleep(100);

  const st = await call("bookmarks_status");
  assert.match(st.text, /"connected": 1/);
  assert.equal(JSON.parse(st.text).port, TEST_PORTS[0]);

  const f = await call("bookmarks_create", {
    parentId: "1",
    title: "Test folder",
  });
  const folderId = f.text.match(/\[(\d+)\]/)[1];
  const b = await call("bookmarks_create", {
    parentId: folderId,
    title: "Anthropic",
    url: "https://www.anthropic.com/",
  });
  const bId = b.text.match(/\[(\d+)\]/)[1];
  await call("bookmarks_create", {
    parentId: folderId,
    title: "Claude Code Docs",
    url: "https://docs.claude.com/",
  });

  const tree = await call("bookmarks_get_tree");
  assert.match(tree.text, /📁 Test folder \(2\)/);
  const sub = await call("bookmarks_get_tree", {
    id: folderId,
    format: "json",
  });
  assert.equal(JSON.parse(sub.text)[0].children.length, 2);

  const ch = await call("bookmarks_get_children", { id: folderId });
  assert.equal(ch.text.split("\n").length, 2);

  const s = await call("bookmarks_search", { query: "anthropic" });
  assert.match(s.text, /Anthropic/);
  const s2 = await call("bookmarks_search", {
    url: "https://docs.claude.com/",
  });
  assert.match(s2.text, /Claude Code Docs/);
  const s3 = await call("bookmarks_search", {});
  assert.equal(s3.isError, true);

  const u = await call("bookmarks_update", {
    id: bId,
    title: "Anthropic (official)",
  });
  assert.match(u.text, /Anthropic \(official\)/);
  const g = await call("bookmarks_get", { ids: [bId] });
  assert.match(g.text, /index=0/);

  const m = await call("bookmarks_move", { id: bId, index: 1 });
  assert.match(m.text, /index=1/);
  const m2 = await call("bookmarks_move", { id: bId, parentId: "2" });
  assert.match(m2.text, /parent=2/);

  await call("bookmarks_get_recent", { count: 5 });

  const rm = await call("bookmarks_remove", { id: bId });
  assert.match(rm.text, /^Removed:/);
  const rmFolderFail = await call("bookmarks_remove", { id: folderId });
  assert.equal(rmFolderFail.isError, true);
  const rt = await call("bookmarks_remove_tree", { id: folderId });
  assert.match(rt.text, /Claude Code Docs/);
  const after = await call("bookmarks_get_children", { id: "1" });
  assert.equal(after.text, "(empty)");

  // Back to the not-connected error once the extension goes away
  fake.stop();
  await sleep(200);
  const r9 = await call("bookmarks_get_tree");
  assert.equal(r9.isError, true);

  console.log("\nOK: all assertions passed");
} finally {
  fake?.stop();
  await client.close();
}
