# PI-Desktop Plugin Host API — targeted findings (Q1–Q5)

Sources read (via mirror `https://ghfast.top/https://raw.githubusercontent.com/vastsa/PI-Desktop/main/`):

- `docs/spec/07-plugins/03-plugin-api.md` (§3 `ui`, §3 `keyboard`, §5 Events, §6 Panel bridge API, §6.1 Floating widgets, §9)
- `docs/spec/07-plugins/02-plugin-manifest-schema.md` (§3 UI config, §4 contributes, §7 Validation rules)
- `docs/spec/07-plugins/05-plugin-lifecycle.md` (§2, §4, §6)

Guiding rule for this document: one panel per plugin is *implied* throughout the spec (single
`ui.panel` entry, id-less `closePanel`), but where the spec never states the behaviour outright it is
marked **NOT DOCUMENTED** below.

---

## Q1 — Does `pi.ui.openPanel()` called twice reuse/focus the window, or open a second one?

**NOT DOCUMENTED.** The spec never says what a second `openPanel()` call for the same plugin does.
There is no "reuse", "focus", "singleton", or "second window" wording anywhere in the three files.

Closest related text (all of it indirectly *implies* a single panel, but none of it states it):

- `03-plugin-api.md` §3 `ui` — the only open call is a single id-less method:
  `pi.ui.openPanel(options?: { title?: string }): Promise<void>`. With no id parameter there is no
  way for a caller to *address* two distinct panels, and no id is returned either (`Promise<void>`),
  so a second call cannot be distinguished from the first by the caller.
- `02-plugin-manifest-schema.md` §3 UI config — `PluginUiConfig.panel?: string` is **one** HTML entry,
  with one `width` / `height` / `resizable` / `title`.
- `05-plugin-lifecycle.md` §4 `disable` — the step is written in the singular: "Close panel".
- `03-plugin-api.md` §6 / §6.1 — "a detached `ui.panel` window" (singular) and "same preload, same
  `pluginBridge` channels".

**Exact signature (verbatim from source):**

```ts
pi.ui.openPanel(options?: { title?: string }): Promise<void>
```

Source: `docs/spec/07-plugins/03-plugin-api.md`, §3 "ui". Only documented parameter: `title?`
(string). No id, no shape, no width/height, no position, no `focus` flag, no return value.

Practical consequence: once opened, a panel cannot be addressed or identified by the plugin process —
see Q2 and Q3.

---

## Q2 — How does the plugin process (main.js) close a panel/widget, and can it query open state?

Closing — yes, exactly one method, no id:

```ts
pi.ui.closePanel(): Promise<void>
```

Source: `docs/spec/07-plugins/03-plugin-api.md`, §3 "ui". It takes **no arguments and no id** — it is
implicitly "the calling plugin's panel". §6.1 confirms this is the plugin-process route for widgets:
"A plugin may still close its own widget through `ui.closePanel()`."

There is no `pi.ui.closeWidget`, `closeView`, `hidePanel`, or any per-id variant documented.
`03-plugin-api.md` §9 lists `ui.*` as implemented.

Querying open state — **NOT DOCUMENTED.** There is **no** `listPanels`, `isPanelOpen`, `getPanel`,
`getPanelState`, or equivalent anywhere in the three files. The only listing API is for shortcuts, not
panels: `pi.keyboard.listGlobalShortcuts(): Promise<PluginGlobalShortcut[]>`.

Closest related text: `03-plugin-api.md` §5 delivers `workspace:changed`, and the §6 panel bridge is a
panel→host request surface — neither reports whether a panel window is currently open. A panel page
cannot report its own liveness either (no documented heartbeat/ready event).

Workaround implied by the spec (not a documented feature): the plugin tracks open state itself — it
knows when it called `openPanel()`, and §6 documents `ui.closePanel` as a panel-side bridge channel, so
a panel could `invoke("ui.closePanel")` and separately notify main via `onPanelInvoke`.

---

## Q3 — How does the plugin process push data/events to its own open panel page?

**NOT DOCUMENTED.** There is no documented plugin-authored push channel to a panel.

Specifically absent from all three files: `pi.ui.send`, `pi.ui.postMessage`, `pi.ui.emit`,
`pi.panel.*` (anything), an `onPanelEvent` handler, a panel-addressed event channel, and any
`pluginBridge.emit`/`send`/`post` on the panel side. `window.pluginBridge` exposes exactly two
members: `invoke(channel, payload?)` and `on(event, handler)`.

The direction the spec *does* document is panel → plugin (a request/response invoke):

