#!/usr/bin/env node
// DoFirst command-line launcher.
//
// Installed globally (`npm install -g .` from this folder, or
// `npm install -g dofirst` once published), this starts the DoFirst
// server and opens it in the default browser.
//
// Usage:
//   dofirst [--port 4173] [--data-dir <folder>] [--no-open]

import { spawn } from "node:child_process";
import { startServer } from "../server.js";

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const port = Number(argValue("--port") || process.env.PORT || 4173);
const dataDir = argValue("--data-dir");
const noOpen = args.includes("--no-open");

const { url, dataFile } = await startServer({ port, dataDir });
console.log(`DoFirst is running at ${url}`);
console.log(`Tasks are saved in ${dataFile}`);
console.log("Press Ctrl+C to stop.");

if (!noOpen) {
  const cmd =
    process.platform === "win32" ? "cmd" :
    process.platform === "darwin" ? "open" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Opening the browser is a convenience only; the URL above always works.
  }
}
