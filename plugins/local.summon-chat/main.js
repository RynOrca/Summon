/**
 * Summon Chat — plugin process (Phase 2: shell, role model, hotkey).
 *
 * A floating chat window with a mode/role selector. The transport for the two
 * modes lands in later phases; this file owns everything that does not depend
 * on it:
 *
 *   - the global hotkey (host key-recorder setting -> real OS registration)
 *   - the preset-role store: load, normalise, persist, protect the built-ins
 *   - widget liveness derived from a heartbeat, not from what we last did
 *   - the panel bridge channels both surfaces (window + roles view) talk to
 *
 * Phase 3 (quick chat + web search) and Phase 4 (real Agent session via
 * desktop.control) plug in at the two `notImplemented` stubs below.
 */

const SHORTCUT_ID = "toggle";
const SHORTCUT_COMMAND = "summon.chat.toggle";

const DEFAULT_ACCELERATOR = "Alt+Shift+C";

/**
 * Same "Modifier+Modifier+Key" shape the host itself uses for Alt+Shift+W,
 * which is the only accelerator shape the spec demonstrates. Deliberately kept
 * clear of the orb plugin's chain so installing both does not fight.
 */
const FALLBACK_ACCELERATORS = ["Alt+Shift+C", "Alt+Shift+Q", "Alt+Shift+J", "F3"];

/**
 * Only ONE registration is ever live under the id below.
 *
 * The manifest used to declare `contributes.globalShortcuts[].default` as well,
 * and the host registers that declared accelerator by itself
 * (`plugin-runtime.ts: registerDeclaredShortcuts`, after the child's onLoad).
 * The plugin process also registers imperatively. For the shipped default the
 * two collided on the same accelerator and the registry refused the second one,
 * so it looked harmless — but the moment the user recorded a different key, the
 * imperative registration moved to the new key while the host's duplicate
 * stayed on `Alt+Shift+C`: two working system-wide toggles, one of them
 * invisible in the UI. The manifest no longer declares a default
 * (the field is optional, `02-plugin-manifest-schema`), which leaves this
 * process as the single owner of the binding.
 */

/**
 * Swallow a keypress the host delivers twice. Narrow on purpose: a deliberate
 * double-press is ~150ms apart at best, and 350ms of de-duplication is still
 * shorter than a human's second tap after watching the window react.
 */
const TOGGLE_DEBOUNCE_MS = 350;

// -------------------------------------------------------- host appearance
/**
 * The UI follows PI-Desktop's own appearance by default（「跟随主软件」）。
 *
 * The host publishes it two ways, both verified in the 0.16.1 source:
 *   - `pi.app.getAppearance()` — resolved `{ theme, base, locale, pluginTheme }`
 *     (`plugin-sdk/src/index.ts: PluginAppearance`; host half is
 *     `app-lifecycle.ts: resolveAppearance`);
 *   - the panel event `appearance:changed`, broadcast to every open panel and
 *     every loaded plugin process (`app-lifecycle.ts: broadcastAppearance`).
 *
 * The page subscribes to the event; the plugin process pulls and caches the same
 * value so a page that opens later starts from the host's *current* palette
 * instead of waiting for the next change.
 */
const HOST_APPEARANCE_MODE = "host";
const APPEARANCE_MODES = [HOST_APPEARANCE_MODE, "system", "dark", "light"];

/** Answer used until the host has been asked: neutral, and never a crash. */
const DEFAULT_HOST_APPEARANCE = {
  theme: "system",
  base: "system",
  locale: "",
  fontScale: 1,
};

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Normalise whatever the host returns into the shape the page consumes. */
function normalizeHostAppearance(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const base = value.base === "light" || value.base === "dark" ? value.base : "system";
  return {
    theme: typeof value.theme === "string" && value.theme ? value.theme : "system",
    // `base` is the *resolved* palette; "system" only means the host could not
    // resolve it, and the page then follows the OS exactly like the app does.
    base: base,
    locale: typeof value.locale === "string" ? value.locale : "",
    // `getAppearance` does not publish the Appearance font scale yet. Read it
    // when it appears, so the day the host adds it the page scales for free.
    fontScale: clampNumber(value.fontScale, 0.8, 1.6, 1),
  };
}

/** Read the host's current appearance. Best effort: a failure keeps the cache. */
async function readHostAppearance() {
  const api = host();
  if (!hasFn(api && api.app, "getAppearance")) return hostAppearance;
  try {
    hostAppearance = normalizeHostAppearance(await api.app.getAppearance());
  } catch (err) {
    // The panel can be summoned before the host resolves its palette; the page
    // then keeps its own default until the next read.
  }
  return hostAppearance;
}

const COMMAND_IDS = [
  "summon.chat.toggle",
  "summon.chat.open",
  "summon.chat.close",
  "summon.chat.status",
];

// ------------------------------------------------------- quick-chat limits
/** The host allows 8 `agent.complete` calls per plugin per rolling 60s. */
const COMPLETE_BUDGET_PER_MINUTE = 8;
/** Harness default; the user can raise it, but the host budget is the real cap. */
const DEFAULT_MAX_TOOL_ROUNDS = 3;

/**
 * 与 manifest.json 的 version 保持一致（smoke 测试会断言两者相等，防止漂移）。
 * 暴露给界面显示：判断「到底加载的是哪个版本」时，这是最直接的证据。
 */
const PLUGIN_VERSION = "0.19.0";
/** Keep the wire prompt well inside the host's 200k combined-character cap. */
const MAX_HISTORY_MESSAGES = 20;
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 15000;

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
/** 免配置兜底：DuckDuckGo 在不少网络里连不上（见 builtInSearch 的说明）。 */
const BING_ENDPOINT = "https://www.bing.com/search?q=";

/** DDG serves a challenge page to unknown agents, so send a browser-ish one. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * `agent.complete` runs with `tools: []`, so there is no function calling. The
 * tool loop is done by convention instead: the model asks for a tool by emitting
 * one JSON line, we run it, and feed the result back as a user turn.
 *
 * Two tools:
 *   · `current_time` — **always available** in quick chat. It is a local
 *     computation (no network, no API, no cost), and a model that does not know
 *     today's date will happily answer "深圳今天天气" from its training data or
 *     search with a stale year. The user has to ask for it to be useful, though,
 *     which is why the directive has to name it.
 *   · `web_search` — only when the role has the "联网搜索" switch on; offering it
 *     to a role that cannot search just makes the model emit JSON forever.
 */
const TOOL_DIRECTIVE = function (allowSearch) {
  const lines = [
    "",
    "## 可用工具",
    "current_time —— 读取当前日期时间。回答任何与「今天 / 现在 / 最新 / 今年 /",
    "这周」相关的问题之前，**先调用它**：你不知道今天是哪一天，训练数据里的年份是过期的。",
  ];
  if (allowSearch) {
    lines.push(
      "web_search —— 联网搜索。需要最新信息、事实核查或你不确定的内容时使用它。",
      "搜索关键词里如果涉及年份，用 current_time 拿到的真实年份。",
    );
  }
  lines.push(
    "",
    "要使用工具时，**只输出一行 JSON，不要有其他任何文字**：",
  );
  if (allowSearch) {
    lines.push(
      '{"tool":"current_time"}',
      '{"tool":"web_search","query":"搜索关键词"}',
    );
  } else {
    lines.push('{"tool":"current_time"}');
  }
  lines.push("", "拿到工具结果后，用中文直接给出最终回答，不要再输出 JSON。");
  return lines.join("\n");
};

/** 模型可以申请的**全部**工具（界面只展示、执行在工具循环里）。 */
const TOOL_IDS = ["current_time", "web_search"];
/**
 * 一轮里「读时钟 + 搜索 + 再读时钟…」的总次数上限，防止弱模型对着工具反复打转。
 * 与用户可调的 `maxToolRounds`（只管搜索）分开：时钟是白给的，不该占搜索的额度。
 */
const MAX_TOOL_CALLS = 6;

// ------------------------------------------------------------ role model
/** `agent.complete` caps `system` at 32 KiB; clamp rather than fail. */
const MAX_SYSTEM_CHARS = 32000;
const MAX_ROLES = 50;
const ROLE_MODES = ["agent", "quick"];
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The two roles that always exist and cannot be deleted. Their prompt/tools may
 * be edited; their id and mode may not.
 */
const BUILTIN_ROLES = [
  { id: "agent", name: "Agent", builtin: true, mode: "agent", system: "", tools: [], skills: [] },
  {
    id: "quick",
    name: "快捷对话",
    builtin: true,
    mode: "quick",
    system:
      "你是一个简洁、直接的中文助手。需要最新信息时使用 web_search 工具，不要凭记忆猜事实。",
    tools: ["web_search"],
    skills: [],
  },
];

function builtinRole(id) {
  for (const role of BUILTIN_ROLES) if (role.id === id) return role;
  return null;
}

function clampString(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() && out.indexOf(item.trim()) === -1) {
      out.push(item.trim());
    }
  }
  return out;
}

/**
 * Coerce whatever is in settings into a usable role list.
 *
 * Never throws: a hand-edited `roles` JSON blob can be anything, and a bad blob
 * must not take the plugin down. Built-ins are always present, ids are made
 * unique, and unknown fields are dropped.
 */
function normalizeRoles(raw) {
  const source = raw && typeof raw === "object" && Array.isArray(raw.roles) ? raw.roles : [];
  const roles = [];
  const seen = Object.create(null);
  const problems = [];

  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!ROLE_ID_PATTERN.test(id)) {
      problems.push("角色 id 不合法，已忽略：" + JSON.stringify(entry.id));
      continue;
    }
    if (seen[id]) {
      problems.push("角色 id 重复，已忽略后一个：" + id);
      continue;
    }

    const builtin = builtinRole(id);
    const requestedMode = ROLE_MODES.indexOf(entry.mode) !== -1 ? entry.mode : "quick";
    // A built-in's mode is part of its identity, not an editable field.
    const mode = builtin ? builtin.mode : requestedMode;

    seen[id] = true;
    roles.push({
      id,
      name: clampString(typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id, 80),
      builtin: !!builtin,
      mode,
      system: clampString(entry.system, MAX_SYSTEM_CHARS),
      tools: stringArray(entry.tools),
      skills: stringArray(entry.skills),
    });
  }

  // Built-ins survive an empty, truncated, or hostile blob. Collected then
  // prepended in declaration order so Agent stays ahead of 快捷对话.
  const missing = [];
  for (const role of BUILTIN_ROLES) {
    if (!seen[role.id]) {
      seen[role.id] = true;
      missing.push({
        id: role.id,
        name: role.name,
        builtin: true,
        mode: role.mode,
        system: role.system,
        tools: role.tools.slice(),
        skills: role.skills.slice(),
      });
    }
  }
  if (missing.length > 0) roles.unshift.apply(roles, missing);

  return { version: 1, roles: roles.slice(0, MAX_ROLES), problems };
}

function roleById(roles, id) {
  for (const role of roles) if (role.id === id) return role;
  return null;
}

// ------------------------------------------------------------------ state
let lastToggleAt = 0;
let settings = {
  accelerator: DEFAULT_ACCELERATOR,
  defaultRoleId: "quick",
  defaultModelKey: "",
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  agentStartMode: "new",
  lastAgentSessionId: "",
  appearance: HOST_APPEARANCE_MODE,
  fontSize: 13,
  opacity: 100,
  searchEndpoint: "",
  searchApiKey: "",
};
let roleState = normalizeRoles(null);
let shortcutState = { requested: null, active: null, registered: false, error: null, fallbackFrom: null };
let settingsListener = null;
let appearanceListener = null;
/** Last appearance read from the host; served to a panel that opens later. */
let hostAppearance = normalizeHostAppearance(DEFAULT_HOST_APPEARANCE);
/** Rolling timestamps of `agent.complete` calls, against the host's 8/min budget. */
let completionTimes = [];