```ts
// panel page
window.pluginBridge.invoke(channel, payload?)
// plugin process (main.js) — handler for channels the host does not implement
onPanelInvoke(channel, payload)
```

Source: `docs/spec/07-plugins/03-plugin-api.md`, §6 "Panel bridge API": "A channel the host does not
implement itself is forwarded to the plugin's `onPanelInvoke(channel, payload)`, so a plugin may define
its own panel ↔ main channels; a plugin that exports no `onPanelInvoke` gets `UNSUPPORTED` from its own
process."

Host-pushed events exist but are fixed and host-owned — the plugin process cannot author them:

- Plugin process ← host (`03-plugin-api.md` §5): `pi.events.on(event, handler)` /
  `pi.events.off(event, handler)`; delivered: `bus.message`, `workspace:changed`,
  `plugin:settingsChanged`, `appearance:changed`, `session:modelChanged`, `session:turnEnded`.
- Panel ← host (§6 "Panel events (host -> panel)"): `appearance:changed`, `workspace:changed`,
  `view:open` (docked views only), `session:turnEnded`.

`pi.bus` is **not** a route to your own panel: `pi.bus.subscribe(pattern, handler)` is a
plugin-process handler, panels have no documented bus subscription, and §3 "bus" states "A publisher
is excluded from its own fan-out."

Bottom line: the only documented in-band path is panel → plugin via `onPanelInvoke(channel, payload)`.
To toggle an already-open widget the panel must **pull** (`invoke("plugin.getSettings")`, or your own
channel handled by `onPanelInvoke`, re-read on a timer or user action) or derive state from
`workspace:changed` / `appearance:changed`. The spec also never states that `onPanelInvoke`'s return
value is delivered back to the `invoke(...)` promise — that reply path is likewise unstated.

---

## Q4 — Complete `window.pluginBridge` surface in a panel page

```ts
window.pluginBridge.invoke(channel, payload?)
window.pluginBridge.on(event, handler)
```

Source: `docs/spec/07-plugins/03-plugin-api.md`, §6 "Panel bridge API". That is the complete member
list — two methods. `invoke` is the request surface (channels table below); `on` subscribes to the
host-pushed events of §6 "Panel events". §6 also notes the "same preload, same `pluginBridge` channels"
for a detached `ui.panel`, a floating widget, and a docked `contributes.views` surface.

Fixed channels (verbatim from the §6 table, "Channel | Required permission"):

| Channel | Required permission |
|---|---|
| `ui.showToast`, `ui.closePanel` | None beyond the loaded panel |
| `ui.notify` | `notify` |
| `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | `notify` |
| `plugin.getSettings`, `workspace.get`, `app.getAppearance` | None |
| `app.setTheme`, `themes.upsert`, `themes.remove`, `themes.list` | `ui.theme` |
| `models.list` | `models.list` |
| `fs.readText`, `fs.stat`, `fs.readRange`, `fs.readPreview`, `fs.openDefault`, `fs.reveal`, `fs.glob`, `fs.list` | `fs.read` |
| `fs.writeText` | `fs.write` |
| `clipboard.readText`, `clipboard.getHistory` | `clipboard.read` |
| `clipboard.writeText` | `clipboard.write` |
| `shell.openExternal` | `shell.openExternal` |
| `net.fetch` | `net.fetch` |

Plus, from the same §6 paragraph, host-supported channels `skill.list`, `skill.read`, `skill.create`,
`skill.update`, `skill.remove`, `skill.setEnabled`. Explicitly **not** exposed: `plugin.setSettings`,
`fs.remove`, "arbitrary Electron IPC". Any other channel is forwarded to the plugin's own
`onPanelInvoke(channel, payload)`.

Mapping to what you asked for:

- **Close the panel:** `invoke("ui.closePanel")` — present in the table, no permission beyond the
  loaded panel. No id argument (see Q2).
- **Read settings:** `invoke("plugin.getSettings")` — read-only; writing is deliberately absent.
- **Workspace info:** `invoke("workspace.get")`.
- **Own plugin id:** **NOT DOCUMENTED.** The panel bridge table has no `plugin.getId` channel, and no
  other panel-side source of the plugin id is documented. (`pi.plugin.getId()` exists only in the
  plugin process, §3 "plugin".)
- **Receive pushed messages:** only the four fixed host events via `pluginBridge.on` (Q3); no
  documented channel lets the plugin process push custom data to the panel.
- Adjacent: `ui.showToast` needs no extra permission, and `app.getAppearance` gives theme/locale.

Schema-drift note: §6.1 references `ui.shape`, `ui.alwaysOnTop`, `ui.width`, `ui.height`,
`ui.resizable`, but `02-plugin-manifest-schema.md` §3 `PluginUiConfig` declares only
`panel` / `width` / `height` / `resizable` / `title` — `shape` and `alwaysOnTop` are not in the
manifest schema type.

---

## Q5 — Accelerator grammar and `keyboard.globalShortcut` registration

Signature (verbatim, `03-plugin-api.md` §3 "keyboard (requires `keyboard.globalShortcut`)"):
```ts
pi.keyboard.registerGlobalShortcut(input: {
  id: string
  accelerator: string
  command: string
}): Promise<PluginGlobalShortcut>

