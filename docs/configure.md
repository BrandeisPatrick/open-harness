# Configure Open Harness from a file or the command line

Open Harness works with any service that speaks the OpenAI chat-completions API: OpenRouter, Portkey, OpenAI, Anthropic, Groq, DeepSeek, Together, Ollama, LM Studio, or a gateway of your own. You can set all of it in Settings, or in a plain file, `~/.open-harness/settings.json`, or with the `open-harness` command. The file and the command are made so that a coding agent (Claude Code, Codex, …) can do the setup for you: ask it to "set Open Harness up for OpenRouter" and point it at [For coding agents](#for-coding-agents).

The running app reads the file again within a second of a change; nothing needs a restart.

- [Shortest working examples](#shortest-working-examples)
- [The command line](#the-command-line)
- [Reference](#reference)
- [For coding agents](#for-coding-agents)

## Shortest working examples

Each block is a whole `~/.open-harness/settings.json`. `provider` chooses the provider in use; `providers` names as many as you like. The key comes from an environment variable (`apiKeyEnv`, or the type's usual one); the `env` block of the same file counts, which is the reliable place for it, because the app started from the Dock or Finder does not see what your shell profile exports.

### OpenRouter

```json
{
  "$schema": "https://brandeispatrick.github.io/open-harness/settings.schema.json",
  "env": { "OPENROUTER_API_KEY": "sk-or-…" },
  "provider": "openrouter",
  "providers": {
    "openrouter": { "type": "openrouter", "model": "anthropic/claude-sonnet-4.5" }
  }
}
```

### Portkey with a virtual key

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey-vk",
  "providers": {
    "portkey-vk": { "type": "portkey", "virtualKey": "openai-prod-1a2b3c", "model": "gpt-4o-mini" }
  }
}
```

### Portkey with a config id

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey-routing",
  "providers": {
    "portkey-routing": { "type": "portkey", "config": "pc-fallback-1a2b3c", "model": "gpt-4o-mini", "contextWindow": 128000 }
  }
}
```

The built-in `portkey` block (Settings → Model → the gateway fields) keeps working as before; a named entry is the way to have several Portkey setups side by side.

### Anthropic

```json
{
  "env": { "ANTHROPIC_API_KEY": "sk-ant-…" },
  "provider": "anthropic",
  "providers": {
    "anthropic": { "type": "anthropic", "model": "claude-sonnet-5-5", "contextWindow": 200000 }
  }
}
```

### OpenAI

```json
{
  "env": { "OPENAI_API_KEY": "sk-…" },
  "provider": "openai",
  "providers": {
    "openai": { "type": "openai", "model": "gpt-4.1-mini", "models": ["gpt-4.1-mini", "gpt-4.1"] }
  }
}
```

### Ollama

Ollama on this Mac needs nothing: it is the default. For another machine, or a second Ollama:

```json
{
  "provider": "ollama-box",
  "providers": {
    "ollama-box": { "type": "ollama", "baseURL": "http://192.168.1.20:11434/v1", "model": "qwen3:14b", "numCtx": 32768 }
  }
}
```

### LM Studio

```json
{
  "provider": "lmstudio",
  "providers": {
    "lmstudio": { "type": "lmstudio", "model": "qwen2.5-coder-14b-instruct", "contextWindow": 32768 }
  }
}
```

### Any OpenAI-compatible gateway

```json
{
  "env": { "GATEWAY_TOKEN": "…" },
  "provider": "work",
  "providers": {
    "work": {
      "type": "openai-compatible",
      "label": "Work gateway",
      "baseURL": "https://llm.example.com/v1",
      "apiKeyEnv": "GATEWAY_TOKEN",
      "model": "default",
      "headers": { "X-Team": "platform" },
      "contextWindow": 200000,
      "maxOutput": 8192
    }
  }
}
```

## The command line

`open-harness` is inside the app: `/Applications/Open Harness.app/Contents/Resources/bin/open-harness`. It runs with the app's own Electron, so nothing else has to be installed, and it does not need the app to be running. Settings → General → Command line tool → Install links it as `~/.local/bin/open-harness` (no administrator password). From a checkout: `node bin/open-harness.js` (after `npm run build`).

```bash
open-harness provider add openrouter --type openrouter --model anthropic/claude-sonnet-4.5
open-harness provider use openrouter
open-harness provider test
```

| Command | What it does |
| --- | --- |
| `provider list` | Every provider; `*` marks the one in use. |
| `provider add <name> --type <type> [--base-url URL] [--key-env VAR \| --key-stdin] [--model ID] [--models a,b] [--header K=V]… [--label TEXT] [--context-window N] [--max-output N] [--virtual-key VK] [--portkey-config ID] [--portkey-provider SLUG] [--num-ctx N] [--think auto\|on\|off] [--use] [--replace]` | Adds a named provider to your settings.json. `--use` also selects it. |
| `provider remove <name>` | Removes it (and the choice of it, if it was the one in use). |
| `provider use <name> [--model ID]` | Selects it, and sets its model. Works for `ollama` and `portkey` too. |
| `provider test [<name>]` | One tiny chat completion: `ok  OpenRouter · anthropic/claude-sonnet-4.5  (812 ms)`, or the service's error in plain words. |
| `config path` | Where settings.json and config.json are. |
| `config get [<key>]` | What the app uses: one field, or all of them. Keys show as `set` / `not set`. |
| `config set <key> <value>` | Sets a field in settings.json, checked by the app's own rules (`config set theme dark`, `config set maxTurns 60`, `config set dreaming.time 04:30`). |
| `config set <key> --stdin` | For a secret (`portkey.apiKey`, `env.SOME_API_KEY`): the value is read from standard input. |
| `config unset <key>` | Removes a field from settings.json. |
| `doctor` | What the app would use right now (files, provider, base URL, model, whether the key is set) and what is wrong. |

Every command takes `--json` (`{"ok": true, …}` or `{"ok": false, "error": "…"}`) and `--help`. The exit code is 0 on success, 1 when something is wrong, 2 for a mistake in the command itself, with a one-line reason.

A key is never taken from a command-line argument, which would stay in your shell history: `--key-env VAR` names the variable that holds it, and `--key-stdin` reads it from standard input (`pbpaste | open-harness provider add openrouter --type openrouter --key-stdin`, or type it at the prompt, where it is not shown) and stores it as `apiKey` in your settings.json.

The command writes only your settings.json, atomically, keeping every key it does not know about, in two-space JSON. `OPEN_HARNESS_CONFIG_DIR` moves the folder it uses, as it does for the app; `OPEN_HARNESS_USER_DATA` tells it where the app's data folder (with config.json) is, if not in the usual place.

## Reference

### Where settings live

| File | What it is |
| --- | --- |
| `~/.open-harness/settings.json` | Yours. Always applied. The command line writes here. |
| `<project>/.open-harness/settings.json` | A project's. Applied only once you trust it in Settings → Configuration files; an edit withdraws the approval. Wins over yours. |
| `~/Library/Application Support/Open Harness/config.json` | What the window's Settings write. |

Precedence: defaults < config.json < your settings.json < the project's. A field a file sets is read-only in Settings and is never written into config.json. A value of the wrong type, or an unknown key, is skipped and reported (in Settings → Configuration files, in `open-harness doctor`); the rest of the file still applies. `${VAR}` and `${VAR:-default}` are expanded in every string. The schema, for editors and agents: [settings.schema.json](https://brandeispatrick.github.io/open-harness/settings.schema.json) (put it in `"$schema"`).

### Providers

`"provider"` is the name of the provider in use: `ollama` (the `ollama` block), `portkey` (the `portkey` block, any gateway) or a key of `"providers"`. The names `ollama` and `portkey` cannot be used for a named entry.

| Type | Label | Base URL | Key variable | Source |
| --- | --- | --- | --- | --- |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | [quickstart](https://openrouter.ai/docs/quickstart) |
| `portkey` | Portkey | `https://api.portkey.ai/v1` | `PORTKEY_API_KEY` | [API reference](https://portkey.ai/docs/api-reference/inference-api/introduction) |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` | [API reference](https://developers.openai.com/api/reference/overview) |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1/` | `ANTHROPIC_API_KEY` | [OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk) |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | [OpenAI compatibility](https://console.groq.com/docs/openai) |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | [first API call](https://api-docs.deepseek.com/) |
| `together` | Together AI | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | [OpenAI compatibility](https://docs.together.ai/docs/openai-api-compatibility) |
| `ollama` | Ollama | `http://localhost:11434/v1` | none | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |
| `lmstudio` | LM Studio | `http://localhost:1234/v1` | none | [OpenAI endpoints](https://lmstudio.ai/docs/app/api/endpoints/openai) |
| `openai-compatible` | OpenAI-compatible | none: `baseURL` is required | none unless `apiKeyEnv` or `apiKey` | |

OpenRouter entries also send `HTTP-Referer` and `X-OpenRouter-Title` (OpenRouter's app attribution); an entry's own `headers` win.

Fields of an entry (only `type` is required):

| Field | Types | What it is |
| --- | --- | --- |
| `type` | all | One of the types above. |
| `label` | all | How the window names it. Default: the type's label (with the entry's name when two entries share a type). |
| `baseURL` | all | Overrides the type's endpoint; required for `openai-compatible`. |
| `apiKeyEnv` | all | The variable that holds the key. Default: the type's. Naming one makes the key required. |
| `apiKey` | all | The key itself. Allowed in your settings.json and config.json; ignored, with a problem line, in a project's file. |
| `model` | all | The model to run. |
| `models` | all | Models to offer in the model picker. The window also asks the service (`GET /models`) where it can. |
| `headers` | all | Extra request headers, `"Name": "value"`; `${VAR}` is expanded. |
| `contextWindow` | all | The model's window in tokens (default 128000): the context meter and auto-compaction go by it. For `ollama`, `numCtx` is the window instead. |
| `maxOutput` | all | The most tokens one reply may have, sent as `max_tokens`. Default: the service decides. |
| `virtualKey`, `config`, `provider` | `portkey` | `x-portkey-virtual-key`, `x-portkey-config`, `x-portkey-provider`. With `provider`, put the upstream key in `headers` as `"Authorization": "Bearer ${UPSTREAM_KEY}"`. |
| `numCtx`, `think` | `ollama` | `num_ctx` (also the context window) and the thinking mode, as in the `ollama` block. An `ollama` entry uses Ollama's native API, like the block. |

A bad field is skipped and reported; an entry without a usable `type`, or an `openai-compatible` one without `baseURL`, is skipped whole. A missing key is an error that names the variable to set, shown in Settings, under the chat bar and by `open-harness doctor`.

What the model can do (images, tools) is detected for Ollama; for the other services it is unknown, so the app does not refuse an image it cannot be sure about.

### Keys

- Keys never appear in the window (Settings shows "Set (OPENROUTER_API_KEY)" or "Not set"), in logs, in the transcript, in what mods can read, or in the command's output.
- A key in the `env` block is in the app's environment, so the commands the agent runs see it too. A key stored as `apiKey` (what `--key-stdin` does) is not.
- A project's settings.json may name a variable (`apiKeyEnv`) but may not hold a key (`apiKey`, `portkey.apiKey`, `portkey.providerApiKey`) or set a variable whose name ends in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` in its `env` block: a repository must not carry or override a secret.

### The other settings

`permissionMode`, `maxTurns`, `sendScreenshotsToModel`, `systemPromptExtra`, `theme`, `autoTitles`, `autoCompact`, `compactThreshold`, `pruneToolResults`, `toolSet`, `toolActivity`, `notifications`, `keepAwake`, `historyTrashDays`; the `ollama` block (`baseURL`, `model`, `numCtx`, `think`), the `portkey` block (`baseURL`, `apiKey`, `model`, `virtualKey`, `provider`, `providerApiKey`, `configId`, `contextWindow`), `dreaming` (`daily`, `time`, `mode`, `skills`, `mods`, `memory`); `env`; and in your own file `workingDirectory`, the folder the app opens in. The schema has the allowed values of each.

## For coding agents

You are setting up Open Harness for the person you work with. Do it with the `open-harness` command; edit `~/.open-harness/settings.json` by hand only if the command is not available, and then keep every key that is already in the file.

1. Find the command. In order: `open-harness` on the PATH; `/Applications/Open Harness.app/Contents/Resources/bin/open-harness`; in a checkout of the repository, `node bin/open-harness.js` after `npm run build`. Check it with `open-harness --help`.
2. See what is there: `open-harness doctor --json` and `open-harness provider list --json`.
3. Add the provider the person asked for, with the type from the table in [Providers](#providers) (use `openai-compatible` with `--base-url` for anything else) and the model they want:
   `open-harness provider add openrouter --type openrouter --model anthropic/claude-sonnet-4.5 --use --json`
4. The key. Ask the person; never invent one. If it is already in an environment variable the app can see, name it with `--key-env VAR`. Otherwise have them store it without showing it to you: they run `open-harness provider add … --key-stdin --replace` themselves and paste the key at the prompt, or put it in the `env` block of `~/.open-harness/settings.json`. Remember that the app opened from the Dock does not see variables exported in a shell profile.
5. Check it: `open-harness provider test --json`. `"ok": true` with the model and the time means the app can use it. Otherwise the `error` says what the service answered (a refused key, an unknown model, an unreachable address); fix that and test again.
6. Tell the person what you set: the provider name, the model, and that the app has picked it up already (it re-reads the file within a second).

Never:

- put a key in a project's `.open-harness/settings.json`, in a repository, in a commit, or in any file other than the person's own `~/.open-harness/settings.json`;
- pass a key as a command-line argument, or print, echo or log one (no `cat ~/.open-harness/settings.json` when it holds keys: use `open-harness config get` and `doctor`, which never show them);
- invent a base URL for a service: use the type, or the URL the person or the service's documentation gives;
- edit `config.json` while the app is running (the window owns it), or remove keys you did not add.