/**
 * ------------------------------------------------------------------ liveness
 * Who owns "is the window up?" — the previous design guessed from the age of
 * the last heartbeat (2s beacon, 6s TTL), and that guess is what made the hotkey
 * feel unresponsive:
 *
 *   - a heartbeat says the *page* is alive, not that the window is on screen.
 *     Minimizing a window keeps its renderer running, so for those 6 seconds the
 *     plugin believed a hidden window was visible and the next press *closed*
 *     it — a press that visibly did nothing.
 *   - the same guess made a real open flicker: press to open, stay away longer
 *     than the TTL, then the press meant to "bring it back" closed it instead.
 *
 * Now the state is asserted at both ends and never inferred:
 *   - this process sets it when IT opens or closes the panel;
 *   - the page reports `visibilitychange` (hidden when the window is minimized
 *     or occluded) and `pagehide` (the surface is going away).
 * The only inference left is the startup default: a process that has just loaded
 * has no panel.
 */
let panelOpen = false;
/** False is authoritative: the page said it is hidden. True may mean "not yet reported". */
let panelVisible = false;
/** True once the page has answered about itself, so a stale "true" cannot stick. */
let panelReported = false;

function panelLikelyVisible() {
  return panelOpen && panelVisible;
}

/**
 * Mirror of the desktop app's own model preference, so the widget defaults to
 * the same model the main window is using. Read through `settings/get`.
 */
let appDefaults = { providerId: "", modelId: "", modelKey: "", thinkingDisplayMode: "compact" };

/**
 * Live phase of the in-flight quick-chat turn. The host has no plugin-facing
 * push channel, so the widget polls this to show "正在思考 / 正在搜索".
 *
 * The finished result is carried HERE rather than returned from the panel call:
 * the host enforces a 30s hard timeout on every panel invoke
 * (plugin-runtime.ts `PLUGIN_PANEL_TIMEOUT_MS = 30_000`), and a quick-chat turn
 * may run a web search plus several `agent.complete` calls (each allowed 90s).
 * Doing that work inside the invoke produced
 * `plugin local.summon-chat did not answer pi-plugin-panel-invoke`.
 */
let quickProgress = {
  turnId: "",
  phase: "idle",
  detail: "",
  round: 0,
  inFlight: false,
  startedAt: 0,
  updatedAt: 0,
  result: null,
  error: null,
  input: null,
};

function host() {
  return typeof pi !== "undefined" && pi !== null ? pi : null;
}

function hasFn(obj, name) {
  try {
    return typeof obj === "object" && obj !== null && typeof obj[name] === "function";
  } catch (err) {
    return false;
  }
}

async function toast(message) {
  const api = host();
  try {
    if (api && api.ui) {
      if (typeof api.ui.notify === "function") { await api.ui.notify({ message: message }); return; }
      if (typeof api.ui.showToast === "function") { await api.ui.showToast({ message: message }); return; }
    }
  } catch (err) {
    // best-effort
  }
  console.log("[summon-chat] " + message);
}

// --------------------------------------------------------------- commands
/**
 * Show the panel, and make it usable in the same breath.
 *
 * `panelHost.open()` reuses the live window when there is one: it restores a
 * minimized window, shows it, and focuses it. That is the whole reason the
 * window is declared as `shape: "panel"` — the same method sets
 * `alwaysOnTop: widget && request.alwaysOnTop === true` and `resizable:
 * request.resizable ?? !widget`, i.e. a widget can never be focused by the host
 * (so a hotkey summons a window the user still has to click before typing),
 * while a panel also takes keyboard focus on show.
 */
async function openWidget() {
  const api = host();
  if (!api || !api.ui || typeof api.ui.openPanel !== "function") {
    return { ok: false, error: "OPEN_PANEL_NOT_AVAILABLE" };
  }
  await api.ui.openPanel({ title: "Summon Chat" });
  panelOpen = true;
  // Left true on purpose: the window may be up while its page has not answered
  // yet. A press in that window re-runs openPanel, which is a no-op besides
  // restoring and focusing the same window — never a close.
  panelVisible = true;
  panelReported = false;
  return { ok: true, action: "open" };
}

async function closeWidget() {
  const api = host();
  if (!api || !api.ui || typeof api.ui.closePanel !== "function") {
    return { ok: false, error: "CLOSE_PANEL_NOT_AVAILABLE" };
  }
  await api.ui.closePanel();
  // Authoritative and race-free: `panelHost.close()` resolves after the page is
  // gone (`plugin-panel-senders.ts: pageGoneWithin`), so no later `pagehide`
  // report can contradict this ordering.
  panelOpen = false;
  panelVisible = false;
  panelReported = false;
  return { ok: true, action: "close" };
}

/**
 * One press, one action — from anywhere, in both directions.
 *
 *   panel not up        -> open (and focus)
 *   up but hidden       -> show + focus again (restore a minimized window)
 *   up and visible      -> close
 *
 * `panelOpen` is only ever set by this process and by the page's own reports, so
 * the branch above cannot be reached with a stale belief about the window; see
 * the note on `panelOpen` for why that used to be a heartbeat guess.
 */
async function toggleWidget() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    return { ok: true, action: "debounced" };
  }
  lastToggleAt = now;
  if (!panelOpen) return await openWidget();
  if (!panelVisible) return await openWidget();
  return await closeWidget();
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
  const candidates = [wanted].concat(
    FALLBACK_ACCELERATORS.filter(function (a) { return a !== wanted; }),
  );

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const result = await api.keyboard.registerGlobalShortcut({
        id: SHORTCUT_ID,
        accelerator: candidate,
        command: SHORTCUT_COMMAND,
      });
      // Refusals are RETURNED, not thrown.
      if (result && result.registered) {
        shortcutState = {
          requested: wanted,
          active: result.accelerator || candidate,
          registered: true,
          error: null,
          // Recorded so the settings UI can say plainly which key is live.
          // Without it a silent fallback (user records Alt+D, Alt+D is taken by
          // another app, the plugin quietly moves to Alt+Shift+C) reads as
          // "the hotkey doesn't respond".
          fallbackFrom: candidate !== wanted ? wanted : null,
        };
        if (candidate !== wanted) {
          await toast("「" + wanted + "」被占用或无效，已改用 " + candidate);
        }
        return shortcutState;
      }
      lastError = (result && result.error) || "UNKNOWN";
    } catch (err) {
      lastError = "THROWN:" + (err && err.message ? err.message : String(err));
    }
  }

  shortcutState = { requested: wanted, active: null, registered: false, error: lastError };
  await toast("快捷键注册失败（" + lastError + "）。可在插件设置里换一个键。");
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
    listed = "<error: " + err.message + ">";
  }
  await toast(
    shortcutState.registered
      ? "呼出快捷键：" + shortcutState.active
      : "快捷键未生效" + (shortcutState.error ? "（" + shortcutState.error + "）" : ""),
  );
  return { shortcut: shortcutState, hostList: listed, roles: roleState.roles.length };
}

// --------------------------------------------------------------- settings
async function loadSettings() {
  const api = host();
  try {
    const raw = await api.plugin.getSettings();
    const source = raw && typeof raw === "object" ? raw : {};
    settings = {
      accelerator:
        typeof source.accelerator === "string" && source.accelerator.trim()
          ? source.accelerator.trim()
          : DEFAULT_ACCELERATOR,
      defaultRoleId:
        typeof source.defaultRoleId === "string" && source.defaultRoleId.trim()
          ? source.defaultRoleId.trim()
          : "quick",
      defaultModelKey:
        typeof source.defaultModelKey === "string" ? source.defaultModelKey.trim() : "",
      maxToolRounds: clampInt(source.maxToolRounds, 0, 5, DEFAULT_MAX_TOOL_ROUNDS),
      // "new" is the default: every summon starts a fresh session. The widget's
      // session picker is the per-open override either way.
      agentStartMode: source.agentStartMode === "continue" ? "continue" : "new",
      lastAgentSessionId:
        typeof source.lastAgentSessionId === "string" ? source.lastAgentSessionId.trim() : "",
      // "host" is the default: the window mirrors whatever PI-Desktop is
      // wearing (palette + locale) instead of drifting from it.
      appearance:
        APPEARANCE_MODES.indexOf(source.appearance) !== -1
          ? source.appearance
          : HOST_APPEARANCE_MODE,
      // 15px is the default: the design ships `html{font-size:16px}`, so a
      // 13px default made the whole rem-based UI read too small.
      fontSize: clampInt(source.fontSize, 12, 20, 15),
      opacity: clampInt(source.opacity, 50, 100, 100),
      searchEndpoint: typeof source.searchEndpoint === "string" ? source.searchEndpoint.trim() : "",
      searchApiKey: typeof source.searchApiKey === "string" ? source.searchApiKey : "",
    };
    roleState = normalizeRoles(source.roles);
    quickHistory = normalizeQuickHistory(source.quickConversations);
    // A default that points at a deleted role falls back to a built-in.
    if (!roleById(roleState.roles, settings.defaultRoleId)) {
      settings.defaultRoleId = "quick";
    }
  } catch (err) {
    // Keep last-known-good rather than failing the load.
  }
  return settings;
}

/** Persist a new role list, returning what was actually stored. */
async function saveRoles(raw) {
  const api = host();
  const next = normalizeRoles(raw);
  roleState = next;

  if (roleById(next.roles, settings.defaultRoleId) === null) {
    settings.defaultRoleId = "quick";
  }

  try {
    await api.plugin.setSettings({
      roles: { version: 1, roles: next.roles },
      defaultRoleId: settings.defaultRoleId,
    });
  } catch (err) {
    return {
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      message: err && err.message ? err.message : String(err),
      roles: next.roles,
    };
  }
  return { ok: true, roles: next.roles, problems: next.problems, defaultRoleId: settings.defaultRoleId };
}

async function onSettingsChanged() {
  const previous = settings.accelerator;
  await loadSettings();
  if (settings.accelerator !== previous) {
    await applyShortcut(settings.accelerator);
  }
}

// ------------------------------------------------------------------ search
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, function (_whole, code) {
      return String.fromCharCode(Number(code));
    });
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded>. */
function unwrapDdgLink(href) {
  const raw = String(href || "");
  const match = /[?&]uddg=([^&]+)/.exec(raw);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch (err) {
      return raw;
    }
  }
  if (raw.indexOf("//") === 0) return "https:" + raw;
  return raw;
}

function parseDdgHtml(html) {
  const titles = [];
  const titleRe =
    /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = titleRe.exec(html)) !== null) {
    titles.push({ url: unwrapDdgLink(decodeEntities(match[1])), title: stripTags(match[2]) });
  }

  const snippets = [];
  const snippetRe =
    /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(match[1]));
  }

  return titles.map(function (item, index) {
    return { title: item.title, url: item.url, snippet: snippets[index] || "" };
  });
}

/** lite.duckduckgo.com uses a table layout instead of result divs. */
function parseDdgLite(html) {
  const titles = [];
  const titleRe =
    /<a\b[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = titleRe.exec(html)) !== null) {
    titles.push({ url: unwrapDdgLink(decodeEntities(match[1])), title: stripTags(match[2]) });
  }

  const snippets = [];
  const snippetRe = /<td\b[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  while ((match = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(match[1]));
  }

  return titles.map(function (item, index) {
    return { title: item.title, url: item.url, snippet: snippets[index] || "" };
  });
}

/**
 * Bing 的结果块。
 *
 * 为什么加它：**内置的 DuckDuckGo 端点在不少网络里根本连不上**（本机实测三个
 * 域名全部超时，`html` / `lite` / `api` 都不通），于是「联网搜索」这个功能整体
 * 失效 —— 用户看到的就是「无法联网搜索」。Bing 在这里是通的（200、10 条结果、
 * 解析稳定），所以把它当作**免配置的兜底**，DDG 优先。
 *
 * 只用 `li.b_algo` 里的 `<h2><a href>` 与 `<p>` 摘要：这两处结构多年没变，
 * 而 Bing 是抓来的页面、不是承诺过的 API —— 解析失败时如实报错（见
 * `builtInSearch` 的 error），不要静默返回空。
 */
function parseBing(html) {
  const blocks = String(html || "").match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>)/g) || [];
  const out = [];
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const para = /<p class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ||
      /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({
      title: stripTags(link[2]),
      url: url,
      snippet: para ? stripTags(para[1]) : "",
    });
    if (out.length >= SEARCH_RESULT_LIMIT) break;
  }
  return out;
}

