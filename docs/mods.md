# Mods

A mod is a folder of web files that adds something to OpenAgent: a panel in the right-hand rail, a tab beside the Browser, a strip above the composer, a background behind the app, a theme, a slash command. The panels the app ships with (Context, Outputs, Tasks, Skills, Side chat, …) are mods written against this same protocol, so anything they do, yours can do.

A mod page is an ordinary HTML page. It runs in a sandboxed frame, talks to the app through one small object (`harness`), and reloads the moment one of its files is saved. That last part is the point: the agent can write a mod for you in the middle of a session, you turn it on, and from then on every edit shows up live.

Protocol version: **1**.

## A mod in two files

```
~/.openagent/mods/word-count/
  mod.json
  panel.html
```

```json
{
  "protocol": 1,
  "id": "word-count",
  "name": "Word count",
  "version": "0.1.0",
  "description": "How much the assistant has written in this session.",
  "permissions": ["session:read"],
  "contributes": {
    "views": [{ "id": "main", "title": "Word count", "entry": "panel.html", "seat": "rail" }]
  }
}
```

```html
<!doctype html>
<link rel="stylesheet" href="/@harness/harness.css">
<div class="h-row"><span class="h-label">Assistant words</span><span class="h-value" id="n">0</span></div>
<script src="/@harness/harness.js"></script>
<script>
  let words = 0;
  const show = () => (document.getElementById('n').textContent = words.toLocaleString());
  const count = (text) => (text.match(/\S+/g) || []).length;
  harness.ready.then(async () => {
    const { items } = await harness.session.transcript();
    words = items.filter((i) => i.role === 'assistant').reduce((n, i) => n + count(i.text), 0);
    show();
  });
  harness.on('message.assistant', (m) => { words += count(m.text); show(); });
  harness.on('session.switched', () => location.reload());
</script>
```

Save the two files, turn the mod on in Settings → Mods (or on the card that appears in the chat), and the panel is in the rail. Edit `panel.html` and it reloads.

## Where mods live

| Scope | Folder | Starts |
| --- | --- | --- |
| bundled | `mods/` inside the app | on (you can turn one off) |
| user | `~/.openagent/mods/<id>/` | off until you turn it on once |
| project | `<project>/.openagent/mods/<id>/` | off until you turn it on for that project |

A user mod with the id of a bundled one replaces it, which is how you customise a built-in panel: Settings → Mods → Customise copies it into your folder, and you edit the copy.

The app watches these folders. A new folder with a valid `mod.json` shows up in Settings → Mods right away, and as a card in the chat when a session is open. Nothing a mod contributes is loaded until it is on.

Turning a mod on grants the permissions its manifest lists at that moment. Later edits to its pages reload it without asking again. An edit that adds a permission, or adds a `styles` or `background` contribution it did not have, pauses the mod until you approve the change.

`Settings → Mods → Safe mode` turns every user and project mod off at once.

## mod.json

| Field | | |
| --- | --- | --- |
| `protocol` | required | `1` |
| `id` | required | lower-case letters, digits and `-`, 2 to 40 characters, starting with a letter; the same as the folder name |
| `name` | required | shown in Settings and on panel headers |
| `version` | required | `major.minor.patch` |
| `description` | | one line |
| `author`, `homepage`, `license` | | shown in Settings |
| `icon` | | the name of a built-in icon (`gauge`, `list`, `message`, `clock`, `folder`, `sparkles`, `plug`, `image`, `terminal`, `globe`, `settings`, …) or the path of an SVG file in the mod |
| `permissions` | | what the pages may ask the app for (see Permissions); default none |
| `contributes.views` | | pages and where they sit (see Seats) |
| `contributes.styles` | | CSS files applied to the app itself (themes, a restyled composer) |
| `contributes.commands` | | slash commands |
| `contributes.settings` | | options shown under the mod in Settings |

Unknown fields are ignored, so a mod written for a later protocol still loads with what this version understands.

### Seats

A view is one HTML page in one seat.

