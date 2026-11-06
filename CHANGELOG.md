# Changelog

## Unreleased

Silo Harness (the new name of Open Harness) now works with whichever model service you use, and can be set up from a file or the command line, by you or by a coding agent such as Claude Code.

### Silo Harness

The app is now called **Silo Harness** (it was Open Harness). Nothing you have is lost, and nothing needs to be done by hand:

- **On the first launch** the config folder `~/.open-harness` is renamed `~/.silo-harness`, and a link is left at `~/.open-harness` pointing to it, so your scripts and an older copy of the app still find it. The data folder (sessions, history, settings, artifacts) moves from `~/Library/Application Support/Open Harness` to `~/Library/Application Support/Silo Harness`. Both are renamed in place, not copied. If either cannot be moved, the app says so in its log and goes on: the config folder keeps being used under its old name, and the data folder starts empty with the old one left untouched.
- **New names, old ones still read.** A project's folder is `.silo-harness/` (skills, mods, settings.json); `.open-harness/` is still read when a project has only that one. The instructions file is `SILOHARNESS.md`, in a project and in `~/.silo-harness`; `OPENHARNESS.md` (and `OPENAGENT.md`, `OPENCODER.md`) are still read when it is absent, and the `#` shortcut and dreams add to the file you already have.
- **Variables.** `SILO_HARNESS_CONFIG_DIR`, `SILO_HARNESS_USER_DATA` and `SILO_HARNESS_CLI_LINK_DIR`; the `OPEN_HARNESS_…` names still work when the new ones are not set. The terminal sets `SILO_HARNESS_TERMINAL` and, for this release, `OPEN_HARNESS_TERMINAL` too, and `TERM_PROGRAM` is `Silo Harness`.
- **The command is `silo`** (it was `open-harness`), at `Contents/Resources/bin/silo`. Settings → General → Command line tool → Install links it into `~/.local/bin` and takes away the old `open-harness` link the app made there.
- **Mods** keep working unchanged: the mod protocol, `mod.json`, the CSS tokens and the bridge are the same. `harness.info.app.name` now says "Silo Harness".
- **The old app can go.** Once Silo Harness has started once, drag Open Harness to the Trash.

### Any provider

- **Named providers.** `"providers"` in `~/.silo-harness/settings.json` (or config.json) holds any number of entries, each of a type that knows its base URL, its key variable and its headers, so an entry can be two lines: `openrouter`, `portkey`, `openai`, `anthropic` (its OpenAI-compatible endpoint), `groq`, `deepseek`, `together`, `ollama`, `lmstudio`, and `openai-compatible` for anything else. An entry can override the base URL, name the key's variable (`apiKeyEnv`) or hold the key (`apiKey`), choose the model, list models for the picker, add headers, and state the context window and the most tokens a reply may have. `"provider"` picks one by name. See [docs/configure.md](docs/configure.md).
- **Your 0.4.0 settings keep working as they are.** The Ollama and gateway blocks are the providers `ollama` and `portkey`; nothing is migrated.
- **Settings → Model** chooses among every provider, then its model: a picker from the entry's list and what the service lists, or a text field. A Test button sends one tiny request and says how long the answer took. A provider a file defines is marked "Set in settings.json", and a button opens the file.
- **The model button under the chat bar** lists the provider's models and the other providers that are ready to use, and names the provider by its label: the gateway fields are no longer called "Portkey" when they point somewhere else. The setup strip says when the provider in use needs a key or a model.
- **Plain errors.** A missing key names the variable to set; a refused key, an unknown model or an unreachable address says so, with the provider's name and what to check.

### The command line