/** Map the common JSON shapes of SearXNG / Tavily / Brave / generic APIs. */
function mapCustomResults(data) {  if (!data || typeof data !== "object") return [];
  const candidates = [
    data.results,
    data.data,
    data.organic_results,
    data.items,
    data.web && data.web.results,
    data.news,
  ];
  for (let i = 0; i < candidates.length; i++) {
    const list = candidates[i];
    if (!Array.isArray(list)) continue;
    return list.slice(0, SEARCH_RESULT_LIMIT).map(function (row) {
      const item = row && typeof row === "object" ? row : {};
      return {
        title: stripTags(item.title || item.name || item.heading || ""),
        url: String(item.url || item.link || item.href || ""),
        snippet: stripTags(item.content || item.snippet || item.description || item.text || ""),
      };
    });
  }
  return [];
}

/**
 * 用户自填的搜索端点。
 *
 * ⚠️ **Tavily 必须用 POST。** 这是「装了 tavily 还是搜不到」的直接原因：
 * 老实现一律 GET + `?q=`，而 `api.tavily.com/search` 只接受 POST ——
 * 实测 `GET /search` 回的是 **405 Method Not Allowed**（POST 同一把 key 才是
 * 401/200，即 key 经过 `Authorization: Bearer` 校验）。所以按端点识别提供方，
 * 用各自的正确姿势请求。
 *
 * 证据：`tavily-python` 的客户端是 POST `https://api.tavily.com/search`，
 * 头 `Authorization: Bearer <key>`，体 `{query, max_results, search_depth}`，
 * 响应 `{results:[{title,url,content,…}]}` —— `mapCustomResults` 本来就能认这个形状。
 */
async function customSearch(endpoint, query, apiKey) {
  const api = host();
  if (!hasFn(api && api.net, "fetch")) {
    return { ok: false, error: "UNSUPPORTED", results: [], message: "宿主没有 pi.net.fetch" };
  }

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (err) {
    return { ok: false, error: "INVALID_ARGUMENT", results: [], message: "搜索端点不是合法 URL（要写全 https:// 开头）" };
  }

  // 只写 host 是很自然的写法（`api.tavily.com`），但那样 URL 没有路径、
  // 请求会打到首页。Tavily 补上 /search，用户就不必记住路径。
  const isTavily = /(^|\.)tavily\.com$/i.test(parsed.hostname) || /^tvly-/i.test(String(apiKey || ""));
  if (isTavily && (parsed.pathname === "/" || parsed.pathname === "")) parsed.pathname = "/search";

  let response;
  try {
    if (isTavily) {
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = "Bearer " + apiKey;
      const body = JSON.stringify({ query: query, max_results: SEARCH_RESULT_LIMIT });
      response = await api.net.fetch({
        url: parsed.toString(),
        method: "POST",
        headers: headers,
        body: body,
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
    } else {
      if (!parsed.searchParams.get("q") && !parsed.searchParams.get("query")) {
        parsed.searchParams.set("q", query);
      }
      if (/searx/i.test(endpoint) && !parsed.searchParams.get("format")) {
        parsed.searchParams.set("format", "json");
      }
      const headers = { Accept: "application/json" };
      if (apiKey) headers.Authorization = "Bearer " + apiKey;
      response = await api.net.fetch({
        url: parsed.toString(),
        method: "GET",
        headers: headers,
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
    }
  } catch (err) {
    return {
      ok: false,
      error: (err && err.code) || "FETCH_FAILED",
      results: [],
      message: err && err.message ? err.message : String(err),
    };
  }

  if (!response || response.status !== 200) {
    const status = response && response.status;
    // Tavily 的两个特殊状态：432 = 用量上限，433 = 需要付费计划。直接抄给用户，
    // 比「HTTP_4xx」有用得多。
    const hint = status === 432 ? "（Tavily 用量已达上限）" : status === 433 ? "（Tavily 需要付费计划）"
      : status === 401 ? "（API Key 不对或没填）" : status === 405 ? "（这个端点不接受 GET，可能是 Tavily 这类只收 POST 的 API）" : "";
    return {
      ok: false,
      error: "HTTP_" + status,
      results: [],
      message: "搜索端点返回 HTTP " + status + hint,
    };
  }

  let data;
  try {
    data = JSON.parse(response.bodyText || "");
  } catch (err) {
    return { ok: false, error: "INVALID_JSON", results: [], message: "自定义端点没有返回 JSON" };
  }

  const results = mapCustomResults(data);
  if (!results.length) {
    // 有的 API 把「为什么没有结果」写在 body 里（Tavily 是 detail/error）。
    const detail = (data && (data.detail || data.error || data.message)) || "";
    return {
      ok: false,
      error: "NO_RESULTS_PARSED",
      results: [],
      message: "返回的 JSON 里没有可用的结果" + (detail ? "：" + String(detail).slice(0, 200) : "（结构不认识）"),
    };
  }
  return { ok: true, provider: isTavily ? "tavily" : "custom", results: results };
}

/**
 * 内置搜索：先 DuckDuckGo（免 key、结构化程度最好），不通就退到 Bing。
 *
 * ⚠️ 这里如实报告**为什么失败**，因为「联网搜索没成功」这句话对用户毫无帮助。
 * 之前无论哪种失败都归成一个 `SEARCH_FAILED` 加一句「没解析到结果」，而实际原因
 * 可能是网络不通（本机 DDG 三个域名全超时）、被限流（HTTP 403），或者页面结构
 * 变了（解析 0 条）—— 三种要做的事完全不同。
 */
async function builtInSearch(query) {
  const api = host();
  if (!hasFn(api && api.net, "fetch")) {
    return { ok: false, error: "UNSUPPORTED", results: [], message: "宿主没有 pi.net.fetch" };
  }

  const attempts = [
    { url: DDG_HTML_ENDPOINT + "?q=" + encodeURIComponent(query), parse: parseDdgHtml, provider: "duckduckgo" },
    { url: DDG_LITE_ENDPOINT + "?q=" + encodeURIComponent(query), parse: parseDdgLite, provider: "duckduckgo" },
    { url: BING_ENDPOINT + encodeURIComponent(query) + "&setlang=zh-CN", parse: parseBing, provider: "bing" },
  ];

  const failures = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    let response;
    try {
      response = await api.net.fetch({
        url: attempt.url,
        method: "GET",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
    } catch (err) {
      failures.push(attempt.provider + " 连不上（" + ((err && err.code) || "网络错误") + "）");
      continue;
    }
    if (!response || response.status !== 200) {
      failures.push(attempt.provider + " 返回 HTTP " + (response && response.status));
      continue;
    }
    const results = attempt.parse(response.bodyText || "").slice(0, SEARCH_RESULT_LIMIT);
    if (results.length) return { ok: true, provider: attempt.provider, results: results };
    failures.push(attempt.provider + " 的页面里没解析到结果（结构可能变了）");
  }

  return {
    ok: false,
    error: "SEARCH_FAILED",
    results: [],
    message: "内置搜索没成功：" + failures.join("；") +
      "。可以在插件设置里填自己的搜索端点（SearXNG / Tavily / Brave 等）。",
    failures: failures,
  };
}

async function webSearch(query) {
  const endpoint = String(settings.searchEndpoint || "").trim();
  if (endpoint) return await customSearch(endpoint, query, settings.searchApiKey);
  return await builtInSearch(query);
}

// --------------------------------------------------------------- models
async function listModels() {
  const api = host();
  if (!hasFn(api && api.models, "list")) return [];
  try {
    const rows = await api.models.list();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter(function (row) { return row && typeof row.key === "string"; })
      .map(function (row) {
        const levels = Array.isArray(row.thinkingLevels) ? row.thinkingLevels : [];
        return {
          key: row.key,
          label: row.label || row.key,
          providerId: row.providerId || "",
          modelId: row.modelId || "",
          supportsReasoning: !!row.supportsReasoning,
          thinkingLevels: levels,
          // The host's own default rule, so the widget preselects what the app would.
          defaultThinkingLevel: defaultThinkingLevel(levels),
        };
      });
  } catch (err) {
    return [];
  }
}

async function resolveModelKey(explicit) {
  const wanted = String(explicit || settings.defaultModelKey || "").trim();
  if (wanted) return wanted;
  const models = await listModels();
  return models.length ? models[0].key : "";
}

// ------------------------------------------------------- quick chat engine
function recentCompletionCount() {
  const cutoff = Date.now() - 60000;
  completionTimes = completionTimes.filter(function (t) { return t > cutoff; });
  return completionTimes.length;
}

/** Accept only a JSON object that actually names a tool we implement. */
function extractToolCall(text) {
  const cleaned = String(text || "").replace(/```[a-zA-Z]*/g, "").replace(/```/g, "");
  const re = /\{[^{}]*"tool"\s*:\s*"([a-zA-Z_]+)"[^{}]*\}/g;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      continue;
    }
    if (!parsed || typeof parsed.tool !== "string") continue;
    if (TOOL_IDS.indexOf(parsed.tool) === -1) continue;
    return parsed;
  }
  return null;
}

/**
 * `project/*` 的返回形状没有公开契约，所以路径与项目列表都按几种可能形状解析；
 * 解析不出来就返回空，绝不让界面崩掉。
 */
function readProjectPath(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return (
    firstNonEmptyString(
      value.path,
      value.projectPath,
      value.root,
      value.dir,
      value.project && value.project.path,
      value.workspace && value.workspace.path,
    ) || ""
  );
}

function normalizeProjects(value) {
  const rows = Array.isArray(value)
    ? value
    : value && Array.isArray(value.projects)
      ? value.projects
      : [];
  const out = [];
  for (const row of rows) {
    if (typeof row === "string") {
      if (row.trim()) out.push({ path: row, name: row });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const projectPath = readProjectPath(row);
    if (!projectPath) continue;
    out.push({
      path: projectPath,
      name: firstNonEmptyString(row.name, row.title, row.label) || projectPath,
    });
  }
  return out;
}

/**
 * 技能文档有可能被模型原样复述（本地小模型尤其如此），所以注入时附带约束。
 */
const SKILL_GUARD =
  "下面这些技能文档**只是背景知识**，用来说明应该怎么做，不是回答内容。\n" +
  "绝对不要把文档本身复述、摘抄或输出给用户，也不要用 JSON 包裹回复；\n" +
  "请始终用自然语言直接回答用户的问题。";

/**
 * 技能目录：名称 → 引用。
 *
 * 角色可以在 **System Prompt 里用 `/技能名` 引用技能**，语法与主窗口 composer 一致 ——
 * 宿主 `packages/shared/src/composer-trigger.ts` 的 `findSkillMentions` 用的就是
 * `/(^|\s)\/([^\s]+)/g`，再拿这个名字去查技能目录。
 *
 * 插件 SDK 里**没有** skill 命名空间（`pi.skill` 不存在），所以走 desktop.control 的
 * `skill/list` 与 `skill/read` —— 两者风险等级都是 read，不弹确认框。
 */
let skillCatalogCache = null;

async function skillCatalog() {
  if (skillCatalogCache) return skillCatalogCache;
  const map = new Map();
  const result = await desktopInvoke("skill/list", [{}]);
  if (result.ok) {
    const value = result.value;
    const rows = Array.isArray(value)
      ? value
      : value && Array.isArray(value.skills)
        ? value.skills
        : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const ref = firstNonEmptyString(row.id, row.skillId, row.slug, row.key, row.name);
      const label = firstNonEmptyString(row.name, row.slug, row.id, row.key);
      if (!ref || !label) continue;
      // 名字、slug、id 都能命中，免得用户还得猜该写哪一个。
      map.set(label, ref);
      if (row.slug) map.set(row.slug, ref);
      if (row.id) map.set(row.id, ref);
    }
    // 只在成功时缓存：失败可能只是这一刻的事。
    skillCatalogCache = map;
  }
  return map;
}

async function readSkillBody(ref) {
  const attempts = [{ id: ref }, { name: ref }, ref];
  for (let i = 0; i < attempts.length; i++) {
    const result = await desktopInvoke("skill/read", [attempts[i]]);
    if (!result.ok) continue;
    const value = result.value;
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const body = firstNonEmptyString(
        value.content,
        value.body,
        value.text,
        value.markdown,
        value.skill && value.skill.content,
      );
      if (body) return body;
    }
  }
  return "";
}

/**
 * 把 System Prompt 里 `/技能名` 引用到的技能文档读出来，附在人设后面。
 *
 * 这样快捷对话也能用技能，而且**不需要**再单独维护一份 skills 列表 ——
 * 角色预设词本身就是唯一的事实来源。读不到的引用会被静静跳过，
 * 不会因为一个写错的技能名就让整轮对话失败。
 */
async function injectMentionedSkills(systemText) {
  const text = typeof systemText === "string" ? systemText : "";
  if (!text || text.indexOf("/") === -1) return text;

  const names = [];
  const re = /(^|\s)\/([^\s]+)/g;
  let match = re.exec(text);
  while (match !== null && names.length < 8) {
    if (names.indexOf(match[2]) === -1) names.push(match[2]);
    match = re.exec(text);
  }
  if (!names.length) return text;

  const catalog = await skillCatalog();
  const docs = [];
  for (const name of names) {
    const body = await readSkillBody(catalog.get(name) || name);
    if (body) docs.push("# Skill: " + name + "\n" + body);
  }
  if (!docs.length) return text;
  return text + "\n\n" + SKILL_GUARD + "\n\n" + docs.join("\n\n");
}

/**
 * 快捷对话的 system prompt 由「角色人设（含 `/技能名` 引用）+ 联网搜索指令」构成。
 * 它仍然**没有工具执行环境**：联网搜索由插件自己跑（见 runQuickChat），
 * 技能在这里只作为背景知识注入。
 */
async function buildSystemPrompt(role) {
  const parts = [];
  if (role.system) parts.push(await injectMentionedSkills(role.system));
  parts.push(TOOL_DIRECTIVE((role.tools || []).indexOf("web_search") !== -1));
  return parts.join("\n\n").slice(0, MAX_SYSTEM_CHARS);
}

/**
 * 当前时间。**本地算，不走网、不花钱**，所以它永远可用。
 *
 * 为什么这件事值得一个工具：模型不知道今天是几号，于是
 *   · 「深圳今天天气」它会照训练数据答，或者搜一个过期的年份；
 *   · 「今年是哪一年」「明天是周几」这类问题只能靠猜。
 * 给一次准确的时间就够 —— 相对日期（下周五、三天后）模型自己会算。
 *
 * 时区取本机（`Intl` 的 `timeZone`），偏移量直接量出来，不靠猜：
 * 用 `Intl` 格式化一个已知时刻再反解。夏令时也会跟着对。
 */
function currentTimeBlock(now) {
  const at = now instanceof Date ? now : new Date();
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (err) {
    zone = "";
  }

  const pad = function (n) { return String(n).padStart(2, "0"); };
  const local =
    at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate()) +
    " " + pad(at.getHours()) + ":" + pad(at.getMinutes()) + ":" + pad(at.getSeconds());
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][at.getDay()];

  let offset = "";
  try {
    const named = new Intl.DateTimeFormat("en-US", {
      timeZone: zone || undefined,
      timeZoneName: "shortOffset",
    }).formatToParts(at).find(function (part) { return part.type === "timeZoneName"; });
    offset = named ? named.value.replace(/^GMT/, "UTC") : "";
  } catch (err) {
    offset = "";
  }
  if (!offset) {
    // Fallback: measure the real gap between local time and UTC.
    const mins = -at.getTimezoneOffset();
    const sign = mins < 0 ? "-" : "+";
    const abs = Math.abs(mins);
    offset = "UTC" + sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
  }

  return [
    "当前时间：" + local + "（" + weekday + "）",
    "时区：" + (zone || "本机时区") + (offset ? "（" + offset + "）" : ""),
    "ISO：" + at.toISOString(),
  ].join("\n");
}

