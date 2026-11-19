// CLI test: run `chrome-bookmarks` commands against the fake extension, through the background daemon.
//   node test/cli.mjs
// Uses test-only ports and a temporary state directory, so it never touches a real daemon,
// a real MCP session or the real Chrome extension.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeExtension } from "./fake-extension.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "server", "cli.js");
const TEST_PORTS = [17877, 17876];
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbm-cli-test-"));
const env = {
  ...process.env,
  CHROME_BOOKMARKS_MCP_PORTS: TEST_PORTS.join(","),
  CHROME_BOOKMARKS_STATE_DIR: stateDir,
  CHROME_BOOKMARKS_IDLE_MS: "3000",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(...args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env, timeout: 60000 },
      (err, stdout, stderr) => {
        const r = { code: err ? (err.code ?? 1) : 0, stdout, stderr };
        console.log(
          `\n$ chrome-bookmarks ${args.join(" ")}  (exit ${r.code})\n${stdout}${stderr}`,
        );
        resolve(r);
      },
    );
  });
}
const idOf = (s) => s.match(/\[(\d+)\]/)[1];

// Occupy the first port (as another MCP session would) so the daemon has to move on to the next one
const blocker = net.createServer();
await new Promise((r) => blocker.listen(TEST_PORTS[0], "127.0.0.1", r));
const DAEMON_PORT = TEST_PORTS[1];

const fake = startFakeExtension(TEST_PORTS);
try {
  const help = await cli("help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /remove-tree/);

  const st0 = await cli("status");
  assert.equal(JSON.parse(st0.stdout).daemon, "stopped");

  // start returns at once, before the extension has connected
  const t0 = Date.now();
  const started = await cli("start");
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /daemon running/);
  assert.ok(Date.now() - t0 < 10000, "start should not wait for the extension");

  // The next command uses that daemon, which the fake extension then reaches
  const top = await cli("children", "0");
  assert.equal(top.code, 0, top.stderr);
  assert.match(top.stdout, /Bookmarks bar/);

  const st = JSON.parse((await cli("status")).stdout);
  assert.equal(st.daemon, "running");
  assert.equal(st.port, DAEMON_PORT);
  assert.equal(st.connected, 1);

  const f = await cli("create", "--parent", "1", "--title", "Test folder");
  const folderId = idOf(f.stdout);
  const b = await cli(
    "create",
    "--parent",
    folderId,
    "--title",
    "Anthropic",
    "--url",
    "https://www.anthropic.com/",
  );
  const bId = idOf(b.stdout);
  await cli(
    "create",
    "--parent",
    folderId,
    "--title",
    "Claude Code Docs",
    "--url",
    "https://docs.claude.com/",
  );

  assert.match((await cli("tree")).stdout, /📁 Test folder \(2\)/);
  const sub = JSON.parse((await cli("tree", folderId, "--json")).stdout);
  assert.equal(sub[0].children.length, 2);

  assert.match((await cli("search", "anthropic")).stdout, /Anthropic/);
  assert.match(
    (await cli("search", "--url", "https://docs.claude.com/")).stdout,
    /Claude Code Docs/,
  );
  const s3 = await cli("search");
  assert.equal(s3.code, 1);
  assert.match(s3.stderr, /Specify at least one/);

  assert.match(
    (await cli("update", bId, "--title", "Anthropic (official)")).stdout,
    /Anthropic \(official\)/,
  );
  assert.match((await cli("get", bId)).stdout, /index=0/);
  assert.match((await cli("move", bId, "--index", "1")).stdout, /index=1/);
  assert.match((await cli("move", bId, "--parent", "2")).stdout, /parent=2/);
  assert.match((await cli("recent", "5")).stdout, /Anthropic/);

  assert.notEqual((await cli("move", bId, "--index", "x")).code, 0);
  assert.notEqual((await cli("nope")).code, 0);

  assert.match((await cli("remove", bId)).stdout, /^Removed:/);
  assert.equal((await cli("remove", folderId)).code, 1); // a clean error exit, not a crash
  assert.match((await cli("remove-tree", folderId)).stdout, /Claude Code Docs/);
  assert.equal((await cli("children", "1")).stdout.trim(), "(empty)");

  // A request without the token is refused
  const forged = await fetch(`http://127.0.0.1:${DAEMON_PORT}/rpc`, {
    method: "POST",
    body: JSON.stringify({ op: "call", api: "getTree", args: [] }),
  });
  assert.equal(forged.status, 426);

  // A daemon of another version (e.g. left over from before an upgrade) is replaced
  const stateFile = path.join(stateDir, `daemon-${TEST_PORTS.join("-")}.json`);
  const oldState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ ...oldState, version: "0.0.0-old" }),
  );
  assert.match((await cli("children", "0")).stdout, /Bookmarks bar/);
  const newState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.notEqual(
    newState.pid,
    oldState.pid,
    "old-version daemon was not replaced",
  );
  assert.notEqual(newState.version, "0.0.0-old");

  // stop, then a new command starts a fresh daemon
  assert.match((await cli("stop")).stdout, /stopped daemon/);
  await sleep(300);
  assert.equal(JSON.parse((await cli("status")).stdout).daemon, "stopped");
  assert.match((await cli("children", "0")).stdout, /Other bookmarks/);

  // The daemon exits by itself after the idle period (3 s here; checked every 3 s)
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (JSON.parse((await cli("status")).stdout).daemon === "stopped") break;
  }
  assert.equal(JSON.parse((await cli("status")).stdout).daemon, "stopped");

  console.log("\nOK: all CLI assertions passed");
} finally {
  fake.stop();
  blocker.close();
  await cli("stop");
  fs.rmSync(stateDir, { recursive: true, force: true });
}
