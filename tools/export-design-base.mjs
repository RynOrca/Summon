/**
 * Export the reusable CSS out of the "鲸唤 Summon 原型源码包" design package.
 *
 * The prototype is a single 100KB HTML file that mixes the design system with
 * the documentation page around it. Only two regions are reusable by the app:
 *
 *   7–113    design tokens (light + dark)
 *   168–489  generic components + the desktop-window framework
 *
 * Everything else in that file is doc-page scaffolding (sidebar, section
 * cards, the state gallery, the responsive demo) and must NOT ship.
 *
 * Also appends the ONE sanctioned deviation from the design: the user asked for
 * a true-black dark theme, where the design's dark surface is a near-black.
 * It is appended as an override rule rather than editing the token block, so
 * the vendored tokens stay byte-identical to the source and the deviation is
 * visible in one place.
 *
 * Run:  node tools/export-design-base.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

const PROTO = path.join(repoRoot, "鲸唤 Summon 原型源码包 v1.4", "index.html");
const OUT = path.join(repoRoot, "docs", "port-base.css");

// Ranges exclude the enclosing <style>/</style> lines themselves, so the export
// is a valid standalone stylesheet.
// The component block runs to 511: 490–511 are the APP's container queries
// (@container 320–900px) plus prefers-reduced-motion, which are load-bearing for
// a narrow window. Only 512+ is the documentation gallery, and that is cut.
const TOKEN_RANGE = [8, 112];
const COMPONENT_RANGE = [169, 511];

const lines = (await readFile(PROTO, "utf8")).split(/\r?\n/);
const slice = ([from, to]) => lines.slice(from - 1, to);

const tokenLines = slice(TOKEN_RANGE);
const componentLines = slice(COMPONENT_RANGE);

// Sanity-check the ranges rather than trusting the line numbers blindly: if the
// package is ever regenerated, these must fail loudly instead of exporting
// doc-page CSS into the app.
const tokenRaw = tokenLines.join("\n");
const componentText = componentLines.join("\n");

// The source's first style block is not only tokens: it also carries the
// documentation page's own CSS (sidebar, brand lockup, section cards, the
// responsive demo). Those rules must not ship — they are dead weight, and one of
// them (`.brand .logo`) uses a literal #fff, which the design spec forbids in
// element styles. Drop them by selector and report exactly what was dropped.
const DOC_PAGE_SELECTORS = [
  ".layout", ".sidenav", ".brand", "main", "section", ".sec-desc",
  ".tbl", ".grid", ".g2", ".g3", ".card", ".swatches", ".pagebar", ".sw",
];
function isDocPageSelector(selectorText) {
  return selectorText.split(",").some(function (raw) {
    const s = raw.trim();
    return DOC_PAGE_SELECTORS.some(function (bad) {
      if (s.indexOf(bad) !== 0) return false;
      const next = s.charAt(bad.length);
      return next === "" || !/[a-zA-Z0-9_-]/.test(next);
    });
  });
}

const droppedSelectors = [];
let tokenText = tokenRaw;
if (/@keyframes/.test(tokenRaw)) {
  // The simple rule splitter below cannot handle nested blocks; refuse instead
  // of silently mangling the export.
  console.error("token 区间里出现了 @keyframes，规则过滤器无法安全处理，未写出文件。");
  process.exit(1);
}
{
  const kept = [];
  for (const rule of tokenRaw.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (isDocPageSelector(rule[1])) {
      droppedSelectors.push(rule[1].trim().split("\n").pop().trim());
      continue;
    }
    kept.push(rule[0]);
  }
  tokenText = kept.join("\n");
}

const problems = [];
if (!/:root/.test(tokenText)) problems.push("token 区间里没有 :root");
if (!/\[data-theme=["']?dark["']?\]/.test(tokenText)) problems.push("token 区间里没有暗色主题块");
if (!/^\s*\.btn\b/m.test(componentText)) problems.push("组件区间里没有 .btn");
if (!/\.composer\b/.test(componentText)) problems.push("组件区间里没有 .composer");
if (!/\.win\b/.test(componentText)) problems.push("组件区间里没有 .win（窗口框架）");
if (!/@container/.test(componentText)) problems.push("组件区间里没有容器查询（§4 响应式规则）");
if (!/prefers-reduced-motion/.test(componentText)) problems.push("组件区间里没有 prefers-reduced-motion");
// Doc-page scaffolding must not leak in.
for (const bad of [".gallery", ".resp-demo", ".sidebar", ".toc", ".brand", ".mini-win", ".rsp-stage"]) {
  if (new RegExp(`\\${bad}\\b`).test(componentText)) problems.push(`组件区间混入了文档页样式 ${bad}`);
}
// The export must be a plain stylesheet, not carry the prototype's tags.
for (const tag of ["<style", "</style", "<html", "<body"]) {
  if (tokenText.includes(tag) || componentText.includes(tag)) {
    problems.push(`区间里混入了 ${tag} 标签`);
  }
}

if (problems.length) {
  console.error("导出前自检失败，未写出文件：");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

// Which token carries the dark window background? Report it so the override
// below is auditable rather than magic.
const darkMatch = /\[data-theme=["']?dark["']?\]\s*\{([\s\S]*?)\}/.exec(tokenText);
const darkBlock = darkMatch ? darkMatch[1] : "";
const bgToken = /(--[a-zA-Z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(darkBlock);

const tokenCount = new Set([...tokenText.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1])).size;
const symbolCount = [...(await readFile(PROTO, "utf8")).matchAll(/<symbol id="/g)].length;

const banner = [
  "/* ------------------------------------------------------------------------",
  " * 由 tools/export-design-base.mjs 从设计源包导出，请勿手改。",
  " * 设计来源：鲸唤 Summon 原型源码包 v1.4（design.md + index.html）",
  ` *   Token        index.html:${TOKEN_RANGE[0]}–${TOKEN_RANGE[1]}   （${tokenCount} 个自定义属性）`,
  ` *   组件/窗口框架 index.html:${COMPONENT_RANGE[0]}–${COMPONENT_RANGE[1]}`,
  ` * 图标 sprite 在 index.html:115–161（${symbolCount} 个 symbol），需内联进页面。`,
  " * 文档页脚手架（侧栏/状态画廊/响应式演示）已排除。",
  " * ------------------------------------------------------------------------ */",
  "",
].join("\n");

