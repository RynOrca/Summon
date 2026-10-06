/**
 * Summon Widget — plugin process (Phase 2 + 3).
 *
 * A transparent always-on-top orb, summonable/dismissible from anywhere with a
 * system-wide hotkey.
 *
 * Two host facts drive the design, both confirmed on PI-Desktop 0.16.1 by the
 * Phase 1 probe (see docs/api-findings.md):
 *
 *   1. `pi.ui.closePanel()` EXISTS on the plugin-process side -> we can open and
 *      close our own widget directly. No polling needed to *close* it.
 *   2. There is NO "is my panel open?" query -> we cannot ask. And the panel can
 *      also be opened by the host (e.g. the plugin row's own button), which our
 *      command never sees. So a plain boolean would go stale.
 *
 * Fix for (2): the widget page beacons `summon.heartbeat` every couple of
 * seconds while it is alive, and reports `summon.closed` when it goes away.
 * Liveness is therefore derived from the beacon, not from what we last did —
 * which keeps the hotkey correct no matter how the widget was opened, and
 * self-heals if the page is torn down without a clean unload.
 */

const SHORTCUT_ID = "toggle";
const SHORTCUT_COMMAND = "summon.toggle";

const DEFAULT_ACCELERATOR = "Alt+Shift+S";

/**
 * Tried in order when the preferred accelerator is refused. These follow the
 * same "Modifier+Modifier+Key" shape the host itself uses for its own
 * Alt+Shift+W, because that is the only accelerator shape the spec actually
 * demonstrates (the full grammar is undocumented — api-findings Q5).
 */
const FALLBACK_ACCELERATORS = [
  "Alt+Shift+S",
  "Alt+Shift+P",
  "CommandOrControl+Shift+Space",
  "F2",
];

/** The widget beacons every 2s; treat it as gone after this long without one. */
const HEARTBEAT_TTL_MS = 6000;

/**
 * The accelerator setting is a `shortcut` field, so the host binds it in-app as
 * well as us registering it globally. One keypress can arrive twice while
 * PI-Desktop is focused; this swallows the duplicate.
 */
const TOGGLE_DEBOUNCE_MS = 350;

const COMMAND_IDS = ["summon.toggle", "summon.open", "summon.close", "summon.shortcutStatus"];

// ------------------------------------------------------------------ state
let lastHeartbeatAt = 0;
let lastToggleAt = 0;
let settings = { accelerator: DEFAULT_ACCELERATOR, dismissOnClick: true };
let shortcutState = { requested: null, active: null, registered: false, error: null };
let settingsListener = null;

function host() {
  return typeof pi !== "undefined" && pi !== null ? pi : null;
}

function panelLikelyVisible() {
  return lastHeartbeatAt > 0 && Date.now() - lastHeartbeatAt < HEARTBEAT_TTL_MS;
}

// ---------------------------------------------------------------- helpers
async function toast(message) {
  const api = host();
  try {
    if (api && api.ui) {
      if (typeof api.ui.notify === "function") { await api.ui.notify({ message: message }); return; }
      if (typeof api.ui.showToast === "function") { await api.ui.showToast({ message: message }); return; }
    }
  } catch (err) {
    // Notifications are best-effort; fall through to the log.
  }
  console.log("[summon] " + message);
}

function safeKeys(obj) {
  try {
    if (obj === null || obj === undefined) return null;
    return Object.keys(obj).sort();
  } catch (err) {
    return ["<error: " + err.message + ">"];
  }
}

function hasFn(obj, name) {
  try {
    return typeof obj === "object" && obj !== null && typeof obj[name] === "function";
  } catch (err) {
    return false;
  }
}

// --------------------------------------------------------------- commands
async function openWidget() {
  const api = host();
  if (!api || !api.ui || typeof api.ui.openPanel !== "function") {
    return { ok: false, error: "OPEN_PANEL_NOT_AVAILABLE" };
  }
  await api.ui.openPanel({ title: "Summon" });
  return { ok: true, action: "open" };
}

async function closeWidget() {
  const api = host();
  if (!api || !api.ui || typeof api.ui.closePanel !== "function") {
    return { ok: false, error: "CLOSE_PANEL_NOT_AVAILABLE" };
  }
  await api.ui.closePanel();
  lastHeartbeatAt = 0;
  return { ok: true, action: "close" };
}

