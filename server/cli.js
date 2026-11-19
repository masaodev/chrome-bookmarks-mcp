#!/usr/bin/env node
// chrome-bookmarks — command-line access to Chrome bookmarks without keeping an MCP server running.
//
//   CLI ──(HTTP 127.0.0.1, token)── daemon ──(WebSocket 127.0.0.1)── Chrome extension ──(chrome.bookmarks)── Chrome
//
// The first command starts a shared background daemon on one of the extension's ports. The extension
// only reconnects every 30 s, so the first command may wait up to ~30 s; later commands reuse the
// connection and return immediately. The daemon exits by itself after an idle period (default 10 min).
//
// Run `chrome-bookmarks help` for the commands.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Bridge, createOps, makeLog, resolvePorts } from "./bridge.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json");
const PORTS = resolvePorts();
const IDLE_MS =
  Number.parseInt(process.env.CHROME_BOOKMARKS_IDLE_MS || "", 10) || 600000;
const CONNECT_WAIT_MS = 40000; // the extension's reconnect alarm fires every 30 s
const STATE_DIR =
  process.env.CHROME_BOOKMARKS_STATE_DIR ||
  path.join(os.tmpdir(), "chrome-bookmarks-mcp");
// One daemon per port set, so the tests (other ports) never touch the real daemon.
const STATE_FILE = path.join(STATE_DIR, `daemon-${PORTS.join("-")}.json`);
const TOKEN_HEADER = "x-chrome-bookmarks-token";

const HELP = `chrome-bookmarks ${VERSION} — read and write Chrome bookmarks from the command line

Usage: chrome-bookmarks <command> [options]

Read
  status                         Connection status of the background daemon
  tree [id]                      Whole tree, or the subtree under id (folder ids are in [brackets])
  children <id>                  Direct children of a folder (id 0 lists the top-level folders)
  get <id> [id...]               Nodes by id
  search [query] [--title T] [--url U]
                                 query = word match on title and URL; --title / --url = exact match
  recent [count]                 Recently added bookmarks (default 20)

Write
  create --title T [--url U] [--parent ID] [--index N]
                                 Create a bookmark (or a folder when --url is omitted)
  update <id> [--title T] [--url U]
  move <id> [--parent ID] [--index N]
  remove <id>                    Remove one bookmark or an empty folder (cannot be undone)
  remove-tree <id>               Remove a folder and everything inside it (cannot be undone)

Daemon
  start                          Start the background daemon and return at once (warm-up:
                                 the extension connects while you do something else)
  stop                           Stop the background daemon now

Options
  --json                         Print raw chrome.bookmarks data as JSON

The first command starts a background daemon and waits for the "Chrome Bookmarks MCP Bridge"
extension to connect (up to ~30 s). The daemon exits after ${Math.round(IDLE_MS / 60000)} min without commands.`;

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      s += c;
      if (s.length > 1e6) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