function formatTimeResult() {
  return "工具结果(current_time)：\n" + currentTimeBlock(new Date()) +
    "\n（这是本机时间。涉及「今天/现在/最新」的回答请以它为准；" +
    "相对日期可以自己推算，不必再调用本工具。）";
}

/**
 * 有些模型（尤其本地端点）会把回复包成内容块数组：
 * `{"content":[{"type":"text","text":"…"}]}`。
 * 整段都是这个形状时剥出正文 —— 否则用户看到的是一坨 JSON。
 * 放在插件侧（而不是界面侧）是为了能被 smoke 测试覆盖。
 */
function unwrapModelText(text) {
  if (typeof text !== "string") return typeof text === "undefined" ? "" : String(text);
  const trimmed = text.trim();
  if (trimmed.charAt(0) !== "{") return text;
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return text;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.content)) return text;
  const parts = [];
  for (const block of parsed.content) {
    if (block && typeof block.text === "string" && block.text) parts.push(block.text);
  }
  if (!parts.length) return text;
  return parts.join("\n\n");
}

function formatToolResult(query, search) {
  if (!search.ok) {
    return (
      "工具结果(web_search) 失败：" + (search.message || search.error || "未知错误") + "\n" +
      "请直接说明无法联网搜索，并基于你已有的知识回答，不要编造来源。"
    );
  }
  if (!search.results.length) {
    return "工具结果(web_search) 「" + query + "」没有找到结果。";
  }
  const lines = search.results.map(function (row, index) {
    return index + 1 + ". " + row.title + "\n   " + row.url + "\n   " + row.snippet;
  });
  return "工具结果(web_search) 「" + query + "」：\n" + lines.join("\n");
}

function setProgress(phase, detail, round, step) {
  // A cancelled turn keeps running in the background (agent.complete cannot be
  // aborted), and it keeps calling setProgress. Without this guard those ticks
  // would flip `inFlight` back on and the page would start waiting again for a
  // turn the user already stopped.
  if (quickProgress.phase === "cancelled") return -1;
  const at = Date.now();
  // `steps` is the live timeline the panel draws while the turn runs: one row per
  // step that actually happened, in order. Without it the panel can only say
  // "正在搜索…", and the keyword / source URLs only appear after the turn ends —
  // which is exactly the "不知道它做了什么" complaint.
  //
  // The sequence is: previous step → done; append the new one. So the panel sees
  // 「思考完成」 followed by 「正在搜索「…」」, the same shape as the reference UI.
  const steps = (quickProgress.steps || []).map(function (row, index, all) {
    if (index === all.length - 1 && row.status === "running") {
      // Date.now() has 1ms resolution, so a step that finished in the same tick
      // would report 0; recording 1 keeps "did this row finish?" unambiguous.
      const took = row.at ? Math.max(1, at - row.at) : null;
      return Object.assign({}, row, { status: "done", tookMs: took });
    }
    return row;
  });
  if (step) steps.push(Object.assign({ at: at, status: "running" }, step));
  // Object.assign, not a fresh literal: turnId/result/error must survive every
  // progress tick or the page would lose the answer it is polling for.
  quickProgress = Object.assign({}, quickProgress, {
    phase: phase,
    detail: detail || "",
    round: typeof round === "number" ? round : quickProgress.round,
    inFlight: true,
    startedAt: quickProgress.startedAt || at,
    updatedAt: at,
    steps: steps,
  });
  return steps.length - 1;
}

/**
 * The "thinking" phase fires once per round and its label changes ("正在思考…"
 * then "正在思考（第 2 轮）…"). A fresh row per tick would flood the timeline, so
 * the newest row is replaced while it is still the running one.
 */
function setThinkingStep(detail, round) {
  if (quickProgress.phase === "cancelled") return;
  const steps = quickProgress.steps || [];
  const last = steps[steps.length - 1];
  if (last && last.kind === "thinking" && last.status === "running") {
    // Only the label changes. `at` must keep the time the step *started* — moving
    // it here would make every thinking row report a few milliseconds.
    updateProgressStep(steps.length - 1, { detail: detail, round: round });
    return;
  }
  const at = setProgress("thinking", detail, round, {
    kind: "thinking",
    phase: "thinking",
    detail: detail,
    round: round,
  });
  updateProgressStep(at, { detail: detail, round: round });
}

/**
 * Close every still-running step. Called when a turn reaches a terminal state:
 * the last "思考" row would otherwise stay marked running forever, and the panel
 * would keep an animation alive next to an answer that is already on screen.
 */
function settleProgressSteps(outcome) {
  const steps = (quickProgress.steps || []).map(function (row) {
    if (row.status !== "running") return row;
    return Object.assign({}, row, {
      status: outcome,
      tookMs: row.at ? Math.max(1, Date.now() - row.at) : null,
    });
  });
  quickProgress = Object.assign({}, quickProgress, { steps: steps });
}

/**
 * Patch one already-appended live step (a search that started as "running" and
 * has now finished). Keeps the row in place so the timeline does not jump.
 */
function updateProgressStep(index, patch) {
  if (quickProgress.phase === "cancelled") return;
  const steps = (quickProgress.steps || []).slice();
  if (!(index >= 0 && index < steps.length)) return;
  steps[index] = Object.assign({}, steps[index], patch);
  if (steps[index].status !== "running" && steps[index].tookMs == null && steps[index].at) {
    steps[index].tookMs = Date.now() - steps[index].at;
  }
  // Date.now() has 1ms resolution, so a step that finished in the same tick
  // would report 0. The renderer hides anything below 1ms anyway; recording 0
  // makes "did this row even finish?" ambiguous in the payload.
  if (steps[index].tookMs === 0) steps[index].tookMs = 1;
  quickProgress = Object.assign({}, quickProgress, { steps: steps, updatedAt: Date.now() });
}

function finishQuickTurn(patch) {
  quickProgress = Object.assign({}, quickProgress, {
    phase: patch.phase,
    detail: "",
    inFlight: false,
    updatedAt: Date.now(),
    result: patch.result !== undefined ? patch.result : quickProgress.result,
    error: patch.error !== undefined ? patch.error : quickProgress.error,
  });
  settleProgressSteps(patch.error ? "error" : "done");
}

/**
 * Start a quick-chat turn and return IMMEDIATELY.
 *
 * The model work runs detached; the page polls `summon.chat.progress` and picks
 * the answer up from `progress.result` once `inFlight` goes false. This is the
 * whole reason the panel call cannot await the work — see the note on
 * `quickProgress` for the 30s host timeout that this avoids.
 */
async function quickChat(input) {
  if (quickProgress.inFlight) {
    return { ok: false, error: "BUSY", message: "上一轮还没结束，请稍候。" };
  }
  const payload = input && typeof input === "object" ? input : {};
  const turnId = "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  quickProgress = {
    turnId: turnId,
    phase: "starting",
    detail: "正在准备…",
    round: 0,
    inFlight: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null,
    // Live timeline for the panel: one entry per step that actually happened.
    // It is what makes the widget show the search keyword and the source URLs
    // while the turn runs, instead of only a phase word.
    steps: [{ kind: "turn", phase: "starting", detail: "正在准备…", at: Date.now(), status: "running" }],
    input: {
      text: typeof payload.text === "string" ? payload.text : "",
      roleId: typeof payload.roleId === "string" ? payload.roleId : "",
      conversationId:
        typeof payload.conversationId === "string" && payload.conversationId
          ? payload.conversationId
          : "q-" + Date.now().toString(36),
    },
  };
  const current = quickProgress;

  runQuickChat(payload)
    .then(function (result) {
      if (quickProgress.turnId !== turnId) return; // superseded; drop the reply
      // The user pressed stop while this turn was running: the model call itself
      // cannot be aborted (PluginCompleteInput has no AbortSignal), so the reply
      // is simply discarded and never recorded.
      if (quickProgress.phase === "cancelled") return;
      finishQuickTurn({ phase: "done", result: result || { ok: false, error: "EMPTY" } });
      return rememberQuickTurn(current.input, result);
    })
    .catch(function (err) {
      if (quickProgress.turnId !== turnId) return;
      finishQuickTurn({
        phase: "error",
        error: { message: err && err.message ? err.message : String(err) },
      });
    });

  return { ok: true, accepted: true, turnId: turnId };
}

