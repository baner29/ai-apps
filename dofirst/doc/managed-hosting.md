# Managed hosting platforms

This document explains how to run DoFirst on a managed AI hosting platform.
A managed platform runs the app on its own servers.
Your tasks stay on that platform, in your account on that platform.
Each platform section below follows the official documentation of that platform.

## The three methods

Most platforms accept one of these three methods:

1. **Single file:** Paste or upload `standalone.html` from this repository.
   The file contains the full app.
   The app saves tasks in the browser storage of the platform.
   On a chat-based platform such as Gemini, you attach the file inside a chat.
   Then you ask the assistant to open the file in the app surface of that platform.
2. **Repository import:** Give the platform the GitHub address of this repository.
   The platform copies the files and runs the app.
3. **Prompt rebuild:** Describe DoFirst to the platform.
   The platform writes a new app with the same function.
   A rebuild is new code with the same behaviour.

The single-file method gives you the exact app.
Use the single-file method when the platform accepts it.

## Anthropic Claude: Artifacts

An artifact is created inside a chat.
There is no artifact editor where you paste code.

1. Sign in at claude.ai.
2. If artifacts do not appear, open **Settings**, then **Capabilities**, and turn on **Code execution and file creation**.
3. Start a new chat.
4. Attach the `standalone.html` file with the add-files button.
   You can also paste the file content into the message.
5. Send this prompt: "Create an artifact from this HTML file. Use the code exactly as it is. Do not rewrite it."
6. Claude opens the app in a panel beside the chat.
7. Test the board. Ask in the same chat for any changes.
8. Find the app again later under **Artifacts** in the left sidebar.

To share the app, open the artifact and select **Share**.
On Pro, Max, or Ultra, you can share with anyone who has the link.
The Free plan cannot share a new artifact by link.
To save tasks between sessions, you need Pro or above.
Ask Claude to save the tasks with the storage of the artifact.

## OpenAI ChatGPT: Sites

Check your plan first.
Sites needs ChatGPT Plus or Pro, or a Business or Enterprise workspace.
Sites is not included on the Free plan or the Go plan.

1. On chatgpt.com, select **Work**.
   In the desktop app, select **ChatGPT**, then **Work**, or select **Codex**.
2. In the chat, attach the `standalone.html` file.
3. Send a prompt that contains the word "website" or "@Sites".
   Example: "Use @Sites to build a website from the attached HTML file. Keep the design and the functions as they are. Save my tasks in the database of the Site."
4. Check the private preview. Ask for changes in the chat.
5. Select **Deploy**. ChatGPT creates the address of the Site, a `chatgpt.site` address.
   The new Site is private to you.
6. Open **Share** and choose who can open the Site.
   Select **Anyone on the internet** only if you want a public Site.
7. Save, then select **Visit** to open the live Site, or **Copy link** to share the address.

ChatGPT builds the Site in its own runtime from your file.
ChatGPT does not host the raw HTML file unchanged.
There is no GitHub import for Sites.
To use your own domain, open the settings of the Site, select **Add domain**, and add the DNS records that Sites gives you.

## Google Gemini: Canvas

Canvas is a panel inside a Gemini chat.
Gemini has no separate Canvas page.
You start Canvas from inside a chat.

On a computer:

