// DoFirst web UI. Talks to the local server API in server.js.

const QUADRANTS = [
  { id: "do-now", label: "Do Now", sub: "Urgent and important" },
  { id: "schedule", label: "Schedule", sub: "Important, not urgent" },
  { id: "delegate", label: "Delegate", sub: "Urgent, not important" },
  { id: "eliminate", label: "Eliminate", sub: "Neither urgent nor important" },
];

const state = { tasks: [], filter: "all", search: "", showDone: true };

const $ = (sel) => document.querySelector(sel);
const board = $("#board");
const statusEl = $("#status");

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function load() {
  const data = await api("/api/tasks");
  state.tasks = data.tasks;
  render();
}

function visibleTasks() {
  const q = state.search.trim().toLowerCase();
  return state.tasks.filter((t) => {
    if (state.filter !== "all" && t.context !== state.filter) return false;
    if (!state.showDone && t.status === "done") return false;
    if (q && !`${t.title} ${t.description || ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dueChip(task) {
  if (!task.dueDate) return null;
  const due = new Date(`${task.dueDate}T23:59:59`);
  const today = new Date();
  const days = Math.round(
    (new Date(due.getFullYear(), due.getMonth(), due.getDate()) -
      new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000,
  );
  const chip = el("span", "chip", `Due ${task.dueDate}`);
  if (days < 0 && task.status !== "done") {
    chip.classList.add("overdue");
    chip.textContent = `Overdue: ${task.dueDate}`;
  } else if (days === 0) {
    chip.classList.add("overdue");
    chip.textContent = "Due today";
  } else if (days === 1) {
    chip.textContent = "Due tomorrow";
  }
  return chip;
}

function cardFor(task) {
  const card = el("article", "card" + (task.status === "done" ? " done" : ""));
  card.draggable = true;
  card.dataset.id = task.id;
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
  });

  const top = el("div", "card-top");
  const doneBtn = el("button", "done-toggle", task.status === "done" ? "✓" : "");
  doneBtn.type = "button";
  doneBtn.title = task.status === "done" ? "Mark as active" : "Mark as done";
  doneBtn.addEventListener("click", async () => {
    await api(`/api/tasks/${task.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: task.status === "done" ? "active" : "done" }),
    });
    await load();
  });
  top.appendChild(doneBtn);

  const body = el("div");
  body.appendChild(el("p", "card-title", task.title));
  if (task.description) body.appendChild(el("p", "card-desc", task.description));

  const meta = el("div", "meta");
  if (typeof task.aiScore === "number") {
    meta.appendChild(el("span", "chip score", `AI ${task.aiScore}`));
  }
  meta.appendChild(el("span", "chip", task.context === "personal" ? "Personal" : "Work"));
  const due = dueChip(task);
  if (due) meta.appendChild(due);
  meta.appendChild(el("span", "chip", `Impact ${task.impact ?? "-"}/5`));
  meta.appendChild(el("span", "chip", `Importance ${task.importance ?? "-"}/5`));
  meta.appendChild(el("span", "chip", `Criticality ${task.criticality ?? "-"}/5`));
  body.appendChild(meta);

  if (task.aiReasoning) body.appendChild(el("p", "reasoning", task.aiReasoning));

  const actions = el("div", "card-actions");
  const scoreBtn = el("button", "", "AI Place");
  scoreBtn.type = "button";
  scoreBtn.addEventListener("click", async () => {
    setStatus("Scoring...");
    await api(`/api/tasks/${task.id}/score`, { method: "POST" });
    setStatus("");
    await load();
  });
  const editBtn = el("button", "", "Edit");
  editBtn.type = "button";
  editBtn.addEventListener("click", () => openDetailForEdit(task));
  const delBtn = el("button", "", "Delete");
  delBtn.type = "button";
  delBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    await api(`/api/tasks/${task.id}`, { method: "DELETE" });
    await load();
  });
  const move = document.createElement("select");
  move.setAttribute("aria-label", "Move to quadrant");
  for (const q of QUADRANTS) {
    const opt = document.createElement("option");
    opt.value = q.id;
    opt.textContent = `Move: ${q.label}`;
    opt.selected = q.id === task.quadrant;
    move.appendChild(opt);
  }
  move.addEventListener("change", async () => {
    await api(`/api/tasks/${task.id}`, {
      method: "PUT",
      body: JSON.stringify({ quadrant: move.value }),
    });
    await load();
  });
  actions.append(scoreBtn, editBtn, delBtn, move);
  body.appendChild(actions);

  top.appendChild(body);
  card.appendChild(top);
  return card;
}