async function runQuickChat(input) {
  const api = host();
  const payload = input && typeof input === "object" ? input : {};
  const role =
    roleById(roleState.roles, payload.roleId) ||
    roleById(roleState.roles, "quick") ||
    roleState.roles[0];

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return { ok: false, error: "INVALID_ARGUMENT", message: "空消息" };
  if (!role) return { ok: false, error: "NO_ROLE", message: "没有可用角色" };

  if (!hasFn(api && api.agent, "complete")) {
    return { ok: false, error: "UNSUPPORTED", message: "宿主没有 pi.agent.complete（需要 agent.complete 权限）" };
  }

  const modelKey = await resolveModelKey(payload.modelKey);
  if (!modelKey) {
    return {
      ok: false,
      error: "NO_MODEL",
      message: "没有可用模型。请先在 PI-Desktop 里登录一个模型提供方，或在插件设置里填「快捷对话模型」。",
    };
  }

  const system = await buildSystemPrompt(role);

  const messages = [];
  const history = Array.isArray(payload.history) ? payload.history : [];
  history.slice(-MAX_HISTORY_MESSAGES).forEach(function (row) {
    if (!row || typeof row !== "object") return;
    if (row.role !== "user" && row.role !== "assistant") return;
    if (typeof row.content !== "string" || !row.content) return;
    messages.push({ role: row.role, content: row.content });
  });
  messages.push({ role: "user", content: text });

  const useTools = (role.tools || []).indexOf("web_search") !== -1;
  const maxRounds = useTools ? clampInt(settings.maxToolRounds, 0, 5, DEFAULT_MAX_TOOL_ROUNDS) : 0;

  const trace = [];
  let answer = "";
  let rounds = 0;
  // `current_time` 每轮只给一次：它是个常量，再问一次也给同样的答案 —— 而每多问一次
  // 就是一次模型调用（宿主每分钟只放 8 次）。给过一次之后就从可用列表里摘掉。
  let clockGiven = false;

  for (;;) {
    if (recentCompletionCount() >= COMPLETE_BUDGET_PER_MINUTE) {
      return {
        ok: false,
        error: "RATE_LIMITED",
        message: "宿主限制每分钟 8 次补全，请稍等一会儿再发。",
        trace: trace,
        text: answer,
      };
    }

    completionTimes.push(Date.now());
    setThinkingStep(rounds > 0 ? "正在思考（第 " + (rounds + 1) + " 轮）…" : "正在思考…", rounds);
    let result;
    try {
      const completionInput = { modelKey: modelKey, system: system, messages: messages.slice() };
      // Optional: models publish their own thinking levels (PluginModelInfo).
      if (payload.thinkingLevel) completionInput.thinkingLevel = payload.thinkingLevel;
      result = await api.agent.complete(completionInput);
    } catch (err) {
      return {
        ok: false,
        error: (err && err.code) || "COMPLETE_FAILED",
        message: err && err.message ? err.message : String(err),
        trace: trace,
      };
    }

    answer = unwrapModelText(result && result.text);
    if (!answer) {
      return { ok: false, error: "EMPTY_RESPONSE", message: "模型返回了空内容", trace: trace };
    }

    const call = extractToolCall(answer);
    if (!call) break; // 不是工具调用 → 这就是最终回答

    // 时钟：本地计算，不花搜索的轮次额度。
    // ⚠️ 它的闸门**不能**用 `rounds >= maxRounds` —— 不开联网搜索时 maxRounds 是 0，
    // 于是 `0 >= 0` 直接把这一支掐掉，角色越「干净」越用不了时间工具（第一次写就是这样）。
    // 各管各的预算：搜索有 `--rounds`，时钟由 clockGiven 保证每轮只给一次，
    // 两者都还要受一个绝对上限约束，避免弱模型无限循环。
    if (call.tool === "current_time") {
      if (clockGiven || rounds >= MAX_TOOL_CALLS) break;
      clockGiven = true;
      rounds++;
      const stepAt = setProgress("tool", "正在读取当前时间…", rounds, {
        kind: "tool",
        phase: "tool",
        detail: "正在读取当前时间…",
        round: rounds,
        status: "running",
        at: Date.now(),
      });
      const stamp = currentTimeBlock(new Date());
      trace.push({
        round: rounds,
        tool: "current_time",
        ok: true,
        provider: "local",
        count: 0,
        error: null,
        // 时间线的「结果」栏显示的原文（点开那一行就能看到）。
        results: [],
        detail: stamp.split("\n").join(" · "),
      });
      updateProgressStep(stepAt, {
        status: "done",
        detail: "当前时间：" + stamp.split("\n")[0].replace(/^当前时间：/, ""),
      });
      messages.push({ role: "assistant", content: answer });
      messages.push({ role: "user", content: formatTimeResult() });
      continue;
    }

    if (!useTools || rounds >= maxRounds) break;

    rounds++;
    const query = typeof call.query === "string" ? call.query.trim() : "";
    if (!query) break;

    // The step is appended *before* the search runs, so the panel shows the
    // keyword immediately; the row is then patched with the result count, the
    // provider and the source URLs. "正在搜索…" alone tells the user nothing.
    const stepAt = setProgress("searching", "正在搜索「" + query.slice(0, 40) + "」…", rounds, {
      kind: "search",
      phase: "searching",
      query: query,
      round: rounds,
      status: "running",
      at: Date.now(),
    });
    const search = await webSearch(query);
    const results = search.results ? search.results : [];
    trace.push({
      round: rounds,
      tool: "web_search",
      query: query,
      ok: search.ok,
      provider: search.provider || null,
      count: results.length,
      error: search.ok ? null : search.error || "SEARCH_FAILED",
      // 失败时把**每一项尝试各自的原因**也带上：界面之前只能干说
      // 「联网搜索没成功」，而真正该区分的是「连不上」「被限流」「页面结构变了」。
      failures: search.ok ? null : (search.failures || null),
      message: search.ok ? null : (search.message || null),
      results: results,
    });
    updateProgressStep(stepAt, {
      status: search.ok ? "done" : "error",
      detail: search.ok
        ? "「" + query + "」→ " + results.length + " 条（" + (search.provider || "?") + "）"
        : "「" + query + "」失败：" + (search.error || "未知错误"),
      provider: search.provider || null,
      count: results.length,
      error: search.ok ? null : search.error || "SEARCH_FAILED",
      // Only what the timeline shows: title + url. The snippet stays in the model
      // context, where it belongs — it would triple the size of the panel state.
      results: results.map(function (row) {
        return { title: row && row.title ? String(row.title) : "", url: row && row.url ? String(row.url) : "" };
      }),
    });

    messages.push({ role: "assistant", content: answer });
    messages.push({ role: "user", content: formatToolResult(query, search) });
  }

  return {
    ok: true,
    text: answer,
    modelKey: modelKey,
    roleId: role.id,
    trace: trace,
    searched: trace.length > 0,
    usage: null,
  };
}

// ------------------------------------------------- Agent mode (desktop.control)
/**
 * Every call goes through the host's reviewed operation catalog. The request
 * shapes below were read from the host source:
 *   - `agent/prompt`  args: [{ sessionId, content }]      (AgentPromptRequest)
 *   - `session/get`   args: [{ id, messageBefore?, messageLimit?, contentLimit? }]
 *   - `session/open`  args: [sessionId]
 *
 * The *response* shapes are not documented and could not be verified without a
 * running host, so every reader below accepts several plausible shapes and
 * degrades to an empty result instead of throwing. If a field looks wrong in
 * practice, this is the place to fix it.
 */
async function desktopInvoke(operation, args, options) {
  const api = host();
  if (!hasFn(api && api.desktop, "invoke")) {
    return {
      ok: false,
      error: "UNSUPPORTED",
      message: "宿主没有 pi.desktop.invoke。Agent 模式需要 desktop.control 权限。",
    };
  }
  const input = { operation: operation, args: args || [] };
  // `dangerous` operations additionally need the host's native user consent.
  // confirm=true is only the caller's acknowledgement, not the user's decision.
  if (options && options.confirm === true) input.confirm = true;
  try {
    const value = await api.desktop.invoke(input);
    return { ok: true, value: value };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.code) || "INVOKE_FAILED",
      message: err && err.message ? err.message : String(err),
    };
  }
}

function firstNonEmptyString() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * `session/list` returns `SessionSummary[]` and `session/get` returns
 * `{ session: SessionDetail }` where `SessionDetail = SessionSummary &
 * { messages }`, per packages/shared/src/types/sessions.ts. Kept tolerant
 * anyway, because the wire shape is not a documented plugin contract.
 */
function normalizeSessionSummary(row) {
  const item = row && typeof row === "object" ? row : {};
  const providerId = firstNonEmptyString(item.providerId);
  const modelId = firstNonEmptyString(item.modelId);
  const levels = Array.isArray(item.supportedThinkingLevels)
    ? item.supportedThinkingLevels.filter(function (level) { return typeof level === "string"; })
    : [];

  return {
    id: firstNonEmptyString(item.id, item.sessionId, item.key),
    title: firstNonEmptyString(item.title, item.name, item.summary) || "(无标题)",
    status: firstNonEmptyString(item.status, item.state),
    mode: firstNonEmptyString(item.mode) || null,
    permissionMode: firstNonEmptyString(item.permissionMode) || null,
    // 会话绑定的项目目录。界面用它显示「当前项目文件夹」——用户在一个项目里
    // 建了会话却看不到自己在哪个项目，是这个插件最容易被误解的地方之一。
    projectPath: firstNonEmptyString(item.projectPath, item.project && item.project.path) || null,
    providerId: providerId || null,
    modelId: modelId || null,
    modelKey: providerId && modelId ? providerId + "/" + modelId : null,
    thinkingLevel: firstNonEmptyString(item.thinkingLevel) || null,
    supportedThinkingLevels: levels,
    supportsReasoning: item.supportsReasoning === true,
    messageCount: typeof item.messageCount === "number" ? item.messageCount : null,
    updatedAt: item.updatedAt || item.updated_at || null,
  };
}

function normalizeSessionList(value) {
  const rows = Array.isArray(value)
    ? value
    : value && Array.isArray(value.sessions)
      ? value.sessions
      : value && Array.isArray(value.items)
        ? value.items
        : value && value.result && Array.isArray(value.result.sessions)
          ? value.result.sessions
          : [];

  return rows.map(normalizeSessionSummary).filter(function (row) { return !!row.id; });
}

/** Read the desktop app's own model + thinking-display preferences. */
async function readAppDefaults() {
  const result = await desktopInvoke("settings/get", []);
  if (!result.ok) return appDefaults;
  const value = result.value && typeof result.value === "object" ? result.value : {};
  const settingsNode = value.settings && typeof value.settings === "object" ? value.settings : value;
  const providerId = firstNonEmptyString(settingsNode.defaultProviderId);
  const modelId = firstNonEmptyString(settingsNode.defaultModelId);
  appDefaults = {
    providerId: providerId,
    modelId: modelId,
    modelKey: providerId && modelId ? providerId + "/" + modelId : "",
    thinkingDisplayMode: settingsNode.thinkingDisplayMode === "detailed" ? "detailed" : "compact",
  };
  return appDefaults;
}

/**
 * Mirror the host's own default-thinking rule (model-catalog.ts): prefer
 * "medium" when the model publishes it, otherwise the first level.
 */
function defaultThinkingLevel(levels) {
  if (!Array.isArray(levels) || !levels.length) return null;
  return levels.indexOf("medium") !== -1 ? "medium" : levels[0];
}

