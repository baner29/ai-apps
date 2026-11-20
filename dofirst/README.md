# DoFirst: Task Prioritization Matrix with AI Scoring

**DoFirst** is a task prioritization app for personal and professional work. It puts every task on a prioritization matrix with four quadrants, so you can see at a glance what to do now, what to schedule, what to hand off, and what to drop.

You can place each task yourself, or let the built-in AI scoring engine place it for you. The engine reads the task description and weighs the due date, impact, importance, and criticality, then gives the task a score from 0 to 100, a quadrant, and a short reason you can check. If you disagree, drag the task to a different quadrant. Your placement always wins.

DoFirst runs entirely on your own computer. It has **zero npm dependencies**, needs **no API keys and no accounts**, and works offline. Your tasks are saved in a file on your machine, never sent anywhere.

---

## The matrix

DoFirst uses the Eisenhower Matrix. Each task sits in one of four quadrants, based on how urgent and how important it is.

| Quadrant | Urgent | Important | What it means | Example |
| --- | --- | --- | --- | --- |
| **Do Now** | Yes | Yes | Do this first, before anything else on the board. | Fix a production outage that is due today |
| **Schedule** | No | Yes | Important work with no immediate deadline. Give it a date and protect the time. | Plan next quarter's roadmap |
| **Delegate** | Yes | No | Time-sensitive, but it does not need you personally. Hand it to someone else if you can. | Book a meeting room for tomorrow |
| **Eliminate** | No | No | Low value in both directions. Drop it, or keep it parked here until it earns a move. | Re-read an old report nobody asked for |

---

## Key features

- **Drag and drop:** Drag any task card from one quadrant to another. On touch screens, each card also has a move menu, so the board works on a phone.
- **Quick add:** Type a title, pick a due date, and add the task in seconds. The AI places it for you.
- **Detailed add:** Add a description, a due date, a context (Work or Personal), and 1 to 5 ratings for impact, importance, and criticality.
- **Manual or AI placement:** Choose the quadrant yourself, or let the AI decide. You can switch approaches task by task.
- **AI score and reasoning:** Every AI-placed task shows a score from 0 to 100 and the reason for its placement, written on the card.
- **Re-score at any time:** Use **AI Place** on a single card to score it again, or **AI Prioritize All** to score and re-rank the whole board in one pass.
- **Filters and search:** Filter the board by All, Work, or Personal, search by title, and show or hide completed tasks.
- **Full task control:** Edit a task, mark it done, or delete it from its card.
- **Persistent by default:** Tasks are saved to a file on your computer, so your board survives restarts, updates, and reinstalls.

---

## Installation

**Prerequisite for every method:** [Node.js](https://nodejs.org) 18 or later. Node.js includes `npm` and `npx`. Download the LTS installer for Windows or macOS from nodejs.org and run it, then check your install:

```bash
node --version   # v18 or higher
npm --version
```

### Option 1: One command with npx (Windows, macOS, Linux)

This downloads only the `dofirst` folder from this repository, installs it, and runs it. No Git required.

```bash
npx degit baner29/ai-apps/dofirst dofirst-app
cd dofirst-app
npm install
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) in your browser.

### Option 2: Clone the repository

```bash
git clone https://github.com/baner29/ai-apps.git
cd ai-apps/dofirst
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173) in your browser. (`npm install` is not needed. DoFirst has no dependencies.)

### Option 3: Install the `dofirst` command

Install DoFirst once, then start it from any terminal with a single command.

```bash
# From inside the dofirst folder (see Option 1 or 2):
npm install -g .

# From then on, anywhere:
dofirst
```

The `dofirst` command starts the server and opens the app in your default browser. Useful flags:

```bash
dofirst --port 8080          # use a different port
dofirst --data-dir ./my-data # save tasks in a different folder
dofirst --no-open            # start the server without opening a browser
```

On Windows, npm creates a `dofirst` command that works in both PowerShell and Command Prompt. On macOS, if `npm install -g` reports a permissions error, install Node.js from the official installer (which sets up a user-writable global folder) or prefix the command with `sudo`.

