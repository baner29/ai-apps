# Managed hosting platforms

This document explains how to run DoFirst on a managed AI hosting platform.
A managed platform runs the app on its own servers.
Your tasks stay on that platform, in your account on that platform.

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

1. Download `standalone.html` from this repository.
2. Start a new Artifact in Claude.
3. Paste the file content into the Artifact.
4. Publish the Artifact if you want a shareable link.

Artifacts are single-file apps.
Access works through the link.
Artifacts have no app-level user login.

## OpenAI ChatGPT: Sites

1. Open ChatGPT and start a new Site.
2. Give ChatGPT the `standalone.html` file, or give the address of this repository.
3. Tell ChatGPT to create the task prioritization app from the file.
4. Publish the Site.

Sites give you a hosted address.
Sites can include a database, user login, and a custom domain.

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

1. Open Grok and select Build Mode.
2. Describe DoFirst, or import the project from GitHub.
3. Check the preview in the conversation.
4. Publish the app.

Build Mode publishes to a `grok.me` address.
You can also connect your own domain.
Build Mode started as an early beta for the top subscription tier.

## Meta Muse: Spaces

1. Open Muse.
2. Ask Muse to build DoFirst as a Space.
3. Give Muse the README of this repository as the specification.
4. Open the Space from your Library.

A full-stack Space saves data on the platform.
The Space runs inside your Muse account.

## Perplexity: Computer

1. Open Perplexity Computer.
2. Ask Computer to build the DoFirst app from this repository.
3. Check the preview.
4. Select Publish.

Publish gives you a Perplexity-hosted `pplx.app` address.
You can also publish through a connected Vercel account.

## Microsoft Copilot: Copilot Pages

Copilot Pages are for documents and notes.
Pages do not run a full database app.
Use a Page to share a board summary or notes.
Use the self-hosted edition or the single-file edition for the live board.

## Lovable

1. Open Lovable.
2. Import this repository from GitHub, or describe DoFirst in a prompt.
3. Publish the app.

Lovable publishes to a `lovable.app` address.
Git sync works in both directions.

## Bolt.new

1. Open Bolt.new.
2. Import this repository from GitHub, or describe DoFirst in a prompt.
3. Publish the app.

Bolt publishes to a `bolt.host` address.
Bolt offers its own database option.

## Replit

1. Open Replit.
2. Import this repository.
3. Run the app and check the board.
4. Select Publish.

Replit publishes to a `replit.app` address.
Replit offers a managed database.

## v0 by Vercel

1. Open v0.
2. Describe DoFirst, or import the code.
3. Deploy the app to Vercel.

v0 generates a Next.js app.
This method is a prompt rebuild.
The result is new code with the same function.

## Base44

1. Open Base44.
2. Describe DoFirst in a prompt.
3. Let Base44 create the backend and the app.
4. Publish the app.

This method is a prompt rebuild.
Base44 supplies the backend and the hosting.

## Taskade: Genesis

1. Open Taskade Genesis.
2. Describe DoFirst in a prompt.
3. Generate the workspace.
4. Open the generated board.

Genesis turns the prompt into a workspace.
The workspace contains projects, agents, and automations.

## Platforms with no managed app hosting

**Meta AI** has no general app-hosting feature for consumers.
Use the single-file edition on a static web host.
You can also use the self-hosted edition.

**Hermes Agent (Nous Research)** is a self-hosted agent.
Hermes is not a hosting platform.
Give Hermes the address of this repository.
Hermes can clone the repository and run the self-hosted edition for you.

## Add tasks with natural language

After you add DoFirst to a platform, you can work through the assistant of that platform.
Say the task in plain words.
The assistant adds the task to the board.
The scoring engine sets the score and the quadrant.
Open the app to see the board.
Move a task, edit a task, or complete a task, as you like.
The same account gives you the same board on each device.
You keep no server and no database for this setup.

## Note

Platform features and plan limits change often.
This document describes the platforms as of November 2026.
Check the platform documentation for the current steps.