- **`silo`**, inside the app at `Contents/Resources/bin/silo`, runs with the app's own Electron and does not need the app to be running: `provider list`, `provider add`, `provider remove`, `provider use`, `provider test`, `config path`, `config get`, `config set`, `config unset` and `doctor`, each with `--json` and `--help` and an exit code that says whether it worked. It writes your settings.json and keeps everything it does not know about; the running app picks the change up within a second.
- A key is never taken from a command-line argument: `--key-env` names its variable, `--key-stdin` reads it from standard input.
- **Settings → General → Command line tool** shows where the command is and links it into `~/.local/bin` (no administrator password), and says so when that folder is not on your PATH.
- **For coding agents**: [docs/configure.md](docs/configure.md) has the exact steps and what never to do, and [settings.schema.json](https://brandeispatrick.github.io/silo-harness/settings.schema.json) describes every field; settings.json accepts a `"$schema"` key.

### Keys

- Keys never reach the window, the logs, the transcript, what mods can read or the command's output: Settings shows "Set (OPENROUTER_API_KEY)" or "Not set".
- A project's settings.json may no longer carry a key: `apiKey`, `portkey.apiKey`, `portkey.providerApiKey` and `env` variables named like a key are ignored there, with a problem line.
- Nor may it choose which key is sent, or where: `apiKeyEnv` is ignored in a project's file (the type's usual variable is used), a provider entry for a service that takes a key cannot set its own address there (define it in your own settings.json and select it from the project with `"provider"`), a header cannot hold a `${VAR}`, and the gateway block's `portkey.baseURL` is ignored (its model, virtual key, provider slug and config id still apply).

## 0.5.0

The window is white and grey now, like Claude Code: neutral surfaces in light and dark, grey buttons, and colour only where it means something. The warm look of 0.4.0 is a bundled theme you can turn back on. Settings → Mods has a tab for each kind of mod, and the app has a new icon.

### White and grey

- **A new icon.** An S on a grey LED dot-matrix board, on a light tile. The mark in the sidebar and on the empty page draws the same S in the scheme's colours, and a theme can colour it through `--mark` and `--mark-ink`.
- **Neutral surfaces.** The transcript, the top bar, the rail, cards and the chat bar are white, the sidebar a light grey, the user's bubble and code a lighter one; in dark, a neutral near-black with the sidebar and controls a step lighter. No warm tint anywhere.
- **Grey buttons.** A button is white with a hairline; the one that confirms (Allow, Apply, Apply all, Save, Turn on, Compact now …) is a grey fill with the text colour. A dangerous action has red text and a red hairline rather than a red fill. The same goes for the mod kit's `h-btn`, the bundled mods' pages and the phone page.
- **Colour where it means something.** Blue for links, the focus ring, a switch that is on, the context ring and progress; green and red for diffs, success and failure; amber for the Auto mode, a context window filling up and a session waiting for you; the unread dot stays blue. The spinner, selected rows and tabs, the icon on a card and the mark beside the model name are neutral.
- **The phone page** has the same palette.

### Themes

- **Paper theme.** A bundled theme mod, off by default, that brings back 0.4.0's paper surfaces and terracotta accent on buttons, switches, spinners and marks. Turn it on in Settings → Mods.
- New tokens for themes and mod pages, so a theme can colour each role again: `--button-fill`, `--button-fill-hover` and `--button-text` (the button that confirms), `--switch-on`, `--spinner`, `--badge-bg` and `--badge-ink`, `--mark` and `--mark-ink`, `--segment-on`, `--attention`, and the sidebar's `--side-hover`, `--side-active` and `--tree-line`, now on `:root`. `--accent` is the blue. `docs/mods.md` lists them; Midnight sets them and keeps its blue buttons.

### Settings → Mods, by kind

- **A tab for each kind of mod.** Settings → Mods opens on a strip of tabs: Mods (panels, side-pane tabs, composer strips and slash commands), Backgrounds, Chat bar, Conversation and Themes. A mod is in each tab its manifest calls for, so Hyperspace is under Backgrounds, Chat bar and Conversation, and not among the general mods. The arrow keys move between the tabs, and Settings remembers the last one while the app runs.
- **Pick it where it lives.** Each special tab starts with its picker: the background (with your own picture and the Dim slider), the chat bar look or the conversation look in use, each with that mod's own settings right under it; on Themes, the theme mods with their switches in the order they apply, the later one winning where two overlap. Below the picker are the mods of that kind, with the same cards as before.
- **Use the whole set.** A mod that brings a conversation look, a chat bar look and a background has "Use the whole set" on its card, in each of its tabs, in place of the Set row.
- **New and Install on every tab.** The New form starts at the tab's kind, and can now write a starter theme too.
- **Appearance is shorter.** It keeps Light, Dark and System, and shows the current background, chat bar look, conversation look and themes, each with a row that opens its tab. Search still finds the rows inside the tabs, and choosing a hit (click it, or press Enter for the first one) opens its tab. The card in the chat for a new background or look links to its tab.

