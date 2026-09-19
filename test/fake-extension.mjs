// Fake extension for testing the server without Chrome.
// Emulates the main chrome.bookmarks APIs on an in-memory tree and speaks the same protocol as extension/background.js.

import WebSocket from "ws";

export function createFakeBookmarks() {
  let seq = 10;
  const nodes = new Map();
  const add = (n) => {
    nodes.set(n.id, n);
    return n;
  };
  add({ id: "0", title: "", children: ["1", "2", "3"] });
  add({
    id: "1",
    parentId: "0",
    index: 0,
    title: "Bookmarks bar",
    children: [],
  });
  add({
    id: "2",
    parentId: "0",
    index: 1,
    title: "Other bookmarks",
    children: [],
  });
  add({
    id: "3",
    parentId: "0",
    index: 2,
    title: "Mobile bookmarks",
    children: [],
  });

  const isFolder = (n) => !n.url;
  const reindex = (folder) =>
    folder.children.forEach((cid, i) => {
      nodes.get(cid).index = i;
    });
  const pub = (n) => {
    const { children, ...rest } = n;
    return rest;
  };
  const toTree = (n) =>
    isFolder(n)
      ? { ...pub(n), children: n.children.map((c) => toTree(nodes.get(c))) }
      : pub(n);
  const must = (id) => {
    const n = nodes.get(String(id));
    if (!n) throw new Error(`Can't find bookmark for id.`);
    return n;
  };

  const api = {
    getTree: async () => [toTree(nodes.get("0"))],
    getSubTree: async (id) => [toTree(must(id))],
    getChildren: async (id) => must(id).children.map((c) => pub(nodes.get(c))),
    get: async (ids) =>
      (Array.isArray(ids) ? ids : [ids]).map((i) => pub(must(i))),
    getRecent: async (count) =>
      [...nodes.values()]
        .filter((n) => n.url)
        .sort((a, b) => b.dateAdded - a.dateAdded)
        .slice(0, count)
        .map(pub),
    search: async (q) => {
      const all = [...nodes.values()].filter((n) => n.id !== "0");
      if (typeof q === "string") {
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        return all
          .filter((n) =>
            words.every((w) =>
              `${n.title} ${n.url || ""}`.toLowerCase().includes(w),
            ),
          )
          .map(pub);
      }
      return all
        .filter(
          (n) =>
            (q.title === undefined || n.title === q.title) &&
            (q.url === undefined || n.url === q.url) &&
            (q.query === undefined ||
              `${n.title} ${n.url || ""}`
                .toLowerCase()
                .includes(q.query.toLowerCase())),
        )
        .map(pub);
    },
    create: async ({ parentId = "2", title = "", url, index }) => {
      const parent = must(parentId);
      if (!isFolder(parent))
        throw new Error("Parameter 'parentId' does not specify a folder.");
      const n = {
        id: String(++seq),
        parentId: parent.id,
        title,
        dateAdded: Date.now(),
      };
      if (url) n.url = url;
      else n.children = [];
      add(n);
      parent.children.splice(index ?? parent.children.length, 0, n.id);
      reindex(parent);
      return pub(n);
    },
    update: async (id, changes) => {
      const n = must(id);
      if (changes.title !== undefined) n.title = changes.title;
      if (changes.url !== undefined) {
        if (isFolder(n)) throw new Error("Can't set URL of a bookmark folder.");
        n.url = changes.url;
      }
      return pub(n);
    },
    move: async (id, dest) => {
      const n = must(id);
      const from = must(n.parentId);
      const to = dest.parentId !== undefined ? must(dest.parentId) : from;
      from.children.splice(from.children.indexOf(n.id), 1);
      reindex(from);
      to.children.splice(dest.index ?? to.children.length, 0, n.id);
      n.parentId = to.id;
      reindex(to);
      return pub(n);
    },
    remove: async (id) => {
      const n = must(id);
      if (isFolder(n) && n.children.length)
        throw new Error(
          "Can't remove non-empty folder (use recursive to force).",
        );
      const p = must(n.parentId);
      p.children.splice(p.children.indexOf(n.id), 1);
      reindex(p);
      nodes.delete(n.id);
    },
    removeTree: async (id) => {
      const n = must(id);
      const rm = (x) => {
        if (isFolder(x)) x.children.forEach((c) => rm(nodes.get(c)));
        nodes.delete(x.id);
      };
      const p = must(n.parentId);
      p.children.splice(p.children.indexOf(n.id), 1);
      reindex(p);
      rm(n);
    },
  };
  return api;
}

/** Keep connecting to the server ports until stop() is called. */
export function startFakeExtension(
  ports,
  bookmarks = createFakeBookmarks(),
  { origin = "chrome-extension://fakeextensionid" } = {},
) {
  const sockets = new Map();
  let stopped = false;

  const connect = (port) => {
    if (stopped || sockets.has(port)) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    sockets.set(port, ws);
    ws.on("open", () =>
      ws.send(JSON.stringify({ hello: { extensionVersion: "fake" } })),
    );
    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.ping) return ws.send(JSON.stringify({ pong: true }));
      if (msg.id === undefined) return;
      try {
        const fn = bookmarks[msg.api];
        if (!fn) throw new Error(`API not allowed: ${msg.api}`);
        const result = await fn(...(msg.args || []));
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: result === undefined ? null : result,
          }),
        );
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, error: e.message }));
      }
    });
    ws.on("close", () => sockets.delete(port));
    ws.on("error", () => {});
  };
  const tick = () => ports.forEach(connect);
  tick();
  const timer = setInterval(tick, 500);
  return {
    bookmarks,
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const ws of sockets.values()) ws.terminate();
    },
    get connected() {
      return [...sockets.values()].filter(
        (w) => w.readyState === WebSocket.OPEN,
      ).length;
    },
  };
}