1. Go to [gemini.google.com](https://gemini.google.com) and sign in.
2. Start a new chat.
3. Below the prompt box, select **Canvas**.
   In some versions, select **Tools** first, then select **Canvas**.
   In other versions, click the **+** icon, then select **Canvas**.
4. Click the **+** icon and select **Upload files**.
5. Select the `standalone.html` file on your computer.
6. Enter this prompt: "Open this HTML file as an app in Canvas. Use the code exactly as it is. Do not rewrite the code."
7. Send the prompt.
8. Gemini opens the app in the Canvas panel.
9. Select the preview in the Canvas panel to use the board.

In the Gemini mobile app:

1. Open the Gemini app.
2. Start a new chat.
3. Tap the **+** icon below the prompt box.
4. Select **Canvas**.
5. Tap the **+** icon again and attach the `standalone.html` file.
6. Enter the same prompt as Step 6 above.
7. Send the prompt.

Changes in Canvas are saved automatically.
The single-file edition saves tasks in the browser storage of the device.
To save tasks across devices, ask Gemini in the chat to add data storage to the app.

## xAI Grok: Build Mode

Build Mode is prompt-only.
You describe the app and Grok writes its own code.
Build Mode cannot import a GitHub repository or an HTML file.
The GitHub direction is one way only: you can export a finished project to GitHub.

1. Open grok.com in a browser, or open the Grok app.
2. Open the mode switcher and choose **Build**.
3. Describe the app in plain words.
   Example: "Build a task prioritization board with four columns: Do Now, Schedule, Delegate, Eliminate. Let me add tasks with a due date and ratings, score each task from 0 to 100, and drag tasks between columns."
4. Wait for Grok to build the app. A preview opens inside the chat.
5. Test the preview. Type changes in the chat until the app works as you want.
6. Select **Publish**.
7. Choose who can open the app: only you, anyone with the link, or everyone.
8. Copy your `grok.me` link and open it in any browser.
9. Optional: connect a domain you own instead of the `grok.me` address.

Build Mode is available on every Grok plan since August 2026.
Use on the Free plan is limited.

## Meta Muse: Spaces

1. Open Muse.
2. Ask Muse to build DoFirst as a Space.
3. Give Muse the README of this repository as the specification.
4. Open the Space from your Library.

A full-stack Space saves data on the platform.
The Space runs inside your Muse account.

## Perplexity: Computer

Publishing with Computer works on the web only.
Computer needs a Pro or Max account.

1. On a computer, go to perplexity.ai and sign in.
2. In the input box on the home page, set the mode toggle to **Computer**.
3. In the Computer panel, select the **Start a task** field.
4. Attach the `standalone.html` file. Download the file from this repository first.
5. Type: "Build a website from this HTML file exactly as it is, then show me a preview."
6. Check the preview. Ask Computer for changes in plain words.
7. Open the website preview and select **Publish**.
8. Select **Publish (Perplexity)** to get a `pplx.app` address. You can change the first part of the address.
9. Set who can see the site.
   On a personal account, a published site is public to everyone by default.
   Choose private or specific people if you do not want a public site.
10. Copy the `pplx.app` link and open it to use the board.

To change the site later, ask Computer to make the change.
Computer publishes the change to the same address.
Optional: select **Publish with Vercel** instead, connect your Vercel account, and use your own domain.

## Microsoft Copilot: Copilot Pages

Copilot Pages are for documents and notes.
Pages do not run a full database app.
Use a Page to share a board summary or notes.
Use the self-hosted edition or the single-file edition for the live board.

## Lovable

Lovable cannot connect an existing GitHub repository.
The way in with existing code is a ZIP upload.
Lovable then rebuilds the app in its own format.

1. On GitHub, open the `baner29/ai-apps` repository.
2. Select **Code**, then **Download ZIP**.
   You can also make a ZIP of the `dofirst` folder on your computer.
3. Go to lovable.dev and sign in.
4. On the dashboard, select the **+** button in the prompt box.
5. Select **Import project to Lovable**.
6. Select **Upload code**, upload the ZIP, and start the import.
7. Wait while Lovable rebuilds DoFirst and shows a preview.
8. Check the board in the preview. Type changes in the project chat.
9. Select **Publish** in the top right of the editor.
10. Edit the suggested `lovable.app` address if you want, then select **Publish** again.
11. Your board is live at that address.
    After later changes, select **Publish**, then **Publish changes**, to update the live site.

The first import build is free.
Later imports use credits.
The Free plan gives a small number of build credits each day.
Publishing to a `lovable.app` address is free on all plans.
A custom domain needs a paid plan.
If you connect GitHub from a Lovable project, Lovable creates a new repository for the project.

## Bolt.new

Bolt imports the whole repository as one project.
DoFirst is one folder inside the `ai-apps` repository.
After the import, you ask Bolt to build the app from that folder.

1. Go to bolt.new and sign in.
2. On the homepage, below the chatbox, select **GitHub**.
3. Sign in to GitHub, select **Authorize**, then install the Bolt.new GitHub App, and give Bolt access to the `baner29/ai-apps` repository.
   You need push permission on the repository.
4. In the import dialog, select `baner29/ai-apps` from the list, or select **Import from URL** and paste `https://github.com/baner29/ai-apps`.
5. Select **Choose this repository**. Bolt loads the repository as a new project, linked to the `main` branch.
6. In the project chat, type: "Build the DoFirst task board from the file dofirst/standalone.html in this project. Keep the four quadrants and the scoring rules."
7. Check the board in the preview.
8. Select **Publish** in the top right, then select **Publish** again in the publish menu.
9. Wait about a minute, then select the link in the chat. Your board is live at a `bolt.host` address.
   To change the address, open the publish menu and select the pencil icon, **Edit domain**.
10. After a later change, open the publish menu and select **Update**.

Bolt rebuilds the app in the project.
Bolt does not run the Node.js server of this repository.
On the Free plan, a published site is public for anyone with the link.
A private site and a custom domain need a paid plan.

## Replit

1. Go to replit.com and sign in.
2. Go to replit.com/import.
3. Select **GitHub**.
4. Connect your GitHub account if Replit asks.
5. Select the `baner29/ai-apps` repository.
6. Select **Import**. The Replit Agent checks the project and sets it up.
7. In the Project Editor, select **Run** and check that the DoFirst board opens.
8. If the wrong app starts, open **Workflows** and set the run command to `npm start` in the `dofirst` folder.
9. Select **Publish** in the top-right corner.
10. In the Publishing pane, check the suggested `.replit.app` name and set access to **Public**.
11. Select **Publish**.
12. Open the `.replit.app` address to use the board.

Replit offers a managed database in the Publishing pane.
DoFirst does not need it. DoFirst uses its own data file.
On the free Starter plan, you get one published app.
The link stops working after 30 days.

## v0 by Vercel

v0 has two routes.
Route A is a prompt rebuild: new code with the same function.
Route B imports the real DoFirst code from GitHub.

Route A: prompt rebuild

1. Go to v0.app and sign in.
2. Start a new chat.
3. Describe DoFirst in the prompt box: a task board with four quadrants (Do Now, Schedule, Delegate, Eliminate), drag and drop, and scoring from due date, impact, importance, and criticality.
4. Send the prompt and check the app in the preview.
5. Select **Publish** in the chat header.
6. Confirm the Vercel project name.
7. Choose who can open the app, and confirm the `vercel.app` domain.
8. Select **Publish**.
9. Open the `vercel.app` address to use the board.

Route B: import from GitHub

1. Go to v0.app and sign in.
2. Start a new chat.
3. Open the **+** menu in the prompt box.
4. Select **Import from…**, then **Import from GitHub**.
5. Paste `https://github.com/baner29/ai-apps`. Install the Vercel GitHub App if v0 asks.
6. Select **Import**.
7. Set the **Root Directory** to `dofirst`.
8. Confirm the Vercel team, the project name, and the base branch `main`.
9. Ask v0 in the chat to run the app and fix what does not work.
10. Select **Publish** in the chat header, confirm who can open the app and the domain, and select **Publish**.
11. Open the `vercel.app` address to use the board.

DoFirst is a plain Node.js server that saves tasks to a local file.
That is not how Vercel production runs.
Expect v0 to change the app before the imported version works in production.
The Free plan allows only a small number of messages per day.

## Base44

Base44 is prompt-only for your own app.
You cannot upload the HTML file of DoFirst and run it as it is.
Files that you attach are used as context for the build only.

1. Go to base44.com and sign up or sign in.
2. In the prompt box on the home page, describe DoFirst in plain words: a task board with four columns (Do Now, Schedule, Delegate, Eliminate), tasks with a due date and ratings for impact, importance, and criticality, and placement by score.
3. Send the prompt. If Base44 asks questions, answer them or select **Skip question**.
4. Wait while Base44 builds the app. The preview is on the right of the editor.
5. Test the board in the preview. Type changes into the AI chat on the left.
6. Select **Publish** in the top bar of the editor.
7. In the publish panel, check the address of the app. The address ends in `.base44.app` and you can change the first part.
8. Set **App visibility**, then select **Publish**.
9. Your app is live at that address. Use **Share your app** in the same panel to send the link.

Base44 supplies the backend and the hosting.
The Free plan allows up to 5 apps and a small number of build messages per month.
A custom domain needs a paid plan.

## Taskade: Genesis

Genesis is the app builder inside Taskade.
There is no separate Genesis page.
Genesis builds from a prompt only. You cannot upload the HTML file of DoFirst.

1. Open Taskade and sign in.
2. Select **Create**, or go to taskade.com/create.
3. In the prompt box, describe DoFirst in plain words: who uses it, what a task contains (title, due date, impact, importance, criticality), and the result you want, a board with four columns: Do Now, Schedule, Delegate, Eliminate.
4. Answer any questions from Taskade EVE, then wait while it builds.
5. Check the result in the preview.
6. To fix anything, type the change in the chat, one change at a time.
7. Select **Publish**.
8. Under **Who can open it**, select **Anyone with the link**.
9. Select **Publish**, then select **Copy link**.
10. Your app is live at that link. Visitors do not need a Taskade account.

The Free plan allows 3 Genesis apps in a workspace.
Building uses AI credits, and a new Free account can start with no credits.
A password and your own domain need the Pro plan.

## Add tasks with natural language

After you add DoFirst to a platform, you can work through the assistant of that platform.
Say the task in plain words.
The assistant adds the task to the board.
The scoring engine sets the score and the quadrant.
Open the app to see the board.
Move a task, edit a task, or complete a task, as you like.
The same account gives you the same board on each device.
You keep no server and no database for this setup.

## Platforms with no managed app hosting

**Meta AI** has no general app-hosting feature for consumers.
Use the single-file edition on a static web host.
You can also use the self-hosted edition.

**Hermes Agent (Nous Research)** is a self-hosted agent.
Hermes is not a hosting platform.
Give Hermes the address of this repository.
Hermes can clone the repository and run the self-hosted edition for you.

## Note

Platform features and plan limits change often.
This document describes the platforms as of November 2026.
Check the platform documentation for the current steps.
