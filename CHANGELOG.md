# Changelog

## 0.2.0

The app is now called **Open Harness** (it was OpenAgent). On the first launch your sessions, settings and artifacts are moved from the old data folder to the new one (`~/Library/Application Support/Open Harness`). `OPENAGENT.md` files and `.openagent/skills` folders are still read.

### Mods

Everything beside the chat is now a mod: a folder of web files that the app shows in a seat and reloads when a file is saved.

- **A protocol, documented**: [docs/mods.md](docs/mods.md). A `mod.json`, pages that run in sandboxed frames, one small `harness` object to talk to the app, and permissions you grant when you turn a mod on.
- **Seats**: sections in a right-hand rail, tabs beside the Browser, a strip above the composer, a background behind the window. A mod can also contribute styles (themes, a restyled chat bar), slash commands and its own settings.
- **Built in**: Environment, Context, Tasks, Plan, Outputs, Sub-sessions, Skills in the rail; Side chat and Scheduled as tabs; dynamic backgrounds, a compact chat bar and a theme to turn on.
- **The agent writes them**: ask for a panel and the agent writes the folder, checks it with `mod_check`, and a card in the chat offers to turn it on. After that its edits show up live.
- **Safe by construction**: a mod cannot reach the network without the `network` permission, cannot read another mod's files, and can never answer an approval card or change the permission mode. Mods from a project, or written by the agent, stay off until you turn them on.
- **For authors**: a playground that hosts mods outside the app (`node modkit/playground/serve.js`), and Settings → Mods to install from a folder or a Git URL, start a new one, or customise a built-in one.

### Sessions

- **Several sessions run at once.** Switch freely; a session keeps running off screen. The sidebar shows which are running, which wait for you, and which finished unseen.
- **Sub-sessions.** The agent can start sub-sessions for parts of a job, read what they did, message them, and merge their results back; so can you, with `/spawn`, `/merge`, `/sessions` and `/send`. Forks can be merged back the same way.
- **A sidebar that shows the family.** Forks and sub-sessions are nested under the session they came from. Sessions are grouped by day, groups collapse, and search looks inside conversations, not just titles.
- **Each session has its own folder**, and the app's folder follows the session on screen.
- **Scheduled tasks.** A prompt that runs once, every N minutes or on a cron rhythm, in a new session or an existing one. The agent can create them; each one it creates is shown to you for approval first.
- **Remote control.** Follow and steer sessions from your phone: a token-protected page served by the app, off until you turn it on.

### Nothing is lost

- **History log.** Every message, tool call and approval is written to an append-only log as it happens. A crash or force-quit mid-run no longer loses the run; a rewind or a compaction no longer destroys what it removes.
- **Trash.** A deleted session can be restored for 30 days.
- **Export** a session as Markdown.

### The conversation

- **Images in replies.** The model can show an image inline (`show_image`): a screenshot it took, a chart it made, a picture in the project. Tool rows that produced an image carry a thumbnail. Remote images in a reply are never loaded.
- **The task list is a card in the chat**, under the latest message.
- **Better compaction.** Old tool output is cleared first; if that is not enough the older part is summarised and the recent part kept word for word, with your latest request carried verbatim. A summary that saves nothing is not used, and a session is never left over the limit. A "context too long" error from the provider now compacts and retries instead of ending the run.
- **Stop means stop.** Stopping a run now ends the shell command it was running, and whatever that command started.

### Settings

- **A settings page**: sections on the left, one control per row, changes apply as you make them, search across everything.
- **settings.json, made safe.** A project's `.open-harness/settings.json` used to apply as soon as you opened the folder, which let a cloned repository switch the agent to Bypass or point your key at another server. It now waits for your approval, and an edit withdraws it. Values are validated, files are re-read while the app runs, and fields a file sets are shown read-only.
- **Keep awake** while a session runs.
- **Tools sized to the model.** With a context window under 32k tokens the scheduling, session and mod tools are left out, so small local models keep their room to work. Settings → Context decides.

### For contributors

- `docs/architecture.md`: the app container, the session runtime, and the seams features plug into.
- `npm test`: the headless suites (a mock model, no network). `npm run test:live`: the real app, hidden, on a throwaway profile, driven against the API (`ANTHROPIC_API_KEY`) or a mock model; with `OPEN_HARNESS_LIVE_APP` set to a packaged binary the same scripts drive that.
- `node scripts/readme-shots.js` remakes the README screenshots from scripted scenes in the real app.

### Known limits

- Project MCP servers and a project's settings file follow the folder of the session on screen, not each background session's.
- Remote control is plain HTTP: use it on a network you trust. It has not been tried on phone browsers beyond a phone-sized window.
- A rewind deletes the stored copy of images shown after that point.
- Not notarized: on first launch, open it once, then allow it in System Settings → Privacy & Security → Open Anyway.

## 0.1.0

First public release.