async function runDaemon() {
  const log = makeLog("chrome-bookmarks-daemon");
  const token = crypto.randomBytes(24).toString("hex");
  let lastActivity = Date.now();

  const send = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const bridge = new Bridge({
    ports: PORTS,
    log,
    async onHttp(req, res) {
      // Only our CLI may use the control endpoint. Browsers always send Origin on cross-site
      // requests and cannot add the token header without a CORS preflight, which we never grant.
      if (
        req.method !== "POST" ||
        req.url !== "/rpc" ||
        req.headers.origin ||
        req.headers[TOKEN_HEADER] !== token
      ) {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
        return;
      }
      try {
        const { op, api, args, wait } = JSON.parse(await readBody(req));
        // status does not count as activity, so polling it never keeps the daemon alive
        if (op === "status") return send(res, 200, { result: bridge.status() });
        if (op === "stop") {
          send(res, 200, { result: "stopping" });
          return setTimeout(shutdown, 50);
        }
        if (op === "call") {
          lastActivity = Date.now();
          if (!bridge.connected && wait)
            await bridge.waitForClient(Math.min(Number(wait), CONNECT_WAIT_MS));
          const result = await bridge.call(api, args || []);
          lastActivity = Date.now();
          return send(res, 200, { result });
        }
        send(res, 400, { error: `unknown op: ${op}` });
      } catch (e) {
        send(res, 200, { error: String(e?.message || e) });
      }
    },
  });

  const shutdown = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(STATE_FILE);
    } catch {
      /* already gone */
    }
    bridge.close();
    log("exiting");
    process.exit(0);
  };

  const port = await bridge.listen();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ pid: process.pid, port, token, version: VERSION }),
    { mode: 0o600 },
  );
  log(`daemon v${VERSION} ready on port ${port} (idle exit ${IDLE_MS} ms)`);

  setInterval(
    () => {
      if (!bridge.busy && Date.now() - lastActivity > IDLE_MS) shutdown();
    },
    Math.min(30000, IDLE_MS),
  ).unref?.();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function rpc(state, body, timeoutMs = 5000) {
  const res = await fetch(`http://127.0.0.1:${state.port}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TOKEN_HEADER]: state.token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) throw new Error(`daemon answered HTTP ${res.status}`);
  const msg = await res.json();
  if (msg.error !== undefined) throw new Error(msg.error);
  return msg.result;
}

/** Return the state of a live daemon, or null. */
async function liveDaemon() {
  const state = readState();
  if (!state) return null;
  try {
    await rpc(state, { op: "status" }, 2000);
    return state;
  } catch {
    return null;
  }
}

/** Wait until the stopped daemon has removed its state file (it exits right after). */
async function waitForPortRelease(old) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (readState()?.pid !== old.pid) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function ensureDaemon() {
  const live = await liveDaemon();
  // A daemon from another version (e.g. left over from before an upgrade) is replaced,
  // so that the command always runs with the code that was just installed.
  if (live && live.version === VERSION) return live;
  if (live) {
    try {
      await rpc(live, { op: "stop" });
    } catch {
      /* already exiting */
    }
    await waitForPortRelease(live);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(STATE_DIR, "daemon.log"), "a");
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "__daemon"],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
  fs.closeSync(logFd);

  const until = Date.now() + 10000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    const state = readState();
    if (state?.pid === child.pid) {
      try {
        await rpc(state, { op: "status" }, 2000);
        return state;
      } catch {
        /* not ready yet */
      }
    }
  }
  throw new Error(
    `Could not start the background daemon (see ${path.join(STATE_DIR, "daemon.log")})`,
  );
}

async function makeCaller() {
  const state = await ensureDaemon();
  let notified = false;
  return async (api, args) => {
    if (!notified) {
      notified = true;
      const st = await rpc(state, { op: "status" });
      if (!st.connected)
        process.stderr.write(
          "Waiting for the Chrome extension to connect (up to ~30 s)...\n",
        );
    }
    return rpc(
      state,
      { op: "call", api, args, wait: CONNECT_WAIT_MS },
      CONNECT_WAIT_MS + 20000,
    );
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const intOpt = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0 || String(n) !== String(v).trim())
    throw new Error(`--${name} must be a non-negative integer`);
  return n;
};
const need = (v, what) => {
  if (v === undefined || v === "") throw new Error(`Missing ${what}`);
  return v;
};

async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      title: { type: "string" },
      url: { type: "string" },
      parent: { type: "string" },
      index: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [cmd, ...rest] = positionals;

  if (o.version) return console.log(VERSION);
  if (o.help || !cmd || cmd === "help") return console.log(HELP);
  if (cmd === "__daemon") return runDaemon();

  if (cmd === "stop") {
    const live = await liveDaemon();
    if (!live) return console.log("daemon is not running");
    await rpc(live, { op: "stop" });
    return console.log(`stopped daemon (pid ${live.pid})`);
  }
  if (cmd === "start") {
    const state = await ensureDaemon();
    const st = await rpc(state, { op: "status" });
    return console.log(
      `daemon running (pid ${state.pid}, port ${st.port}); ` +
        (st.connected
          ? "Chrome extension connected"
          : "waiting for the Chrome extension (connects within ~30 s)"),
    );
  }
  if (cmd === "status") {
    const live = await liveDaemon();
    const st = live
      ? {
          daemon: "running",
          pid: live.pid,
          ...(await rpc(live, { op: "status" })),
        }
      : { daemon: "stopped" };
    return console.log(JSON.stringify(st, null, 2));
  }

  const runners = {
    tree: (ops) => ops.getTree({ id: rest[0] }),
    children: (ops) => ops.getChildren({ id: need(rest[0], "folder id") }),
    get: (ops) => ops.get({ ids: rest.length ? rest : need(undefined, "id") }),
    search: (ops) =>
      ops.search({
        query: rest.length ? rest.join(" ") : undefined,
        title: o.title,
        url: o.url,
      }),
    recent: (ops) => ops.getRecent({ count: intOpt(rest[0], "count") ?? 20 }),
    create: (ops) =>
      ops.create({
        parentId: o.parent,
        title: need(o.title, "--title"),
        url: o.url,
        index: intOpt(o.index, "index"),
      }),
    update: (ops) =>
      ops.update({ id: need(rest[0], "id"), title: o.title, url: o.url }),
    move: (ops) =>
      ops.move({
        id: need(rest[0], "id"),
        parentId: o.parent,
        index: intOpt(o.index, "index"),
      }),
    remove: (ops) => ops.remove({ id: need(rest[0], "id") }),
    "remove-tree": (ops) => ops.removeTree({ id: need(rest[0], "id") }),
  };
  const run = runners[cmd];
  if (!run)
    throw new Error(`Unknown command: ${cmd} (see chrome-bookmarks help)`);

  const ops = createOps(await makeCaller());
  const { data, text } = await run(ops);
  console.log(o.json ? JSON.stringify(data, null, 2) : text);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`Error: ${e.message || e}`);
  // Let the process end by itself: process.exit() while fetch's sockets are still closing
  // trips a libuv assertion on Windows (exit code 3221226505 instead of 1).
  process.exitCode = 1;
});