/**
 * Derived from live liveness rather than from what we last did, so a widget
 * opened by the host (plugin row, command palette) still toggles correctly.
 *
 * Debounced because the accelerator setting is a `shortcut` field, which the
 * host ALSO binds in-app against `summon.toggle`. While PI-Desktop is focused a
 * single keypress can therefore arrive twice — once through the renderer's
 * in-app binding and once through the OS-global shortcut — and without this the
 * two would cancel out and the widget would appear not to respond.
 */
async function toggleWidget() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    return { ok: true, action: "debounced" };
  }
  lastToggleAt = now;

  if (panelLikelyVisible()) return await closeWidget();
  return await openWidget();
}

// --------------------------------------------------------------- shortcut
async function applyShortcut(preferred) {
  const api = host();
  if (!api || !api.keyboard || typeof api.keyboard.registerGlobalShortcut !== "function") {
    shortcutState = {
      requested: preferred,
      active: null,
      registered: false,
      error: "KEYBOARD_API_NOT_AVAILABLE",
    };
    return shortcutState;
  }

  const wanted = String(preferred || "").trim() || DEFAULT_ACCELERATOR;
  const candidates = [wanted].concat(FALLBACK_ACCELERATORS.filter(function (a) { return a !== wanted; }));

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const result = await api.keyboard.registerGlobalShortcut({
        id: SHORTCUT_ID,
        accelerator: candidate,
        command: SHORTCUT_COMMAND,
      });

      // Refusals are RETURNED, not thrown (api-findings Q5).
      if (result && result.registered) {
        shortcutState = {
          requested: wanted,
          active: result.accelerator || candidate,
          registered: true,
          error: null,
        };
        if (candidate !== wanted) {
          await toast("「" + wanted + "」被占用或无效，已改用 " + candidate);
        }
        return shortcutState;
      }
      lastError = (result && result.error) || "UNKNOWN";
    } catch (err) {
      // UNSUPPORTED / INVALID_ARGUMENT are thrown.
      lastError = "THROWN:" + (err && err.message ? err.message : String(err));
    }
  }

  shortcutState = { requested: wanted, active: null, registered: false, error: lastError };
  await toast(
    "快捷键注册失败（" + lastError + "）。可在插件设置里换一个键，或用命令面板执行 Summon: Toggle Widget。"
  );
  return shortcutState;
}

async function shortcutStatus() {
  const api = host();
  let listed = null;
  try {
    if (api && api.keyboard && typeof api.keyboard.listGlobalShortcuts === "function") {
      listed = await api.keyboard.listGlobalShortcuts();
    }
  } catch (err) {
    listed = ["<error: " + err.message + ">"];
  }

  const summary = shortcutState.registered
    ? "快捷键生效中：" + shortcutState.active
    : "快捷键未生效" + (shortcutState.error ? "（" + shortcutState.error + "）" : "");
  await toast(summary);

  return { state: shortcutState, hostList: listed };
}

// --------------------------------------------------------------- settings
async function loadSettings() {
  const api = host();
  try {
    const raw = await api.plugin.getSettings();
    settings = {
      accelerator:
        raw && typeof raw.accelerator === "string" && raw.accelerator.trim()
          ? raw.accelerator.trim()
          : DEFAULT_ACCELERATOR,
      // Defaults to true, so only an explicit false turns it off.
      dismissOnClick: !(raw && raw.dismissOnClick === false),
    };
  } catch (err) {
    // Keep the defaults rather than failing the load.
  }
  return settings;
}

async function onSettingsChanged() {
  const previous = settings.accelerator;
  await loadSettings();
  if (settings.accelerator !== previous) {
    await applyShortcut(settings.accelerator);
  }
}