/** A durable message may carry a string body or an array of typed parts. */
function extractMessageText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(function (part) {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (message && typeof message.text === "string") return message.text;
  return "";
}

/** Tool traffic arrives as its own `role: "tool"` message, not as message parts. */

/** Trim a string, or null. */
function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A finite number, or null. Durations arrive as ms integers; 0 means "unknown". */
function optionalNumber(value) {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : null;
}

/**
 * One provider-hosted web-search round, normalized.
 *
 * Shape comes from `HostedSearchRound` (packages/shared/src/types/messages.ts):
 * `{ id, status, kind?, query?, url?, sources[{url,title?}] }`. The renderer shows
 * the query and the source URLs, so only those fields are carried over — the raw
 * block is large (it contains the provider's own wire payload) and dumping it
 * into the panel would cost more than it explains.
 */
function normalizeHostedSearchRound(row) {
  const item = row && typeof row === "object" ? row : {};
  const sources = (Array.isArray(item.sources) ? item.sources : [])
    .map(function (source) {
      if (!source || typeof source !== "object") return null;
      const url = optionalText(source.url);
      if (!url) return null;
      return { url: url, title: optionalText(source.title) };
    })
    .filter(Boolean)
    .slice(0, 12);
  return {
    id: optionalText(item.id) || "",
    status: optionalText(item.status) || "completed",
    kind: optionalText(item.kind) || "search",
    query: optionalText(item.query),
    url: optionalText(item.url),
    sources: sources,
  };
}

/**
 * Provider-hosted search activity for one assistant turn.
 *
 * Present only when the model binding opted into native web search *and* the
 * provider actually searched — i.e. exactly the case the user asked to see
 * (「联网搜索了也不会展现搜索的关键词、搜索的网址」).
 */
function normalizeHostedSearch(value) {
  if (!value || typeof value !== "object") return null;
  const rounds = (Array.isArray(value.rounds) ? value.rounds : [])
    .map(normalizeHostedSearchRound)
    .filter(Boolean);
  if (!rounds.length) return null;
  return {
    status: optionalText(value.status) || "completed",
    rounds: rounds,
  };
}

/**
 * A tool row's own metadata.
 *
 * Every field here is persisted by the host and comes back through `session/get`
 * (`ui_to_record` → `remote_tool_meta` → `record_to_ui`): the tool name, the
 * call's status, its arguments, its result, and how long it ran. The main window
 * renders exactly these; before this the widget flattened them into the row's
 * body text and the user could not tell a tool call from a tool result.
 */
function normalizeToolMeta(message) {
  const name = optionalText(message.toolName) || optionalText(message.tool_name);
  const callId = optionalText(message.toolCallId) || optionalText(message.tool_call_id);
  const args = message.toolArgs !== undefined ? message.toolArgs : message.tool_args;
  const result = message.toolResult !== undefined ? message.toolResult : message.tool_result;
  const status = optionalText(message.toolStatus) || optionalText(message.tool_status);
  if (!name && !callId && args === undefined && result === undefined && !status) return null;
  return {
    name: name || "",
    callId: callId || "",
    status: status || (message.isError || message.is_error ? "error" : "success"),
    args: args === undefined ? null : args,
    result: result === undefined ? null : result,
    durationMs: optionalNumber(message.toolDurationMs) || optionalNumber(message.tool_duration_ms),
    completedAt:
      optionalText(message.toolCompletedAt) || optionalText(message.tool_completed_at) || null,
  };
}

function normalizeTranscript(value) {
  const session =
    value && typeof value === "object" && value.session && typeof value.session === "object"
      ? value.session
      : value && typeof value === "object"
        ? value
        : {};

  const rawMessages = Array.isArray(session.messages)
    ? session.messages
    : Array.isArray(session.transcript)
      ? session.transcript
      : Array.isArray(value && value.messages)
        ? value.messages
        : [];

  const messages = rawMessages
    .map(function (row) {
      const message = row && typeof row === "object" ? row : {};
      const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
      const error = message.error && typeof message.error === "object" ? message.error : null;
      const tool = normalizeToolMeta(message);
      return {
        id: firstNonEmptyString(message.id, message.messageId, message.seq && String(message.seq)),
        role: firstNonEmptyString(message.role, message.type) || "unknown",
        // UiMessage.content is a plain string; extractMessageText stays as a
        // fallback for hosts that expose typed parts instead.
        // unwrapModelText 再兜一层：有的端点会把 text 包成内容块 JSON。
        text: unwrapModelText(
          typeof message.content === "string" ? message.content : extractMessageText(message),
        ),
        // The host keeps model reasoning out of the answer text on purpose.
        thinking: typeof message.thinking === "string" ? message.thinking : "",
        status: firstNonEmptyString(message.status) || null,
        modelId: firstNonEmptyString(message.modelId) || null,
        providerId: firstNonEmptyString(message.providerId) || null,
        // An assistant turn is "the reply still being written" exactly when the
        // host says so. The panel uses this to decide whether the row is worth
        // re-rendering on every poll, and to show a live "writing" state.
        streaming: message.status === "streaming",
        // "This message is internal model context, never a visible chat row."
        modelSystem: !!message.modelSystem,
        // Elapsed model time for this turn (host: responseDurationMs) — the
        // number behind "已处理 2m 11s" in the reference UI.
        durationMs:
          optionalNumber(message.responseDurationMs) ||
          optionalNumber(message.response_duration_ms),
        createdAt: firstNonEmptyString(message.createdAt, message.created_at) || null,
        tool: tool,
        hostedSearch: normalizeHostedSearch(message.hostedSearch || message.hosted_search),
        usage: usage
          ? {
              inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
              outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
              reasoningTokens: typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : null,
              cacheReadTokens: typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : null,
              totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : null,
            }
          : null,
        error: error
          ? {
              code: firstNonEmptyString(error.code, error.errorCode) || null,
              message: firstNonEmptyString(error.message, error.detail) || null,
            }
          : null,
        at: message.createdAt || message.at || message.timestamp || null,
      };
    })
    // A tool row keeps its place even with empty text: its identity now lives in
    // `tool` (name / status / args / result), and dropping it would hide the very
    // thing the timeline is built from.
    .filter(function (row) {
      return row.text || row.thinking || row.error || row.tool || row.hostedSearch;
    })
    // Internal model instructions are not chat rows. They carry text, so without
    // this they would render as a stray assistant message.
    .filter(function (row) { return !row.modelSystem; });

  const summary = normalizeSessionSummary(session);

  return {
    session: summary,
    sessionId: summary.id || firstNonEmptyString(session.id, value && value.sessionId),
    title: summary.title || null,
    status: summary.status || null,
    modelKey: summary.modelKey,
    thinkingLevel: summary.thinkingLevel,
    permissionMode: summary.permissionMode,
    supportedThinkingLevels: summary.supportedThinkingLevels,
    supportsReasoning: summary.supportsReasoning,
    messages: messages,
    rawMessageCount: rawMessages.length,
  };
}

/**
 * 悬浮窗自己的对话历史。
 *
 * 快捷对话是本插件跑的，**不是宿主会话**，所以宿主的历史里天然看不到它 ——
 * `session/list` 只列真实会话。插件唯一的持久化出口是 getSettings/setSettings
 * （插件 SDK 里没有文件或专用存储 API），所以存在设置里，并做严格裁剪，
 * 避免把设置对象撑大。
 */
const QUICK_HISTORY_MAX = 12;
const QUICK_HISTORY_MESSAGES = 20;
const QUICK_HISTORY_CHARS = 1000;

let quickHistory = [];

function normalizeQuickHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(function (row) {
      return row && typeof row === "object" && Array.isArray(row.messages);
    })
    .slice(0, QUICK_HISTORY_MAX)
    .map(function (row) {
      return {
        id: typeof row.id === "string" ? row.id : "",
        title: typeof row.title === "string" ? row.title.slice(0, 120) : "未命名对话",
        roleName: typeof row.roleName === "string" ? row.roleName.slice(0, 60) : "",
        at: typeof row.at === "number" ? row.at : 0,
        messages: row.messages
          .filter(function (m) {
            return m && typeof m.text === "string" && m.text;
          })
          .slice(-QUICK_HISTORY_MESSAGES)
          .map(function (m) {
            return {
              role: m.role === "user" ? "user" : "assistant",
              text: m.text.slice(0, QUICK_HISTORY_CHARS),
            };
          }),
      };
    })
    .filter(function (row) {
      return row.id && row.messages.length;
    });
}

async function rememberQuickTurn(input, result) {
  const inp = input && typeof input === "object" ? input : {};
  const conversationId = inp.conversationId || "q-current";
  const text = typeof inp.text === "string" ? inp.text : "";
  const reply = result && result.ok && typeof result.text === "string" ? result.text : "";
  if (!text) return;

  let conv = null;
  for (let i = 0; i < quickHistory.length; i++) {
    if (quickHistory[i].id === conversationId) {
      conv = quickHistory[i];
      break;
    }
  }
  if (!conv) {
    const role = roleById(roleState.roles, inp.roleId);
    conv = {
      id: conversationId,
      title: text.slice(0, 60),
      roleName: role ? role.name : "",
      at: Date.now(),
      messages: [],
    };
    quickHistory.unshift(conv);
  }
  conv.at = Date.now();
  conv.messages.push({ role: "user", text: text.slice(0, QUICK_HISTORY_CHARS) });
  if (reply) {
    conv.messages.push({ role: "assistant", text: reply.slice(0, QUICK_HISTORY_CHARS) });
  }
  conv.messages = conv.messages.slice(-QUICK_HISTORY_MESSAGES);
  quickHistory = quickHistory.slice(0, QUICK_HISTORY_MAX);

  try {
    await host().plugin.setSettings({ quickConversations: quickHistory });
  } catch (err) {
    // History is a convenience; never fail the turn over it.
  }
}

async function listSessions() {
  const result = await desktopInvoke("session/list", []);
  // Quick-chat conversations live only in this plugin, so they are not in
  // `session/list`; the drawer shows both groups. They ride along even when the
  // host call fails — a host hiccup must not silently empty the drawer — but the
  // failure itself is still propagated so callers can report it.
  if (!result.ok) return Object.assign({}, result, { quick: quickHistory });
  return {
    ok: true,
    sessions: normalizeSessionList(result.value),
    quick: quickHistory,
  };
}

/**
 * `session/create` accepts { title, projectPath, mode, providerId, modelId,
 * thinkingLevel }, so a new Agent session can be born already configured — no
 * `dangerous` confirm dialog needed (only `session/configure` needs one).
 */
async function createAgentSession(config) {
  const cfg = config && typeof config === "object" ? config : {};
  const input = {};
  if (cfg.title) input.title = String(cfg.title).slice(0, 120);
  if (cfg.providerId) input.providerId = cfg.providerId;
  if (cfg.modelId) input.modelId = cfg.modelId;
  if (cfg.thinkingLevel) input.thinkingLevel = cfg.thinkingLevel;
  if (cfg.mode) input.mode = cfg.mode;
  // ⚠️ 这一项以前漏了：`session/create` 的 schema 里**有** `projectPath`
  // （mcp-control.ts 的 pi_session_create），而插件的建会话请求从来没带上它。
  // 后果就是用户「选了项目文件夹但没用」—— 新建的会话落在宿主的默认/活动项目下，
  // 悬浮窗里也看不出自己在哪个项目。会话自己的 projectPath 才是决定工作目录的那一条
  // （session-launch.ts 用 `session.projectPath` 定 cwd 与项目指令）。
  if (cfg.projectPath) input.projectPath = String(cfg.projectPath);

  // 新会话的权限模式。`session/create` 的 MCP tool schema 里**没有**这一项，但：
  //   · 控制面只校验 required 字段（assertRequiredFields），stripSecretMaterial 也不做
  //     白名单，所以额外字段能透传到 IPC；
  //   · 宿主 IPC 的 session.create 是把 input 原样交给 host-core 的。
  // 所以先按「直接带上」试一次；万一宿主不认而报错，就退回不带它再建一次 ——
  // 绝不能因为一个未文档化字段让发送失败。是否真的生效由界面读 transcript 校验。
  if (cfg.permissionMode) input.permissionMode = cfg.permissionMode;

  let result = await desktopInvoke("session/create", [input]);
  if (!result.ok && input.permissionMode) {
    const withoutPermission = Object.assign({}, input);
    delete withoutPermission.permissionMode;
    result = await desktopInvoke("session/create", [withoutPermission]);
  }
  if (!result.ok) return result;

  const value = result.value || {};
  const sessionId = firstNonEmptyString(
    value.id,
    value.sessionId,
    value.session && value.session.id,
    value.session && value.session.sessionId,
  );
  if (!sessionId) {
    return {
      ok: false,
      error: "NO_SESSION_ID",
      message: "session/create 返回里找不到会话 id（响应结构与预期不同）",
      raw: value,
    };
  }
  return { ok: true, sessionId: sessionId };
}

/**
 * Change a session's model / thinking level for its next turn.
 *
 * `session/configure` is a `dangerous` operation: the host asks the user in a
 * native dialog every time, and `mode` is required, so we echo the session's
 * current mode back.
 */
async function configureSession(sessionId, config) {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "INVALID_ARGUMENT", message: "缺少 sessionId" };
  const cfg = config && typeof config === "object" ? config : {};

  const body = {};
  if (cfg.mode) body.mode = cfg.mode;
  if (cfg.providerId) body.providerId = cfg.providerId;
  if (cfg.modelId) body.modelId = cfg.modelId;
  if (cfg.thinkingLevel) body.thinkingLevel = cfg.thinkingLevel;
  // 权限模式也走 session/configure（schema 的 enum 是 inherit/ask/accept-edits/auto），
  // 它属于 dangerous，所以下面必须带 confirm。
  if (cfg.permissionMode) body.permissionMode = cfg.permissionMode;
  if (!body.mode) {
    return {
      ok: false,
      error: "INVALID_ARGUMENT",
      message: "session/configure 必须带上会话当前的 mode（会话信息里没有 mode 就改不了）",
    };
  }

  const result = await desktopInvoke("session/configure", [id, body], { confirm: true });
  if (!result.ok) return result;
  return { ok: true, sessionId: id, applied: body };
}