pi.keyboard.unregisterGlobalShortcut(id: string): Promise<void>
pi.keyboard.listGlobalShortcuts(): Promise<PluginGlobalShortcut[]>

type PluginGlobalShortcut = {
  id: string
  accelerator: string
  command: string
  registered: boolean
  error?: string
}
```

One argument object, three fields: `id` (plugin-local), `accelerator` (string), `command` (must
already be registered by the calling plugin — "anything else fails `INVALID_ARGUMENT`").

**Accepted accelerator string format — NOT DOCUMENTED as a formal grammar for
`accelerator`.** The spec never writes a grammar, a BNF, a modifier vocabulary, or an example
in the `keyboard` section. The only accelerator literals that appear anywhere in the three files are
the two the host itself spends (`03-plugin-api.md` §3 "keyboard"):

```text
Alt+Space      // by default opens the plugin launcher
Alt+Shift+W    // by default shows or hides the window
```

So the *only* documented shape is `Modifier+Modifier+Key` — `+`-joined, capitalised modifier names,
single trailing key. Nothing in these three files documents `CommandOrControl`, `CmdOrCtrl`, `Ctrl`,
`Super`, `Meta`, `F2`, or `Alt+Q`; do not assume them on this evidence.

**Allowed key names — NOT DOCUMENTED.** There is no list of accepted key names or modifier names in
`03-plugin-api.md`, `02-plugin-manifest-schema.md`, or `05-plugin-lifecycle.md`.

**Does it match `contributes.globalShortcuts[].default`?** Yes, per the manifest spec — the two are
the *same* grammar, described rather than enumerated:

- `02-plugin-manifest-schema.md` §7 rule 13 (on `shortcut` settings): "are validated as
  modifier-plus-key or F-key bindings".
- `02-plugin-manifest-schema.md` §7 rule 18 (on `contributes.globalShortcuts`): "`default`, when
  present, uses the same modifier-plus-key / F-key grammar as `shortcut` settings".

The manifest field itself (`02-plugin-manifest-schema.md` §4):

```ts
type PluginGlobalShortcutContrib = {
  id: string;       // ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$, unique within the plugin
  command: string;  // must be declared in contributes.commands
  default?: string; // accelerator the host registers after load; omitted means `pi.keyboard` registers it later
};
```

At most 8 entries (manifest §7 rule 18), matching the runtime cap "at most 8 entries per plugin".

**Error codes — all four exist, plus two thrown codes:**

```ts
// returned, not thrown: registerGlobalShortcut resolves `registered: false` + `error`
"SHORTCUT_CONFLICT" | "SHORTCUT_UNAVAILABLE" | "INVALID_ACCELERATOR" | "LIMIT_EXCEEDED"
// thrown: "UNSUPPORTED" and "INVALID_ARGUMENT" (e.g. `command` not registered by this plugin)
```

Source: `03-plugin-api.md` §3 "keyboard": "Refusals are returned, not thrown:
`registerGlobalShortcut` resolves with `registered: false` and an `error` of `SHORTCUT_CONFLICT`,
`SHORTCUT_UNAVAILABLE` (platform refusal), `INVALID_ACCELERATOR`, or `LIMIT_EXCEEDED` (at most 8
entries per plugin). `UNSUPPORTED` and `INVALID_ARGUMENT` are thrown." Also: a refused
re-registration "leaves the previous binding in place"; re-registering the same `id`
"replaces that entry's accelerator".

**Is `contributes.globalShortcuts[].default` registered automatically on load? YES:**

> "Every `contributes.globalShortcuts` entry that declares a `default` is registered by the host after
> the plugin's load, but only when its command actually registered; an entry without a `default` waits
> for a `registerGlobalShortcut` call."

Source: `03-plugin-api.md` §3 "keyboard". Related: everything is released on disable/unload/crash, and
register/unregister are audited. (Contrast with `settings` type `shortcut`, which is plugin-local and
"never registered as OS-global shortcuts" — §3 "plugin".)