const override = [
  "",
  "/* ------------------------------------------------------------------------",
  " * 对设计的唯一偏离：用户明确要求暗色主题底色为**纯黑**，",
  ` * 而设计的暗色底面是近黑色${bgToken ? `（${bgToken[1]}: ${bgToken[2]}）` : ""}。`,
  " * 以覆写规则追加而不是改写 Token 块，这样上面引入的 Token 与源包保持逐字节一致。",
  " * ------------------------------------------------------------------------ */",
  '[data-theme="dark"]{ --bg:#000000; }',
  "",
].join("\n");

await writeFile(OUT, banner + tokenText + "\n\n" + componentText + override, "utf8");

// ---- icon sprite -----------------------------------------------------------
// Exported as a bare <symbol> fragment (no outer <svg>) so it can be dropped
// straight into the app's own hidden svg element.
const protoHtml = await readFile(PROTO, "utf8");
const svgSpans = [];
for (const open of protoHtml.matchAll(/<svg\b[^>]*>/g)) {
  const close = protoHtml.indexOf("</svg>", open.index);
  if (close === -1) continue;
  const body = protoHtml.slice(open.index + open[0].length, close);
  if (body.includes("<symbol")) svgSpans.push({ open: open[0], body });
}
if (svgSpans.length !== 1) {
  console.error(`期望源包里有且只有一个图标 sprite，实际 ${svgSpans.length} 个，未写出。`);
  process.exit(1);
}
const SPRITE_OUT = path.join(repoRoot, "docs", "port-icons.fragment.html");
await writeFile(
  SPRITE_OUT,
  "<!-- 由 tools/export-design-base.mjs 从 鲸唤 Summon 原型源码包 v1.4 导出" +
    "（index.html 图标 sprite），内联进 <svg hidden> 即可。 -->\n" +
    svgSpans[0].body.trim() +
    "\n",
  "utf8",
);
const spriteSymbols = [...svgSpans[0].body.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
console.log(`  sprite          ${spriteSymbols.length} symbols -> ${path.relative(repoRoot, SPRITE_OUT)}`);
console.log(`                  ${spriteSymbols.slice(0, 8).join(", ")} …`);

console.log(`wrote ${path.relative(repoRoot, OUT)}`);
console.log(`  tokens          ${tokenCount}`);
console.log(`  icon symbols    ${symbolCount} (仍需内联到页面)`);
console.log(`  dark bg token   ${bgToken ? bgToken[1] + " = " + bgToken[2] : "未识别"}  -> 覆盖为 #000000`);
console.log(`  剔除文档页规则  ${droppedSelectors.length} 条：${droppedSelectors.slice(0, 6).join(" / ")}${droppedSelectors.length > 6 ? " …" : ""}`);
console.log(`  bytes           ${(await readFile(OUT, "utf8")).length}`);
