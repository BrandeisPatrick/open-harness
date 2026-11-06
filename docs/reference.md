# Reference

## Permission modes

| Mode | Behaviour |
| --- | --- |
| Ask | Commands, writes and edits show an approval card (default) |
| Accept edits | Edits inside the project run; commands ask |
| Auto | Everything runs except what the guard flags: sudo, destructive git, pushes, writes outside the project, piping downloads into a shell, publishing, cloud or macOS settings changes, secrets |
| Plan | Read-only exploration ending in a plan card you approve |
| Bypass | Everything runs |

"Allow … for this session" and "Always allow … for this project" cover a program, a flagged reason, an MCP server or edits. Saved rules: Settings → Permissions.

## Keyboard

`⌘N` new session · `⌘B` sidebar · `⌘⇧B` browser · `⌘⇧D` diff · `⌘⇧T` terminal · `⌘T` terminal tab · `⌘K` focus composer · `⌘F` search sessions · `⌘,` settings · `F2` rename · `Esc` stop · `Esc Esc` rewind to your last message · `⌘↑` `⌘↓` previous prompts · `⌘⇧C` copy last reply · `⇧Tab` cycle mode · `⌘/` shortcuts.

Slash commands: `/name` runs a skill, `/skills`, `/compact [focus]`, `/mcp`. A message starting with `#` is added to the project's instructions file after a confirmation.

## Tools

| Tool | Purpose |
| --- | --- |
| `read_file` `write_file` `edit_file` `list_directory` `glob` `grep` | Files |
| `bash` | Shell command in the working directory |
| `terminal_run` `terminal_read` `terminal_list` `terminal_stop` | Terminal pane tabs |
| `browser_*` | Built-in browser: navigate, click and type by visible text, read, wait, screenshot, eval |
| `create_artifact` | HTML, SVG, Markdown or code shown in the browser pane |
| `update_tasks` | The task list card |
| `skill` | Load a skill |
| `submit_plan` | Plan mode: hand the plan to you |
| `mcp__<server>__<tool>` | MCP server tools |

## Providers

- **Ollama** (default): native `/api/chat` with `num_ctx`, thinking control and capability detection.
- **Portkey fields** = any OpenAI-compatible endpoint. Tested: Portkey, and Anthropic directly at `https://api.anthropic.com/v1` with an Anthropic key (`claude-haiku-5-5`, `claude-sonnet-5-5`). Also usable: OpenRouter, LM Studio, vLLM, llama.cpp.

## Configuration

`~/Library/Application Support/OpenAgent/config.json`: provider, model, Ollama context size (`numCtx`, 16k default), permission mode, MCP servers, rules, notifications, auto-compact. Sessions and artifacts live next to it. A project's `.mcp.json` is read; its servers stay off until enabled in Settings. Skills: `<project>/.openagent/skills`, `~/.openagent/skills`, bundled `skills/`.

### settings.json

`~/.openagent/settings.json`, then `<project>/.openagent/settings.json`, layer over `config.json` the way Claude Code's `settings.json` does. Precedence: defaults < `config.json` < user < project.

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey",
  "portkey": { "baseURL": "https://gateway.example.com/v1", "model": "@vertex/gemini-2.5-pro", "contextWindow": 200000 }
}
```

`env` is applied to the process environment before anything reads it, so a key can live there instead of in `config.json` — `PORTKEY_API_KEY` is already a fallback for the Portkey key. Settable: `provider`, `ollama`, `portkey`, `workingDirectory`, `permissionMode`, `maxTurns`, `sendScreenshotsToModel`, `systemPromptExtra`, `theme`, `autoTitles`, `autoCompact`, `notifications`. `${VAR}` and `${VAR:-default}` are expanded in every string, as in `.mcp.json`.

A field a settings file sets is owned by that file: the Settings panel shows the effective value, but saving restores `config.json` to what it held, so an override — or a secret — is never written there. The panel does not yet mark those fields read-only, so an edit to one appears to revert on save.

## Security

The agent runs with your permissions: keep approvals on for untrusted tasks. Pages it reads are untrusted input. MCP servers are child processes with your permissions. `@` mentions send the file to the model. The built-in browser is a normal Chromium profile.
