/**
 * Mechanical fidelity check for the design-system port.
 *
 * The renderer is a port of the "鲸唤 Summon 原型源码包 v1.4" prototype. Reviewing
 * that by eye is unreliable, so this asserts the parts that are objective:
 *
 *   1. every design token the prototype defines still exists in the ported CSS
 *   2. every design token the ported CSS *uses* is one the prototype defines
 *      (catches invented token names that silently resolve to nothing)
 *   3. every `<use href="#i-...">` resolves to a `<symbol>` in the inline sprite
 *   4. the port only calls bridge channels main.js actually implements
 *   5. no remote resources (the plugin page must work offline)
 *   6. the full-bleed root element is NOT marked data-pi-plugin-no-drag
 *      (that once made the window impossible to move)
 *   7. a close affordance exists (a widget has no host titlebar capsule)
 *
 * Run:  node tools/check-design-port.mjs
 */

import { readFile, readdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const PLUGIN = path.join(repoRoot, "plugins", "local.summon-chat");
const RENDERER = path.join(PLUGIN, "renderer");

const PROTO_DIR = path.join(repoRoot, "鲸唤 Summon 原型源码包 v1.4");
const PROTO = path.join(PROTO_DIR, "index.html");

// Prototype line ranges, as documented in the source README.
const TOKEN_RANGE = [7, 113];
const SPRITE_RANGE = [115, 161];

let failures = 0;
function ok(label, condition, detail) {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition && detail) console.log(`      ${detail}`);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const protoLines = (await readFile(PROTO, "utf8")).split(/\r?\n/);
const slice = ([from, to]) => protoLines.slice(from - 1, to).join("\n");
const tokenBlock = slice(TOKEN_RANGE);
const spriteBlock = slice(SPRITE_RANGE);

const protoTokens = new Set([...tokenBlock.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));

// ---- the ported surface (html + any CSS it links) --------------------------
const htmlPath = path.join(RENDERER, "index.html");
const html = await readFile(htmlPath, "utf8");

const linkedCss = [];
for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/gi)) linkedCss.push(m[1]);
let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
for (const href of linkedCss) {
  const cssPath = path.resolve(RENDERER, href.replace(/^\.\//, ""));
  if (await exists(cssPath)) css += "\n" + (await readFile(cssPath, "utf8"));
  else ok(`linked stylesheet ${href} exists`, false);
}

console.log(`proto tokens: ${protoTokens.size}   ported css: ${css.length} bytes` +
  (linkedCss.length ? `   (linked: ${linkedCss.join(", ")})` : "") + "\n");

// ---- spec hard rules ------------------------------------------------------
// The app's own container queries (§4) are load-bearing at narrow widths, and
// prefers-reduced-motion is an accessibility requirement. Both sit at the END of
// the prototype's component block, where a range mistake cuts them silently —
// that is exactly what happened once: cutting at 489 dropped the @container
// rules that hide long chip labels below 400px.
ok("移植后包含设计系统的容器查询（@container）", /@container/.test(css));
ok("移植后包含 prefers-reduced-motion", /prefers-reduced-motion/.test(css));

// Every class the MARKUP uses must have at least one CSS rule. Inventing an
// unstyled wrapper is how the scroll area broke: the wrapper around .msg-area
// needed `flex:1; min-height:0; position:relative`, and without it the list
// could not scroll internally, the toolbars were pushed out of view, and the
// fade band anchored to the wrong ancestor so the blur landed mid-transcript.
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
const usedClasses = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  m[1].split(/\s+/).filter(Boolean).forEach((c) => usedClasses.add(c));
}
const unstyled = [...usedClasses].filter((c) => !cssClasses.has(c)).sort();
ok(`界面用到的 ${usedClasses.size} 个 class 都有对应样式`, unstyled.length === 0,
  unstyled.length ? `没有任何 CSS 规则：${unstyled.join(", ")}` : "");

// design-spec §9: colours may only come from variables. The banned literals are
// legitimate on a token-definition line (that is where the values live); any
// other occurrence is a violation.
const BANNED = /(#fff\b|#ffffff\b|#eceef1\b|#e8eaed\b|rgba\(\s*255\s*,\s*255\s*,\s*255)/i;
const colourViolations = [];
for (const line of css.split(/\r?\n/)) {
  if (!BANNED.test(line)) continue;
  if (/^\s*--[a-zA-Z0-9-]+\s*:/.test(line)) continue;
  colourViolations.push(line.trim().slice(0, 96));
}
ok("元素样式里没有禁用的纯白/浅灰字面量（只允许出现在 Token 定义行）",
  colourViolations.length === 0,
  colourViolations.slice(0, 5).join("\n      "));

// The spec does not tokenise z-index; the prototype's values are the contract
// for overlay layers. Small values are local stacking and are fine.
const Z_ALLOWED = new Set([400, 450, 460, 500, 600]);
const badZ = new Set();
for (const m of css.matchAll(/z-index\s*:\s*(-?\d+)/g)) {
  const n = Number(m[1]);
  if (n < 100) continue;
  if (!Z_ALLOWED.has(n)) badZ.add(n);
}
ok("遮罩/抽屉/弹层的 z-index 取自原型约定（400/450/460/500/600）",
  badZ.size === 0,
  badZ.size ? `出现了 ${[...badZ].join(", ")}` : "");

// The one sanctioned deviation from the design: the user asked for a true-black
// dark theme, where the design's dark surface is a near-black. The override is
// appended, so scan EVERY dark block — the first one is the vendored original.
const darkBlocks = [...css.matchAll(/\[data-theme=["']?dark["']?\]\s*\{([^}]*)\}/g)].map((m) => m[1]);
ok("使用了设计系统的 data-theme 主题机制", darkBlocks.length > 0);
ok(`暗色主题的底色被覆写为纯黑 #000（找到 ${darkBlocks.length} 个暗色块）`,
  darkBlocks.some((b) => /--bg\s*:\s*#000(?:000)?\b/i.test(b)),
  "没有任何暗色块把 --bg 设为 #000");

// 1. token coverage
const missingTokens = [...protoTokens].filter((t) => !css.includes(t));
ok(`全部 ${protoTokens.size} 个设计 Token 都出现在移植后的 CSS 里`,
  missingTokens.length === 0,
  missingTokens.length ? `缺失 ${missingTokens.length} 个：${missingTokens.slice(0, 12).join(", ")}` : "");

// 2. no invented tokens
const usedTokens = new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
const invented = [...usedTokens].filter((t) => !protoTokens.has(t));
ok("没有自造 Token（每个 var() 都能在原型里找到定义）",
  invented.length === 0,
  invented.length ? `自造：${invented.join(", ")}` : "");

// 3. icon sprite resolves
const spriteIds = new Set([...spriteBlock.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
const portedIds = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
const usedIcons = new Set([...html.matchAll(/<use[^>]+href="#([^"]+)"/g)].map((m) => m[1]));
const danglingIcons = [...usedIcons].filter((id) => !portedIds.has(id));
ok(`用到的 ${usedIcons.size} 个图标都在内联 sprite 里`,
  danglingIcons.length === 0,
  danglingIcons.length ? `悬空引用：${danglingIcons.join(", ")}` : "");
ok(`图标 sprite 已从原型带入（原型 ${spriteIds.size} 个，移植后 ${portedIds.size} 个）`,
  portedIds.size > 0,
  "内联 sprite 没有被带过来");

// 4. bridge channels used must be implemented
const mainJs = await readFile(path.join(PLUGIN, "main.js"), "utf8");
const implemented = new Set(
  [...mainJs.matchAll(/case\s+"(summon\.chat\.[A-Za-z]+)"/g)].map((m) => m[1]),
);
const invoked = new Set(
  [...html.matchAll(/invoke\(\s*"(summon\.chat\.[A-Za-z]+)"/g)].map((m) => m[1]),
);
const unimplemented = [...invoked].filter((c) => !implemented.has(c));
ok(`界面调用的 ${invoked.size} 个通道 main.js 都实现了`,
  unimplemented.length === 0,
  unimplemented.length ? `未实现：${unimplemented.join(", ")}` : "");

// 5. offline
const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
ok("没有远程资源引用（离线可用）", remote.length === 0, remote.join(", "));

// 6. the drag-map trap: the full-bleed root must stay draggable
const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
const firstTag = bodyMatch ? /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/.exec(bodyMatch[1]) : null;
if (!firstTag) {
  ok("能找到 body 的第一个元素", false);
} else {
  const carriesNoDrag = /\bdata-pi-plugin-no-drag\b/.test(firstTag[2]);
  ok(`铺满窗口的根元素 <${firstTag[1]}> 没有被标记 data-pi-plugin-no-drag`,
    !carriesNoDrag,
    carriesNoDrag ? "这会让整个窗口无法拖动" : "");
  ok("至少有一处 data-pi-plugin-no-drag（交互区需要豁免拖动）",
    html.includes("data-pi-plugin-no-drag"));
}

// 7. a widget has no host capsule, so the page needs its own close
ok("提供了关闭入口（widget 形态没有宿主标题栏按钮）",
  /invoke\(\s*"summon\.chat\.dismiss"/.test(html));

// 8. the settings/behaviour surface survived the port
const mustExist = [
  ["角色选择器", /summon\.chat\.setDefaultRole/],
  ["模型选择器", /summon\.chat\.setModelKey/],
  ["思考档位", /summon\.chat\.configureSession/],
  ["会话列表", /summon\.chat\.listSessions/],
  ["transcript 轮询", /summon\.chat\.readTranscript/],
  ["快捷对话", /summon\.chat\.sendQuick/],
  ["Agent 发送", /summon\.chat\.sendAgent/],
  ["进度指示", /summon\.chat\.progress/],
  ["角色保存", /summon\.chat\.saveRoles/],
  ["设置保存", /summon\.chat\.saveSettings/],
  ["心跳", /summon\.chat\.heartbeat/],
  ["中文档位标签", /无[\s\S]*低[\s\S]*中[\s\S]*高/],
];
for (const [label, re] of mustExist) ok(`移植后仍保留：${label}`, re.test(html) || re.test(css));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
