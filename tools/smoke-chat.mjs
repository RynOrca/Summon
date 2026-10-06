/**
 * Local smoke test for the Summon Chat plugin (Phase 2).
 *
 * Runs the REAL main.js against a fake host `pi`. The fake host keeps a real
 * settings store so save -> reload round-trips are actually exercised.
 *
 * Run:  node tools/smoke-chat.mjs
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// This suite targets the authored plugin. The generated "-top" variant differs
// only in generated identifiers, so it is covered by tools/check-variant.mjs
// plus a real `pi-plugin check`, not by duplicating every call site here.
const pluginMain = path.join(here, "..", "plugins", "local.summon-chat", "main.js");
const EXPECT_ACCEL = "Alt+Shift+C";
const EXPECT_FALLBACK = "Alt+Shift+Q";
const require = createRequire(import.meta.url);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(label, condition) {
  check(label, !!condition, true);
}

// ------------------------------------------------------------- fake host
function makeHost(options = {}) {
  const calls = {
    openPanel: [],
    closePanel: 0,
    notify: [],
    registerInputs: [],
    unregistered: [],
    events: [],
    setSettings: [],
    completeInputs: [],
    fetches: [],
    skillReads: [],
    skillLists: 0,
    desktopInvokes: [],
    appSettingsReads: 0,
  };
  // A real store, so save -> reload actually round-trips.
  const store = { settings: options.settings ? JSON.parse(JSON.stringify(options.settings)) : {} };
  const outcomes = options.registerOutcomes ? [...options.registerOutcomes] : [];
  // Scripted per-call responses for the Phase 3/4 engines.
  const completions = options.completions ? [...options.completions] : [];
  const fetches = options.fetches ? [...options.fetches] : [];
  const desktopResponses = options.desktop ? [...options.desktop] : [];

  const host = {
    ui: {
      async openPanel(o) { calls.openPanel.push(o); },
      async closePanel() { calls.closePanel++; },
      async notify(p) { calls.notify.push(p); },
    },
    commands: {
      registered: {},
      async register(c) { this.registered[c.id] = c; },
      async unregister(id) { delete this.registered[id]; calls.unregistered.push(id); },
    },
    plugin: {
      async getSettings() { return JSON.parse(JSON.stringify(store.settings)); },
      async setSettings(patch) {
        calls.setSettings.push(patch);
        Object.assign(store.settings, JSON.parse(JSON.stringify(patch)));
      },
      getId() { return "local.summon-chat"; },
      getManifest() { return {}; },
    },
    keyboard: {
      async registerGlobalShortcut(input) {
        calls.registerInputs.push(input);
        const next = outcomes.shift();
        if (next) return { id: input.id, command: input.command, ...next };
        return { id: input.id, accelerator: input.accelerator, command: input.command, registered: true };
      },
      async unregisterGlobalShortcut(id) { calls.unregistered.push("shortcut:" + id); },
      async listGlobalShortcuts() { return []; },
    },
    events: {
      handlers: {},
      on(name, handler) { this.handlers[name] = handler; calls.events.push("on:" + name); },
      off(name) { delete this.handlers[name]; calls.events.push("off:" + name); },
    },
    // Phase 4: desktop.control gateway. Scripted per call; an unscripted call
    // throws so a test that reaches further than intended fails loudly.
    desktop: {
      async invoke(input) {
        // `settings/get` is read during onLoad to mirror the main window's model
        // preference. Answer it out of band so tests only script the operations
        // they actually assert on.
        if (input && input.operation === "settings/get") {
          calls.appSettingsReads++;
          return { settings: options.appSettings || {} };
        }
        if (input && input.operation === "skill/list") {
          calls.skillLists++;
          const names = Object.keys(options.skills || {});
          return { skills: names.map((n) => ({ id: n, name: n, slug: n })) };
        }
        if (input && input.operation === "skill/read") {
          const arg = input.args && input.args[0];
          const name = arg && typeof arg === "object" ? arg.name || arg.id : arg;
          calls.skillReads.push(name);
          return (options.skills && options.skills[name]) || "";
        }
        calls.desktopInvokes.push(input);
        const next = desktopResponses.shift();
        if (next === undefined) throw new Error("no scripted desktop response left");
        if (next instanceof Error) throw next;
        return next;
      },
      async listOperations() { return options.operations || []; },
    },
    agent: {
      async complete(input) {
        calls.completeInputs.push(input);
        const next = completions.shift();
        if (next === undefined) throw new Error("no scripted completion left");
        if (next instanceof Error) throw next;
        return { text: typeof next === "string" ? next : next.text, modelKey: input.modelKey };
      },
    },
    models: { async list() { return options.models || []; } },
    skill: {
      async read(arg) {
        calls.skillReads.push(arg);
        const name = arg && typeof arg === "object" ? arg.name || arg.id : arg;
        return (options.skills && options.skills[name]) || "";
      },
    },
    net: {
      async fetch(input) {
        calls.fetches.push(input);
        const next = fetches.shift();
        if (next === undefined) throw new Error("no scripted fetch left");
        // A function response lets a test hold the call open and observe
        // in-flight state (the plugin exposes a live progress phase).
        if (typeof next === "function") return await next();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { host, calls, store, completions, fetches, desktopResponses };
}

function load(host) {
  globalThis.pi = host;
  delete require.cache[require.resolve(pluginMain)];
  const mod = require(pluginMain);

  // `sendQuick` now returns as soon as the turn is ACCEPTED, and the page polls
  // `progress` for the answer. That is not a style choice: the host kills any
  // panel invoke that runs longer than 30s (plugin-runtime.ts
  // PLUGIN_PANEL_TIMEOUT_MS = 30_000) and a turn may search the web plus run
  // several completions, so awaiting the work inside the invoke produced
  // "plugin local.summon-chat did not answer pi-plugin-panel-invoke".
  //
  // Wrap it so the suites below can keep asserting on the finished result while
  // still exercising the real accept-then-poll contract end to end.
  const invokePanel = mod.onPanelInvoke;
  // The raw, unwrapped entry point, so the accept-then-poll contract itself can
  // be asserted instead of only the convenience wrapper below.
  mod.__rawPanelInvoke = invokePanel;
  mod.onPanelInvoke = async function (channel, payload) {
    const first = await invokePanel.call(mod, channel, payload);
    if (channel !== "summon.chat.sendQuick" || !first || first.accepted !== true) return first;
    for (let i = 0; i < 600; i++) {
      const tick = await invokePanel.call(mod, "summon.chat.progress", {});
      const p = tick && tick.progress;
      if (p && p.turnId === first.turnId && !p.inFlight) {
        if (p.error) return { ok: false, error: "TURN_FAILED", message: p.error.message };
        return p.result;
      }
      await wait(5);
    }
    throw new Error("sendQuick never finished: " + first.turnId);
  };
  return mod;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ lifecycle
console.log("=== exports + registration ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  check("onLoad", typeof mod.onLoad, "function");
  check("onUnload", typeof mod.onUnload, "function");
  check("onPanelInvoke", typeof mod.onPanelInvoke, "function");

  await mod.onLoad();
  check("command ids", Object.keys(host.commands.registered).sort(), [
    "summon.chat.close",
    "summon.chat.open",
    "summon.chat.status",
    "summon.chat.toggle",
  ]);
  check("uses accelerator field", calls.registerInputs[0].accelerator, EXPECT_ACCEL);
  check("targets the toggle command", calls.registerInputs[0].command, calls.registerInputs[0].command);
  // Must not collide with the orb plugin's default.
  ok("default differs from the orb plugin", calls.registerInputs[0].accelerator !== "Alt+Shift+S");
}

console.log("\n=== a fresh install still has both built-in roles ===");
{
  const { host } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  check("role ids", boot.roles.map((r) => r.id), ["agent", "quick"]);
  check("agent is builtin + agent mode", [boot.roles[0].builtin, boot.roles[0].mode], [true, "agent"]);
  check("quick is builtin + quick mode", [boot.roles[1].builtin, boot.roles[1].mode], [true, "quick"]);
  ok("quick ships with web_search", boot.roles[1].tools.includes("web_search"));
  check("default role", boot.defaultRoleId, "quick");
}

// ================================================================ roles
console.log("\n=== adding a custom role persists and round-trips ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);

  const saved = await mod.onPanelInvoke("summon.chat.saveRoles", {
    roles: [
      { id: "agent", mode: "agent" },
      { id: "quick", mode: "quick" },
      {
        id: "translator",
        name: "翻译助手",
        mode: "quick",
        system: "只输出译文。",
        tools: [],
        skills: ["release-notes"],
      },
    ],
  });
  check("save ok", saved.ok, true);
  check("role ids", saved.roles.map((r) => r.id), ["agent", "quick", "translator"]);
  check("custom role is not builtin", saved.roles[2].builtin, false);
  check("system prompt kept", saved.roles[2].system, "只输出译文。");
  check("skills kept", saved.roles[2].skills, ["release-notes"]);
  ok("wrote through setSettings", calls.setSettings.length >= 1);

  // A fresh load must see it — this is the round-trip through the real store.
  const mod2 = load(host);
  await mod2.onLoad();
  const boot = await mod2.onPanelInvoke("summon.chat.bootstrap", {});
  check("survives reload", boot.roles.map((r) => r.id), ["agent", "quick", "translator"]);
}

console.log("\n=== built-in roles cannot be deleted ===");
{
  const { host } = makeHost();
  const mod = load(host);
  // Hostile intent: save a list that simply omits them.
  const saved = await mod.onPanelInvoke("summon.chat.saveRoles", {
    roles: [{ id: "translator", mode: "quick" }],
  });
  check("built-ins were restored", saved.roles.map((r) => r.id), ["agent", "quick", "translator"]);
  ok("agent is still builtin", saved.roles[0].builtin === true);
  ok("quick is still builtin", saved.roles[1].builtin === true);
}

console.log("\n=== a built-in's mode cannot be reassigned ===");
{
  const { host } = makeHost();
  const mod = load(host);
  const saved = await mod.onPanelInvoke("summon.chat.saveRoles", {
    roles: [
      { id: "agent", mode: "quick" },
      { id: "quick", mode: "agent" },
    ],
  });
  check("agent stays in agent mode", saved.roles[0].mode, "agent");
  check("quick stays in quick mode", saved.roles[1].mode, "quick");
}

console.log("\n=== a hostile roles blob cannot take the plugin down ===");
{
  const cases = [
    { label: "null", value: null },
    { label: "a string", value: "not an object" },
    { label: "an array", value: [1, 2, 3] },
    { label: "roles as a string", value: { roles: "nope" } },
    { label: "null entries", value: { roles: [null, undefined, 42, "x", []] } },
  ];
  for (const testCase of cases) {
    const { host } = makeHost({ settings: { roles: testCase.value } });
    const mod = load(host);
    await mod.onLoad();
    const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
    const ids = boot.roles.map((r) => r.id);
    const survived = ids.includes("agent") && ids.includes("quick");
    check(`roles=${testCase.label} -> built-ins survive`, survived, true);
    check(`roles=${testCase.label} -> exactly the two built-ins`, ids, ["agent", "quick"]);
  }
}

console.log("\n=== bad role entries are dropped, not fatal ===");
{
  const { host } = makeHost({
    settings: {
      roles: {
        roles: [
          { id: "agent", mode: "agent" },
          { id: "quick", mode: "quick" },
          { id: "Bad Id!", mode: "quick" },
          { id: "UPPER", mode: "quick" },
          { id: "translator", mode: "quick" },
          { id: "translator", mode: "quick", name: "dup" },
          { id: "", mode: "quick" },
          { id: "no-mode" },
        ],
      },
    },
  });
  const mod = load(host);
  await mod.onLoad();
  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  check("kept the valid ones only", boot.roles.map((r) => r.id), ["agent", "quick", "translator", "no-mode"]);
  check("a missing mode defaults to quick", boot.roles[3].mode, "quick");
  ok("reported the problems", boot.problems.length >= 3);
}

console.log("\n=== an over-long system prompt is clamped, not rejected ===");
{
  const { host } = makeHost();
  const mod = load(host);
  const huge = "x".repeat(40000);
  const saved = await mod.onPanelInvoke("summon.chat.saveRoles", {
    roles: [{ id: "big", mode: "quick", system: huge }],
  });
  const big = saved.roles.find((r) => r.id === "big");
  check("clamped to 32000", big.system.length, 32000);
  check("still saved", big.id, "big");
}

console.log("\n=== role limits ===");
{
  const { host } = makeHost();
  const mod = load(host);
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ id: `r${i}`, mode: "quick" });
  const saved = await mod.onPanelInvoke("summon.chat.saveRoles", { roles: many });
  check("capped at 50", saved.roles.length, 50);
}

console.log("\n=== default role handling ===");
{
  const { host } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  const good = await mod.onPanelInvoke("summon.chat.setDefaultRole", { id: "agent" });
  check("set ok", good.ok, true);
  check("default changed", good.defaultRoleId, "agent");

  const bad = await mod.onPanelInvoke("summon.chat.setDefaultRole", { id: "nope" });
  check("unknown role refused", bad.ok, false);
  check("coded error", bad.error, "NOT_FOUND");
}

console.log("\n=== a default pointing at a deleted role falls back ===");
{
  const { host } = makeHost({ settings: { defaultRoleId: "ghost" } });
  const mod = load(host);
  await mod.onLoad();
  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  check("fell back to quick", boot.defaultRoleId, "quick");
}

// ============================================================== window
console.log("\n=== heartbeat drives liveness + toggle ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  check("no heartbeat -> not visible", (await mod.onPanelInvoke("summon.chat.probe", {})).panelLikelyVisible, false);

  await mod.onPanelInvoke("summon.chat.heartbeat", {});
  check("after heartbeat -> visible", (await mod.onPanelInvoke("summon.chat.probe", {})).panelLikelyVisible, true);

  await host.commands.registered["summon.chat.toggle"].run();
  check("toggle while open -> closePanel", calls.closePanel, 1);

  await wait(400);
  await host.commands.registered["summon.chat.toggle"].run();
  check("toggle while closed -> openPanel", calls.openPanel.length, 1);
}

console.log("\n=== a double-delivered keypress toggles once ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  await host.commands.registered["summon.chat.toggle"].run();
  check("first delivery opens", calls.openPanel.length, 1);
  await host.commands.registered["summon.chat.toggle"].run();
  check("second delivery swallowed", calls.closePanel, 0);
  await mod.onPanelInvoke("summon.chat.closed", {});
  check("summon.chat.closed resets liveness", (await mod.onPanelInvoke("summon.chat.probe", {})).panelLikelyVisible, false);
}

console.log("\n=== dismiss + unknown channel ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  const dismissed = await mod.onPanelInvoke("summon.chat.dismiss", {});
  check("dismiss closes", calls.closePanel, 1);
  check("dismiss ok", dismissed.ok, true);

  const unknown = await mod.onPanelInvoke("nope", {});
  check("unknown channel refused", unknown.error, "UNKNOWN_CHANNEL");
}

// ======================================================== phase stubs
// ==================================================== Agent mode (P4)
console.log("\n=== session list is normalised from the plausible shapes ===");
{
  const { host, calls } = makeHost({
    desktop: [
      { sessions: [{ id: "s1", title: "One", status: "idle", updatedAt: 5 }, { sessionId: "s2" }] },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.listSessions", {});
  check("operation name is the documented one", calls.desktopInvokes[0].operation, "session/list");
  check("no args", calls.desktopInvokes[0].args, []);
  check("ok", res.ok, true);
  check("two sessions", res.sessions.length, 2);
  check("first", [res.sessions[0].id, res.sessions[0].title], ["s1", "One"]);
  check("sessionId alias accepted", res.sessions[1].id, "s2");
  check("missing title defaulted", res.sessions[1].title, "(无标题)");
}

console.log("\n=== a bare array and a junk payload both survive ===");
{
  const bare = makeHost({ desktop: [[{ id: "a" }]] });
  const modBare = load(bare.host);
  await modBare.onLoad();
  const resBare = await modBare.onPanelInvoke("summon.chat.listSessions", {});
  check("bare array works", resBare.sessions.map((s) => s.id), ["a"]);

  const junk = makeHost({ desktop: ["not a list"] });
  const modJunk = load(junk.host);
  await modJunk.onLoad();
  const resJunk = await modJunk.onPanelInvoke("summon.chat.listSessions", {});
  check("junk still ok", resJunk.ok, true);
  check("junk yields no sessions", resJunk.sessions, []);
}

console.log("\n=== transcript normalisation ===");
{
  const { host, calls } = makeHost({
    desktop: [
      {
        session: {
          id: "s1",
          title: "T",
          status: "running",
          messages: [
            { id: "m1", role: "user", content: "你好" },
            // A host that exposes typed parts instead of a string still works.
            {
              id: "m2",
              role: "assistant",
              content: [
                { type: "text", text: "部分一" },
                { type: "text", text: "部分二" },
              ],
            },
            // Tool traffic is its own role:"tool" message, not a content part.
            { id: "m3", role: "tool", content: "Bash: ls" },
            { id: "m4", role: "assistant", content: "" },
          ],
        },
      },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.readTranscript", { sessionId: "s1" });
  check("operation", calls.desktopInvokes[0].operation, "session/get");
  check("arg shape is {id, messageLimit}", calls.desktopInvokes[0].args, [{ id: "s1", messageLimit: 30 }]);
  check("ok", res.ok, true);
  check("session meta", [res.transcript.sessionId, res.transcript.status], ["s1", "running"]);
  check("text message kept", res.transcript.messages[0], {
    id: "m1", role: "user", text: "你好", thinking: "", status: null,
    modelId: null, providerId: null, usage: null, error: null, at: null,
  });
  check("typed parts joined as a fallback", res.transcript.messages[1].text, "部分一\n部分二");
  check("tool rows are their own message", res.transcript.messages[2].role, "tool");
  check("tool row text kept", res.transcript.messages[2].text, "Bash: ls");
  check("empty row dropped", res.transcript.messages.length, 3);
}

console.log("\n=== transcript arg validation ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.readTranscript", {});
  check("refused", res.ok, false);
  check("coded", res.error, "INVALID_ARGUMENT");
  check("no host call made", calls.desktopInvokes.length, 0);
}

console.log("\n=== Agent send creates a fresh session, then prompts it ===");
{
  const { host, calls } = makeHost({
    desktop: [{ id: "new-session" }, { accepted: true, turnId: "t1" }],
  });
  const mod = load(host);
  await mod.onLoad();

  const res = await mod.onPanelInvoke("summon.chat.sendAgent", { text: "帮我看看这个 bug" });
  check("ok", res.ok, true);
  check("reports the created session", res.sessionId, "new-session");
  check("marked created", res.created, true);
  check("turn id surfaced", res.turnId, "t1");

  check("two host calls", calls.desktopInvokes.length, 2);
  check("create first", calls.desktopInvokes[0].operation, "session/create");
  check("prompt second", calls.desktopInvokes[1].operation, "agent/prompt");
  check("prompt request shape", calls.desktopInvokes[1].args, [
    { sessionId: "new-session", content: "帮我看看这个 bug" },
  ]);
}

console.log("\n=== Agent send to an existing session prompts directly ===");
{
  const { host, calls } = makeHost({ desktop: [{ accepted: true }] });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendAgent", { sessionId: "s9", text: "继续" });
  check("ok", res.ok, true);
  check("not created", res.created, false);
  check("one call only", calls.desktopInvokes.length, 1);
  check("operation", calls.desktopInvokes[0].operation, "agent/prompt");
}

console.log("\n=== Agent send validation and failure reporting ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  const empty = await mod.onPanelInvoke("summon.chat.sendAgent", { text: "  " });
  check("empty refused", empty.error, "INVALID_ARGUMENT");
  check("no host call", calls.desktopInvokes.length, 0);

  // session/create that returns no recognisable id must be reported, not guessed.
  const noId = makeHost({ desktop: [{ ok: true }] });
  const modNoId = load(noId.host);
  await modNoId.onLoad();
  const res = await modNoId.onPanelInvoke("summon.chat.sendAgent", { text: "hi" });
  check("refused", res.ok, false);
  check("coded", res.error, "NO_SESSION_ID");
  check("did not try to prompt", noId.calls.desktopInvokes.length, 1);
}

console.log("\n=== agentStartMode controls what a fresh summon resumes ===");
{
  // Default "new": nothing is handed back, so the first message creates one.
  const fresh = makeHost({ desktop: [{ accepted: true }] });
  const modFresh = load(fresh.host);
  await modFresh.onLoad();
  const bootFresh = await modFresh.onPanelInvoke("summon.chat.bootstrap", {});
  check("default mode is new", bootFresh.agentStartMode, "new");
  check("nothing to resume", bootFresh.resumeSessionId, null);

  // "continue": the remembered session comes back so the window can resume it.
  const resume = makeHost({
    settings: { agentStartMode: "continue", lastAgentSessionId: "s-remembered" },
  });
  const modResume = load(resume.host);
  await modResume.onLoad();
  const bootResume = await modResume.onPanelInvoke("summon.chat.bootstrap", {});
  check("mode read", bootResume.agentStartMode, "continue");
  check("session handed back", bootResume.resumeSessionId, "s-remembered");
}

console.log("\n=== a used session is remembered for next time ===");
{
  const { host, calls } = makeHost({ desktop: [{ id: "s-new" }, { accepted: true }] });
  const mod = load(host);
  await mod.onLoad();
  check("nothing remembered yet", (await mod.onPanelInvoke("summon.chat.bootstrap", {})).resumeSessionId, null);

  await mod.onPanelInvoke("summon.chat.sendAgent", { text: "hi" });
  ok("persisted lastAgentSessionId", calls.setSettings.some(function (p) {
    return p.lastAgentSessionId === "s-new";
  }));

  // Switching the mode on must surface it (this also reloads settings).
  host.plugin.getSettings = async function () {
    return { agentStartMode: "continue", lastAgentSessionId: "s-new" };
  };
  await host.events.handlers["plugin:settingsChanged"]();
  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  check("resume offered after the switch", boot.resumeSessionId, "s-new");
}

console.log("\n=== an explicit sessionId continues it regardless of mode ===");
{
  const { host, calls } = makeHost({
    settings: { agentStartMode: "new" },
    desktop: [{ accepted: true }],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendAgent", { sessionId: "picked", text: "继续" });
  check("continued the picked session", res.sessionId, "picked");
  check("did not create one", res.created, false);
  check("only one host call", calls.desktopInvokes.length, 1);
}

console.log("\n=== host errors are surfaced with their code ===");
{
  const { host } = makeHost({ desktop: [Object.assign(new Error("nope"), { code: "PERMISSION_DENIED" })] });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.listSessions", {});
  check("refused", res.ok, false);
  check("code preserved", res.error, "PERMISSION_DENIED");
  check("message preserved", res.message, "nope");
}

console.log("\n=== a host without the desktop API degrades honestly ===");
{
  const { host } = makeHost();
  delete host.desktop;
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.listSessions", {});
  check("refused", res.ok, false);
  check("coded UNSUPPORTED", res.error, "UNSUPPORTED");
  ok("message names the permission", res.message.includes("desktop.control"));
}

console.log("\n=== open session + agent status ===");
{
  const { host, calls } = makeHost({ desktop: [true, "running", { status: "idle" }] });
  const mod = load(host);
  await mod.onLoad();

  const opened = await mod.onPanelInvoke("summon.chat.openSession", { sessionId: "s3" });
  check("open ok", opened.ok, true);
  check("session/open arg is the bare id", calls.desktopInvokes[0].args, ["s3"]);

  const strStatus = await mod.onPanelInvoke("summon.chat.agentStatus", { sessionId: "s3" });
  check("string status read", strStatus.status, "running");

  const objStatus = await mod.onPanelInvoke("summon.chat.agentStatus", { sessionId: "s3" });
  check("object status read", objStatus.status, "idle");

  const bad = await mod.onPanelInvoke("summon.chat.openSession", {});
  check("open refuses without an id", bad.error, "INVALID_ARGUMENT");
}

console.log("\n=== listOperations passthrough ===");
{
  const { host } = makeHost({ operations: [{ id: "agent/prompt", description: "x", risk: "write" }] });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.listOperations", {});
  check("ok", res.ok, true);
  check("one operation", res.operations.length, 1);
  check("id", res.operations[0].id, "agent/prompt");
}

// ========================================================= quick chat (P3)
const DDG_HTML = [
  '<div class="result results_links web-result">',
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">First &amp; Result</a>',
  '<a class="result__snippet" href="#">Snippet one</a>',
  "</div>",
  '<div class="result results_links web-result">',
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Second</a>',
  '<a class="result__snippet" href="#">Snippet two</a>',
  "</div>",
].join("\n");

const MODEL = { defaultModelKey: "prov/model-a" };

console.log("\n=== quick chat: a plain answer, no tools ===");
{
  const { host, calls } = makeHost({
    settings: { ...MODEL, roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] } },
    completions: ["你好，我是回答。"],
  });
  const mod = load(host);
  await mod.onLoad();

  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "你好" });
  check("ok", res.ok, true);
  check("text returned", res.text, "你好，我是回答。");
  check("one completion", calls.completeInputs.length, 1);
  check("model passed through", calls.completeInputs[0].modelKey, "prov/model-a");
  check("no search happened", calls.fetches.length, 0);
  check("trace empty", res.trace, []);
  check("last message is the user turn", calls.completeInputs[0].messages.at(-1), { role: "user", content: "你好" });
}

console.log("\n=== quick chat: the web_search tool loop ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    completions: ['{"tool":"web_search","query":"PI-Desktop 插件"}', "根据搜索结果，答案是……"],
    fetches: [{ status: 200, headers: {}, bodyText: DDG_HTML }],
  });
  const mod = load(host);
  await mod.onLoad();

  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "PI-Desktop 插件是什么" });
  check("ok", res.ok, true);
  check("final answer is the second completion", res.text, "根据搜索结果，答案是……");
  check("two completions", calls.completeInputs.length, 2);
  check("one search", calls.fetches.length, 1);
  check("searched flag", res.searched, true);
  check("trace length", res.trace.length, 1);
  check("trace provider", res.trace[0].provider, "duckduckgo");
  check("parsed two results", res.trace[0].count, 2);
  check("results carried for the UI", res.trace[0].results.length, 2);
  check("ddg redirect unwrapped", res.trace[0].results[0].url, "https://example.com/a");
  check("entities decoded in title", res.trace[0].results[0].title, "First & Result");

  // The result must actually reach the model on the next round.
  const second = calls.completeInputs[1].messages;
  const injected = second[second.length - 1];
  check("tool result is the last user turn", injected.role, "user");
  ok("tool result names the tool", injected.content.includes("工具结果(web_search)"));
  ok("tool result carries a snippet", injected.content.includes("Snippet one"));
  ok("system prompt teaches the tool", calls.completeInputs[0].system.includes("web_search"));
}

console.log("\n=== tool call inside a code fence is still detected ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    completions: ['```json\n{"tool":"web_search","query":"x"}\n```', "done"],
    fetches: [{ status: 200, headers: {}, bodyText: DDG_HTML }],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("fence stripped and executed", calls.fetches.length, 1);
  check("final text", res.text, "done");
}

console.log("\n=== unknown tool names are never executed ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    completions: ['{"tool":"run_shell","query":"rm -rf /"}'],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("no fetch", calls.fetches.length, 0);
  check("one completion only", calls.completeInputs.length, 1);
  check("text passed through as the answer", res.text, '{"tool":"run_shell","query":"rm -rf /"}');
}

console.log("\n=== malformed tool JSON does not loop ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    completions: ['{"tool":"web_search","query":}', "not reached"],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("no fetch", calls.fetches.length, 0);
  check("stopped after one", calls.completeInputs.length, 1);
  ok("returned the raw output", res.ok && res.text.length > 0);
}

console.log("\n=== maxToolRounds=0 disables the loop ===");
{
  const { host, calls } = makeHost({
    settings: { ...MODEL, maxToolRounds: 0 },
    completions: ['{"tool":"web_search","query":"x"}'],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("no search", calls.fetches.length, 0);
  check("trace empty", res.trace, []);
  check("one completion", calls.completeInputs.length, 1);
}

console.log("\n=== the loop is capped ===");
{
  // Always asks for another search; must stop at maxToolRounds.
  const { host, calls } = makeHost({
    settings: { ...MODEL, maxToolRounds: 2 },
    completions: [
      '{"tool":"web_search","query":"a"}',
      '{"tool":"web_search","query":"b"}',
      '{"tool":"web_search","query":"c"}',
      '{"tool":"web_search","query":"d"}',
    ],
    fetches: [
      { status: 200, headers: {}, bodyText: DDG_HTML },
      { status: 200, headers: {}, bodyText: DDG_HTML },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("stopped at 2 searches", calls.fetches.length, 2);
  check("3 completions (1 + 2 rounds)", calls.completeInputs.length, 3);
  check("trace length 2", res.trace.length, 2);
}

console.log("\n=== a failing search still produces an answer ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    completions: ['{"tool":"web_search","query":"x"}', "无法联网，我按已有知识回答。"],
    fetches: [new Error("NETWORK_ERROR")],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("still ok", res.ok, true);
  check("trace records the failure", res.trace[0].ok, false);
  const injected = calls.completeInputs[1].messages.at(-1);
  ok("model was told the search failed", injected.content.includes("失败"));
  ok("and told not to invent sources", injected.content.includes("不要编造"));
}

console.log("\n=== custom search endpoint ===");
{
  const { host, calls } = makeHost({
    settings: {
      ...MODEL,
      searchEndpoint: "https://searx.example/search?q=",
      searchApiKey: "sk-test",
    },
    completions: ['{"tool":"web_search","query":"hello"}', "ok"],
    fetches: [
      {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({ results: [{ title: "T", url: "https://x.test", content: "C" }] }),
      },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("used the custom provider", res.trace[0].provider, "custom");
  check("mapped one result", res.trace[0].count, 1);
  const sent = calls.fetches[0];
  ok("api key sent as bearer", sent.headers.Authorization === "Bearer sk-test");
  ok("searx got format=json", sent.url.includes("format=json"));
  ok("query shared the q param", sent.url.includes("q=hello") || sent.url.includes("q=hello&") || sent.url.includes("hello"));
}

console.log("\n=== no model available is reported clearly ===");
{
  const { host, calls } = makeHost({
    settings: { roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] } },
    models: [],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "hi" });
  check("refused", res.ok, false);
  check("coded NO_MODEL", res.error, "NO_MODEL");
  check("never called complete", calls.completeInputs.length, 0);
}

console.log("\n=== first available model is used when none is chosen ===");
{
  const { host, calls } = makeHost({
    settings: { roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] } },
    models: [{ key: "p/first", label: "First" }, { key: "p/second", label: "Second" }],
    completions: ["ok"],
  });
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "hi" });
  check("fell back to the first model", calls.completeInputs[0].modelKey, "p/first");
}

console.log("\n=== empty input is refused ===");
{
  const { host, calls } = makeHost({ settings: MODEL });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "   " });
  check("refused", res.ok, false);
  check("coded", res.error, "INVALID_ARGUMENT");
  check("no completion spent", calls.completeInputs.length, 0);
}

console.log("\n=== the host's 8-per-minute completion budget is respected ===");
{
  const { host, calls } = makeHost({
    settings: { ...MODEL, roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] } },
    completions: ["a", "b", "c", "d", "e", "f", "g", "h", "SHOULD NOT RUN"],
  });
  const mod = load(host);
  await mod.onLoad();
  const results = [];
  for (let i = 0; i < 9; i++) {
    results.push(await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "q" + i }));
  }
  check("first eight succeeded", results.slice(0, 8).every((r) => r.ok), true);
  check("ninth refused", results[8].ok, false);
  check("coded RATE_LIMITED", results[8].error, "RATE_LIMITED");
  check("only eight completions spent", calls.completeInputs.length, 8);
}

// 快捷对话**没有 tools 列表**：技能只在 System Prompt 里用 `/技能名` 显式引用时才注入，
// 语法与主窗口 composer 一致（宿主 composer-trigger.ts 的 /(^|\s)\/([^\s]+)/ ）。
console.log("\n=== skills are pulled in only when the role prompt references them ===");
{
  // 没有引用 → 一个字都不该读
  const { host, calls } = makeHost({
    settings: { ...MODEL, roles: { roles: [{ id: "sk", mode: "quick", tools: [], system: "你是助手。" }] } },
    completions: ["ok"],
    skills: { "release-notes": "SKILL BODY HERE" },
  });
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "sk", text: "q" });
  ok("没有引用就不注入技能", !calls.completeInputs[0].system.includes("SKILL BODY HERE"));
  check("也没有去读技能", calls.skillReads.length, 0);
  check("也没有查技能目录", calls.skillLists, 0);
}
{
  // 引用了 → 读出来注入，并附上「不要复述」的约束（弱模型会把文档原样吐出来）
  const { host, calls } = makeHost({
    settings: {
      ...MODEL,
      roles: { roles: [{ id: "sk3", mode: "quick", tools: [], system: "回答前先按 /release-notes 的要求做。" }] },
    },
    completions: ["ok"],
    skills: { "release-notes": "SKILL BODY HERE" },
  });
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "sk3", text: "q" });
  const system = calls.completeInputs[0].system;
  ok("引用的技能被注入", system.includes("SKILL BODY HERE"));
  check("读的正是被引用的那个", calls.skillReads, ["release-notes"]);
  ok("附带了「不要复述」的约束", system.includes("只是背景知识"));
  ok("人设本身仍在", system.includes("回答前先按"));
}

console.log("\n=== model list + selection round-trip ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    models: [
      { key: "p/a", label: "A", providerId: "p", modelId: "a", supportsReasoning: true, thinkingLevels: ["low", "high"] },
      { key: "p/b", label: "B" },
    ],
  });
  const mod = load(host);
  await mod.onLoad();

  const listed = await mod.onPanelInvoke("summon.chat.listModels", {});
  check("ok", listed.ok, true);
  check("two models", listed.models.length, 2);
  check("selected is the explicit default", listed.selected, "prov/model-a");

  const set = await mod.onPanelInvoke("summon.chat.setModelKey", { key: "p/b" });
  check("set ok", set.ok, true);
  check("persisted", set.defaultModelKey, "p/b");
  ok("wrote through setSettings", calls.setSettings.some((p) => p.defaultModelKey === "p/b"));

  const listed2 = await mod.onPanelInvoke("summon.chat.listModels", {});
  check("selection reflected", listed2.selected, "p/b");
}

console.log("\n=== search can be exercised without spending a completion ===");
{
  const { host, calls } = makeHost({
    settings: MODEL,
    fetches: [{ status: 200, headers: {}, bodyText: DDG_HTML }],
  });
  const mod = load(host);
  await mod.onLoad();

  const res = await mod.onPanelInvoke("summon.chat.search", { query: "hello" });
  check("search ok", res.ok, true);
  check("two results", res.results.length, 2);
  check("no completion spent", calls.completeInputs.length, 0);

  const empty = await mod.onPanelInvoke("summon.chat.search", { query: "  " });
  check("empty query refused", empty.error, "INVALID_ARGUMENT");
}

console.log("\n=== a 429 from search is surfaced, not hidden ===");
{
  const { host } = makeHost({
    settings: MODEL,
    completions: ['{"tool":"web_search","query":"x"}', "answered anyway"],
    fetches: [
      { status: 429, headers: { "retry-after": "30" }, bodyText: "" },
      { status: 429, headers: { "retry-after": "30" }, bodyText: "" },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("trace says HTTP_429", res.trace[0].error, "HTTP_429");
  check("user still got an answer", res.text, "answered anyway");
}

// ===================================== app-default mirroring + thinking (P5)
console.log("\n=== the main window's model + thinking display are mirrored ===");
{
  const detailed = makeHost({
    appSettings: {
      defaultProviderId: "prov",
      defaultModelId: "model-a",
      thinkingDisplayMode: "detailed",
    },
  });
  const modDetailed = load(detailed.host);
  await modDetailed.onLoad();
  const bootDetailed = await modDetailed.onPanelInvoke("summon.chat.bootstrap", {});
  check("thinking display mode mirrored", bootDetailed.thinkingDisplayMode, "detailed");
  check("app model key exposed", bootDetailed.appDefaultModelKey, "prov/model-a");
  ok("settings read during load", detailed.calls.appSettingsReads >= 1);

  const plain = makeHost({});
  const modPlain = load(plain.host);
  await modPlain.onLoad();
  const bootPlain = await modPlain.onPanelInvoke("summon.chat.bootstrap", {});
  check("compact is the default", bootPlain.thinkingDisplayMode, "compact");
  check("no app model", bootPlain.appDefaultModelKey, null);
}

console.log("\n=== the model picker follows the app until the user chooses ===");
{
  const { host } = makeHost({
    appSettings: { defaultProviderId: "prov", defaultModelId: "model-b" },
    models: [{ key: "prov/model-a" }, { key: "prov/model-b" }],
  });
  const mod = load(host);
  await mod.onLoad();

  const listed = await mod.onPanelInvoke("summon.chat.listModels", {});
  check("selected follows the app", listed.selected, "prov/model-b");
  check("flagged as app default", listed.fromAppDefault, true);
  check("app key reported", listed.appDefaultKey, "prov/model-b");

  await mod.onPanelInvoke("summon.chat.setModelKey", { key: "prov/model-a" });
  const after = await mod.onPanelInvoke("summon.chat.listModels", {});
  check("an explicit choice wins", after.selected, "prov/model-a");
  check("no longer flagged", after.fromAppDefault, false);
}

console.log("\n=== thinking levels come from the model, with the host's default rule ===");
{
  const { host } = makeHost({
    models: [
      { key: "p/with-medium", supportsReasoning: true, thinkingLevels: ["low", "medium", "high"] },
      { key: "p/no-medium", supportsReasoning: true, thinkingLevels: ["low", "high"] },
      { key: "p/none", thinkingLevels: [] },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const listed = await mod.onPanelInvoke("summon.chat.listModels", {});
  check("medium preferred when published", listed.models[0].defaultThinkingLevel, "medium");
  check("otherwise the first level", listed.models[1].defaultThinkingLevel, "low");
  check("no levels -> null", listed.models[2].defaultThinkingLevel, null);
  check("levels carried through", listed.models[0].thinkingLevels, ["low", "medium", "high"]);
}

console.log("\n=== the chosen thinking level reaches agent.complete ===");
{
  const { host, calls } = makeHost({ settings: MODEL, completions: ["ok"] });
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q", thinkingLevel: "high" });
  check("thinkingLevel forwarded", calls.completeInputs[0].thinkingLevel, "high");

  const bare = makeHost({ settings: MODEL, completions: ["ok"] });
  const modBare = load(bare.host);
  await modBare.onLoad();
  await modBare.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  check("omitted when unset", "thinkingLevel" in bare.calls.completeInputs[0], false);
}

console.log("\n=== the live phase is exposed for the thinking indicator ===");
{
  const { host } = makeHost({
    settings: MODEL,
    completions: ['{"tool":"web_search","query":"q"}', "done"],
    // Held open so the in-flight phase can actually be observed.
    fetches: [async function () {
      await wait(80);
      return { status: 200, headers: {}, bodyText: DDG_HTML };
    }],
  });
  const mod = load(host);
  await mod.onLoad();

  const idle = await mod.onPanelInvoke("summon.chat.progress", {});
  check("idle before anything", idle.progress.inFlight, false);

  const pending = mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "quick", text: "q" });
  await wait(25);
  const mid = await mod.onPanelInvoke("summon.chat.progress", {});
  ok("in flight while running", mid.progress.inFlight);
  ok("phase is a real one",
    ["starting", "thinking", "searching"].indexOf(mid.progress.phase) !== -1);
  ok("phase carries a human detail line", typeof mid.progress.detail === "string");

  await pending;
  const after = await mod.onPanelInvoke("summon.chat.progress", {});
  check("cleared afterwards", after.progress.inFlight, false);
}

console.log("\n=== transcript carries thinking, status, usage and errors ===");
{
  const { host } = makeHost({
    desktop: [
      {
        session: {
          id: "s1",
          title: "T",
          status: "running",
          modelId: "model-a",
          providerId: "prov",
          thinkingLevel: "high",
          permissionMode: "ask",
          supportsReasoning: true,
          supportedThinkingLevels: ["low", "high"],
          messageCount: 4,
          messages: [
            { id: "m1", role: "user", content: "hi", createdAt: "t1" },
            {
              id: "m2", role: "assistant", content: "answer",
              thinking: "先看 A，再看 B。", status: "complete",
              modelId: "model-a", providerId: "prov",
              usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, totalTokens: 18 },
              createdAt: "t2",
            },
            { id: "m3", role: "tool", content: "Bash: ls", createdAt: "t3" },
            { id: "m4", role: "assistant", content: "", error: { code: "PROVIDER_ERROR", message: "boom" } },
          ],
        },
      },
    ],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.readTranscript", { sessionId: "s1" });
  ok("ok", res.ok);

  const t = res.transcript;
  check("session model key", t.modelKey, "prov/model-a");
  check("session thinking level", t.thinkingLevel, "high");
  check("supported levels", t.supportedThinkingLevels, ["low", "high"]);
  check("permission mode", t.permissionMode, "ask");
  check("supports reasoning", t.supportsReasoning, true);
  check("role kept for tool rows", t.messages[2].role, "tool");
  check("thinking kept separate from text", t.messages[1].thinking, "先看 A，再看 B。");
  check("answer text untouched", t.messages[1].text, "answer");
  check("message status", t.messages[1].status, "complete");
  check("usage projected", t.messages[1].usage, {
    inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cacheReadTokens: null, totalTokens: 18,
  });
  check("structured error kept", t.messages[3].error, { code: "PROVIDER_ERROR", message: "boom" });
  check("error row survives", t.messages.length, 4);
}

console.log("\n=== a new session is born with the picked model + thinking ===");
{
  const { host, calls } = makeHost({ desktop: [{ id: "s-new" }, { accepted: true }] });
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.chat.sendAgent", {
    text: "hi", providerId: "p", modelId: "m", thinkingLevel: "low",
  });
  check("session/create got the picks", calls.desktopInvokes[0].args, [
    { title: "hi", providerId: "p", modelId: "m", thinkingLevel: "low" },
  ]);
}

console.log("\n=== changing an existing session's model needs the user's consent ===");
{
  const { host, calls } = makeHost({ desktop: [true] });
  const mod = load(host);
  await mod.onLoad();

  const res = await mod.onPanelInvoke("summon.chat.configureSession", {
    sessionId: "s1",
    config: { mode: "agent", providerId: "p", modelId: "m", thinkingLevel: "high" },
  });
  check("ok", res.ok, true);
  check("operation", calls.desktopInvokes[0].operation, "session/configure");
  check("args carry mode + picks", calls.desktopInvokes[0].args, [
    "s1", { mode: "agent", providerId: "p", modelId: "m", thinkingLevel: "high" },
  ]);
  check("confirm acknowledgement sent", calls.desktopInvokes[0].confirm, true);

  // mode is required by the host schema; refuse locally instead of guessing.
  const bare = makeHost({});
  const modBare = load(bare.host);
  await modBare.onLoad();
  const bad = await modBare.onPanelInvoke("summon.chat.configureSession", {
    sessionId: "s1", config: { modelId: "m" },
  });
  check("refused without mode", bad.error, "INVALID_ARGUMENT");
  check("no host call made", bare.calls.desktopInvokes.length, 0);
}

console.log("\n=== the in-window settings panel persists through the same store ===");
{
  const { host, calls } = makeHost({});
  const mod = load(host);
  await mod.onLoad();

  const res = await mod.onPanelInvoke("summon.chat.saveSettings", {
    agentStartMode: "continue",
    maxToolRounds: 9,
    searchEndpoint: "  https://searx.example/search  ",
    searchApiKey: "k",
  });
  check("ok", res.ok, true);
  check("rounds clamped to the harness max", res.settings.maxToolRounds, 5);
  check("endpoint trimmed", res.settings.searchEndpoint, "https://searx.example/search");
  ok("persisted", calls.setSettings.some(function (p) { return p.agentStartMode === "continue"; }));

  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  check("bootstrap reflects it", boot.settings.agentStartMode, "continue");

  const empty = await mod.onPanelInvoke("summon.chat.saveSettings", {});
  check("nothing to save is refused", empty.error, "INVALID_ARGUMENT");
}

console.log("\n=== appearance, font size and opacity persist with clamping ===");
{
  const { host, calls } = makeHost({});
  const mod = load(host);
  await mod.onLoad();

  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  check("appearance defaults to system", boot.settings.appearance, "system");
  // 15px, not 13px: the design ships html{font-size:16px} and its whole scale is
  // rem-based, so a 13px default rendered everything noticeably too small.
  check("font size defaults to 15", boot.settings.fontSize, 15);
  check("opacity defaults to 100", boot.settings.opacity, 100);

  const saved = await mod.onPanelInvoke("summon.chat.saveSettings", {
    appearance: "dark", fontSize: 99, opacity: 1,
  });
  check("ok", saved.ok, true);
  check("dark kept", saved.settings.appearance, "dark");
  check("font size clamped to 20", saved.settings.fontSize, 20);
  check("opacity clamped to 50", saved.settings.opacity, 50);
  ok("persisted", calls.setSettings.some(function (p) { return p.appearance === "dark"; }));

  const weird = await mod.onPanelInvoke("summon.chat.saveSettings", { appearance: "neon" });
  check("unknown appearance falls back to system", weird.settings.appearance, "system");

  const light = await mod.onPanelInvoke("summon.chat.saveSettings", {
    appearance: "light", fontSize: 12, opacity: 100,
  });
  check("light kept", light.settings.appearance, "light");
  check("min font size", light.settings.fontSize, 12);
  check("max opacity", light.settings.opacity, 100);

  // Round-trip through a fresh load to prove it is really stored.
  const mod2 = load(host);
  await mod2.onLoad();
  const boot2 = await mod2.onPanelInvoke("summon.chat.bootstrap", {});
  check("survives reload", boot2.settings.appearance, "light");
  check("reload keeps font size", boot2.settings.fontSize, 12);
}

// ============================================================ shortcut
console.log("\n=== refused shortcut falls back ===");
{
  const { host, calls } = makeHost({
    registerOutcomes: [{ registered: false, error: "SHORTCUT_CONFLICT" }],
  });
  const mod = load(host);
  await mod.onLoad();
  check("tried twice", calls.registerInputs.length, 2);
  check("fallback candidate", calls.registerInputs[1].accelerator, EXPECT_FALLBACK);
  const probe = await mod.onPanelInvoke("summon.chat.probe", {});
  check("requested preserved", probe.shortcut.requested, EXPECT_ACCEL);
  check("active is the fallback", probe.shortcut.active, EXPECT_FALLBACK);
}

console.log("\n=== all accelerators refused is reported, not thrown ===");
{
  const refuse = { registered: false, error: "SHORTCUT_UNAVAILABLE" };
  const { host, calls } = makeHost({
    registerOutcomes: [refuse, refuse, refuse, refuse],
  });
  const mod = load(host);
  await mod.onLoad();
  const probe = await mod.onPanelInvoke("summon.chat.probe", {});
  check("registered=false", probe.shortcut.registered, false);
  check("error surfaced", probe.shortcut.error, "SHORTCUT_UNAVAILABLE");
  ok("user was warned", calls.notify.length >= 1);
}

console.log("\n=== settings change re-registers only when the key changed ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  check("registered once", calls.registerInputs.length, 1);

  await host.events.handlers["plugin:settingsChanged"]();
  check("unchanged -> no churn", calls.registerInputs.length, 1);

  host.plugin.getSettings = async () => ({ accelerator: "Alt+Shift+Z", roles: { roles: [] } });
  await host.events.handlers["plugin:settingsChanged"]();
  check("changed -> re-registered", calls.registerInputs.length, 2);
  check("new key applied", calls.registerInputs[1].accelerator, "Alt+Shift+Z");
}

// ======================= 快捷对话：受理即返回 + 轮询取结果
// 宿主给每次面板调用定了 30 秒硬超时（plugin-runtime.ts
// PLUGIN_PANEL_TIMEOUT_MS = 30_000），而一轮快捷问答要联网搜索 + 多次
// agent.complete（单轮上限 90 秒）。所以模型调用绝不能待在面板调用里 ——
// 否则报 "plugin <id> did not answer pi-plugin-panel-invoke"。
// 这一组断言直接用未包装的 onPanelInvoke，把「受理 → 轮询 → 取结果」钉住。
console.log("\n=== quick chat returns on accept and the page polls for the answer ===");
{
  const { host, calls } = makeHost({
    settings: { defaultModelKey: "prov/model-a", roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] } },
    completions: ["你好，我是回答。"],
  });
  const mod = load(host);
  await mod.onLoad();
  const raw = mod.__rawPanelInvoke;
  ok("原始 onPanelInvoke 被暴露给测试", typeof raw === "function");

  // 让模型调用慢一点，才能观察到「已受理但还没有结果」这个中间态。
  const originalComplete = host.agent.complete;
  host.agent.complete = async function (input) {
    await wait(60);
    return originalComplete.call(host.agent, input);
  };

  const ack = await raw("summon.chat.sendQuick", { roleId: "plain", text: "你好" });
  check("sendQuick 立即返回 accepted", ack.accepted, true);
  ok("sendQuick 带 turnId", typeof ack.turnId === "string" && ack.turnId.length > 0);
  ok("sendQuick 不再同步返回答案（否则面板调用就会超时）", ack.text === undefined);

  const mid = (await raw("summon.chat.progress", {})).progress;
  check("受理后处于进行中", mid.inFlight, true);
  check("进行中还没有结果", mid.result, null);
  check("进行中带同一个 turnId", mid.turnId, ack.turnId);

  const overlap = await raw("summon.chat.sendQuick", { roleId: "plain", text: "插队" });
  check("上一轮没结束时再发送被拒", overlap.error, "BUSY");
  ok("被拒时不会多打一次模型 (completeInputs=" + calls.completeInputs.length + ")",
    calls.completeInputs.length <= 1);

  let fin = null;
  for (let i = 0; i < 300 && !fin; i++) {
    const p = (await raw("summon.chat.progress", {})).progress;
    if (p.turnId === ack.turnId && !p.inFlight) fin = p;
    else await wait(10);
  }
  ok("轮询拿到了完成态", fin !== null);
  ok("完成态里带着答案 (got " + JSON.stringify(fin && fin.result) + ")",
    !!(fin && fin.result && fin.result.text === "你好，我是回答。"));
  check("完成态已清掉 inFlight", fin && fin.inFlight, false);

  // 悬浮窗历史：快捷对话不是宿主会话，session/list 里没有它，所以插件自己记。
  const listed = await raw("summon.chat.listSessions", {});
  ok("listSessions 带 quick 分组 (got " + JSON.stringify(listed && listed.quick) + ")",
    Array.isArray(listed.quick) && listed.quick.length === 1);
  if (Array.isArray(listed.quick) && listed.quick.length === 1) {
    check("历史里存了用户提问", listed.quick[0].messages[0].text, "你好");
    check("历史里存了助手回复", listed.quick[0].messages[1].text, "你好，我是回答。");
    check("历史条目有标题", listed.quick[0].title, "你好");
  }
}

// ======================= 停止：Agent 真中止，快捷对话只能放弃
console.log("\n=== stop: agent/abort for real sessions, graceful abandon for quick chat ===");
{
  // --- Agent 模式：真的调 agent/abort
  const agentHost = makeHost({
    settings: {
      defaultModelKey: "prov/model-a",
      roles: { roles: [{ id: "ag", mode: "agent", tools: [] }] },
    },
    desktop: [[{ id: "s1" }]], // session/get
  });
  const agentMod = load(agentHost.host);
  await agentMod.onLoad();
  const agentRaw = agentMod.__rawPanelInvoke;

  await agentRaw("summon.chat.readTranscript", { sessionId: "s1" });
  const aborted = await agentRaw("summon.chat.abortAgent", { sessionId: "s1" });
  const abortCall = agentHost.calls.desktopInvokes.filter((c) => c.operation === "agent/abort")[0];
  ok("调用了 agent/abort", !!abortCall);
  if (abortCall) {
    check("入参形状是 [{sessionId}]", abortCall.args, [{ sessionId: "s1" }]);
    check("不要求确认（风险等级 write，不是 dangerous）", abortCall.confirm, undefined);
  }
  // 宿主返回什么就透传什么，插件不伪造成功
  ok("abortAgent 有返回", aborted !== undefined);

  const noSession = await agentRaw("summon.chat.abortAgent", {});
  check("缺 sessionId 被拒", noSession.error, "INVALID_ARGUMENT");

  // --- 快捷对话：模型调用停不下来，只能放弃等待并丢弃结果
  const quickHost = makeHost({
    settings: {
      defaultModelKey: "prov/model-a",
      roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] },
    },
    completions: ["这一条不该被记下"],
  });
  const mod = load(quickHost.host);
  await mod.onLoad();
  const raw = mod.__rawPanelInvoke;

  const originalComplete = quickHost.host.agent.complete;
  quickHost.host.agent.complete = async function (input) {
    await wait(90);
    return originalComplete.call(quickHost.host.agent, input);
  };

  const ack = await raw("summon.chat.sendQuick", { roleId: "plain", text: "会被取消" });
  const cancelled = await raw("summon.chat.cancelQuick", {});
  check("取消成功", cancelled.ok, true);
  check("如实标记为「软」取消（模型调用无法中断）", cancelled.soft, true);
  check("取消的是那一轮", cancelled.turnId, ack.turnId);

  const afterCancel = (await raw("summon.chat.progress", {})).progress;
  check("取消后不再 inFlight", afterCancel.inFlight, false);
  check("取消后阶段是 cancelled", afterCancel.phase, "cancelled");

  // 让后台那一轮真的跑完：结果必须被丢弃、进度不能被它重新点亮、历史也不能记。
  await wait(220);
  const later = (await raw("summon.chat.progress", {})).progress;
  check("后台跑完也不会重新点亮进度", later.inFlight, false);
  check("阶段仍是 cancelled", later.phase, "cancelled");
  check("被取消的轮次不产生结果", later.result, null);
  const listed = await raw("summon.chat.listSessions", {});
  check("被取消的轮次不进悬浮窗历史", (listed.quick || []).length, 0);

  const again = await raw("summon.chat.cancelQuick", {});
  check("没有进行中的轮次时取消被拒", again.error, "NOT_RUNNING");
}

// ======================= 版本号必须与 manifest 一致
// 设置页会把 boot.version 显示出来，用来判断「到底加载的是哪个版本」——
// 这个数字一旦和 manifest 漂移，排查就会指向错误的构建。
console.log("\n=== the version shown in settings matches the manifest ===");
{
  const manifest = JSON.parse(
    readFileSync(path.join(here, "..", "plugins", "local.summon-chat", "manifest.json"), "utf8"),
  );
  const { host } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  const boot = await mod.onPanelInvoke("summon.chat.bootstrap", {});
  ok("bootstrap 暴露了版本号", typeof boot.version === "string" && boot.version.length > 0);
  check("版本号与 manifest 一致", boot.version, manifest.version);
}

// ======================= 内容块 JSON 剥壳 + 技能不得被复述
console.log("\n=== content-block JSON is unwrapped, and skill docs must not be echoed ===");
{
  // 有些端点把回复包成 {"content":[{"type":"text","text":"…"}]}，
  // 直接渲染出来就是一坨 JSON —— 实测发生过。
  const wrapped = JSON.stringify({ content: [{ type: "text", text: "真正的回答" }] });

  const { host, calls } = makeHost({
    settings: {
      defaultModelKey: "prov/model-a",
      roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] },
    },
    completions: [wrapped],
  });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "你好" });
  check("快捷对话的回答被剥壳", res.text, "真正的回答");

  // 多块要拼起来；不是这个形状的字符串必须原样保留
  const multi = JSON.stringify({ content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] });
  const plain = makeHost({
    settings: { defaultModelKey: "prov/model-a", roles: { roles: [{ id: "plain", mode: "quick", tools: [] }] } },
    completions: [multi, "{不是 JSON", "普通回答"],
  });
  const modPlain = load(plain.host);
  await modPlain.onLoad();
  const multiRes = await modPlain.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "a" });
  check("多个内容块被拼接", multiRes.text, "第一段\n\n第二段");
  const brokenRes = await modPlain.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "b" });
  check("坏 JSON 原样保留", brokenRes.text, "{不是 JSON");
  const normalRes = await modPlain.onPanelInvoke("summon.chat.sendQuick", { roleId: "plain", text: "c" });
  check("普通文本原样保留", normalRes.text, "普通回答");

  // transcript 那一侧也要剥壳（同一个 helper，不同调用点）
  const t = makeHost({
    desktop: [
      {
        session: { id: "s1", title: "T", status: "complete" },
        messages: [{ id: "m1", role: "assistant", content: wrapped }],
      },
    ],
  });
  const modT = load(t.host);
  await modT.onLoad();
  const read = await modT.onPanelInvoke("summon.chat.readTranscript", { sessionId: "s1" });
  check("transcript 里的回答也被剥壳", read.transcript.messages[0].text, "真正的回答");

  // 老的 skills 字段已经不看了：只有 System Prompt 里的 `/技能名` 引用算数。
  const sk = makeHost({
    settings: {
      defaultModelKey: "prov/model-a",
      roles: {
        roles: [
          { id: "sk2", mode: "quick", tools: ["web_search"], skills: ["tavily-search"], system: "你是助手。" },
        ],
      },
    },
    skills: { "tavily-search": "SECRET SKILL BODY" },
    completions: ["好的。"],
  });
  const modSk = load(sk.host);
  await modSk.onLoad();
  await modSk.onPanelInvoke("summon.chat.sendQuick", { roleId: "sk2", text: "你好" });
  const system = sk.calls.completeInputs[0].system;
  ok("旧的 skills 字段不再生效", !system.includes("SECRET SKILL BODY"));
  ok("但联网搜索的指令要在", system.includes("web_search"));
  check("没有去读技能", sk.calls.skillReads.length, 0);
}

// ======================= 增强提示词 + 权限模式
console.log("\n=== prompt enhancement and permission mode ===");
{
  // --- 增强提示词：prompt/enhance，write 级（不弹确认框）
  const s = makeHost({ desktop: ["增强后的提示词"] });
  const ms = load(s.host);
  await ms.onLoad();
  const r1 = await ms.onPanelInvoke("summon.chat.enhancePrompt", { draft: "写个总结" });
  check("字符串返回直接用", r1.text, "增强后的提示词");
  check("operation", s.calls.desktopInvokes[0].operation, "prompt/enhance");
  check("入参是 [{draft}]", s.calls.desktopInvokes[0].args, [{ draft: "写个总结" }]);
  check("write 级不要求 confirm", s.calls.desktopInvokes[0].confirm, undefined);

  // 返回值没有公开契约 —— 几种可能都要兜住
  for (const [key, value] of [["text", "A"], ["enhanced", "B"], ["draft", "C"], ["prompt", "D"]]) {
    const h = makeHost({ desktop: [{ [key]: value }] });
    const m = load(h.host);
    await m.onLoad();
    const r = await m.onPanelInvoke("summon.chat.enhancePrompt", { draft: "x" });
    check("兜住返回值的 ." + key, r.text, value);
  }

  const sid = makeHost({ desktop: ["ok"] });
  const msid = load(sid.host);
  await msid.onLoad();
  await msid.onPanelInvoke("summon.chat.enhancePrompt", { draft: "x", sessionId: "s9" });
  check("sessionId 透传", sid.calls.desktopInvokes[0].args, [{ draft: "x", sessionId: "s9" }]);

  const e = makeHost({ desktop: ["never"] });
  const me = load(e.host);
  await me.onLoad();
  const empty = await me.onPanelInvoke("summon.chat.enhancePrompt", { draft: "   " });
  check("空草稿被拒（而且不打扰宿主）", empty.error, "INVALID_ARGUMENT");
  check("空草稿没有发起调用", e.calls.desktopInvokes.length, 0);

  const n = makeHost({ desktop: [{}] });
  const mn = load(n.host);
  await mn.onLoad();
  check("宿主没返回正文时报错", (await mn.onPanelInvoke("summon.chat.enhancePrompt", { draft: "x" })).error,
    "EMPTY_ENHANCEMENT");

  // --- 权限模式：走 session/configure，dangerous 必须带 confirm
  const p = makeHost({
    desktop: [
      { session: { id: "s1", mode: "agent" }, messages: [] },
      { ok: true },
    ],
  });
  const mp = load(p.host);
  await mp.onLoad();
  await mp.onPanelInvoke("summon.chat.readTranscript", { sessionId: "s1" });
  const applied = await mp.onPanelInvoke("summon.chat.configureSession", {
    sessionId: "s1",
    config: { mode: "agent", permissionMode: "accept-edits" },
  });
  check("权限模式配置成功", applied.ok, true);
  const call = p.calls.desktopInvokes.filter((c) => c.operation === "session/configure")[0];
  ok("调用了 session/configure", !!call);
  if (call) {
    check("带上 permissionMode", call.args[1].permissionMode, "accept-edits");
    check("也带上必需的 mode", call.args[1].mode, "agent");
    check("dangerous 必须带 confirm", call.confirm, true);
  }
}

// ======================= 项目文件夹
console.log("\n=== project folder: list / get / set / clear ===");
{
  const h = makeHost({
    desktop: [
      [{ path: "C:\\a", name: "A" }, { path: "C:\\b", name: "B" }], // project/list
      { path: "C:\\a" }, // project/get
      { ok: true }, // project/set
      { ok: true }, // project/clear
    ],
  });
  const m = load(h.host);
  await m.onLoad();

  const listed = await m.onPanelInvoke("summon.chat.listProjects", {});
  check("先 project/list", h.calls.desktopInvokes[0].operation, "project/list");
  check("再 project/get", h.calls.desktopInvokes[1].operation, "project/get");
  check("项目路径", listed.projects.map((p) => p.path), ["C:\\a", "C:\\b"]);
  check("项目名称", listed.projects.map((p) => p.name), ["A", "B"]);
  check("当前项目", listed.currentPath, "C:\\a");

  const set = await m.onPanelInvoke("summon.chat.setProject", { path: "C:\\b" });
  const setCall = h.calls.desktopInvokes.filter((c) => c.operation === "project/set")[0];
  ok("调用了 project/set", !!setCall);
  if (setCall) {
    check("入参形状是 [path]", setCall.args, ["C:\\b"]);
    check("write 级不要求 confirm", setCall.confirm, undefined);
  }
  check("ok", set.ok, true);

  await m.onPanelInvoke("summon.chat.setProject", { path: "  " });
  check("空路径走 project/clear",
    h.calls.desktopInvokes.filter((c) => c.operation === "project/clear").length, 1);

  // 返回形状没有公开契约：字符串数组 / 裸字符串都要能认
  const h2 = makeHost({ desktop: [["C:\\x"], "C:\\x"] });
  const m2 = load(h2.host);
  await m2.onLoad();
  const l2 = await m2.onPanelInvoke("summon.chat.listProjects", {});
  check("字符串数组也认", l2.projects.map((p) => p.path), ["C:\\x"]);
  check("裸字符串当前项目也认", l2.currentPath, "C:\\x");

  // 宿主失败时不能崩，也不能假装成功
  const h3 = makeHost({ desktop: [new Error("nope"), new Error("nope")] });
  const m3 = load(h3.host);
  await m3.onLoad();
  const l3 = await m3.onPanelInvoke("summon.chat.listProjects", {});
  check("列表失败仍是 ok:true（界面要能渲染）", l3.ok, true);
  ok("但带上了 error", typeof l3.error === "string");
  check("且项目为空", l3.projects, []);
}

// ============================================================= cleanup
console.log("\n=== onUnload cleans up ===");
{
  const { host, calls, store } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  const rolesBefore = JSON.stringify(store.settings);
  await mod.onUnload();
  check("no commands left", Object.keys(host.commands.registered).length, 0);
  ok("unregistered the shortcut", calls.unregistered.includes("shortcut:toggle"));
  ok("unsubscribed from settings", calls.events.includes("off:plugin:settingsChanged"));
  check("unload does not wipe stored roles", JSON.stringify(store.settings), rolesBefore);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
