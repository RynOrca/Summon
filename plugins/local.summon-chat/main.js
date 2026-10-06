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

const HEARTBEAT_TTL_MS = 6000;

/** The host binds a `shortcut` setting in-app too; swallow the double delivery. */
const TOGGLE_DEBOUNCE_MS = 350;

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
const PLUGIN_VERSION = "0.17.0";
/** Keep the wire prompt well inside the host's 200k combined-character cap. */
const MAX_HISTORY_MESSAGES = 20;
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_TIMEOUT_MS = 15000;

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";

/** DDG serves a challenge page to unknown agents, so send a browser-ish one. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * `agent.complete` runs with `tools: []`, so there is no function calling. The
 * tool loop is done by convention instead: the model asks for a search by
 * emitting one JSON line, we run it, and feed the result back as a user turn.
 */
const TOOL_DIRECTIVE = [
  "",
  "## 可用工具",
  "web_search —— 联网搜索。当你需要最新信息、事实核查或你不确定的内容时使用它。",
  "",
  "要使用工具时，**只输出一行 JSON，不要有其他任何文字**：",
  '{"tool":"web_search","query":"搜索关键词"}',
  "",
  "拿到工具结果后，用中文直接给出最终回答，不要再输出 JSON。",
].join("\n");

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
let lastHeartbeatAt = 0;
let lastToggleAt = 0;
let settings = {
  accelerator: DEFAULT_ACCELERATOR,
  defaultRoleId: "quick",
  defaultModelKey: "",
  maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  agentStartMode: "new",
  lastAgentSessionId: "",
  appearance: "system",
  fontSize: 13,
  opacity: 100,
  searchEndpoint: "",
  searchApiKey: "",
};
let roleState = normalizeRoles(null);
let shortcutState = { requested: null, active: null, registered: false, error: null };
let settingsListener = null;
/** Rolling timestamps of `agent.complete` calls, against the host's 8/min budget. */
let completionTimes = [];

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

