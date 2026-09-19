// Zip the extension/ folder into dist/chrome-bookmarks-mcp-extension-<version>.zip
// for attaching to a GitHub release. Uses PowerShell on Windows and `zip` elsewhere.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(root, "extension", "manifest.json"), "utf8"),
);
const dist = path.join(root, "dist");
const out = path.join(
  dist,
  `chrome-bookmarks-mcp-extension-${manifest.version}.zip`,
);

mkdirSync(dist, { recursive: true });
rmSync(out, { force: true });

if (process.platform === "win32") {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${path.join(root, "extension", "*")}' -DestinationPath '${out}'`,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("zip", ["-r", out, "."], {
    cwd: path.join(root, "extension"),
    stdio: "inherit",
  });
}
console.log(`wrote ${path.relative(root, out)}`);
