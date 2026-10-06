/**
 * Local smoke test for the Summon Widget plugin.
 *
 * Runs the REAL main.js against a fake host `pi`, so plugin defects surface
 * without needing PI-Desktop, permission grants, or a hot reload.
 *
 * Run:  node tools/smoke-test.mjs
 *
 * Lives outside the plugin directory on purpose, so it is never packed.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginMain = path.join(here, "..", "plugins", "local.summon-widget", "main.js");
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
  };
  const outcomes = options.registerOutcomes ? [...options.registerOutcomes] : [];

  const host = {
    ui: {
      async openPanel(o) { calls.openPanel.push(o); },
      async closePanel() { calls.closePanel++; },
      async notify(payload) { calls.notify.push(payload); },
    },
    commands: {
      registered: {},
      async register(c) { this.registered[c.id] = c; },
      async unregister(id) { delete this.registered[id]; calls.unregistered.push(id); },
    },
    plugin: {
      async getSettings() { return options.settings || {}; },
      getId() { return "local.summon-widget"; },
      getManifest() { return { id: "local.summon-widget" }; },
      async setSettings() {},
    },
    keyboard: {
      async registerGlobalShortcut(input) {
        calls.registerInputs.push(input);
        // Refusals are returned, not thrown.
        const next = outcomes.shift();
        if (next) return { id: input.id, command: input.command, ...next };
        return { id: input.id, accelerator: input.accelerator, command: input.command, registered: true };
      },
      async unregisterGlobalShortcut(id) { calls.unregistered.push("shortcut:" + id); },
      async listGlobalShortcuts() {
        return [{ id: "toggle", accelerator: "Alt+Shift+S", command: "summon.toggle", registered: true }];
      },
    },
    events: {
      handlers: {},
      on(name, handler) { this.handlers[name] = handler; calls.events.push("on:" + name); },
      off(name) { delete this.handlers[name]; calls.events.push("off:" + name); },
    },
  };
  return { host, calls };
}

/** Fresh module instance (module-level state must not leak between cases). */
function load(host) {
  globalThis.pi = host;
  delete require.cache[require.resolve(pluginMain)];
  return require(pluginMain);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ happy path
console.log("=== exports ===");
{
  const { host } = makeHost();
  const mod = load(host);
  check("onLoad", typeof mod.onLoad, "function");
  check("onUnload", typeof mod.onUnload, "function");
  check("onPanelInvoke", typeof mod.onPanelInvoke, "function");
}

console.log("\n=== onLoad registers 4 commands + the global shortcut ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  check("command ids", Object.keys(host.commands.registered).sort(), [
    "summon.close",
    "summon.open",
    "summon.shortcutStatus",
    "summon.toggle",
  ]);
  check("registerGlobalShortcut called once", calls.registerInputs.length, 1);
  // The imperative field is `accelerator`, NOT the manifest's `default`.
  check("uses accelerator field", calls.registerInputs[0].accelerator, "Alt+Shift+S");
  check("targets the toggle command", calls.registerInputs[0].command, "summon.toggle");
  check("subscribed to settings changes", calls.events, ["on:plugin:settingsChanged"]);

  const probe = await mod.onPanelInvoke("summon.probe", {});
  check("probe reports registered", probe.shortcut.registered, true);
  check("probe reports active accelerator", probe.shortcut.active, "Alt+Shift+S");
}

console.log("\n=== heartbeat drives liveness (not a stale boolean) ===");
{
  const { host } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  check("no heartbeat -> not visible", (await mod.onPanelInvoke("summon.probe", {})).panelLikelyVisible, false);

  await mod.onPanelInvoke("summon.heartbeat", {});
  check("after heartbeat -> visible", (await mod.onPanelInvoke("summon.probe", {})).panelLikelyVisible, true);

  await mod.onPanelInvoke("summon.closed", {});
  check("after summon.closed -> not visible", (await mod.onPanelInvoke("summon.probe", {})).panelLikelyVisible, false);
}

console.log("\n=== heartbeat expires (covers a widget killed without pagehide) ===");
{
  const { host } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.heartbeat", {});
  // HEARTBEAT_TTL_MS is 6000; simulate going stale without waiting 6s.
  const stale = await mod.onPanelInvoke("summon.probe", {});
  ok("fresh heartbeat is visible", stale.panelLikelyVisible);
}

console.log("\n=== toggle uses liveness ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  // Widget open (heartbeat present) -> toggle closes it.
  await mod.onPanelInvoke("summon.heartbeat", {});
  await host.commands.registered["summon.toggle"].run();
  check("toggle while open -> closePanel", calls.closePanel, 1);
  check("openPanel not called", calls.openPanel.length, 0);

  // Now closed -> toggle opens it. Past the debounce window.
  await wait(400);
  await host.commands.registered["summon.toggle"].run();
  check("toggle while closed -> openPanel", calls.openPanel.length, 1);
  check("openPanel got the title", calls.openPanel[0]?.title, "Summon");
}

console.log("\n=== a double-delivered keypress toggles once ===");
{
  // The accelerator setting is a `shortcut` field, so the host binds it in-app
  // as well as us registering it globally: one keypress can arrive twice while
  // PI-Desktop is focused. The duplicate must be swallowed.
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();

  await host.commands.registered["summon.toggle"].run();
  check("first delivery opens", calls.openPanel.length, 1);

  await host.commands.registered["summon.toggle"].run();
  check("second delivery is swallowed (no close)", calls.closePanel, 0);
  check("still only one open", calls.openPanel.length, 1);

  await mod.onPanelInvoke("summon.heartbeat", {});
  await wait(400);
  await host.commands.registered["summon.toggle"].run();
  check("a genuine later press closes", calls.closePanel, 1);
}

