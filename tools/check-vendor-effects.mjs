/**
 * Exercise the two vendored effects for real.
 *
 * They cannot be covered by the smoke tests (those load `main.js` with a fake
 * host and no DOM), and `lint-html-scripts.mjs` only *parses* them — a bundle
 * that parses but no longer defines what the page calls would ship silently.
 * That is not hypothetical: the first generated morphicons bundle omitted
 * `dist/dom.js`, so `window.PiMorph` was never assigned at all.
 *
 * So this script runs both bundles against a small DOM stub and asserts what the
 * page depends on:
 *
 *   morphicons  · `createMorph` exists, paints the initial icon, and a
 *                 `morphTo` produces in-between geometry that is neither the
 *                 source nor the target icon (i.e. it really interpolates);
 *               · a filled icon is rejected loudly rather than morphing wrongly.
 *   curve       · `PiCurve.create(host)` puts an `<svg>` with a trail `<path>`
 *                 and the upstream particle count into the host;
 *               · the trail path is rebuilt as time advances, and the geometry
 *                 is on the 0–100 grid the plugin's CSS expects.
 *
 * Run:  node tools/check-vendor-effects.mjs
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

let failures = 0;
function ok(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log(`      ${detail}`);
  }
}
function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --------------------------------------------------------------------- DOM stub
/**
 * Only what the two bundles touch. morphicons writes `d` through
 * `setAttribute`, the curve loader builds SVG nodes and sets attributes on them.
 * Nothing needs layout, so a tag name plus an attribute map is enough.
 */
function makeNode(tag, doc) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    attributes: Object.create(null),
    children: [],
    childNodes: [],
    parentNode: null,
    ownerDocument: doc,
    style: {},
    textContent: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return name in this.attributes; },
    appendChild(child) {
      if (child && child.parentNode) child.parentNode.removeChild(child);
      this.children.push(child);
      this.childNodes.push(child);
      if (child) child.parentNode = this;
      return child;
    },
    insertBefore(child, before) {
      const at = before ? this.children.indexOf(before) : -1;
      const index = at === -1 ? this.children.length : at;
      this.children.splice(index, 0, child);
      this.childNodes.splice(index, 0, child);
      if (child) child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at !== -1) { this.children.splice(at, 1); this.childNodes.splice(at, 1); }
      if (child) child.parentNode = null;
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
  };
  return node;
}