### Option 4: Install it as a desktop app (Windows and macOS)

DoFirst is an installable web app (PWA), so once it is running you can pin it to your desktop, dock, or taskbar like a native app.

1. Start DoFirst with any method above and open it in your browser.
2. **Windows (Chrome or Edge):** Click the install icon in the address bar, or open the browser menu and choose **Save and share, then Install DoFirst** (Chrome) or **Apps, then Install this site as an app** (Edge).
3. **macOS (Chrome or Edge):** Same as Windows. **macOS (Safari):** Choose **File, then Add to Dock**.
4. Launch DoFirst from your desktop, Start menu, or Dock. Keep the `dofirst` server command running in a terminal while you use it, because the app window talks to your local server.

### Where your tasks are saved

Tasks are stored in a JSON file on your own computer:

- **macOS and Linux:** `~/.dofirst/tasks.json`
- **Windows:** `C:\Users\<your-name>\.dofirst\tasks.json`

The file lives outside the app folder, so updating or reinstalling DoFirst never deletes your board. To use a different location, set the `DOFIRST_DATA_DIR` environment variable or pass `--data-dir` to the `dofirst` command. To change the port, set `PORT` or pass `--port`.

---

## How AI prioritization works

The scoring engine runs locally in `lib/scorer.js`. It makes no network calls and needs no API keys. When you ask it to place a task, it weighs five inputs together:

1. **Task description:** Keyword analysis of the title and description. Words like "outage", "deadline", and "blocked" raise criticality. Words like "client", "launch", and "interview" raise importance. Words like "someday" and "maybe" lower the score.
2. **Urgency:** How close the due date is. An overdue task scores 100 for urgency, a task due today scores 95, and the score falls as the due date moves further out. A task with no due date scores 20.
3. **Impact (1 to 5):** How much difference finishing this task makes.
4. **Importance (1 to 5):** How much this task matters to your goals.
5. **Criticality (1 to 5):** How serious it is if this task slips or fails.

The final score is a weighted total: urgency 35%, importance 25%, impact 20%, and criticality 20%, plus a small keyword adjustment. If you leave a rating unset, the engine infers a starting rating from the description and tells you it did so in the reasoning.

The engine returns three things:

- A **score** from 0 to 100. Higher means do it sooner.
- A **quadrant** on the matrix.
- A short **reason**, shown on the card, so you can check the logic instead of trusting it blindly.

You stay in control at every step. Dragging a task to a new quadrant overrides the engine, and editing a task lets you score it again with fresh inputs.

---

## Usage guide

### Add a task quickly

1. Type the task title in the quick-add bar.
2. Pick a due date if the task has one.
3. Click **Add**. The task appears in the quadrant the AI chose, with its score and reason on the card.

### Add a task with full control

1. Click **Detailed add**.
2. Fill in the title, description, due date, and context (Work or Personal).
3. Rate impact, importance, and criticality from 1 to 5, or leave them on Auto to infer them from the description.
4. Either pick the quadrant yourself in the Placement field, or leave it on "Let the AI decide".
5. Save. The task appears on the board with the ratings shown on its card.

### Change a priority

- **Drag** the card to the quadrant you want, or use the card's **move menu** on touch screens.
- **Edit** the task to change its due date or ratings, then use **AI Place** to score it again.
- Use **AI Prioritize All** after a busy planning session to re-rank the whole board at once.

### Keep the board clean

- Mark a task **done** from the circle on its card. Done tasks can be shown or hidden.
- **Filter** by Work or Personal when you want to plan one side of your life at a time.
- **Search** when the board gets large and you need one task fast.
- Move tasks that no longer matter to **Eliminate**, then delete them when you are sure.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 18 or later, built-in modules only (zero npm dependencies) |
| Server | Node.js `http` server in `server.js`, serving a JSON API and the static web app |
| Frontend | Plain HTML, CSS, and JavaScript in `public/` (no build step, no framework) |
| Drag and drop | Native HTML5 drag events, with a move menu fallback for touch |
| AI scoring | Local scoring engine in `lib/scorer.js` (keyword analysis plus weighted ratings, no network calls) |
| Storage | A JSON file on the user's machine (`~/.dofirst/tasks.json` by default), written atomically |
| CLI | `bin/dofirst.js`, published through the `bin` field in `package.json` |
| Tests | Node.js built-in test runner (`node --test`) |

