// DoFirst server: a zero-dependency Node.js HTTP server.
//
// - Serves the web app from ./public
// - Exposes a small JSON API under /api/tasks
// - Persists tasks to a JSON file so the board survives restarts and
//   reinstalls. Default location: ~/.dofirst/tasks.json
//   Override with the DOFIRST_DATA_DIR environment variable or --data-dir.
//
// Requires Node.js 18 or later. No npm dependencies.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { scoreTask, QUADRANTS } from "./lib/scorer.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

export function resolveDataFile(options = {}) {
  const dir =
    options.dataDir ||
    process.env.DOFIRST_DATA_DIR ||
    join(homedir(), ".dofirst");
  return join(dir, "tasks.json");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function loadTasks(dataFile) {
  try {
    const raw = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

async function saveTasks(dataFile, tasks) {
  await mkdir(dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  await writeFile(tmp, JSON.stringify({ tasks }, null, 2), "utf8");
  await rename(tmp, dataFile);
}

function nextSortOrder(tasks, quadrant) {
  const inQuadrant = tasks.filter((t) => t.quadrant === quadrant);
  if (!inQuadrant.length) return 0;
  return Math.max(...inQuadrant.map((t) => t.sortOrder || 0)) + 1;
}

function cleanTaskInput(body) {
  const rating = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
  };
  return {
    title: String(body.title || "").trim(),
    description: String(body.description || "").trim(),
    context: body.context === "personal" ? "personal" : "work",
    dueDate: body.dueDate || body.due_date || null,
    impact: rating(body.impact),
    importance: rating(body.importance),
    criticality: rating(body.criticality),
  };
}

function applyScore(task, scored) {
  task.aiScore = scored.score;
  task.aiReasoning = scored.reasoning;
  task.impact = scored.impact;
  task.importance = scored.importance;
  task.criticality = scored.criticality;
  return task;
}

export async function createAppServer(options = {}) {
  const dataFile = resolveDataFile(options);
  let tasks = await loadTasks(dataFile);

  async function persist() {
    await saveTasks(dataFile, tasks);
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api","tasks",...]

    if (req.method === "GET" && parts.length === 2) {
      const sorted = [...tasks].sort(
        (a, b) => a.quadrant.localeCompare(b.quadrant) || (a.sortOrder || 0) - (b.sortOrder || 0),
      );
      return sendJson(res, 200, { tasks: sorted });
    }

    if (req.method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      const input = cleanTaskInput(body);
      if (!input.title) return sendJson(res, 400, { error: "A task title is required." });
      const now = new Date().toISOString();
      const task = {
        id: randomUUID(),
        ...input,
        quadrant: "eliminate",
        status: "active",
        aiScore: null,
        aiReasoning: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (body.useAi === false && QUADRANTS.includes(body.quadrant)) {
        task.quadrant = body.quadrant;
        task.impact = input.impact ?? 3;
        task.importance = input.importance ?? 3;
        task.criticality = input.criticality ?? 3;
      } else {
        const scored = scoreTask(input);
        applyScore(task, scored);
        task.quadrant = scored.quadrant;
      }
      task.sortOrder = nextSortOrder(tasks, task.quadrant);
      tasks.push(task);
      await persist();
      return sendJson(res, 201, { task });
    }

    if (req.method === "POST" && parts.length === 3 && parts[2] === "score-all") {
      for (const task of tasks) {
        if (task.status === "done") continue;
        const scored = scoreTask(task);
        applyScore(task, scored);
        const target = scored.quadrant;
        if (target !== task.quadrant) {
          task.sortOrder = nextSortOrder(tasks, target);
          task.quadrant = target;
        }
        task.updatedAt = new Date().toISOString();
      }
      await persist();
      return sendJson(res, 200, { tasks });
    }

    const id = parts[2];
    const task = tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: "Task not found." });

    if (req.method === "GET" && parts.length === 3) {
      return sendJson(res, 200, { task });
    }

    if (req.method === "PUT" && parts.length === 3) {
      const body = await readBody(req);
      if (body.title !== undefined || body.description !== undefined) {
        Object.assign(task, cleanTaskInput({ ...task, ...body }));
      }
      if (QUADRANTS.includes(body.quadrant) && body.quadrant !== task.quadrant) {
        task.sortOrder = nextSortOrder(tasks, body.quadrant);
        task.quadrant = body.quadrant;
      }
      if (body.status === "done" || body.status === "active") task.status = body.status;
      if (typeof body.sortOrder === "number") task.sortOrder = body.sortOrder;
      task.updatedAt = new Date().toISOString();
      await persist();
      return sendJson(res, 200, { task });
    }

    if (req.method === "POST" && parts.length === 4 && parts[3] === "score") {
      const scored = scoreTask(task);
      applyScore(task, scored);
      if (scored.quadrant !== task.quadrant) {
        task.sortOrder = nextSortOrder(tasks, scored.quadrant);
        task.quadrant = scored.quadrant;
      }
      task.updatedAt = new Date().toISOString();
      await persist();
      return sendJson(res, 200, { task });
    }

    if (req.method === "DELETE" && parts.length === 3) {
      tasks = tasks.filter((t) => t.id !== id);
      await persist();
      return sendJson(res, 200, { deleted: true });
    }

    return sendJson(res, 404, { error: "Not found." });
  }

  async function handleStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/standalone.html") {
      // The portable single-file edition lives at the app root, so users can
      // download it and run it on any managed AI hosting platform.
      const data = await readFile(join(ROOT, "standalone.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(data);
    }
    if (pathname === "/") pathname = "/index.html";
    const filePath = normalize(join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
      // Single-page app fallback for non-file routes.
      const index = join(PUBLIC_DIR, "index.html");
      const html = await readFile(index, "utf8");
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(html);
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
    });
    return res.end(data);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (req.method === "GET") return await handleStatic(req, res, url);
      res.writeHead(405); res.end("Method not allowed");
    } catch (err) {
      sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  return { server, dataFile, getTasks: () => tasks };
}

export async function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 4173);
  const host = options.host || process.env.HOST || "127.0.0.1";
  const { server, dataFile } = await createAppServer(options);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { server, dataFile, url: `http://${host}:${port}` };
}

// Run directly: `node server.js` or `npm start`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { url, dataFile } = await startServer();
  console.log(`DoFirst is running at ${url}`);
  console.log(`Tasks are saved in ${dataFile}`);
}
