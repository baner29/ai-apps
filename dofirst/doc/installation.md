# Installation

This document gives the full installation steps for DoFirst.
The README gives an overview of the steps.

## Before you start

Install Node.js 18 or a later version.
Node.js includes the `npm` and `npx` commands.

1. Go to [nodejs.org](https://nodejs.org).
2. Download the LTS installer for your operating system.
3. Run the installer.
4. Open a terminal.
5. Enter `node --version` and check that the version is 18 or higher.

DoFirst has no npm dependencies.
DoFirst needs no API keys.
DoFirst needs no user account.

## Method 1: Install with npx

Use this method to get only the `dofirst` folder.
You do not need Git for this method.
The commands are the same on Windows, macOS, and Linux.

1. Open a terminal.
2. Enter this command:

   ```bash
   npx degit baner29/ai-apps/dofirst dofirst-app
   ```

3. Enter `cd dofirst-app`.
4. Enter `npm install`.
5. Enter `npm start`.
6. Open [http://127.0.0.1:4173](http://127.0.0.1:4173) in your browser.

## Method 2: Clone the repository

1. Open a terminal.
2. Enter this command:

   ```bash
   git clone https://github.com/baner29/ai-apps.git
   ```

3. Enter `cd ai-apps/dofirst`.
4. Enter `npm start`.
5. Open [http://127.0.0.1:4173](http://127.0.0.1:4173) in your browser.

## Method 3: Install the `dofirst` command

Use this method to start DoFirst from any folder with one command.

1. Get the `dofirst` folder with Method 1 or Method 2.
2. Open a terminal in the `dofirst` folder.
3. Enter `npm install -g .`.
4. Close the terminal and open a new terminal.
5. Enter `dofirst` in any folder.

The command starts the server.
The command opens DoFirst in your default browser.

You can add flags to the command:

| Flag | Effect |
| --- | --- |
| `--port 8080` | Use port 8080 |
| `--data-dir ./my-data` | Save tasks in the `./my-data` folder |
| `--no-open` | Start the server and do not open a browser |

On Windows, the command works in PowerShell and in Command Prompt.
On macOS, a permissions error can occur during Step 3.
Install Node.js from the official installer to prevent this error.

## Where DoFirst saves your tasks

DoFirst saves tasks in one JSON file:

- macOS and Linux: `~/.dofirst/tasks.json`
- Windows: `C:\Users\<your-name>\.dofirst\tasks.json`

The file is outside the app folder.
An update or a new installation does not delete the file.
To use a different location, set the `DOFIRST_DATA_DIR` environment variable.
You can also use the `--data-dir` flag with the `dofirst` command.
To use a different port, set the `PORT` environment variable.
You can also use the `--port` flag.

## Update DoFirst

1. Stop the server.
2. Get the new files with Method 1 or Method 2.
3. Start the server again.

Your task file stays in its location.
DoFirst reads the same file after the update.

## Remove DoFirst

1. Stop the server.
2. Delete the app folder.
3. If you used Method 3, enter `npm uninstall -g dofirst`.
4. To delete your tasks also, delete the `.dofirst` folder in your home folder.

## Troubleshooting

**The AI puts a task in the wrong quadrant.**
Drag the task to the correct quadrant.
Your placement replaces the AI placement.
You can also edit the due date or the ratings and click **AI Place**.

**Drag and drop does not work on a touch screen.**
Use the move menu on the task card.
The move menu has the same effect.

**A task due today is not in Do Now.**
Check the impact, importance, and criticality ratings.
A task with a near due date and low ratings can get a low score.
Increase the ratings, or move the task manually.

**Tasks do not appear on the board.**
Check the context filter, the search field, and the Show done setting.
These controls can hide tasks.
The controls do not delete tasks.

**The port is in use.**
Start DoFirst on a different port.
Example: `dofirst --port 8080`.

**The terminal does not find the `dofirst` command.**
Do Method 3 again.
Open a new terminal after the installation.
On Windows, install Node.js from the official installer.
The installer adds the npm folder to your PATH.