### Project layout

```text
dofirst/
  package.json          Package manifest, scripts, and the `dofirst` CLI entry
  server.js             HTTP server, JSON API, and task storage
  bin/
    dofirst.js          Command-line launcher (starts the server, opens a browser)
  lib/
    scorer.js           The AI scoring engine and quadrant rules
  public/
    index.html          The board page
    app.js              Board UI: rendering, drag and drop, forms, filters
    styles.css          Styling, including light and dark colour schemes
    manifest.webmanifest  Installable app (PWA) manifest
    sw.js               Service worker that caches the app shell
    icons/              App icons (SVG and PNG)
  test/
    scorer.test.js      Scoring engine tests
```

### HTTP API

The server exposes a small JSON API. The web UI uses it, and you can call it from any other tool.

| Method and path | Purpose |
| --- | --- |
| `GET /api/tasks` | List every task |
| `POST /api/tasks` | Create a task. Send `useAi: true` for AI placement, or `useAi: false` with a `quadrant` for manual placement |
| `GET /api/tasks/:id` | Read one task |
| `PUT /api/tasks/:id` | Update a task, including moving it with `{ "quadrant": "schedule" }` or completing it with `{ "status": "done" }` |
| `DELETE /api/tasks/:id` | Delete a task |
| `POST /api/tasks/:id/score` | Score and place one task with the AI engine |
| `POST /api/tasks/score-all` | Score and place every active task in one pass |

Quadrant values are `do-now`, `schedule`, `delegate`, and `eliminate`. Context values are `work` and `personal`.

### Data model

Each task in `tasks.json` has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Unique task ID |
| `title` | Task title |
| `description` | Optional longer description |
| `quadrant` | Current quadrant: `do-now`, `schedule`, `delegate`, or `eliminate` |
| `context` | `work` or `personal` |
| `dueDate` | Due date (`YYYY-MM-DD`), or null |
| `impact` | Impact rating, 1 to 5 |
| `importance` | Importance rating, 1 to 5 |
| `criticality` | Criticality rating, 1 to 5 |
| `status` | `active` or `done` |
| `aiScore` | Latest AI score, 0 to 100, or null if never scored |
| `aiReasoning` | Latest AI reason for the placement |
| `sortOrder` | Position of the task within its quadrant |
| `createdAt`, `updatedAt` | Timestamps |

---

## Development

```bash
npm start     # run the app on http://127.0.0.1:4173
npm test      # run the scoring engine tests
```

There is no build step. Edit a file in `public/` or `lib/`, restart the server, and refresh the browser.

---

## Troubleshooting

**The AI put a task in the wrong quadrant.**
Drag it to the right one. Your placement overrides the AI. If the inputs were off, edit the due date or the ratings and use **AI Place** to score it again.

**Dragging does not work on my phone.**
Use the move menu on the card instead. It does the same thing and is built for touch screens.

**A task due today is not in Do Now.**
Check its impact, importance, and criticality ratings. A task can be due today and still score low if it does not matter much. Raise the ratings, or move it by hand.

**My tasks disappeared.**
Check the filters first. A Work or Personal filter, a search term, or the hide-done setting can hide tasks without deleting them. Clear the filter and turn on show-done to see the full board. Your data file is at `~/.dofirst/tasks.json` (Windows: `C:\Users\<your-name>\.dofirst\tasks.json`).

**The port is already in use.**
Start DoFirst on another port: `dofirst --port 8080`, or `PORT=8080 npm start`.

**`dofirst` is not recognised as a command.**
Re-run Option 3 above, and open a new terminal afterwards so your shell picks up the new command. On Windows, make sure you installed Node.js from the official installer, which adds npm's global folder to your PATH.

---

## License

This project is part of the [ai-apps](https://github.com/baner29/ai-apps) repository and is released under the Apache License 2.0. See the repository's `LICENSE` file for details.