## 0.4.0

The app can now look back over your sessions, once a day or when you ask, and suggest what would make the agent work better for you: skills, mods and memory, each for you to apply or dismiss.

### Dreaming

A dream is a quiet session that reads what happened in your recent sessions and suggests how the agent could work better for you: a **skill** for a chore you asked for more than once, a **memory** line for a preference you stated or a correction you had to make, a **mod** for a view you keep asking for.

- **It proposes; you decide.** A dream can read and search your sessions and look at the project, nothing more: no shell, no edits, no browser. Each suggestion says why, quotes your own words and links the sessions it came from. The app applies a suggestion, never the model, and only into the skill folders, the mod folders and the instructions files, never through a link that leads out of the project; a suggestion that changes something that exists says so and shows the difference, and anything applied can be reverted. A new mod stays off until you turn it on.
- **Three modes.** Approve (the default): the dream finishes its review, then each suggestion waits for Apply or Dismiss. Auto: suggestions are applied as they are made and the dream lists what it did. Plan: the suggestions become one plan in the dream's session; approving it applies them all, and answering in the session changes the plan.
- **Once a day, or when you ask.** Off until you turn it on in Settings → Dreaming; then once a day at the time you pick (03:00 by default). A dream missed while the app was closed runs once at the next launch, unless one ran in the last 20 hours. To run one by hand, press the run icon in Settings → Dreaming, or type `/dream` in a session for that session's project.
- **What it reads.** One dream per project with new activity since its last dream, at most five per run, each given a digest of its sessions that the app puts together from the history log (what you asked, the final replies, the tool activity with failures and denied approvals, your `#` memory lines), sized to 40% of the model's context window; what does not fit waits for the next dream. A dream that finds nothing worth suggesting says so, and that is a good result.
- **Where it shows.** A Dreaming row in the sidebar under Customize, with a dot while suggestions wait. Settings → Dreaming lists every dream with its state and its suggestions (Apply, Dismiss, Apply all, Revert) and opens its session, where each suggestion is a card. The sidebar shows a dream's session only while it waits for you or is on screen. A notification when a nightly dream leaves suggestions for you.
- A dream sends parts of your past conversations to the model you configured and uses tokens: about as many as a long message per project.
- `settings.json` can set `dreaming.daily`, `dreaming.time`, `dreaming.mode`, `dreaming.skills`, `dreaming.mods` and `dreaming.memory`. A `#` memory line is now also recorded in the session's history log.

### Fixes

- The "Saved" tick in Settings no longer lands on a row's description: it shows above the control.

## 0.3.0

The window is rebuilt around reading: a measured type scale, one calm column, a chat bar that is a single bar, and tool activity that folds into a line. Mods can now restyle the conversation and the chat bar as looks, with a space-opera set to try, and any session can find another by its name.

### A calmer window to read in

Chatting with an agent means reading a lot of text, so the window now gives the words room and keeps everything else quiet.

