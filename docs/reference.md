# Reference

## Permission modes

| Mode | Behaviour |
| --- | --- |
| Ask | Commands, writes and edits show an approval card (default) |
| Accept edits | Edits inside the project run; commands ask |
| Auto | Everything runs except what the guard flags: sudo, destructive git, pushes, writes outside the project, piping downloads into a shell, publishing, cloud or macOS settings changes, secrets |
| Plan | Read-only exploration ending in a plan card you approve |
| Bypass | Everything runs |

"Allow … for this session" and "Always allow … for this project" cover a program, a flagged reason, an MCP server or edits. Saved rules: Settings → Permissions. One thing asks in every mode, Bypass included: a schedule the agent wants to create or re-time, because it outlives the conversation.

## Keyboard

`⌘N` new session · `⌘B` sidebar · `⌘⇧E` mods rail · `⌘⇧B` browser · `⌘⇧D` diff · `⌘⇧T` terminal · `⌘T` terminal tab · `⌘K` focus composer · `⌘F` search · `⌘,` settings · `F2` rename · `Esc` stop · `Esc Esc` rewind to your last message · `⌘↑` `⌘↓` previous prompts · `⌘⇧C` copy last reply · `⇧Tab` cycle mode · `⌘/` shortcuts.

## Slash commands

| Command | |
| --- | --- |
| `/<skill> [text]` | Run a skill; `/skills` lists them |
| `/compact [focus]` | Compact the conversation now; the focus says what the brief must keep |
| `/mcp` | MCP servers and their tools |
| `/spawn <task>` | Start a sub-session on that task |
| `/merge [name or id]` | Bring a finished sub-session or fork into this session |
| `/sessions [name]` | This session's parent, sub-sessions and forks; with a name, every session that matches it |
| `/send <name or id>: <message>` | Send a message to another session |
| `/rename [new name]` | Rename this session; alone, it makes the title in the top bar editable |
| `/schedules` | The scheduled tasks and their next run |
| a mod's commands | Listed in the menu with the mod's name |

A message starting with `#` is added to the project's instructions file after a confirmation.

## Tools

| Tool | Purpose |
| --- | --- |
| `read_file` `write_file` `edit_file` `list_directory` `glob` `grep` | Files |
| `bash` | Shell command in the session's folder; stopping the run stops the command and what it started |
| `terminal_run` `terminal_read` `terminal_list` `terminal_stop` | Terminal pane tabs |
| `browser_*` | Built-in browser: navigate, click and type by visible text, read, wait, screenshot, eval |
| `show_image` | Put an image (a screenshot, a chart, a picture in the project) inline in the reply |
| `create_artifact` | HTML, SVG, Markdown or code shown in the browser pane |
| `update_tasks` | The task list card |
| `skill` | Load a skill |
| `submit_plan` | Plan mode: hand the plan to you |
| `schedule_create` `schedule_list` `schedule_update` `schedule_delete` | Scheduled tasks |
| `session_spawn` `session_send` `session_list` `session_read` `session_merge` | Sub-sessions and messages between sessions; `session_list` with a `query` finds sessions by name |
| `session_rename` | Rename this session when you ask (no approval; the title is locked like a manual rename) |
| `mod_check` | What is wrong with a mod the agent is writing |
| `mcp__<server>__<tool>` | MCP server tools |

Every tool is described to the model in every request. With a context window under 32k tokens the scheduling, session and mod tools are left out and the model is told so; Settings → Context → "Tools offered to the model" (`toolSet`: `auto`, `all`, `essential`) decides.

## Sessions

- Several sessions run at once (six at most). Switch freely: a running session keeps going off screen, and the sidebar shows a spinner while it runs, a dot when it waits for you, and a blue dot when it finished unseen.
- Each session has its own folder; the app's folder follows the session on screen. Project MCP servers and the project `settings.json` follow the folder on screen, not each background session's.
- The built-in browser belongs to the session on screen. A background session's browser call is refused with a message the model can act on.
- **Forks** copy a conversation and continue on their own. **Sub-sessions** are started by the agent (`session_spawn`) or by `/spawn`; they run in the background, sit under their parent in the sidebar, and report back when they finish a turn. **Merge** summarises what a sub-session or fork did since it split off and adds that to the parent; files need no merging, since sessions share the folder.
- Nesting stops at two levels; a session may have four sub-sessions running and twelve in all.
- **Names.** Rename a session in the sidebar (F2, double-click, the menu), in the top bar, with `/rename`, or by asking the agent ("call this session deploy fix"). From any other session you can then name it in plain words ("read the session called deploy fix"): every command and tool that takes a session accepts its name or id. Lookup searches every session not in the trash and tries, in order: the exact id; the start of an id (6 characters or more); the name ignoring case, quotes, punctuation and spacing (`tcg fork`, `"TCG (fork)"` and `tcg-fork` all find `tcg (fork)`); the start of a name; a name holding every word; a small misspelling. When several sessions fit, a related one (parent, sub-session, fork) wins; otherwise the answer lists them with id, folder and last activity, and with no match at all it lists the closest names. Two sessions may share a name; the rename then says that lookup by it is ambiguous.

## Scheduled tasks

