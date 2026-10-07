/**
 * Vendor the curve-trail loading animation into docs/vendor/curve-loader.js.
 *
 * Source: https://github.com/Paidax01/math-curve-loaders — `original.js` /
 * `original.html` on `main`. That file is the standalone "original particle
 * trail loader" (MIT). This script downloads it and wraps it so the plugin can
 * use it without a second resource file:
 *
 *   · the upstream constants and the two curve functions are kept **verbatim**
 *     (64 particles, 7 petals, 4.6s loop, 4.2s pulse, 28s rotation, …) — that is
 *     the whole reason for using this library, so parametric drift here would
 *     defeat the point;
 *   · only the shell around them is new: it takes a host element instead of
 *     module-scope `document.querySelector` ids, exposes
 *     `window.PiCurve.create(host, opts)`, and shares ONE requestAnimationFrame
 *     across every instance (the gallery drove one instance per card).
 *
 * The rewritten shell is what makes the download reproducible: the upstream file
 * is never edited, so re-running this script after an upstream change is safe.
 *
 * Why the animation is worth inlining at all: the design base's own status
 * spinner is a 0.8s rotating ring, and the user's note was that it moves too
 * fast. This loader's slowest rhythm (4.6s) is the fix.
 *
 * Run:  node tools/fetch-curve-loader.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const OUT = path.join(repoRoot, "docs", "vendor", "curve-loader.js");

// raw.githubusercontent.com is DNS-blackholed on the authoring machine, and the
// ghfast mirror presents a chain Node's fetch will not verify, so the jsDelivr
// copy of the same GitHub file is the default. All three are listed so the
// script survives whichever of them this machine can reach.
const SOURCE_URLS = [
  "https://cdn.jsdelivr.net/gh/Paidax01/math-curve-loaders@main/original.js",
  "https://raw.githubusercontent.com/Paidax01/math-curve-loaders/main/original.js",
  "https://ghfast.top/https://raw.githubusercontent.com/Paidax01/math-curve-loaders/main/original.js",
];

const failures = [];
let upstream = "";
for (const url of SOURCE_URLS) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    upstream = await response.text();
    if (!upstream.includes("function getPoint(")) throw new Error("downloaded file is not the loader");
    console.log(`  source ${url}`);
    break;
  } catch (error) {
    failures.push(`${url} → ${error.message}`);
  }
}
if (!upstream) {
  throw new Error(`could not download the upstream loader:\n  ${failures.join("\n  ")}`);
}

// ---------------------------------------------------------------------------
// Reuse the upstream curve verbatim, and prove we did. The two functions below
// are extracted from the downloaded text (not retyped), so a silent upstream
// change cannot leave this file describing an algorithm it no longer contains.
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`upstream no longer defines ${name}()`);
  let depth = 0;
  let seenBrace = false;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") { depth++; seenBrace = true; } else if (ch === "}") {
      depth--;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}()`);
}

const constBlock = /^const (?:PARTICLE_COUNT|BASE_RADIUS|PETALS|DETAIL|SCALE|TRAIL_SPAN|ROTATION_DURATION_MS|PULSE_DURATION_MS|DURATION_MS)\b.*$/gm;
const constants = upstream.match(constBlock);
if (!constants || constants.length !== 9) {
  throw new Error(`expected 9 upstream constants, found ${constants ? constants.length : 0}`);
}

const getPoint = extractFunction(upstream, "getPoint");
const buildPath = extractFunction(upstream, "buildPath");
const getDetailScale = extractFunction(upstream, "getDetailScale");
const getRotation = extractFunction(upstream, "getRotation");
const getParticle = extractFunction(upstream, "getParticle");
const normalizeProgress = extractFunction(upstream, "normalizeProgress");
for (const [name, body] of Object.entries({ getPoint, buildPath, getDetailScale, getRotation, getParticle })) {
  if (!body) throw new Error(`${name} extraction failed`);
}

const banner = `/* ------------------------------------------------------------------------
 * 数学曲线加载动效 —— 粒子轨迹（rose / 七瓣花环）
 * 上游：https://github.com/Paidax01/math-curve-loaders   （original.js / original.html, main 分支）
 * 许可证：MIT   原作者：Paidax01
 *
 * 本文件由 tools/fetch-curve-loader.mjs 生成，请勿手改。
 * 生成方式：下载上游 original.js，**原样取出**它的 9 个常量与 5 个函数
 * （normalizeProgress / getPoint / buildPath / getDetailScale / getRotation /
 * getParticle），只把外面的壳换掉 —— 上游用模块级 document.querySelector 绑死
 * 单个固定 id，这里改成 PiCurve.create(host) 并让所有实例共用一条 rAF。
 * 曲线参数一个都没动：64 粒子、7 瓣、4.6s 一圈、4.2s 呼吸、28s 自转。
 *
 * 用法：PiCurve.create(document.getElementById("statusAnim"))
 *       → { destroy() }
 * ------------------------------------------------------------------------ */