async function readTranscript(sessionId, messageLimit) {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "INVALID_ARGUMENT", message: "缺少 sessionId" };

  const result = await desktopInvoke("session/get", [
    { id: id, messageLimit: clampInt(messageLimit, 1, 200, 30) },
  ]);
  if (!result.ok) return result;
  return { ok: true, transcript: normalizeTranscript(result.value) };
}

/**
 * 当前的工作目录（Agent 模式）。
 *
 * 项目其实有两个来源，顺序不能反：
 *   1. **会话自己绑定的** `projectPath`（`session/get` 的 summary 里就有）——
 *      这才是决定 cwd、项目指令、记忆的那一条；
 *   2. 还没有会话时，用用户在悬浮窗里选的那个（发第一条消息时交给 `session/create`）。
 * 之前界面一个都不显示，用户「选了项目却看不出生效没有」。
 */
async function currentProject(sessionId, pendingPath) {
  const wanted = String(pendingPath || "").trim();
  const id = String(sessionId || "").trim();
  if (id) {
    const result = await desktopInvoke("session/get", [{ id: id, messageLimit: 1 }]);
    if (result.ok) {
      const t = normalizeTranscript(result.value);
      if (t.session && t.session.projectPath) {
        return { ok: true, path: t.session.projectPath, source: "session" };
      }
    }
  }
  if (wanted) return { ok: true, path: wanted, source: "pending" };
  return { ok: true, path: "", source: "none" };
}

/**
 * 把已有会话挪到用户选的项目下。
 *
 * `session/moveProject` 的 spec 是 `["input"]`、风险 `write`（不弹确认框），宿主 IPC 收
 * `{ sessionId, projectPath }`（session-ipc.ts:385）—— 但**只对空闲会话有效**
 * （`MoveSessionProjectResult::Busy`），所以跑着的时候如实说「下一轮再切」，
 * 不要假装已经切了。
 */
async function moveSessionProject(sessionId, projectPath) {
  const id = String(sessionId || "").trim();
  const path = String(projectPath || "").trim();
  if (!id || !path) return { ok: false, error: "INVALID_ARGUMENT", message: "缺少会话或项目路径" };

  const current = await currentProject(id, "");
  if (current.path === path) return { ok: true, sessionId: id, projectPath: path, unchanged: true };

  const result = await desktopInvoke("session/moveProject", [{ sessionId: id, projectPath: path }]);
  if (!result.ok) {
    const busy = /BUSY|running/i.test(String(result.error || "") + " " + String(result.message || ""));
    return {
      ok: false,
      error: result.error || "MOVE_FAILED",
      message: busy
        ? "会话正在跑，项目要等这一轮结束后才能切。"
        : (result.message || "切换项目失败"),
    };
  }
  return { ok: true, sessionId: id, projectPath: path };
}

async function sendAgent(input) {
  const payload = input && typeof input === "object" ? input : {};
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return { ok: false, error: "INVALID_ARGUMENT", message: "空消息" };

  let sessionId = String(payload.sessionId || "").trim();
  let created = false;
  // 用户当前选的项目。会话不存在时交给 session/create；已存在且不一致时就地挪过去。
  const wantedProject = String(payload.projectPath || "").trim();

  if (!sessionId) {
    // Agent mode opens a fresh session per summon, by decision — born with the
    // model and thinking level the user picked in the widget.
    const made = await createAgentSession({
      title: text.slice(0, 60),
      providerId: payload.providerId,
      modelId: payload.modelId,
      thinkingLevel: payload.thinkingLevel,
      // 让新会话直接带上用户在悬浮窗选的权限模式，而不是建好之后再改
      // （那样每次都要弹一次宿主确认框）。
      permissionMode: payload.permissionMode,
      projectPath: wantedProject || undefined,
    });
    if (!made.ok) return made;
    sessionId = made.sessionId;
    created = true;
  } else if (wantedProject) {
    // best-effort：挪不过去（比如会话正在跑）也不能拦住这条消息。
    await moveSessionProject(sessionId, wantedProject);
  }

  const result = await desktopInvoke("agent/prompt", [{ sessionId: sessionId, content: text }]);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      sessionId: sessionId,
      created: created,
    };
  }

  const value = result.value || {};

  // Remember it so "接续上次的会话" can resume across summons. Best-effort:
  // failing to persist must not fail the send.
  if (settings.lastAgentSessionId !== sessionId) {
    settings.lastAgentSessionId = sessionId;
    try {
      await host().plugin.setSettings({ lastAgentSessionId: sessionId });
    } catch (err) {
      // not fatal
    }
  }

  return {
    ok: true,
    sessionId: sessionId,
    created: created,
    accepted: value.accepted !== false,
    turnId: firstNonEmptyString(value.turnId, value.turn && value.turn.id) || null,
  };
}

async function openSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "INVALID_ARGUMENT", message: "缺少 sessionId" };
  const result = await desktopInvoke("session/open", [id]);
  if (!result.ok) return result;
  return { ok: true, sessionId: id };
}

async function agentStatus(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "INVALID_ARGUMENT", message: "缺少 sessionId" };
  const result = await desktopInvoke("agent/getStatus", [id]);
  if (!result.ok) return result;
  const value = result.value || {};
  return {
    ok: true,
    status: firstNonEmptyString(
      typeof value === "string" ? value : "",
      value.status,
      value.state,
      value.agentStatus,
    ) || "unknown",
    raw: value,
  };
}

// ------------------------------------------------------------------ probe
function probe() {
  const api = host();
  return {
    panelLikelyVisible: panelLikelyVisible(),
    panelOpen: panelOpen,
    panelReported: panelReported,
    shortcut: shortcutState,
    appearanceMode: settings.appearance,
    hostAppearance: hostAppearance,
    shortcutOwner: "plugin-process",
    defaultRoleId: settings.defaultRoleId,
    roleCount: roleState.roles.length,
    roleProblems: roleState.problems,
    hasDesktop: hasFn(api && api.desktop, "invoke"),
    hasAgentComplete: hasFn(api && api.agent, "complete"),
    hasModelsList: hasFn(api && api.models, "list"),
    hasSkillRead: hasFn(api && api.skill, "read"),
    hasNetFetch: hasFn(api && api.net, "fetch"),
    defaultModelKey: settings.defaultModelKey || null,
    maxToolRounds: settings.maxToolRounds,
    searchProvider: settings.searchEndpoint ? "custom" : "duckduckgo",
    hasSearchApiKey: !!settings.searchApiKey,
    completionsUsedThisMinute: recentCompletionCount(),
    appDefaultModelKey: appDefaults.modelKey || null,
    thinkingDisplayMode: appDefaults.thinkingDisplayMode,
    quickPhase: quickProgress.phase,
  };
}

// -------------------------------------------------------------- lifecycle
async function onLoad() {
  const api = host();
  if (!api || !api.commands || typeof api.commands.register !== "function") {
    console.log("[summon-chat] host API unavailable on load");
    return;
  }

  await loadSettings();
  // Best-effort: mirrors the main window's model + thinking-display preference.
  await readAppDefaults();
  // And its palette, so the window opens already wearing the app's colours.
  await readHostAppearance();

  await api.commands.register({
    id: "summon.chat.toggle",
    title: "Summon Chat: Toggle Window",
    keywords: ["chat", "summon", "toggle", "对话", "呼出", "切换"],
    run: async () => { await toggleWidget(); },
  });
  await api.commands.register({
    id: "summon.chat.open",
    title: "Summon Chat: Open Window",
    keywords: ["chat", "open", "打开"],
    run: async () => { await openWidget(); },
  });
  await api.commands.register({
    id: "summon.chat.close",
    title: "Summon Chat: Close Window",
    keywords: ["chat", "close", "关闭"],
    run: async () => { await closeWidget(); },
  });
  await api.commands.register({
    id: "summon.chat.status",
    title: "Summon Chat: Status",
    keywords: ["chat", "status", "状态"],
    run: async () => { await shortcutStatus(); },
  });

  await applyShortcut(settings.accelerator);

  try {
    if (api.events && typeof api.events.on === "function") {
      settingsListener = onSettingsChanged;
      api.events.on("plugin:settingsChanged", settingsListener);
      // The host pushes its palette to every loaded plugin process as well as
      // to every open panel, so the cache a later panel reads stays current.
      appearanceListener = function (appearance) {
        hostAppearance = normalizeHostAppearance(appearance);
      };
      api.events.on("appearance:changed", appearanceListener);
    }
  } catch (err) {
    console.log("[summon-chat] could not subscribe to settings changes: " + err.message);
  }

  console.log("[summon-chat] ready: " + JSON.stringify(probe()));
}

async function onUnload() {
  const api = host();
  if (!api) return;

  try {
    if (api.events && typeof api.events.off === "function") {
      if (settingsListener) api.events.off("plugin:settingsChanged", settingsListener);
      if (appearanceListener) api.events.off("appearance:changed", appearanceListener);
    }
  } catch (err) {
    // best-effort
  }
  settingsListener = null;
  appearanceListener = null;

  try {
    if (api.keyboard && typeof api.keyboard.unregisterGlobalShortcut === "function") {
      await api.keyboard.unregisterGlobalShortcut(SHORTCUT_ID);
    }
  } catch (err) {
    // the host also releases shortcuts on unload/disable/crash
  }

  for (let i = 0; i < COMMAND_IDS.length; i++) {
    try {
      await api.commands.unregister(COMMAND_IDS[i]);
    } catch (err) {
      // onUnload is best-effort
    }
  }

  panelOpen = false;
  panelVisible = false;
  panelReported = false;
}

// ---------------------------------------------------------- panel bridge
/**
 * Shared by both surfaces — the floating window and the roles view — so the
 * role editor and the chat window can never disagree about the role list.
 */
