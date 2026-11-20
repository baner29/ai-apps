# API and data

## HTTP API

The server gives a JSON API.
The web app uses this API.
Other tools on your computer can also use this API.

| Method and path | Function |
| --- | --- |
| `GET /api/tasks` | Get all tasks |
| `POST /api/tasks` | Create a task |
| `GET /api/tasks/:id` | Get one task |
| `PUT /api/tasks/:id` | Update a task |
| `DELETE /api/tasks/:id` | Delete a task |
| `POST /api/tasks/:id/score` | Score one task and set its quadrant |
| `POST /api/tasks/score-all` | Score all active tasks and set their quadrants |

To create a task with AI placement, send `useAi` with the value `true`.
To create a task with manual placement, send `useAi` with the value `false` and send a `quadrant` value.
To move a task, send a `PUT` request with a `quadrant` value.
To complete a task, send a `PUT` request with `status` and the value `done`.

Quadrant values: `do-now`, `schedule`, `delegate`, `eliminate`.
Context values: `work`, `personal`.
Status values: `active`, `done`.

## Data file

DoFirst saves all tasks in one JSON file.
The default location is `~/.dofirst/tasks.json`.
See `doc/installation.md` for other locations and for Windows.
The server writes the file in two steps.
First the server writes a temporary file.
Then the server replaces the old file with the temporary file.
This procedure protects the file during a power loss or a crash.

## Task fields

| Field | Meaning |
| --- | --- |
| `id` | Unique task ID |
| `title` | Task title |
| `description` | Longer description, can be empty |
| `quadrant` | Current quadrant |
| `context` | `work` or `personal` |
| `dueDate` | Due date in `YYYY-MM-DD` form, or null |
| `impact` | Impact rating, 1 to 5 |
| `importance` | Importance rating, 1 to 5 |
| `criticality` | Criticality rating, 1 to 5 |
| `status` | `active` or `done` |
| `aiScore` | Last AI score, 0 to 100, or null |
| `aiReasoning` | Last AI reasoning text, or null |
| `sortOrder` | Position of the task in its quadrant |
| `createdAt` | Creation time |
| `updatedAt` | Last change time |

## Backup

To make a backup, copy the `tasks.json` file to a safe location.
To restore a backup, stop the server and replace the `tasks.json` file with the copy.
Then start the server again.