```json
{ "id": "main", "title": "Context", "entry": "panel.html", "seat": "rail", "order": 20, "maxHeight": 420 }
```

| Seat | Where | Notes |
| --- | --- | --- |
| `rail` | a section in the right-hand rail, between the chat and the side pane | sized to its content up to `maxHeight` (default 360); `order` sorts sections, lower first (bundled ones use 10 to 90); the user can collapse a section |
| `tab` | a tab in the side pane, next to Browser, Diff and Terminal | fills the pane; it is not sized to its content, so make the page `height: 100%` and scroll inside it (the `--h-inset-*` padding is for rail sections) |
| `composer` | a strip directly above the composer | one row, sized to its content up to 120 px |
| `background` | behind the whole window | takes no clicks; only one background is active, chosen in Settings → Mods; the app's surfaces turn translucent over it |

View fields: `id` (unique in the mod), `title`, `entry` (a file in the mod), `seat`, and optionally `order`, `maxHeight`, `icon`.

Reserved for later protocol versions: `transcript` (cards after a turn), `status` (status-line items), `sidebar`.

### Styles

```json
"styles": ["theme.css"]
```

The CSS is added to the app's own page while the mod is on, so it can change colours, type, spacing and the look of the composer or sidebar. Prefer overriding the design tokens (`--bg-100`, `--text-100`, `--accent`, `--r-composer`, … on `:root`) to restyling individual elements: tokens keep working when the app changes. Because a stylesheet can restyle anything, including approval cards, a mod that contributes styles says so when you turn it on.

### Commands

```json
"commands": [{ "name": "words", "description": "Show the word count", "view": "main" }]
```

`/words some text` opens the named view (if given) and delivers a `command` event `{ name, args }` to the mod's views.

### Settings

```json
"settings": [
  { "key": "unit", "type": "select", "title": "Count", "options": ["words", "characters"], "default": "words" },
  { "key": "live", "type": "boolean", "title": "Update while streaming", "default": true }
]
```

Types: `boolean`, `string`, `number` (`min`, `max`, `step`), `select` (`options`). The values are in `harness.settings.get()` and a `settings.changed` event follows every change.

## The page

- Loaded from the mod's own origin (`mod://…/`), so relative URLs to its other files work. Several files, images and fonts are fine; so is one self-contained page.
- Sandboxed: scripts run, but the page has no cookies, `localStorage` or IndexedDB (use `harness.storage`), cannot open windows or dialogs, cannot navigate away, and cannot reach the app's page or another mod.
- Offline unless the mod has the `network` permission: without it every request that is not to the mod's own files is blocked, so a mod that can read your session has no way to send it anywhere.
- Inline `<script>` and `<style>` are allowed.

Every mod origin serves the kit under `/@harness/`:

| File | |
| --- | --- |
| `/@harness/harness.js` | the `harness` object (a classic script: `<script src="/@harness/harness.js"></script>`) |
| `/@harness/harness.css` | the app's design tokens for light and dark, a transparent page, and small classes so a panel looks native |