// ------------------------------------------------------------------ probe
function probe() {
  const api = host();
  const ui = api ? api.ui : null;
  const keyboard = api ? api.keyboard : null;

  let versions = null;
  try {
    if (typeof process !== "undefined" && process.versions) {
      versions = {
        electron: process.versions.electron || null,
        node: process.versions.node || null,
        chrome: process.versions.chrome || null,
      };
    }
  } catch (err) {
    versions = { error: err.message };
  }

  return {
    pluginId: hasFn(api && api.plugin, "getId") ? safeCall(function () { return api.plugin.getId(); }) : null,
    panelLikelyVisible: panelLikelyVisible(),
    msSinceHeartbeat: lastHeartbeatAt ? Date.now() - lastHeartbeatAt : null,
    shortcut: shortcutState,
    settings: settings,
    hasOpenPanel: hasFn(ui, "openPanel"),
    hasClosePanel: hasFn(ui, "closePanel"),
    hasRegisterGlobalShortcut: hasFn(keyboard, "registerGlobalShortcut"),
    hasListGlobalShortcuts: hasFn(keyboard, "listGlobalShortcuts"),
    uiKeys: safeKeys(ui),
    keyboardKeys: safeKeys(keyboard),
    pluginKeys: safeKeys(api && api.plugin),
    versions: versions,
  };
}

function safeCall(fn) {
  try {
    return fn();
  } catch (err) {
    return "<error: " + err.message + ">";
  }
}

// -------------------------------------------------------------- lifecycle
async function onLoad() {
  const api = host();
  if (!api || !api.commands || typeof api.commands.register !== "function") {
    console.log("[summon] host API unavailable on load");
    return;
  }

  await loadSettings();

  await api.commands.register({
    id: "summon.toggle",
    title: "Summon: Toggle Widget",
    keywords: ["summon", "widget", "toggle", "呼出", "切换"],
    run: async () => { await toggleWidget(); },
  });

  await api.commands.register({
    id: "summon.open",
    title: "Summon: Open Widget",
    keywords: ["summon", "open", "打开"],
    run: async () => { await openWidget(); },
  });

  await api.commands.register({
    id: "summon.close",
    title: "Summon: Close Widget",
    keywords: ["summon", "close", "关闭"],
    run: async () => { await closeWidget(); },
  });

  await api.commands.register({
    id: "summon.shortcutStatus",
    title: "Summon: Shortcut Status",
    keywords: ["summon", "shortcut", "快捷键", "状态"],
    run: async () => { await shortcutStatus(); },
  });

  // Re-assert the accelerator from settings. The manifest's declared `default`
  // is registered by the host too, but re-registering the same id simply
  // replaces that entry's accelerator, so this is idempotent and lets a user
  // setting survive restarts.
  await applyShortcut(settings.accelerator);

  try {
    if (api.events && typeof api.events.on === "function") {
      settingsListener = onSettingsChanged;
      api.events.on("plugin:settingsChanged", settingsListener);
    }
  } catch (err) {
    console.log("[summon] could not subscribe to settings changes: " + err.message);
  }

  console.log("[summon] ready: " + JSON.stringify(probe()));
}

async function onUnload() {
  const api = host();
  if (!api) return;

  try {
    if (settingsListener && api.events && typeof api.events.off === "function") {
      api.events.off("plugin:settingsChanged", settingsListener);
    }
  } catch (err) {
    // best-effort
  }
  settingsListener = null;

  try {
    if (api.keyboard && typeof api.keyboard.unregisterGlobalShortcut === "function") {
      await api.keyboard.unregisterGlobalShortcut(SHORTCUT_ID);
    }
  } catch (err) {
    // The host also releases shortcuts on unload/disable/crash.
  }

  for (let i = 0; i < COMMAND_IDS.length; i++) {
    try {
      await api.commands.unregister(COMMAND_IDS[i]);
    } catch (err) {
      // onUnload is best-effort (5s budget).
    }
  }

  lastHeartbeatAt = 0;
}

// ---------------------------------------------------------- panel bridge
/**
 * The only documented panel -> plugin direction. Everything the widget needs
 * from us travels over these channels.
 */
async function onPanelInvoke(channel, payload) {
  if (channel === "summon.heartbeat") {
    lastHeartbeatAt = Date.now();
    return { ok: true };
  }
  if (channel === "summon.closed") {
    lastHeartbeatAt = 0;
    return { ok: true };
  }
  if (channel === "summon.probe") {
    return probe();
  }
  if (channel === "summon.settings") {
    return { settings: settings, shortcut: shortcutState };
  }
  if (channel === "summon.dismiss") {
    return await closeWidget();
  }
  return { ok: false, error: "UNKNOWN_CHANNEL", channel: channel, payload: payload };
}

module.exports = { onLoad, onUnload, onPanelInvoke };