A prompt that runs once at a time, every N minutes (five at least), or on a five-field cron rhythm in local time. Each run gets a session of its own, or is delivered into an existing session. Create them in the Scheduled tab or Settings → Scheduled, or ask the agent: every schedule it creates or re-times shows you an approval card first. Schedules run while the app is open; one that was missed by less than a day runs once at the next launch, never as a backlog. A run that needs approval waits for you like any other.

## Mods

Panels in the right-hand rail, tabs beside the Browser, a strip above the composer, backgrounds, themes and slash commands are mods: folders of web files that run sandboxed and reload when a file is saved. The built-in ones (Environment, Context, Tasks, Plan, Outputs, Sub-sessions, Skills, Side chat, Scheduled) are written against the same protocol as yours. Ask the agent to build one, or see [mods.md](mods.md). `node modkit/playground/serve.js` hosts mods outside the app while you work on them.

## History

- Every message, tool call, approval, plan and error is appended to `history/<session>.jsonl` in the data folder as it happens, and never rewritten: a rewind or a compaction adds a record. After a crash or a force-quit the session is restored from it, with a notice.
- Deleting a session moves it to a trash for 30 days (Settings → History: restore, delete now, change the period).
- Search in the sidebar looks through titles, messages, tool calls and what compactions folded away.
- A session's menu exports it as Markdown; `history.export` also writes JSON or the raw log.

## Context and compaction

Near the limit (`compactThreshold`, 80% by default) old tool output is shortened first, which often is enough. Otherwise the older part of the conversation is summarised into a brief and the recent part is kept word for word; the brief carries your latest request verbatim and lists the files touched. A summary that would not be smaller is not used, and the session is never left over the limit. `/compact [focus]` does the same on demand. The Context panel shows what fills the window, slice by slice.

## Remote control

Settings → Remote control turns on a small web page, served by the app, for following and steering sessions from another device: read along live, send messages, stop a run, answer approval cards and plans. It is off until you turn it on, listens on this Mac only or on your network as you choose, and its links carry a long random token that you can replace. The remote cannot change settings, the permission mode, mods, schedules or trust, cannot save a project rule, and never receives a key. It is plain HTTP: use it on a network you trust.

## Providers

- **Ollama** (default): native `/api/chat` with `num_ctx`, thinking control and capability detection.
- **Gateway fields** = any OpenAI-compatible endpoint. Tested: Portkey, and Anthropic directly at `https://api.anthropic.com/v1` with an Anthropic key (`claude-haiku-5-5`, `claude-sonnet-5-5`). Also usable: OpenRouter, LM Studio, vLLM, llama.cpp.

## Configuration

Settings is the place for all of it. On disk:

- Data folder `~/Library/Application Support/Open Harness/`: `config.json`, `sessions/`, `history/`, `trash/`, `artifacts/` (with each session's images), `schedules.json`, mod storage.
- Config folder `~/.open-harness/` (or `OPEN_HARNESS_CONFIG_DIR`): `settings.json`, `skills/`, `mods/`, `OPENHARNESS.md`.
- In a project: `.open-harness/settings.json`, `.open-harness/skills/`, `.open-harness/mods/`, `.mcp.json`, and an instructions file (`OPENHARNESS.md`, `AGENTS.md` or `CLAUDE.md`).

A project's `.mcp.json` servers, its mods and its `settings.json` all stay off until you turn them on.

### settings.json

`~/.open-harness/settings.json`, then `<project>/.open-harness/settings.json`, layer over `config.json`. Precedence: defaults < `config.json` < user < project.

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey",
  "portkey": { "baseURL": "https://gateway.example.com/v1", "model": "@vertex/gemini-2.5-pro", "contextWindow": 200000 }
}
```

- Settable: `provider`, `ollama.*`, `portkey.*`, `permissionMode`, `maxTurns`, `sendScreenshotsToModel`, `systemPromptExtra`, `theme`, `autoTitles`, `autoCompact`, `compactThreshold`, `pruneToolResults`, `toolSet`, `notifications`, `keepAwake`, `historyTrashDays`, and `env`. `workingDirectory` in the user file is the folder the app opens in. An unknown key or a value of the wrong type is skipped and reported in Settings → Configuration files; the rest of the file applies.
- `env` is applied to the process environment, so a key can live there instead of in `config.json` (`PORTKEY_API_KEY` is a fallback for the gateway key). `${VAR}` and `${VAR:-default}` are expanded in every string. Variables a file set are put back when the file stops applying.
- **A project's file needs your approval.** Until you trust it in Settings → Configuration files nothing in it applies, and an edit withdraws the approval. A notice in the chat tells you one is waiting.
- A field a file sets is read-only in Settings and is never written to `config.json`. Changes made while the app runs (the mode chip, the model chip) last until the files are read again.
- The files are read again when they change, when the folder changes, and when trust changes.

## Keep awake

Settings → General: Off, While running (the default: system sleep is held off while a session runs; the display may still sleep), or Always.

## Security

The agent runs with your permissions: keep approvals on for untrusted tasks. Pages it reads are untrusted input. MCP servers are child processes with your permissions. `@` mentions send the file to the model. The built-in browser is a normal Chromium profile. What a repository brings with it (MCP servers, a settings file, mods) is never applied without you turning it on. Mods run in sandboxed frames with the permissions you grant, cannot reach the network without the `network` permission, and can never answer an approval card or change the permission mode; a mod that contributes styles restyles the app itself, so treat it like a theme from someone you trust. Remote control exposes sessions to whoever holds the link.