The stylesheet follows the app's theme by itself, including a theme mod's colours. Its classes: `h-row` (a label/value line), `h-label`, `h-value`, `h-muted`, `h-title` (a small heading), `h-list` and `h-item` (clickable rows), `h-btn` (`.primary`, `.ghost`, `.sm`), `h-input`, `h-switch`, `h-chip`, `h-bar` with `h-bar-seg` children (a segmented meter), `h-bar-mark` (a tick on the meter), `h-dot` (a colour swatch), `h-chev` (a disclosure chevron), `h-icon` (`.sm`), `h-segmented` (buttons with `aria-pressed`), `h-empty` (an empty state), `h-spin` (a spinner), `h-mono`, and `h-md` (Markdown: put the html of `harness.ui.markdown()` inside an element with this class and it looks like a reply in the chat, with headings, lists, tables, quotes, inline code and code blocks in the app's highlight colours; `.compact` sizes it for a rail section. Inside `h-md`, `harness.js` makes a code block's Copy button copy the block and flip to "Copied", and opens links in the browser with `harness.ui.openExternal`). `h-chip` takes `.accent`, `.success`, `.danger`; `h-btn` also `.icon`. Tokens: `--bg-000 … --bg-400`, `--text-100`, `--text-200`, `--text-400`, `--border`, `--border-subtle`, `--accent`, `--danger`, `--success`, `--warn`, `--code-bg`, `--code-hover`, `--bubble` (the user's message bubble), `--tok-kw`, `--tok-str`, `--tok-com`, `--tok-num`, `--tok-pun` (syntax colours), `--font`, `--mono`, `--r-control`, `--r-card`, and `--h-inset-x`, `--h-inset-top`, `--h-inset-bottom` for the page's own padding.

Rail and composer views are sized to their content automatically. Keep them compact: 13 px text, 8 px gaps, no page padding beyond what `harness.css` gives.

## harness

`harness.ready` resolves once the app has answered the page's hello; until then calls wait (the hello itself never times out; every other call gives up after 30 seconds, except `model.complete`). Every call returns a promise. A failed call rejects with an `Error` whose `code` is `'permission'` (with `.permission` naming it), `'unavailable'`, `'timeout'`, `'unknown-method'`, `'bad-params'` or `'error'`.

`harness.info` is the hello's answer: `{ protocol, mod: { id, name, version, scope }, view: { id, seat, title }, app: { name, version }, granted: [...], theme, settings, visible }`

`harness.on(event, handler)` subscribes and returns a function that unsubscribes. The app only sends events a view has subscribed to. Subscribing to an event the mod has no permission for does nothing (a console warning says so); an unknown event name is accepted and never arrives.

`harness.call(method, params)` sends any bridge method by name, for the rare case the object has no helper for it.

### Always available

| Call | |
| --- | --- |
| `harness.ui.theme()` | `{ scheme: 'light' \| 'dark', tokens }`; event `theme.changed` |
| `harness.ui.resize(height?)` | report the content height (done for you; call it after an animation) |
| `harness.ui.setTitle(text)`, `harness.ui.setBadge(value \| null)` | the view's header title and its badge |
| `harness.ui.toast(text, { kind })` | a short message at the bottom of the window (`info` or `error`) |
| `harness.ui.open(viewId?)` | bring a view of this mod to the front |
| `harness.ui.copy(text)` | copy to the clipboard |
| `harness.ui.openExternal(url)` | open an http(s) link in the default browser |
| `harness.ui.markdown(text)` | `{ html }` rendered the way the chat renders Markdown |
| `harness.storage.get(key, fallback)`, `.set(key, value)`, `.remove(key)`, `.keys()` | this mod's own JSON storage, kept across sessions; `get` resolves with the value (or `fallback` when nothing is stored), `keys` with an array; `harness.storage.session` is the same per session. A value may be up to 256 KB, a mod's storage 5 MB |
| `harness.settings.get()` | the values of the mod's settings; event `settings.changed` |

Events: `theme.changed`, `settings.changed`, `visibility.changed` `{ visible }`, `command` `{ name, args }`, and `session.switched` `{ id }` when another session comes on screen (it carries nothing but the id, so a view without `session:read` can still reset itself). When it arrives, `harness.storage.session` and every `harness.session.*` call already refer to the new session.

### session:read

| Call | Result |
| --- | --- |
| `harness.session.get()` | `{ id, title, cwd, origin, parentId, forkedFrom, messageCount, createdAt, updatedAt, running, attention }` |
| `harness.session.transcript({ limit })` | `{ items }`: `{ role: 'user' \| 'assistant' \| 'tool' \| 'plan' \| 'artifact' \| 'image' \| 'compaction', text, name?, ok? }`, oldest first |
| `harness.session.tasks()` | `{ tasks: [{ id, title, status }] }` |
| `harness.session.plan()` | `{ plan: { id, title, markdown, status } \| null }` |
| `harness.session.outputs()` | `{ outputs: [{ kind: 'artifact' \| 'image' \| 'file', id, title, detail, updatedAt }] }` |
| `harness.session.context()` | `{ tokens, limit, threshold, autoCompact, basis, slices: [{ key, label, tokens, items? }], messages, compactable, compactions, updatedAt }` |
| `harness.session.related()` | `{ parent, children, forks }` (sub-sessions and forks of the session on screen) |
| `harness.outputs.open({ kind, id })` | show an output: an artifact in the Browser, an image in the viewer, a file in the Diff |

Events: `session.changed` (another session came on screen, or this one's title or state changed; reload only when its `id` differs), `related.changed` (a sub-session, fork or the parent changed state), `run.started` `{ sessionId }`, `run.ended` `{ sessionId, reason, text }` (`reason` is `done`, `aborted`, `max_turns`, `error` or `plan`), `message.user` `{ text, origin }`, `message.assistant` `{ text }`, `message.delta` `{ text }` (streaming), `tool.started` `{ id, name, args }`, `tool.ended` `{ id, name, ok, durationMs }`, `tasks.changed` `{ tasks }`, `plan.changed` `{ plan }`, `outputs.changed`, `context.changed` `{ tokens, limit }`.

"The session" is always the one on screen; the events follow it when the user switches.

### session:send

`harness.session.send(text)` sends a message as the user (queued if a run is in progress). `harness.composer.insert(text)` puts text in the composer instead.

### session:control

`harness.session.stop()`, `harness.session.compact(focus?)`, `harness.sessions.open(id)`, `harness.sessions.create()`, `harness.sessions.spawn({ title, prompt })`, `harness.sessions.merge(id)`.

### sessions:read

`harness.sessions.list()` and `harness.sessions.search(query, { limit })` reach every conversation, not just the one on screen.

### model

`harness.model.complete({ messages, system, maxTokens, context }, onDelta)` → `{ text, usage }`. One reply from the configured model, with no tools. `messages` is `[{ role: 'user' | 'assistant', content }]`; `context: 'session'` puts the open session's conversation in front of them (read-only: nothing is added to the session); `onDelta(text)` receives the reply as it streams. `harness.model.cancel()` stops the call in progress, which then resolves with what had arrived and `stopped: true`. When no key or model is set up the call rejects with `unavailable`; when the provider cannot be reached or refuses, with `error` and the provider's message; after two minutes, with `timeout`. A mod may have two calls in flight. This spends tokens, which the permission says when the mod is turned on.

### skills:read

`harness.skills.list()` → `[{ name, description, path, source }]`. `harness.skills.usage({ scope: 'session' | 'all' })` → `{ items: [{ name, count, lastUsedAt }] }`. Event `skills.used` `{ name }`.

### config:read and config:write

`harness.config.get()` → `{ provider, model, workingDirectory, home, permissionMode, theme, autoCompact, compactThreshold, keepAwake, notifications, background, contextLimit }` (`workingDirectory` is the folder of the session on screen, `home` the user's home folder for showing paths as `~/…`). Keys and other secrets are never included. Event `config.changed`, which is also sent when `workingDirectory` changes because a session in another folder came on screen.

`harness.config.set(patch)` changes `theme`, `autoCompact`, `compactThreshold`, `keepAwake`, `notifications` or `background`, and nothing else (any other key is refused as bad params): a mod cannot change the permission mode, the provider, or what is trusted.

### schedules

`harness.schedules.list()`, `.create(input)`, `.update(id, patch)`, `.remove(id)`, `.runNow(id)`; event `schedules.changed`. A schedule with `target: 'session'` and no `sessionId` runs in the session on screen when it is created.

### remote

`harness.remote.status()` → `{ enabled, running, urls, clients }`, `harness.remote.start()`, `harness.remote.stop()`; event `remote.changed`.

### network

No call: with this permission the page may load and fetch `https:` resources.

## Permissions

| Permission | Lets the mod |
| --- | --- |
| `session:read` | read the session on screen: its messages, tool calls, tasks, plan, outputs and context use |
| `session:send` | send messages as you and fill the composer |
| `session:control` | stop a run, compact, open or start sessions, start and merge sub-sessions |
| `sessions:read` | list and search all your conversations |
| `model` | call the model (uses tokens) |
| `skills:read` | list skills and how often they are used |
| `config:read` | read non-secret settings |
| `config:write` | change the theme, auto-compact, keep-awake, notifications and background |
| `schedules` | list, create, change and delete scheduled tasks |
| `remote` | see and switch remote control |
| `network` | reach the internet |

Not available to any mod, whatever it asks for: answering approval cards, changing the permission mode, reading API keys, trusting MCP servers, settings files or other mods, and reading or writing files outside its own folder.

## Under the object: the wire protocol

`harness.js` is a convenience. A page can speak the protocol itself: JSON-RPC 2.0 messages over `window.parent.postMessage`.

```
page → app   { "jsonrpc": "2.0", "id": 1, "method": "hello", "params": { "protocol": 1 } }
app → page   { "jsonrpc": "2.0", "id": 1, "result": { "protocol": 1, "mod": {…}, "view": {…}, "app": {…}, "granted": […], "theme": {…}, "settings": {…}, "visible": true } }

page → app   { "jsonrpc": "2.0", "id": 2, "method": "session.tasks" }
app → page   { "jsonrpc": "2.0", "id": 2, "result": { "tasks": [] } }

page → app   { "jsonrpc": "2.0", "id": 3, "method": "events.subscribe", "params": { "events": ["tasks.changed"] } }
app → page   { "jsonrpc": "2.0", "method": "event", "params": { "name": "tasks.changed", "data": { "tasks": [] } } }
```

Method names are the call names above (`ui.setBadge`, `storage.get`, `session.transcript`, `model.complete`, …) with their arguments as a `params` object. Every result is an object or nothing; `harness.js` hands most of them back as they are and unwraps three: `storage.get` (`{ value }`), `storage.keys` (`{ keys }`) and `skills.list` (`{ skills }`). `events.subscribe` for an event the mod has no permission for is refused with `4003`. Errors use `{ "code", "message", "data" }` with these codes: `-32601` unknown method, `-32602` bad params, `4003` permission needed (`data.permission`), `4004` not available right now, `4008` timed out, `4000` anything else. The app identifies the caller by the frame the message came from, never by what the message says.

## Building one with the agent

Ask for it: "make a mod that shows the git branch and how many files changed". The agent loads the `create-mod` skill, writes the folder, and checks it with the `mod_check` tool, which reports manifest problems and any errors the page threw. A card in the chat offers to turn the new mod on; after that the agent's edits reload it as they land, and `mod_check` gives it the page's errors to fix.

By hand: Settings → Mods → New mod writes a starter folder and opens it. `mod_check` is also what the Settings page shows under a mod's Problems.

## Installing and sharing

A mod is its folder. Copy it into `~/.openagent/mods/`, or use Settings → Mods → Install and give it a folder or a Git URL (the repository is cloned into the mods folder). To share one, publish the folder; adding the `openagent-mod` topic on GitHub makes it findable.

## What keeps this safe

- A mod's pages run in sandboxed frames on their own origin, with no access to the app's page, to Node, to your files or to other mods.
- Every request to the app is checked against the permissions you granted that mod. The frame, not the message, says which mod is asking.
- Without `network` a mod cannot make a request or navigate anywhere, so reading your session and sending it somewhere takes two permissions you can see.
- Mods never get the powers listed under Permissions as unavailable. In particular a mod, and therefore an agent that writes mods, cannot approve its own tool calls.
- Mods that came from a project folder, or that the agent wrote, stay off until you turn them on. Growing a mod's permissions pauses it until you agree.
- Styles are the exception to the sandbox: a stylesheet applies to the app's own page. Treat a mod with styles like a browser theme from someone you trust.
