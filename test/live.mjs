// Live check: start the server, wait for the real Chrome extension to connect, then call read-only tools (no writes).
//   node test/live.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client({ name: "live", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "..", "server", "index.js")],
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => process.stderr.write(`  [server] ${d}`));
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content.map((c) => c.text).join("\n");
};

try {
  // The extension reconnects every 30 s; wait up to 45 s
  let status;
  for (let i = 0; i < 45; i++) {
    status = JSON.parse(await call("bookmarks_status"));
    if (status.connected > 0) break;
    await sleep(1000);
  }
  console.log("status:", JSON.stringify(status));
  if (!status.connected) {
    console.log("NG: the extension did not connect");
    process.exitCode = 1;
  } else {
    const tree = await call("bookmarks_get_tree");
    const lines = tree.split("\n");
    console.log(`tree: ${lines.length} lines`);
    console.log(lines.slice(0, 15).join("\n"));
    console.log("...");
    console.log(await call("bookmarks_get_recent", { count: 5 }));
    console.log("OK");
  }
} finally {
  await client.close();
}