async function onPanelInvoke(channel, payload) {
  switch (channel) {
    /**
     * The page's own view of itself.
     *
     * `heartbeat` is now only a liveness ping that carries the page's visibility
     * — it no longer *is* the open/closed state. Minimizing keeps a renderer
     * alive, so a heartbeat alone cannot tell "on screen" from "hidden", and
     * that is precisely the confusion that made the hotkey feel dead.
     */
    case "summon.chat.heartbeat":
    case "summon.chat.visibility": {
      const visible = !(payload && payload.visible === false);
      panelOpen = true;
      panelVisible = visible;
      panelReported = true;
      return { ok: true, panelOpen: panelOpen, panelVisible: panelVisible };
    }

    /**
     * The panel page is going away (`pagehide`, or the explicit report on the
     * way out). Authoritative for the same reason `closeWidget` is: it is sent
     * by the page that is actually being torn down, not inferred from silence.
     */
    case "summon.chat.closed":
      panelOpen = false;
      panelVisible = false;
      panelReported = false;
      return { ok: true };

    case "summon.chat.probe":
      return probe();

    case "summon.chat.bootstrap":
      return {
        ok: true,
        roles: roleState.roles,
        problems: roleState.problems,
        defaultRoleId: settings.defaultRoleId,
        shortcut: shortcutState,
        search: {
          hasCustomEndpoint: !!settings.searchEndpoint,
          hasApiKey: !!settings.searchApiKey,
          provider: settings.searchEndpoint ? "custom" : "duckduckgo",
        },
        modelKey: settings.defaultModelKey,
        maxToolRounds: settings.maxToolRounds,
        agentStartMode: settings.agentStartMode,
        thinkingDisplayMode: appDefaults.thinkingDisplayMode,
        appDefaultModelKey: appDefaults.modelKey || null,
        // Handed to the page instead of it having to know how to ask the host;
        // `appearance:changed` keeps it current from then on.
        hostAppearance: hostAppearance,
        settings: {
          accelerator: settings.accelerator,
          agentStartMode: settings.agentStartMode,
          maxToolRounds: settings.maxToolRounds,
          appearance: settings.appearance,
          fontSize: settings.fontSize,
          opacity: settings.opacity,
          searchEndpoint: settings.searchEndpoint,
          hasApiKey: !!settings.searchApiKey,
        },
        // Only handed back when the user asked to continue; otherwise the
        // window starts blank and the first message creates a session.
        resumeSessionId:
          settings.agentStartMode === "continue" ? settings.lastAgentSessionId || null : null,
        phase: 4,
        version: PLUGIN_VERSION,
      };

    /** The host's current palette, on demand (used before the first event). */
    case "summon.chat.hostAppearance":
      return { ok: true, appearance: await readHostAppearance() };

    case "summon.chat.saveRoles":
      return await saveRoles(payload && payload.roles ? { roles: payload.roles } : payload);

    case "summon.chat.setDefaultRole": {
      const id = payload && typeof payload.id === "string" ? payload.id : "";
      if (!roleById(roleState.roles, id)) {
        return { ok: false, error: "NOT_FOUND", message: "没有这个角色：" + id };
      }
      settings.defaultRoleId = id;
      try {
        await host().plugin.setSettings({ defaultRoleId: id });
      } catch (err) {
        return { ok: false, error: "SETTINGS_WRITE_FAILED", message: String(err && err.message) };
      }
      return { ok: true, defaultRoleId: id };
    }

    case "summon.chat.dismiss":
      return await closeWidget();

    // ---- Agent mode (desktop.control) ------------------------------------
    case "summon.chat.listSessions":
      return await listSessions();

    case "summon.chat.createSession":
      return await createAgentSession(payload && payload.title);

    case "summon.chat.readTranscript":
      return await readTranscript(payload && payload.sessionId, payload && payload.messageLimit);

    case "summon.chat.sendAgent":
      return await sendAgent(payload);

    case "summon.chat.openSession":
      return await openSession(payload && payload.sessionId);

    case "summon.chat.agentStatus":
      return await agentStatus(payload && payload.sessionId);

    case "summon.chat.listOperations": {
      const api = host();
      if (!hasFn(api && api.desktop, "listOperations")) {
        return { ok: false, error: "UNSUPPORTED", message: "宿主没有 pi.desktop.listOperations" };
      }
      try {
        const operations = await api.desktop.listOperations();
        return { ok: true, operations: Array.isArray(operations) ? operations : [] };
      } catch (err) {
        return { ok: false, error: (err && err.code) || "FAILED", message: String(err && err.message) };
      }
    }

    case "summon.chat.sendQuick":
      return await quickChat(payload);

    /**
     * 停止快捷对话的等待。
     *
     * `agent.complete` 的入参里**没有 AbortSignal**（SDK 的 PluginCompleteInput
     * 只有 modelKey/thinkingLevel/system/messages/includeSessionContext），所以
     * 这一次模型调用**无法真正中断**。能做的是放弃这一轮：不再轮询、丢弃结果、
     * 也不记进历史，把界面交还给用户。页面必须如实说明这一点。
     */
    case "summon.chat.cancelQuick": {
      if (!quickProgress.inFlight) {
        return { ok: false, error: "NOT_RUNNING", message: "当前没有进行中的快捷对话。" };
      }
      const cancelledTurn = quickProgress.turnId;
      quickProgress = Object.assign({}, quickProgress, {
        phase: "cancelled",
        detail: "",
        inFlight: false,
        updatedAt: Date.now(),
        result: null,
        error: null,
      });
      return { ok: true, cancelled: true, turnId: cancelledTurn, soft: true };
    }

    /**
     * 中止 Agent 会话当前这一轮。宿主目录里有这个操作（mcp-control.ts:
     * `spec("agentAbort", "agent/abort", "Abort an active Agent turn.", "write", ["request"])`），
     * 风险等级是 write 而不是 dangerous，所以不会弹确认框。
     * 入参形状取自 agent-host-bridge.ts: `[{ sessionId, ...(turnId ? { turnId } : {}) }]`。
     */
    case "summon.chat.abortAgent": {
      const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (!sessionId) {
        return { ok: false, error: "INVALID_ARGUMENT", message: "缺少 sessionId。" };
      }
      const request = { sessionId: sessionId };
      if (payload && typeof payload.turnId === "string" && payload.turnId) {
        request.turnId = payload.turnId;
      }
      return await desktopInvoke("agent/abort", [request]);
    }

    case "summon.chat.listModels": {
      const models = await listModels();
      const appKeyUsable =
        appDefaults.modelKey &&
        models.some(function (m) { return m.key === appDefaults.modelKey; });
      // An explicit choice wins; otherwise follow the main window's model.
      const selected =
        settings.defaultModelKey ||
        (appKeyUsable ? appDefaults.modelKey : "") ||
        (models.length ? models[0].key : "");
      return {
        ok: true,
        models: models,
        selected: selected,
        isExplicit: !!settings.defaultModelKey,
        appDefaultKey: appDefaults.modelKey || null,
        fromAppDefault: !settings.defaultModelKey && !!appKeyUsable && selected === appDefaults.modelKey,
      };
    }

    /**
     * Live phase of the in-flight quick-chat turn.
     *
     * The page polls this every 400ms, so the payload is deliberately lean: the
     * live timeline (`steps`, capped by the search-round limit) is always sent,
     * while the answer itself and the error only travel once the turn is over —
     * re-serializing a whole answer five times a second would be pure waste.
     * `input` never leaves the plugin process.
     */
    case "summon.chat.progress": {
      const p = quickProgress;
      return {
        ok: true,
        progress: {
          turnId: p.turnId,
          phase: p.phase,
          detail: p.detail,
          round: p.round,
          inFlight: p.inFlight,
          startedAt: p.startedAt,
          updatedAt: p.updatedAt,
          steps: p.steps || [],
          result: p.inFlight ? null : p.result,
          error: p.inFlight ? null : p.error,
        },
      };
    }

    case "summon.chat.appDefaults":
      await readAppDefaults();
      return { ok: true, appDefaults: appDefaults };

    /** `session/configure` is `dangerous`: the host asks the user every time. */
    case "summon.chat.configureSession":
      return await configureSession(payload && payload.sessionId, payload && payload.config);

    /** 悬浮窗要显示 / 绑定「当前项目文件夹」时问这两个通道。 */
    case "summon.chat.currentProject":
      return await currentProject(
        payload && payload.sessionId,
        payload && payload.pendingPath,
      );

    case "summon.chat.moveProject":
      return await moveSessionProject(payload && payload.sessionId, payload && payload.path);

    /**
     * 项目文件夹。宿主目录里有整套：
     * `project/list`（read）/ `project/get`（read）/ `project/set`（write, ["path"]）/ `project/clear`（write）。
     * 都不弹确认框。返回形状没有公开契约，所以几种形状都兜住。
     *
     * 注意 `project/set` 改的是**宿主当前活动项目**（主窗口那一个），
     * 不是「悬浮窗这个会话的项目」——所以选完之后页面还要把路径带给 `sendAgent`，
     * 由它交给 `session/create` 或 `session/moveProject` 才算真的绑上。
     */
    case "summon.chat.listProjects": {
      const listed = await desktopInvoke("project/list", []);
      const current = await desktopInvoke("project/get", []);
      return {
        ok: true,
        projects: listed.ok ? normalizeProjects(listed.value) : [],
        currentPath: current.ok ? readProjectPath(current.value) : "",
        error: listed.ok ? null : listed.error || "PROJECT_LIST_FAILED",
      };
    }

    case "summon.chat.setProject": {
      const projectPath = payload && typeof payload.path === "string" ? payload.path.trim() : "";
      // 空路径 = 清除当前项目（project/clear）。
      if (!projectPath) return await desktopInvoke("project/clear", []);
      return await desktopInvoke("project/set", [projectPath]);
    }

    /**
     * 「增强提示词」按钮。宿主目录里有这个操作：
     * `spec("promptEnhance", "prompt/enhance", "Enhance a prompt using the configured model.", "write", ["request"])`
     * 风险等级是 write，所以不弹确认框。
     * request 的形状从 agent-ipc.ts 的处理器读出来是 `{ draft, sessionId? }`
     * （draft 为空、或以 "/" 开头的斜杠命令，宿主会直接报错）。
     * 返回值没有公开契约，所以几种可能都兜住。
     */
    case "summon.chat.enhancePrompt": {
      const draft = payload && typeof payload.draft === "string" ? payload.draft : "";
      if (!draft.trim()) {
        return { ok: false, error: "INVALID_ARGUMENT", message: "先写点内容再增强。" };
      }
      const request = { draft: draft };
      if (payload && typeof payload.sessionId === "string" && payload.sessionId) {
        request.sessionId = payload.sessionId;
      }
      const enhanced = await desktopInvoke("prompt/enhance", [request]);
      if (!enhanced.ok) return enhanced;
      const value = enhanced.value;
      const text =
        typeof value === "string"
          ? value
          : firstNonEmptyString(
              value && value.text,
              value && value.enhanced,
              value && value.draft,
              value && value.prompt,
            );
      if (!text) {
        return { ok: false, error: "EMPTY_ENHANCEMENT", message: "宿主没有返回增强后的提示词。" };
      }
      return { ok: true, text: text };
    }

    /** Backs the in-window settings panel opened by the gear button. */
    case "summon.chat.saveSettings": {
      const body = payload && typeof payload === "object" ? payload : {};
      const patch = {};
      if (typeof body.agentStartMode === "string") {
        patch.agentStartMode = body.agentStartMode === "continue" ? "continue" : "new";
      }
      if (typeof body.maxToolRounds === "number" || typeof body.maxToolRounds === "string") {
        patch.maxToolRounds = clampInt(body.maxToolRounds, 0, 5, DEFAULT_MAX_TOOL_ROUNDS);
      }
      if (typeof body.searchEndpoint === "string") patch.searchEndpoint = body.searchEndpoint.trim();
      if (typeof body.searchApiKey === "string") patch.searchApiKey = body.searchApiKey;
      if (typeof body.appearance === "string") {
        patch.appearance =
          APPEARANCE_MODES.indexOf(body.appearance) !== -1
            ? body.appearance
            : HOST_APPEARANCE_MODE;
      }
      if (body.fontSize !== undefined) patch.fontSize = clampInt(body.fontSize, 12, 20, 13);
      if (body.opacity !== undefined) patch.opacity = clampInt(body.opacity, 50, 100, 100);
      if (typeof body.accelerator === "string" && body.accelerator.trim()) {
        patch.accelerator = body.accelerator.trim();
      }
      if (!Object.keys(patch).length) {
        return { ok: false, error: "INVALID_ARGUMENT", message: "没有可保存的字段" };
      }
      try {
        await host().plugin.setSettings(patch);
      } catch (err) {
        return { ok: false, error: "SETTINGS_WRITE_FAILED", message: String(err && err.message) };
      }
      await loadSettings();
      // The page needs the fallback key it will actually feel, and the palette
      // if it just switched to "follow the app".
      const appearance = await readHostAppearance();
      if (patch.accelerator && patch.accelerator !== shortcutState.requested) {
        await applyShortcut(patch.accelerator);
      }
      return {
        ok: true,
        settings: {
          accelerator: settings.accelerator,
          agentStartMode: settings.agentStartMode,
          maxToolRounds: settings.maxToolRounds,
          appearance: settings.appearance,
          fontSize: settings.fontSize,
          opacity: settings.opacity,
          searchEndpoint: settings.searchEndpoint,
          hasApiKey: !!settings.searchApiKey,
        },
        shortcut: shortcutState,
        hostAppearance: appearance,
      };
    }

    case "summon.chat.setModelKey": {
      const key = payload && typeof payload.key === "string" ? payload.key.trim() : "";
      settings.defaultModelKey = key;
      try {
        await host().plugin.setSettings({ defaultModelKey: key });
      } catch (err) {
        return { ok: false, error: "SETTINGS_WRITE_FAILED", message: String(err && err.message) };
      }
      return { ok: true, defaultModelKey: key };
    }

    /** Lets the UI (and a curious user) exercise search without spending a completion. */
    case "summon.chat.search": {
      const query = payload && typeof payload.query === "string" ? payload.query.trim() : "";
      if (!query) return { ok: false, error: "INVALID_ARGUMENT", message: "空查询" };
      return await webSearch(query);
    }

    default:
      return { ok: false, error: "UNKNOWN_CHANNEL", channel: channel };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