function panelLikelyVisible() {
  return lastHeartbeatAt > 0 && Date.now() - lastHeartbeatAt < HEARTBEAT_TTL_MS;
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
async function openWidget() {
  const api = host();
  if (!api || !api.ui || typeof api.ui.openPanel !== "function") {
    return { ok: false, error: "OPEN_PANEL_NOT_AVAILABLE" };
  }
  await api.ui.openPanel({ title: "Summon Chat" });
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
      appearance:
        source.appearance === "dark" || source.appearance === "light"
          ? source.appearance
          : "system",
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

/** Map the common JSON shapes of SearXNG / Tavily / Brave / generic APIs. */
function mapCustomResults(data) {
  if (!data || typeof data !== "object") return [];
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

async function customSearch(endpoint, query, apiKey) {
  const api = host();
  if (!hasFn(api && api.net, "fetch")) {
    return { ok: false, error: "UNSUPPORTED", results: [], message: "宿主没有 pi.net.fetch" };
  }

  let url = endpoint;
  try {
    const parsed = new URL(endpoint);
    if (!parsed.searchParams.get("q") && !parsed.searchParams.get("query")) {
      parsed.searchParams.set("q", query);
    }
    if (/searx/i.test(endpoint) && !parsed.searchParams.get("format")) {
      parsed.searchParams.set("format", "json");
    }
    url = parsed.toString();
  } catch (err) {
    return { ok: false, error: "INVALID_ARGUMENT", results: [], message: "搜索端点不是合法 URL" };
  }

  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = "Bearer " + apiKey;

  let response;
  try {
    response = await api.net.fetch({ url: url, method: "GET", headers: headers, timeoutMs: SEARCH_TIMEOUT_MS });
  } catch (err) {
    return {
      ok: false,
      error: (err && err.code) || "FETCH_FAILED",
      results: [],
      message: err && err.message ? err.message : String(err),
    };
  }

  if (!response || response.status !== 200) {
    return { ok: false, error: "HTTP_" + (response && response.status), results: [] };
  }

  let data;
  try {
    data = JSON.parse(response.bodyText || "");
  } catch (err) {
    return { ok: false, error: "INVALID_JSON", results: [], message: "自定义端点没有返回 JSON" };
  }

  const results = mapCustomResults(data);
  if (!results.length) {
    return { ok: false, error: "NO_RESULTS_PARSED", results: [], message: "返回的 JSON 结构不认识" };
  }
  return { ok: true, provider: "custom", results: results };
}

async function duckDuckGoSearch(query) {
  const api = host();
  if (!hasFn(api && api.net, "fetch")) {
    return { ok: false, error: "UNSUPPORTED", results: [], message: "宿主没有 pi.net.fetch" };
  }

  const attempts = [
    { url: DDG_HTML_ENDPOINT + "?q=" + encodeURIComponent(query), parse: parseDdgHtml },
    { url: DDG_LITE_ENDPOINT + "?q=" + encodeURIComponent(query), parse: parseDdgLite },
  ];

  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    let response;
    try {
      response = await api.net.fetch({
        url: attempt.url,
        method: "GET",
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
    } catch (err) {
      lastError = (err && err.code) || "FETCH_FAILED";
      continue;
    }
    if (!response || response.status !== 200) {
      lastError = "HTTP_" + (response && response.status);
      continue;
    }
    const results = attempt.parse(response.bodyText || "").slice(0, SEARCH_RESULT_LIMIT);
    if (results.length) return { ok: true, provider: "duckduckgo", results: results };
    lastError = "NO_RESULTS_PARSED";
  }

  return {
    ok: false,
    error: lastError || "SEARCH_FAILED",
    results: [],
    message: "内置 DuckDuckGo 没解析到结果，可以在插件设置里换成自己的搜索端点。",
  };
}

async function webSearch(query) {
  const endpoint = String(settings.searchEndpoint || "").trim();
  if (endpoint) return await customSearch(endpoint, query, settings.searchApiKey);
  return await duckDuckGoSearch(query);
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
    if (parsed.tool !== "web_search") continue;
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
  if ((role.tools || []).indexOf("web_search") !== -1) parts.push(TOOL_DIRECTIVE);
  return parts.join("\n\n").slice(0, MAX_SYSTEM_CHARS);
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

function setProgress(phase, detail, round) {
  // A cancelled turn keeps running in the background (agent.complete cannot be
  // aborted), and it keeps calling setProgress. Without this guard those ticks
  // would flip `inFlight` back on and the page would start waiting again for a
  // turn the user already stopped.
  if (quickProgress.phase === "cancelled") return;
  // Object.assign, not a fresh literal: turnId/result/error must survive every
  // progress tick or the page would lose the answer it is polling for.
  quickProgress = Object.assign({}, quickProgress, {
    phase: phase,
    detail: detail || "",
    round: typeof round === "number" ? round : quickProgress.round,
    inFlight: true,
    startedAt: quickProgress.startedAt || Date.now(),
    updatedAt: Date.now(),
  });
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
    setProgress("thinking", rounds > 0 ? "正在思考（第 " + (rounds + 1) + " 轮）…" : "正在思考…", rounds);
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

    if (!useTools || rounds >= maxRounds) break;

    const call = extractToolCall(answer);
    if (!call) break;

    rounds++;
    const query = typeof call.query === "string" ? call.query.trim() : "";
    if (!query) break;

    setProgress("searching", "正在搜索「" + query.slice(0, 40) + "」…", rounds);
    const search = await webSearch(query);
    trace.push({
      round: rounds,
      tool: "web_search",
      query: query,
      ok: search.ok,
      provider: search.provider || null,
      count: search.results ? search.results.length : 0,
      error: search.ok ? null : search.error || "SEARCH_FAILED",
      results: search.results ? search.results : [],
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
    .filter(function (row) { return row.text || row.thinking || row.error; });

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

async function sendAgent(input) {
  const payload = input && typeof input === "object" ? input : {};
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return { ok: false, error: "INVALID_ARGUMENT", message: "空消息" };

  let sessionId = String(payload.sessionId || "").trim();
  let created = false;

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
    });
    if (!made.ok) return made;
    sessionId = made.sessionId;
    created = true;
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
    msSinceHeartbeat: lastHeartbeatAt ? Date.now() - lastHeartbeatAt : null,
    shortcut: shortcutState,
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
    // the host also releases shortcuts on unload/disable/crash
  }

  for (let i = 0; i < COMMAND_IDS.length; i++) {
    try {
      await api.commands.unregister(COMMAND_IDS[i]);
    } catch (err) {
      // onUnload is best-effort
    }
  }

  lastHeartbeatAt = 0;
}

// ---------------------------------------------------------- panel bridge
/**
 * Shared by both surfaces — the floating window and the roles view — so the
 * role editor and the chat window can never disagree about the role list.
 */
async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "summon.chat.heartbeat":
      lastHeartbeatAt = Date.now();
      return { ok: true };

    case "summon.chat.closed":
      lastHeartbeatAt = 0;
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

    /** Live phase of the in-flight quick-chat turn, for the "正在思考" indicator. */
    case "summon.chat.progress":
      return { ok: true, progress: quickProgress };

    case "summon.chat.appDefaults":
      await readAppDefaults();
      return { ok: true, appDefaults: appDefaults };

    /** `session/configure` is `dangerous`: the host asks the user every time. */
    case "summon.chat.configureSession":
      return await configureSession(payload && payload.sessionId, payload && payload.config);

    /**
     * 项目文件夹。宿主目录里有整套：
     * `project/list`（read）/ `project/get`（read）/ `project/set`（write, ["path"]）/ `project/clear`（write）。
     * 都不弹确认框。返回形状没有公开契约，所以几种形状都兜住。
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
          body.appearance === "dark" || body.appearance === "light" ? body.appearance : "system";
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
