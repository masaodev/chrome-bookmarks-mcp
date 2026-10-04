# chrome-bookmarks-mcp

[日本語版 README](README.ja.md)

An [MCP](https://modelcontextprotocol.io/) server that lets Claude Code (or any MCP client) **read and write your Chrome bookmarks**, using a small companion Chrome extension.

```
MCP client ──(stdio / MCP)── chrome-bookmarks-mcp ──(WebSocket 127.0.0.1:17870-17874)── extension ──(chrome.bookmarks)── Chrome
```

Chrome exposes bookmark editing only to extensions (`chrome.bookmarks`), and editing the `Bookmarks` file directly does not work while Chrome is running. So this project ships two parts:

- **`chrome-bookmarks-mcp`** (npm) — the MCP server. It starts a WebSocket listener on `127.0.0.1` and forwards tool calls to the extension.
- **Chrome Bookmarks MCP Bridge** (`extension/`) — a Manifest V3 extension that connects to the server and executes `chrome.bookmarks` calls on its behalf.

## Features

- 11 tools: status, get_tree, get_children, get, search, get_recent, create, update, move, remove, remove_tree
- Multiple MCP clients at once: the server takes the first free port in 17870–17874, the extension connects to all five
- Local only: the server binds to `127.0.0.1` and accepts connections whose `Origin` is `chrome-extension://`
- The extension runs only a fixed whitelist of `chrome.bookmarks` APIs
- Destructive tools (`remove`, `remove_tree`) are annotated with `destructiveHint` so clients can ask for confirmation

## Setup

Requires Node.js 18+ and Google Chrome (or another Chromium browser that supports MV3 extensions).

### 1. Register the MCP server

Claude Code:

```sh
claude mcp add --scope user chrome-bookmarks -- npx -y chrome-bookmarks-mcp
claude mcp list   # chrome-bookmarks: ✔ Connected
```

Any other MCP client — add to its server configuration:

```json
{
  "mcpServers": {
    "chrome-bookmarks": {
      "command": "npx",
      "args": ["-y", "chrome-bookmarks-mcp"]
    }
  }
}
```

### 2. Load the extension (once per Chrome profile)

1. Download `chrome-bookmarks-mcp-extension-<version>.zip` from the [Releases](https://github.com/masaodev/chrome-bookmarks-mcp/releases) page and unzip it (or use the `extension/` folder of this repository).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. A green bookmark icon appears in the toolbar. Its badge shows the number of connected MCP servers (empty while no MCP client is running).

Load it in the profile whose bookmarks you want to edit. If the extension is loaded in several profiles, the server sends commands to **the most recently connected** one.

> Chrome shows a "Disable developer mode extensions" prompt on startup for unpacked extensions. Dismiss it (or click "Cancel"); the extension keeps working.

### 3. Try it

Open a new Claude Code session and ask, for example, "list my bookmark folders". Claude will call `bookmarks_get_tree`.

## Tools

| Tool                     | Description                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `bookmarks_status`       | Connection status with the extension (check this first when something fails) |
| `bookmarks_get_tree`     | Whole tree or subtree under an id, as `[id] 📁 title (children)` lines       |
| `bookmarks_get_children` | Direct children of a folder, in order                                        |
| `bookmarks_get`          | Nodes by id                                                                  |
| `bookmarks_search`       | Free-text search (Chrome's built-in) or exact title / url match              |
| `bookmarks_get_recent`   | Recently added bookmarks                                                     |
| `bookmarks_create`       | Create a bookmark or a folder (omit `url` for a folder)                      |
| `bookmarks_update`       | Change title / URL                                                           |
| `bookmarks_move`         | Move to another folder or reorder                                            |
| `bookmarks_remove`       | Remove one bookmark or an empty folder                                       |
| `bookmarks_remove_tree`  | Remove a folder with everything inside                                       |

Every read tool accepts `format: "json"` to get the raw `BookmarkTreeNode` objects instead of the text listing.

The ids of the top-level folders (Bookmarks bar / Other bookmarks / Mobile bookmarks) differ between Chrome profiles. Call `bookmarks_get_children` with id `0` to look them up.

## Troubleshooting

| Symptom                                                                                                                      | What to check                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Chrome extension is not connected"                                                                                          | Is Chrome running? Is the extension enabled at `chrome://extensions`? Click the extension icon to force a reconnect. A session opened before the server was registered does not start it — open a new session (or `/mcp` → reconnect in Claude Code). Open the extension's "Service worker" console for details. |
| `claude mcp list` says Failed                                                                                                | Run `npx chrome-bookmarks-mcp` in a terminal and read stderr. The server refuses to start when all ports 17870–17874 are taken.                                                                                                                                                                                  |
| The extension's Errors list fills with `WebSocket connection to 'ws://127.0.0.1:1787x/' failed: net::ERR_CONNECTION_REFUSED` | Harmless, and fixed in extension 0.1.1: older versions tried every port every 30 s and each port without a server logged a failure. Update the extension, then clear the list.                                                                                                                                   |
| Bookmarks of the wrong profile are changed                                                                                   | The server talks to the most recently connected extension. Disable the extension in profiles you do not want to edit.                                                                                                                                                                                            |

## Development

```sh
git clone https://github.com/masaodev/chrome-bookmarks-mcp.git
cd chrome-bookmarks-mcp
npm install
npm test               # smoke test with a fake extension (no Chrome needed)
npm run live           # read-only check against the real extension (load extension/ first)
npm run pack:extension # dist/chrome-bookmarks-mcp-extension-<version>.zip
```

To run the server from a checkout instead of npm:

```sh
claude mcp add --scope user chrome-bookmarks -- node /path/to/chrome-bookmarks-mcp/server/index.js
```

### Design notes

- MV3 service workers are suspended after ~30 s of inactivity, so the server sends an application-level ping every 20 s and the extension also reconnects from a 30 s alarm.
- A failed WebSocket connection is always logged as an extension error, so the extension first probes each port with a quiet `fetch` (the server answers plain HTTP with 426) and opens a WebSocket only where a server is listening.
- Native Messaging was not used: the host Chrome would spawn and the MCP server the client spawns are separate processes, so a bridge would be needed anyway. One WebSocket does the job.
- `CHROME_BOOKMARKS_MCP_PORTS=17879,17878` (comma-separated) overrides the candidate ports. The smoke test uses this so that a test server never shares the 17870–17874 range with real sessions or the real extension.
- The server and the extension share a tiny JSON protocol (`{id, api, args}` → `{id, result | error}`), so keep their versions in step.

## Security

The server listens on the loopback interface only and rejects connections without a `chrome-extension://` origin. The extension only executes the whitelisted `chrome.bookmarks` methods listed in `background.js`. Any local process could in principle connect to the port and pose as an MCP server; if that matters in your environment, disable the extension when not in use.

## License

[MIT](LICENSE)