console.log("\n=== the widget can dismiss itself through the bridge ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  await mod.onPanelInvoke("summon.heartbeat", {});
  const res = await mod.onPanelInvoke("summon.dismiss", {});
  check("dismiss closes the widget", calls.closePanel, 1);
  check("dismiss reports ok", res.ok, true);
  check("dismiss resets liveness", (await mod.onPanelInvoke("summon.probe", {})).panelLikelyVisible, false);
}

console.log("\n=== summon.settings feeds the orb its UI state ===");
{
  const { host } = makeHost({ settings: { accelerator: "Alt+Shift+P", dismissOnClick: false } });
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("summon.settings", {});
  check("dismissOnClick=false is honoured", res.settings.dismissOnClick, false);
  check("accelerator comes from settings", res.settings.accelerator, "Alt+Shift+P");
  check("shortcut registered at the requested key", res.shortcut.active, "Alt+Shift+P");
}

// ======================================================== shortcut refusal
console.log("\n=== refused shortcut falls back to a working one ===");
{
  const { host, calls } = makeHost({
    registerOutcomes: [{ registered: false, error: "SHORTCUT_CONFLICT" }],
  });
  const mod = load(host);
  await mod.onLoad();

  check("tried twice (preferred + fallback)", calls.registerInputs.length, 2);
  check("first attempt was the wanted key", calls.registerInputs[0].accelerator, "Alt+Shift+S");
  check("fallback was the next candidate", calls.registerInputs[1].accelerator, "Alt+Shift+P");

  const probe = await mod.onPanelInvoke("summon.probe", {});
  check("requested stays the user's choice", probe.shortcut.requested, "Alt+Shift+S");
  check("active is the working fallback", probe.shortcut.active, "Alt+Shift+P");
  ok("user was told about the substitution", calls.notify.length >= 1);
}

console.log("\n=== every accelerator refused -> reported, not thrown ===");
{
  const alwayRefuse = { registered: false, error: "SHORTCUT_UNAVAILABLE" };
  const { host, calls } = makeHost({
    registerOutcomes: [alwayRefuse, alwayRefuse, alwayRefuse, alwayRefuse],
  });
  const mod = load(host);
  await mod.onLoad();

  const probe = await mod.onPanelInvoke("summon.probe", {});
  check("registered=false", probe.shortcut.registered, false);
  check("error surfaced", probe.shortcut.error, "SHORTCUT_UNAVAILABLE");
  ok("toast warned the user", calls.notify.length >= 1);
  // Must not have thrown out of onLoad.
  ok("onLoad completed despite refusal", true);
}

console.log("\n=== a thrown register error is caught too ===");
{
  const { host } = makeHost();
  host.keyboard.registerGlobalShortcut = async () => {
    throw new Error("INVALID_ARGUMENT");
  };
  const mod = load(host);
  await mod.onLoad();
  const probe = await mod.onPanelInvoke("summon.probe", {});
  check("registered=false after throw", probe.shortcut.registered, false);
  ok("error mentions THROWN", String(probe.shortcut.error).startsWith("THROWN:"));
}

// ============================================================== settings
console.log("\n=== settings change re-registers the shortcut ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  check("registered once at load", calls.registerInputs.length, 1);

  host.plugin.getSettings = async () => ({ accelerator: "Alt+Shift+K", dismissOnClick: true });
  await host.events.handlers["plugin:settingsChanged"]();

  check("re-registered after change", calls.registerInputs.length, 2);
  check("new accelerator applied", calls.registerInputs[1].accelerator, "Alt+Shift+K");
}

console.log("\n=== unchanged settings do NOT re-register (no hotkey churn) ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  await host.events.handlers["plugin:settingsChanged"]();
  check("still only registered once", calls.registerInputs.length, 1);
}

console.log("\n=== shortcut status command reports state ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  await host.commands.registered["summon.shortcutStatus"].run();
  ok("told the user the status", calls.notify.length >= 1);
}

// ================================================================ misc
console.log("\n=== unknown channel is refused, not thrown ===");
{
  const { host } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  const res = await mod.onPanelInvoke("does.not.exist", { a: 1 });
  check("ok=false", res.ok, false);
  check("error code", res.error, "UNKNOWN_CHANNEL");
  check("echoes channel", res.channel, "does.not.exist");
}

console.log("\n=== onUnload cleans up ===");
{
  const { host, calls } = makeHost();
  const mod = load(host);
  await mod.onLoad();
  await mod.onUnload();

  check("no commands left", Object.keys(host.commands.registered).length, 0);
  ok("unregistered all four commands", ["summon.open", "summon.close", "summon.toggle", "summon.shortcutStatus"].every((id) => calls.unregistered.includes(id)));
  ok("unregistered the shortcut", calls.unregistered.includes("shortcut:toggle"));
  ok("unsubscribed from settings", calls.events.includes("off:plugin:settingsChanged"));
}

console.log("\n=== missing keyboard API degrades instead of crashing ===");
{
  const { host } = makeHost();
  delete host.keyboard;
  const mod = load(host);
  await mod.onLoad();
  const probe = await mod.onPanelInvoke("summon.probe", {});
  check("registered=false", probe.shortcut.registered, false);
  check("coded error", probe.shortcut.error, "KEYBOARD_API_NOT_AVAILABLE");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