- **One type scale, the system font everywhere.** Replies, your messages, tool and status lines and what you type are 15 px on 21 px lines; rows, menus, buttons and inputs 14 px; headings in the rail, notes and counts 13 px; date groups, captions and badges 12 px. Nothing is smaller than 12 px but keyboard keys and the terminal. Headings in a reply are the body size in semibold, not big headlines.
- **A reading column.** The transcript is one centred column, 736 px at most, with 16 px between blocks. Tool activity is a quiet muted line with its chevron after the words; cards (the task list, plans, artifacts) are a light hairline with no shadow; your message is a soft grey bubble on the right; inline code is a small chip without a border.
- **The chat bar is one bar.** A plus on the left, the text, and one action on the right: a return glyph that sends, or while a run is going a stop square (with text typed, Enter queues it for the agent's next step). Attached pictures sit inside the bar above the text, 120 px each. Under the bar a quiet row shows the model, the permission mode (in colour only for Plan and Bypass) and a context ring whose tooltip has the percentage. This was the bundled "Compact chat bar" mod; it is the app's own look now and the mod is gone (a profile that had it on just ignores the entry).
- **Tool activity folds into one line.** A turn that reads six files, edits two and runs the tests is no longer nine lines between two paragraphs: each run of calls is one quiet line that says what happened, "Read 6 files, edited 2 files, ran a command", with the lines added and removed (+49 −2) and anything that failed or was denied on its right. Click it to see every row as before. While the agent works the line shows the call in flight. An approval card waiting for you stays in the open; once you answer, its line folds in with the call, so a turn in Ask mode folds too. A single call stays a single row, and a session opened later folds the same way. Settings → General → Tool activity → Every call brings back one row per call.
- **More air, fewer boxes.** A 44 px top bar with the folder beside the title, sidebar rows on a 34 px pitch with clear space above each date group, rail sections separated by one hairline with regular-weight headings, rows on a 32 px pitch in the rail mods, and Settings rows with their title and description 24 px apart.
- **For mod authors**: the type scale is in the kit (`--fs-ui`, `--fs-small`, `--fs-micro`, `--fs-body`, `--fs-code` and their line heights; see [docs/mods.md](docs/mods.md)), `harness.css` pages use it (rows 14 px, `h-item` 32 px tall, `h-title` no longer uppercase), and `.h-md` reads like a reply.

### Sessions

- **Find a session by its name.** From any session, name another one in plain words ("read the session called deploy fix", "tell tcg fork to stop"): the agent and the commands find it among all your sessions, not only the related and recent ones. The name may be written loosely (case, quotes, punctuation, the start of it, a small typo). When several sessions fit, a related one wins; otherwise you get the list to pick from.
- **Rename from the conversation.** `/rename <new name>`, or `/rename` alone to edit the title in the top bar; or ask the agent to "call this session …" (`session_rename`, no approval needed). A name another session already has is allowed, and you are told that it makes lookup by that name ambiguous.
- `/sessions <name>` and `session_list` with a query list every session that matches, best first, with its folder and last activity.

### Looks

- **Looks for the conversation and the chat bar.** A mod can now restyle just the transcript or just the chat bar (`contributes.looks`, see [docs/mods.md](docs/mods.md#looks)). The app scopes a look to its region, so it cannot reach the rest of the window, and keeps a few attributes on the region (a run in progress, light or dark, the permission mode, the mod's own settings) so a look can come alive without any script.
- **Settings → Appearance → Looks**: pick a conversation look, a chat bar look and a background, or a whole set from one mod in a single choice.
- **Hyperspace**, a bundled space-opera set to turn on in Settings → Mods: a starfield behind the app that jumps to lightspeed while the agent works and brakes with a flash when it is done, a holographic conversation, and a cockpit chat bar. Five glow colours, and a calm setting for less motion.
- **Backgrounds can follow the pointer** (the `pointer` event), for parallax.
- A mod's stylesheet can no longer `@import` another one, and its relative `url()`s point at the mod's own files.
- Choosing a background from a mod in Settings → Appearance works again.

### Fixes

- A confirmation that followed another one at once (merge twice, delete twice) could close itself without asking: the first one's late "closed" signal cancelled it. Each confirmation now only answers to its own.

## 0.2.0

The app is now called **Open Harness** (it was OpenAgent). On the first launch your sessions, settings and artifacts are moved from the old data folder to the new one (`~/Library/Application Support/Open Harness`). `OPENAGENT.md` files and `.openagent/skills` folders are still read. The repository is now `BrandeisPatrick/open-harness`; old links redirect.

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
