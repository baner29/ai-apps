# DoFirst: Task Prioritization Matrix with AI Scoring

**DoFirst** is a task prioritization app for personal and professional work. It puts every task on a prioritization matrix with four quadrants, so you can see at a glance what to do now, what to schedule, what to hand off, and what to drop.

You can place each task yourself, or let the AI place it for you. The AI reads the task description and weighs the due date, impact, importance, and criticality, then gives the task a score from 0 to 100, a quadrant, and a short reason you can check. If you disagree, drag the task to a different quadrant. Your placement always wins.

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
- **Saved automatically:** Tasks are stored in a database, so your board is still there when you come back.

---

## How AI prioritization works

When you ask the AI to place a task, it weighs five inputs together:

1. **Task description:** What the task actually is, in your own words.
2. **Urgency:** How close the due date is. A task due today scores higher than the same task due next month.
3. **Impact (1 to 5):** How much difference finishing this task makes.
4. **Importance (1 to 5):** How much this task matters to your goals.
5. **Criticality (1 to 5):** How serious it is if this task slips or fails.

The AI returns three things:

- A **score** from 0 to 100. Higher means do it sooner.
- A **quadrant** on the matrix.
- A short **reason**, shown on the card, so you can check the logic instead of trusting it blindly.

If the AI service is unavailable, DoFirst falls back to a built-in scoring rule that weighs due-date urgency against impact, importance, and criticality. The board never gets stuck waiting on the AI.

You stay in control at every step. Dragging a task to a new quadrant overrides the AI, and editing a task lets you score it again with fresh inputs.

---

## Installation and getting started

### For users: use the hosted app (no local install)

DoFirst runs as a hosted web app, so there is nothing to download or configure.

1. Open **DoFirst** in the Muse app, or from your Muse Library on the web.
2. The board opens empty, with the four quadrants ready.
3. Add your first task with **Quick Add**: type the title, set a due date, and click **Add**. The AI places it on the board.
4. To control the placement yourself, open the **Detailed** form instead, fill in the ratings, and pick the quadrant by hand.
5. Drag cards between quadrants as your priorities change. Mark tasks done from the circle on each card.

**Requirements:** A Muse account and a modern browser. The board works on desktop and mobile. On mobile, use the move menu on each card instead of dragging.

### For developers: the stack and local setup

DoFirst is built as a Muse Space (a hosted TypeScript web app). Its application source is managed inside Muse and is not checked into this repository. This folder is the public documentation for the app. The table below lists the exact stack and versions the live app uses, and the steps after it describe how to set up the same architecture locally.

| Layer | Technology | Version in the live app |
| --- | --- | --- |
| Language | TypeScript | 5.6.3 |
| Frontend | React | 19.2.5 |
| Styling | Tailwind CSS | 4.1.13 |
| Data fetching | TanStack React Query | 5.100.10 |
| Runtime and build | Bun | 1.3.10 |
| Backend | Server actions via `@hatch/space-sdk`, validated with Zod | Zod 4.4.3 |
| Database | SQLite via Drizzle ORM | Drizzle ORM 0.45.2 |
| AI | Platform inference, with a deterministic fallback scorer | Model is abstracted by the platform SDK |

**Prerequisites**

- [Bun](https://bun.sh) 1.3.10 or later (the project uses Bun as its runtime and package manager)
- Git
- A Muse workspace, if you want to run the app as a Space with the same server actions and AI inference

**Set up the same stack locally**

```bash
# 1. Clone this repository (documentation and sibling apps)
git clone https://github.com/baner29/ai-apps.git
cd ai-apps

# 2. Install Bun if you do not have it yet
curl -fsSL https://bun.sh/install | bash

# 3. In your own Space or TypeScript project, install the versions DoFirst uses
bun add react@19.2.5 react-dom@19.2.5 @tanstack/react-query@5.100.10
bun add drizzle-orm@0.45.2 zod@4.4.3
bun add -d typescript@5.6.3 tailwindcss@4.1.13
```

**Project layout of the live app**

```text
client/
  src/
    App.tsx        The single-page matrix board (drag and drop, forms, filters)
    api.ts         Typed client for the server actions
    main.tsx       React entry point
    theme.css      Tailwind CSS 4 theme and per-quadrant colours
server/
  src/
    actions.ts     All server actions, including AI scoring
    schema.ts      The tasks table definition (Drizzle, SQLite)
drizzle/           Database migrations
space.json         Space runtime configuration (TypeScript)
package.json       Bun project manifest
```

**Server actions**

The backend exposes seven actions. The client calls them through a typed interface, and Zod validates every request and response.

| Action | Purpose |
| --- | --- |
| `listTasks` | Load every task on the board |
| `createTask` | Add a task, with AI placement when requested |
| `updateTask` | Edit a task's fields |
| `moveTask` | Move a task to a different quadrant |
| `deleteTask` | Remove a task |
| `aiScoreTask` | Score and place one task with the AI |
| `aiPrioritizeAll` | Score and place every active task in one pass |

---

## Usage guide

### Add a task quickly

1. Type the task title in the quick-add bar.
2. Pick a due date if the task has one.
3. Click **Add**. The task appears in the quadrant the AI chose, with its score and reason on the card.

### Add a task with full control

1. Open the **Detailed** form.
2. Fill in the title, description, due date, and context (Work or Personal).
3. Rate impact, importance, and criticality from 1 to 5.
4. Either pick the quadrant yourself, or leave placement to the AI.
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

## Data model

Tasks are stored in a single SQLite table named `tasks`.

| Field | Meaning |
| --- | --- |
| `id` | Unique task ID |
| `title` | Task title |
| `description` | Optional longer description |
| `quadrant` | Current quadrant: Do Now, Schedule, Delegate, or Eliminate |
| `context` | Work or Personal |
| `due_date` | Due date, if the task has one |
| `impact` | Impact rating, 1 to 5 |
| `importance` | Importance rating, 1 to 5 |
| `criticality` | Criticality rating, 1 to 5 |
| `status` | Active or done |
| `ai_score` | Latest AI score, 0 to 100 |
| `ai_reasoning` | Latest AI reason for the placement |
| `sort_order` | Position of the task within its quadrant |
| `created_at`, `updated_at` | Timestamps |

---

## Troubleshooting

**The AI put a task in the wrong quadrant.**
Drag it to the right one. Your placement overrides the AI. If the inputs were off, edit the due date or the ratings and use **AI Place** to score it again.

**Dragging does not work on my phone.**
Use the move menu on the card instead. It does the same thing and is built for touch screens.

**A task due today is not in Do Now.**
Check its impact, importance, and criticality ratings. A task can be due today and still score low if it does not matter much. Raise the ratings, or move it by hand.

**My tasks disappeared.**
Check the filters first. A Work or Personal filter, a search term, or the hide-done setting can hide tasks without deleting them. Clear the filter and turn on show-done to see the full board.

---

## License

This project is part of the [ai-apps](https://github.com/baner29/ai-apps) repository and is released under the Apache License 2.0. See the repository's `LICENSE` file for details.