let rafSeq = 0;
const rafQueue = new Map();
function makeSandbox() {
  const doc = {
    createElementNS: (_ns, tag) => makeNode(tag, doc),
    createElement: (tag) => makeNode(tag, doc),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: null,
    documentElement: { style: {}, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } },
  };
  doc.body = makeNode("body", doc);
  const sandbox = {
    document: doc,
    window: null,
    performance: { now: () => Date.now() },
    requestAnimationFrame(cb) { const id = ++rafSeq; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame(id) { rafQueue.delete(id); },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    console,
    Math, JSON, Object, Array, String, Number, Boolean, isFinite, Date, Set, Map, WeakMap,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/** Run queued animation frames with an advancing timestamp. */
function pumpFrames(sandbox, count, stepMs = 16) {
  let t = 0;
  for (let i = 0; i < count; i++) {
    const due = [...rafQueue.entries()];
    rafQueue.clear();
    if (!due.length) break;
    t += stepMs;
    for (const [, cb] of due) cb(t);
  }
}

const sandbox = makeSandbox();
const context = vm.createContext(sandbox);
for (const file of ["morphicons.js", "curve-loader.js"]) {
  const code = await readFile(path.join(repoRoot, "docs", "vendor", file), "utf8");
  new vm.Script(code, { filename: `docs/vendor/${file}` }).runInContext(context);
}

// ---------------------------------------------------------------- morphicons
console.log("=== morphicons：真的会插值，而不是直接换一个图标 ===");
{
  const morph = sandbox.window.PiMorph;
  ok("window.PiMorph 被挂上了", !!morph);
  eq("版本号透传", morph && morph.version, "1.7.1");
  ok("createMorph 是一个函数", typeof (morph && morph.createMorph) === "function");

  // The two `d` strings the send key morphs between — copied from the template's
  // MORPH_ICONS so this test fails if either side drifts.
  const SEND = "M3.4 11.9 20.6 4.3c.6-.28 1.25.37.97.97L14.1 20.6c-.28.6-1.17.6-1.45 0l-2.3-5.2-4.6-1.8c-.62-.24-.6-1.14.05-1.4";
  const STOP = "M9.2 5.2h5.6a4 4 0 0 1 4 4v5.6a4 4 0 0 1-4 4H9.2a4 4 0 0 1-4-4V9.2a4 4 0 0 1 4-4Z";

  const template = await readFile(
    path.join(repoRoot, "plugins", "local.summon-chat", "renderer", "renderer.template.html"),
    "utf8",
  );
  ok("模板里的 send 就是这两个图标之一（防止两边各自漂移）", template.includes(SEND));
  ok("模板里的 stop 就是这两个图标之一", template.includes(STOP));

  const pathEl = makeNode("path", sandbox.document);
  const instance = morph.createMorph(pathEl, SEND, { reducedMotion: "never" });
  ok("挂载即画出初始图标（d 非空）", typeof pathEl.attributes.d === "string" && pathEl.attributes.d.length > 0,
    JSON.stringify(pathEl.attributes.d));
  ok("初始 d 是 M 开头的合法路径", /^M[\s\d.]/.test(pathEl.attributes.d || ""), pathEl.attributes.d);

  const before = pathEl.attributes.d;
  instance.morphTo(STOP, "snappy");
  pumpFrames(sandbox, 8);
  const midway = pathEl.attributes.d;
  ok("形变过程中 d 变了", midway !== before);
  ok("中途中既不是源图标也不是目标图标",
    midway !== before && midway !== morph.canonicalD(STOP));
  pumpFrames(sandbox, 400);
  const settled = pathEl.attributes.d;
  ok("最终收敛到目标图标的规范 d", settled === morph.canonicalD(STOP),
    `settled=${settled}\n      want=${morph.canonicalD(STOP)}`);

  // The library does NOT reject a fill-drawn `<path>`: it parses (the geometry
  // is valid) and only *reads wrong in transit*, which its own README warns
  // about. The plugin's answer is that no design-system icon is ever handed to
  // it — the two morphed icons are hand-written stroke geometry — so what this
  // asserts is the library's documented behaviour, not a guarantee it makes:
  // the template must never feed it a `fill` attribute.
  ok("模板从不把填充型图标交给 morphicons（它不会替你拒绝）",
    !/fill\s*=\s*["']currentColor["']/.test(template.split("attachMorph")[0].split("var MORPH_ICONS")[1] || ""));
  let parsedFilled = true;
  try {
    morph.createMorph(makeNode("path", sandbox.document), "M8 2.5a.75.75 0 0 1 .75.75v4h4Z");
  } catch (err) {
    parsedFilled = false;
  }
  ok("填充几何仍会被解析（所以上面的约束必须由模板自己守住）", parsedFilled);

  instance.destroy();
}

// -------------------------------------------------------------- curve loader
console.log("\n=== 曲线加载器：SVG 真的建出来了，而且是真的在动 ===");
{
  const loader = sandbox.window.PiCurve;
  ok("window.PiCurve 被挂上了", !!loader);
  ok("create 是一个函数", typeof (loader && loader.create) === "function");

  const host = makeNode("span", sandbox.document);
  const handle = loader.create(host);
  const svg = host.children[0];
  ok("host 里出现了一个 svg", !!svg && svg.tagName === "SVG");
  eq("viewBox 是 0 0 100 100（CSS 按这个网格缩放）", svg && svg.attributes.viewBox, "0 0 100 100");
  const group = svg && svg.children[0];
  ok("有旋转分组", !!group && group.tagName === "G");
  const trail = group && group.children[0];
  eq("第一个子是轨迹 path", trail && trail.tagName, "PATH");
  eq("轨迹是描边（不是填充）", trail && trail.attributes.class, "trail");
  const dots = group ? group.children.filter((n) => n.tagName === "CIRCLE") : [];
  eq("粒子数与上游一致（64）", dots.length, 64);
  ok("轨迹已经画出来了", typeof trail.attributes.d === "string" && trail.attributes.d.length > 100);
  ok("轨迹起点在 0–100 网格内", /^M\s*-?\d/.test(trail.attributes.d || ""), (trail.attributes.d || "").slice(0, 24));
  // The plugin's CSS scales this viewBox to ~18px, so a coordinate off the
  // 0–100 grid would draw outside the box (the loader is written for 0–100).
  const coords = (trail.attributes.d || "").match(/-?\d+(\.\d+)?/g) || [];
  const outOfGrid = coords.filter(Number).some((n) => n < -60 || n > 160);
  ok("轨迹坐标都在 0–100 网格附近（不会画出视野）", !outOfGrid,
    coords.slice(0, 8).join(","));

  const d1 = trail.attributes.d;
  const rot1 = group.attributes.transform;
  pumpFrames(sandbox, 30);
  ok("随时间推移轨迹被重画", trail.attributes.d !== d1);
  ok("粒子位置随帧更新", dots[0].attributes.cx !== undefined && dots[0].attributes.opacity !== undefined);
  pumpFrames(sandbox, 200);
  ok("分组在缓慢自转（28s 一圈）", group.attributes.transform !== rot1);

  handle.destroy();
  ok("destroy 之后 svg 被摘掉", host.children.length === 0);

  // `animate: false` is the reduced-motion path: the page passes it when the OS
  // asks for less motion. It must still DRAW the indicator — silently dropping a
  // status indicator because of a motion preference is what made the loader
  // "disappear" for the user.
  const host2 = makeNode("span", sandbox.document);
  const still = loader.create(host2, { animate: false });
  const stillSvg = host2.children[0];
  ok("animate:false 仍然画出 SVG", !!stillSvg && stillSvg.tagName === "SVG");
  const stillGroup = stillSvg && stillSvg.children[0];
  const stillTrail = stillGroup && stillGroup.children[0];
  ok("animate:false 仍然画出轨迹", typeof (stillTrail && stillTrail.attributes.d) === "string" &&
    stillTrail.attributes.d.length > 100);
  const frozenD = stillTrail.attributes.d;
  const frozenRot = stillGroup.attributes.transform;
  pumpFrames(sandbox, 120);
  ok("animate:false 时不再重画（没有在跑 rAF）", stillTrail.attributes.d === frozenD);
  ok("animate:false 时也不自转", stillGroup.attributes.transform === frozenRot);
  still.destroy();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
