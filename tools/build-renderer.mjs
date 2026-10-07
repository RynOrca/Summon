/**
 * Assemble the shipped renderer from the template + the vendored design system.
 *
 * The plugin page must stay a SINGLE self-contained HTML file: the host serves
 * `manifest.ui.panel` as one sandboxed page, and a build step is the only way to
 * keep the 26KB of design CSS vendored rather than copy-pasted (copy-paste is
 * how the two drift apart).
 *
 *   renderer/renderer.template.html   hand-written markup + behaviour
 *   docs/port-base.css                exported from the design package
 *   docs/port-icons.fragment.html     exported icon sprite
 *   docs/vendor/*.js                  third-party effects (see docs/vendor/README.md)
 *          ->  renderer/index.html     what actually ships
 *
 * Run `npm run build:renderer` after editing the template, the exports, or the
 * design package. `npm run verify` checks the built file.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

const TEMPLATE = path.join(repoRoot, "plugins", "local.summon-chat", "renderer", "renderer.template.html");
const CSS = path.join(repoRoot, "docs", "port-base.css");
const ICONS = path.join(repoRoot, "docs", "port-icons.fragment.html");
const OUT = path.join(repoRoot, "plugins", "local.summon-chat", "renderer", "index.html");

/**
 * Third-party effects, inlined in this order. They are plain classic scripts
 * (each ends by assigning one `window.Pi*` namespace), so order only matters for
 * readability — neither reads the other.
 */
const VENDOR = [
  path.join(repoRoot, "docs", "vendor", "morphicons.js"),
  path.join(repoRoot, "docs", "vendor", "curve-loader.js"),
];

const CSS_PLACEHOLDER = "__DESIGN_CSS__";
const ICON_PLACEHOLDER = "__ICONS__";
const VENDOR_PLACEHOLDER = "__VENDOR_JS__";

const template = await readFile(TEMPLATE, "utf8");
const css = await readFile(CSS, "utf8");
const icons = await readFile(ICONS, "utf8");
const vendor = (
  await Promise.all(VENDOR.map(async (file) => (await readFile(file, "utf8")).trim()))
).join("\n\n");

const problems = [];
for (const [name, needle] of [
  ["CSS", CSS_PLACEHOLDER],
  ["图标", ICON_PLACEHOLDER],
  ["第三方动效", VENDOR_PLACEHOLDER],
]) {
  const count = template.split(needle).length - 1;
  if (count !== 1) problems.push(`模板里 ${name} 占位符应恰好出现 1 次，实际 ${count} 次`);
}
if (/<\/style>/i.test(css)) problems.push("导出的 CSS 里混入了 </style>");
if (/<\/script>/i.test(vendor)) problems.push("第三方动效里混入了 </script>（会提前切断内联脚本）");
// Strip comments first: the fragment's own banner mentions the <svg> tag.
const iconBody = icons.replace(/<!--[\s\S]*?-->/g, "");
if (/<svg\b/i.test(iconBody)) problems.push("图标片段里混入了外层 <svg> 标签");
if (!/\[data-theme=["']?dark["']?\]/.test(css)) problems.push("导出的 CSS 缺少暗色主题块");
if (!/<symbol\s+id="/.test(iconBody)) problems.push("图标片段里没有 symbol");

if (problems.length) {
  console.error("构建前自检失败，未写出 index.html：");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

const html = template
  .split(CSS_PLACEHOLDER).join(css.trim())
  .split(ICON_PLACEHOLDER).join(icons.trim())
  .split(VENDOR_PLACEHOLDER).join(vendor);

// Post-build checks: catching these here is far cheaper than in the app.
const tokenCount = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1])).size;
const failure = [];
if ([CSS_PLACEHOLDER, ICON_PLACEHOLDER, VENDOR_PLACEHOLDER].some((p) => html.includes(p))) {
  failure.push("占位符没有全部替换");
}
if (!/data-pi-plugin-no-drag/.test(html)) failure.push("没有任何可交互区域豁免拖动");
// The two effects live behind these namespaces; a vendor file that silently
// stopped assigning them would leave every animation dead but the page alive.
for (const ns of ["window.PiMorph", "window.PiCurve"]) {
  if (!html.includes(ns)) failure.push(`第三方动效没有挂载 ${ns}`);
}
if (!/--fade-h\s*:/.test(html)) failure.push("缺少 --fade-h：模糊带与输入区渐变底会各算各的");
// Comments are stripped first: the <head> note quotes `<body>` in prose, and a
// naive search would evaluate that sentence instead of the real root element.
const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
const firstAfterBody = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(htmlWithoutComments);
if (firstAfterBody) {
  const root = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/.exec(firstAfterBody[1]);
  if (root && /\bdata-pi-plugin-no-drag\b/.test(root[2])) {
    failure.push("铺满窗口的根元素被标记了 data-pi-plugin-no-drag（会导致窗口无法拖动）");
  }
}
if (failure.length) {
  console.error("构建后自检失败，未写出 index.html：");
  for (const f of failure) console.error("  - " + f);
  process.exit(1);
}

// `--check` turns this into a gate: a template edited without a rebuild would
// otherwise ship a stale page that no test looks at.
if (process.argv.includes("--check")) {
  const existing = existsSync(OUT) ? await readFile(OUT, "utf8") : "";
  if (existing !== html) {
    console.error("renderer/index.html 与模板/设计基座不一致 —— 请运行 npm run build:renderer");
    process.exit(1);
  }
  console.log("renderer/index.html 与模板、设计基座一致");
  process.exit(0);
}

await writeFile(OUT, html, "utf8");
console.log(`built ${path.relative(repoRoot, OUT)}`);
console.log(`  from   ${path.relative(repoRoot, TEMPLATE)}`);
console.log(`         ${path.relative(repoRoot, CSS)}  (${tokenCount} tokens)`);
console.log(`         ${path.relative(repoRoot, ICONS)}`);
for (const file of VENDOR) console.log(`         ${path.relative(repoRoot, file)}`);
console.log(`  size   ${html.length} bytes`);