`;

const shell = `
// ---------------------------------------------------------------- 实例外壳
// 上游在一个模块里只驱动一个固定 id 的 SVG；插件里状态行动画、工具条目动画
// 都可能同时存在，所以这里按实例管理，并且**共用一条 rAF**：N 个实例也只跑
// 一个回调（上游画廊就是一个卡片一条 rAF，那是它自己的场景）。
var instances = [];
var running = false;
var SVG_NS = "http://www.w3.org/2000/svg";

function createSvg() {
  var svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  var group = document.createElementNS(SVG_NS, "g");
  var path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "trail");
  path.setAttribute("stroke-width", String(STROKE_WIDTH));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  group.appendChild(path);
  svg.appendChild(group);
  var dots = [];
  for (var i = 0; i < PARTICLE_COUNT; i++) {
    var circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", "dot");
    group.appendChild(circle);
    dots.push(circle);
  }
  return { svg: svg, group: group, path: path, dots: dots };
}

function renderInstance(instance, time) {
  var progress = (time % DURATION_MS) / DURATION_MS;
  var detailScale = getDetailScale(time);
  instance.group.setAttribute("transform", "rotate(" + getRotation(time) + " 50 50)");
  instance.path.setAttribute("d", buildPath(detailScale));
  for (var i = 0; i < instance.dots.length; i++) {
    var particle = getParticle(i, progress, detailScale);
    var node = instance.dots[i];
    node.setAttribute("cx", particle.x.toFixed(2));
    node.setAttribute("cy", particle.y.toFixed(2));
    node.setAttribute("r", particle.radius.toFixed(2));
    node.setAttribute("opacity", particle.opacity.toFixed(3));
  }
}

function tick(now) {
  for (var i = 0; i < instances.length; i++) {
    renderInstance(instances[i], now - instances[i].startedAt);
  }
  if (instances.length) requestAnimationFrame(tick);
  else running = false;
}

function start() {
  if (running) return;
  running = true;
  requestAnimationFrame(tick);
}

/**
 * 把动效挂到 host 元素里。host 里已有的内容会被清掉 —— 调用方每次重建即可，
 * 重复 create 同一个 host 不会叠加元素。
 *
 * opts.animate === false（宿主开了 prefers-reduced-motion）时**照样画第一帧**，
 * 只是不启动 rAF。页面把「减少动态效果」当成「不要这个状态指示器」是错的。
 */
function create(host, opts) {
  if (!host) return { destroy: function () {} };
  var animate = !(opts && opts.animate === false);
  var built = createSvg();
  host.textContent = "";
  host.appendChild(built.svg);
  var instance = {
    host: host,
    group: built.group,
    path: built.path,
    dots: built.dots,
    startedAt: performance.now(),
  };
  renderInstance(instance, 0);
  if (animate) {
    instances.push(instance);
    start();
  }
  return {
    destroy: function () {
      var at = instances.indexOf(instance);
      if (at !== -1) instances.splice(at, 1);
      if (built.svg.parentNode) built.svg.parentNode.removeChild(built.svg);
    },
  };
}

window.PiCurve = { create: create };
})();
`;

// STROKE_WIDTH comes from original.html's markup (`stroke-width="5.5"`), which
// lives on the <svg> rather than in original.js — kept as a named constant here
// so the value is visible next to the rest of the tuned parameters.
const bundle =
  `${banner}(function () {\n"use strict";\n\n` +
  `${constants.join("\n")}\nvar STROKE_WIDTH = 5.5;\n\n` +
  `${normalizeProgress}\n\n${getPoint}\n\n${buildPath}\n\n${getDetailScale}\n\n${getRotation}\n\n${getParticle}\n` +
  shell;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, bundle, "utf8");
console.log(`wrote ${path.relative(repoRoot, OUT)}`);
console.log(`  upstream ${upstream.length} bytes → bundle ${bundle.length} bytes`);
console.log(`  reused verbatim: ${constants.length} constants + 6 functions`);