function render() {
  const visible = visibleTasks();
  const active = state.tasks.filter((t) => t.status !== "done").length;
  $("#counts").textContent = `${active} active · ${state.tasks.length - active} done`;

  board.innerHTML = "";
  for (const q of QUADRANTS) {
    const section = el("section", "quadrant");
    section.dataset.q = q.id;
    section.addEventListener("dragover", (e) => {
      e.preventDefault();
      section.classList.add("drag-over");
    });
    section.addEventListener("dragleave", () => section.classList.remove("drag-over"));
    section.addEventListener("drop", async (e) => {
      e.preventDefault();
      section.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      await api(`/api/tasks/${id}`, {
        method: "PUT",
        body: JSON.stringify({ quadrant: q.id }),
      });
      await load();
    });

    const head = el("div", "quadrant-head");
    const inQ = visible.filter((t) => t.quadrant === q.id);
    head.appendChild(el("h2", "", `${q.label} (${inQ.length})`));
    head.appendChild(el("span", "q-sub", q.sub));
    section.appendChild(head);

    const cards = el("div", "cards");
    if (!inQ.length) cards.appendChild(el("p", "empty", "No tasks here. Drag one in, or add it above."));
    for (const task of inQ) cards.appendChild(cardFor(task));
    section.appendChild(cards);
    board.appendChild(section);
  }
}

// Quick add: the AI places the task.
$("#quick-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#quick-title").value.trim();
  if (!title) return;
  setStatus("Adding and scoring...");
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title, dueDate: $("#quick-due").value || null, useAi: true }),
  });
  $("#quick-title").value = "";
  $("#quick-due").value = "";
  setStatus("");
  await load();
});

// Detailed form: manual placement or AI, with full ratings.
const detailForm = $("#detail-form");
$("#toggle-detail").addEventListener("click", () => {
  detailForm.hidden = !detailForm.hidden;
  if (!detailForm.hidden) $("#f-title").focus();
});
$("#detail-cancel").addEventListener("click", () => {
  detailForm.reset();
  $("#f-id").value = "";
  $("#detail-submit").textContent = "Save task";
  detailForm.hidden = true;
});

function openDetailForEdit(task) {
  detailForm.hidden = false;
  $("#f-id").value = task.id;
  $("#f-title").value = task.title;
  $("#f-desc").value = task.description || "";
  $("#f-due").value = task.dueDate || "";
  $("#f-context").value = task.context;
  $("#f-quadrant").value = task.quadrant;
  $("#f-impact").value = task.impact ?? "";
  $("#f-importance").value = task.importance ?? "";
  $("#f-criticality").value = task.criticality ?? "";
  $("#detail-submit").textContent = "Save changes";
  $("#f-title").focus();
}

detailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const placement = $("#f-quadrant").value;
  const payload = {
    title: $("#f-title").value.trim(),
    description: $("#f-desc").value.trim(),
    dueDate: $("#f-due").value || null,
    context: $("#f-context").value,
    impact: $("#f-impact").value || null,
    importance: $("#f-importance").value || null,
    criticality: $("#f-criticality").value || null,
  };
  const id = $("#f-id").value;
  setStatus("Saving...");
  if (id) {
    await api(`/api/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        ...payload,
        quadrant: placement === "ai" ? undefined : placement,
      }),
    });
    if (placement === "ai") {
      await api(`/api/tasks/${id}/score`, { method: "POST" });
    }
  } else if (placement === "ai") {
    await api("/api/tasks", { method: "POST", body: JSON.stringify({ ...payload, useAi: true }) });
  } else {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ ...payload, useAi: false, quadrant: placement }),
    });
  }
  detailForm.reset();
  $("#f-id").value = "";
  $("#detail-submit").textContent = "Save task";
  detailForm.hidden = true;
  setStatus("");
  await load();
});

$("#score-all").addEventListener("click", async () => {
  setStatus("Scoring every active task...");
  await api("/api/tasks/score-all", { method: "POST" });
  setStatus("");
  await load();
});

document.querySelectorAll("[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.filter = btn.dataset.filter;
    render();
  });
});
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});
$("#show-done").addEventListener("change", (e) => {
  state.showDone = e.target.checked;
  render();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

load().catch((err) => setStatus(`Could not load tasks: ${err.message}`));
