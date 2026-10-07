/**
 * Mechanical fidelity check for the design-system port.
 *
 * The renderer is a port of the "鲸唤 Summon 原型源码包 v1.4" prototype. Reviewing
 * that by eye is unreliable, so this asserts the parts that are objective:
 *
 *   1. every design token the prototype defines still exists in the ported CSS
 *   2. every design token the ported CSS *uses* is one the prototype defines
 *      (catches invented token names that silently resolve to nothing);
 *      host-published variables are the one allowed exception
 *   3. every `<use href="#i-...">` resolves to a `<symbol>` in the inline sprite
 *   4. the port only calls bridge channels main.js actually implements
 *   5. no remote resources (the plugin page must work offline)
 *   6. the full-bleed root element is NOT marked data-pi-plugin-no-drag
 *      (that once made the window impossible to move)
 *   7. a close affordance exists (Escape still dismisses the window; the host
 *      owns the titlebar capsule in `panel` shape)
 *   8. the tool's role/settings surface survived the port
 *   9. the deliberate palette deviation: the dark Tokens carry PI-Desktop's own
 *      grey ramp (#181818 page, white accent) instead of the prototype's blue
 *  10. the panel chrome contract: the page opts into the v2 spacing rules,
 *      reserves the host's 46px drag band exactly once, and draws a hairline so
 *      that band does not read as a stray empty row
 *
 * The port used to be a byte-for-byte palette copy of the prototype. It is not
 * any more — by request the plugin wears the host app's design tokens — so rules
 * 1/2 now check that every prototype token NAME still exists while the dark
 * VALUES are allowed to be the app's.
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
//
// White is NOT banned any more. The port no longer ships the prototype's blue
// palette: it ships PI-Desktop's own tokens (apps/desktop/src/styles/tokens.css),
// where the secondary/muted/faint text tier IS a white-alpha ramp
// (--ds-text-secondary 70%, --ds-text-muted 52%, --ds-text-faint 38%) and the
// user bubble is an 8% white fill. The literals that stay banned are the
// prototype's own ink values, which must never reappear as a hand-written colour.
const BANNED = /(#eceef1\b|#e8eaed\b|#[0-9a-f]{2}191b1f\b)/i;
const colourViolations = [];
for (const line of css.split(/\r?\n/)) {
  if (!BANNED.test(line)) continue;
  if (/^\s*--[a-zA-Z0-9-]+:/.test(line)) continue;
  colourViolations.push(line.trim().slice(0, 96));
}
ok("元素样式里没有禁用的旧设计墨色字面量（只允许出现在 Token 定义行）",
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

// The dark theme no longer carries the prototype's near-black: the plugin was
// asked to look like the app it lives in, so the dark Tokens are PI-Desktop's
// own grey ramp, whose page surface is #181818 (= builtinWindowBackground("dark")
// and --ds-bg-primary). The appended override is still scanned, so this asserts
// the deliberate deviation instead of the old pure-black one.
const darkBlocks = [...css.matchAll(/\[data-theme=["']?dark["']?\]\s*\{([^}]*)\}/g)].map((m) => m[1]);
ok("使用了设计系统的 data-theme 主题机制", darkBlocks.length > 0);
ok(`暗色主题改用 PI-Desktop 的底色 #181818（找到 ${darkBlocks.length} 个暗色块）`,
  darkBlocks.some((b) => /--bg\s*:\s*#181818\b/i.test(b)),
  "没有任何暗色块把 --bg 设为 #181818（主软件的 --ds-bg-primary）");
ok("暗色主题与主软件同一个中性强调色（白），不是原型里的鲸蓝",
  darkBlocks.some((b) => /--accent-fill\s*:\s*#fff(?:fff)?\b/i.test(b)),
  "暗色块的 --accent-fill 不是 #ffffff");

// 1. token coverage
const missingTokens = [...protoTokens].filter((t) => !css.includes(t));
ok(`全部 ${protoTokens.size} 个设计 Token 都出现在移植后的 CSS 里`,
  missingTokens.length === 0,
  missingTokens.length ? `缺失 ${missingTokens.length} 个：${missingTokens.slice(0, 12).join(", ")}` : "");

// 2. no invented tokens
//
// Two legitimate exceptions, both narrow:
//
//  · host-published variables — the panel preload sets them on the document
//    before any page script runs, so they exist at runtime but cannot be in the
//    prototype's `:root` block;
//  · the plugin's own **geometry** variables — a number shared by two rules that
//    must agree on it. `--fade-h` is one: the blurred band and the composer's
//    gradient floor have to meet on exactly the same line, so both read the same
//    variable instead of repeating a length. They must be declared in a template
//    `:root` block and must never carry a colour — inventing a *colour* token is
//    still the thing this catches.
const HOST_PUBLISHED_TOKENS = new Set(["--pi-plugin-titlebar-height"]);
const PLUGIN_GEOMETRY_TOKENS = new Set(["--fade-h", "--fade-overlap", "--fade-pad"]);
const allowedTokens = new Set([...HOST_PUBLISHED_TOKENS, ...PLUGIN_GEOMETRY_TOKENS]);
const usedTokens = new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
const invented = [...usedTokens].filter((t) => !protoTokens.has(t) && !allowedTokens.has(t));
ok("没有自造 Token（宿主发布的变量与插件的几何变量除外，每个 var() 都能在原型里找到定义）",
  invented.length === 0,
  invented.length ? `自造：${invented.join(", ")}` : "");
// The geometry escape hatch must stay honest: declared, and never a colour.
for (const token of PLUGIN_GEOMETRY_TOKENS) {
  const declaration = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(css);
  ok(`插件自己的 ${token} 有定义，且不是颜色值`,
    !!declaration && !/#|rgb|hsl/i.test(declaration[1]),
    declaration ? `${token}: ${declaration[1].trim()}` : `${token} 没有在 :root 里定义`);
}

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

// 6. the drag-map trap: the full-bleed root must stay draggable.
// Comments are stripped first: the page's <head> note quotes `<body>` in prose,
// and starting the slice inside that sentence made this check evaluate a comment.
const bodyHtml = html.replace(/<!--[\s\S]*?-->/g, "");
const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(bodyHtml);
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

// 7. the host owns the titlebar capsule in `panel` shape, so the page needs a
//    keyboard way out (Escape) rather than a duplicate close button.
ok("提供了关闭入口（面板形态用 Escape 收窗，标题栏胶囊归宿主）",
  /invoke\(\s*"summon\.chat\.dismiss"/.test(html));

// 10. the panel chrome contract. Two ways to get this wrong, and both looked
//     like a bug in the screenshot that prompted this check:
//       - no reservation at all: the topbar hides under the host's window-button
//         capsule and its buttons cannot be clicked;
//       - reserved twice (the host injects `padding-top:46px !important` on
//         <body> unless the page opts into the v2 contract): everything shifts
//         46px too far down and a stray blank row appears.
//     So: opt in via the meta, reserve it in exactly one place, and draw a
//     hairline so the band reads as the host's titlebar area rather than as an
//     unexplained empty row.
const ruleBlocks = (() => {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let depth = 0;
  let start = 0;
  let bodyStart = -1;
  let prelude = "";
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      if (depth === 0) {
        prelude = clean.slice(start, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        out.push({ selector: prelude.trim(), body: clean.slice(bodyStart, i) });
        start = i + 1;
      }
    }
  }
  return out;
})();

const winDecls = {};
for (const rule of ruleBlocks) {
  if (rule.selector !== "#win") continue;
  for (const decl of rule.body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/g)) {
    winDecls[decl[1].trim()] = decl[2].trim();
  }
}
const bandOffsets = ["inset", "top", "margin-top", "padding-top"].filter((prop) => {
  const value = winDecls[prop];
  return value && !/^(0(px)?|auto|none)$/.test(value);
});
ok("预留了宿主的 46px 拖拽带，且只预留一次",
  bandOffsets.length === 1 && bandOffsets[0] === "padding-top",
  bandOffsets.length === 0
    ? "没有任何占位 —— 顶栏会被宿主胶囊盖住"
    : bandOffsets.length > 1
      ? `占位了两次：${bandOffsets.join(" + ")}（内容会整体下移 46px）`
      : `占位方式不是 padding-top，而是 ${bandOffsets[0]}`);
ok("声明了 pi-plugin-chrome=v2（否则宿主的 body padding 会与本页的占位叠加）",
  /<meta[^>]+name=["']pi-plugin-chrome["'][^>]+content=["']v2["']/i.test(html));
ok("拖拽带下方有一条分界线（否则那段高度读起来像凭空多出的一行）",
  /\.pi-has-band\s+\.topbar\s*\{[^}]*border-bottom/.test(css),
  "缺少 .pi-has-band .topbar 的分隔线规则");
ok("分界线的开关由脚本按宿主发布的 --pi-plugin-titlebar-height 决定",
  /getPropertyValue\(\s*"--pi-plugin-titlebar-height"/.test(html) &&
    /classList\.toggle\(\s*"pi-has-band"/.test(html));

// 12. the composer's input area. It is a real multi-line region pinned to the
//     bottom of the window (the user's "red box"), not a one-line field: the text
//     starts at its top and the send key / hint keep their place below it. The
//     sizing is applied as inline style from the script — a CSS rule at the same
//     specificity as the design base lost to source order — so the assertion
//     looks at the script.
{
  // The composer is a plain single row again (textarea left, buttons right,
  // bottom-aligned). Two regressions have to stay impossible:
  //   1. the composer as a flex column with the buttons pinned to the window's
  //      bottom → a large empty area under the buttons;
  //   2. an auto-growing textarea next to a stretched one → the input area ran
  //      away to 400px+ because `scrollHeight` reported the stretched height.
  const composerRule = /(?:^|\n)\.composer\s*\{([^}]*)\}/.exec(css);
  ok("composer 没有被做成纵向两段（否则按钮会被推到窗口底部、下面留白）",
    !composerRule || !/flex-direction:\s*column/.test(composerRule[1]),
    composerRule ? composerRule[1].trim().replace(/\s+/g, " ") : "找不到 .composer 规则");
  ok("对话输入区不再被 autoGrow 接管（高度只有一个来源）",
    !/autoGrow\(\s*\$\("chatInput"\)\s*\)/.test(html),
    "仍然存在 autoGrow(chatInput) 调用");
  const heightRule = /COMPOSER_INPUT_HEIGHT\s*=\s*"(\d+)px"/.exec(html);
  const height = heightRule ? Number(heightRule[1]) : NaN;
  ok("输入框高度固定为 140px（约 6 行，超出在框内滚动）",
    height === 140,
    heightRule ? `COMPOSER_INPUT_HEIGHT=${height}px` : "找不到 COMPOSER_INPUT_HEIGHT");
  ok("输入框高度由脚本以内联样式写入（同特异性会被基座压掉）",
    /inputs\[i\]\.style\.height\s*=\s*COMPOSER_INPUT_HEIGHT/.test(html),
    "fitComposerInput() 没有把 height 写成内联样式");
  ok("输入框在内容超出时在框内滚动",
    /\.composer\s+\.bare-input\.comp\s*\{[^}]*overflow-y:\s*auto/.test(css),
    "缺少 .composer .bare-input.comp 的 overflow-y: auto");
  ok("输入框高度是在启动时设置的",
    /fitComposerInput\(\);/.test(html));
  ok("「Enter 发送 · Shift+Enter 换行」提示已从页面移除",
    // All comment forms are stripped: this file's notes (and the template's) quote
    // the removed string, and a check that matches its own documentation asserts
    // nothing. What must be gone is the live element and its text.
    !/id="compHint"/.test(bodyHtml) &&
      !/Enter 发送 · Shift\+Enter 换行/.test(
        bodyHtml.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
      ),
    "markup 里仍然有 #compHint 或那行提示文案");
  ok("忙时的 Enter 语义改由状态行说明（提示删掉后不能丢信息）",
    /setStatus\(isAgent\(\)\s*\?\s*"Enter 直接发送/.test(html),
    "setBusy() 没有把 Enter 语义交给状态行");
}
// The dark accent in this palette is WHITE, so a selected segment filled with
// `--accent-fill` was white-on-white — the "跟随系统" pill rendered as a blank
// white box. The selected state must not rely on the accent being dark.
{
  const segRule = /\[data-theme="dark"\]\s*\.seg\s+button\.on\s*\{([^}]*)\}/.exec(css);
  const body = segRule ? segRule[1] : "";
  ok("暗色下分段控件的选中态不靠 --accent-fill 填充（那里它是纯白，会白底白字）",
    segRule && !/background:\s*var\(--accent-fill\)/.test(body) && /color:\s*var\(--text-primary\)/.test(body),
    segRule ? body.trim().replace(/\s+/g, " ") : "缺少 [data-theme=dark] .seg button.on 规则");
}
// Deleting the role that is open in the editor has to close the editor: leaving
// it open produced a card whose Save did nothing (roleById() returned null).
ok("删掉正在编辑的角色时会一起收掉编辑器（否则留下一个没反应的残留卡片）",
  /if\s*\(\s*editingRoleId\s*&&\s*!roleById\(\s*state\.roles,\s*editingRoleId\s*\)\s*\)\s*closeRoleEditor\(\)/.test(html),
  "persistRoles() 没有在角色消失后关闭编辑器");

// 11. the topbar shares the host's band row, so it must survive the host's drag
//     map: `paintThroughNoDragRects()` punches a hole for every visible element
//     matching PAINT_THROUGH_NO_DRAG_SELECTOR — which includes anything carrying
//     `data-pi-plugin-no-drag`. An unmarked control in the band is covered by a
//     drag segment and cannot be clicked.
{
  const start = html.indexOf('<div class="topbar">');
  const end = html.indexOf('<div class="chatbody">', start);
  const bandTopbar = start === -1 || end === -1 ? "" : html.slice(start, end);
  const controls = [...bandTopbar.matchAll(/<(button|textarea|input|select)\b[^>]*>/g)].map((m) => m[0]);
  const unmarked = controls.filter((tag) => !/data-pi-plugin-no-drag/.test(tag));
  ok(`拖拽带那一排的 ${controls.length} 个控件都标了 data-pi-plugin-no-drag（否则宿主的拖拽地图会盖住它们）`,
    controls.length > 0 && unmarked.length === 0,
    unmarked.length
      ? "未标记：" + unmarked.map((t) => (/\bid="([^"]+)"/.exec(t) || [])[1] || t).join(", ")
      : "没有找到顶栏控件");
}
ok("顶栏搬进拖拽带时给宿主胶囊留了位置",
  /\.pi-has-band\s+\.topbar\s*\{[^}]*padding-right:\s*calc\(/.test(css),
  "缺少为胶囊预留的 padding-right");
ok("顶栏搬进拖拽带用的是宿主发布的高度，没有写死像素",
  /\.pi-has-band\s+\.topbar\s*\{[^}]*height:\s*var\(--pi-plugin-titlebar-height/.test(css),
  "height 没有用 var(--pi-plugin-titlebar-height)");
// The band placement is applied as INLINE style from the measured band height,
// not only through the cascade. Reported live: `.pi-has-band .topbar` computed to
// the base values on the visible view while applying to the hidden one, and an
// inline value removes that whole class of surprise.
ok("带内位置由脚本以内联样式写入（measure 后设置，不依赖层叠胜负）",
  /bar\.style\.marginTop\s*=\s*"-"\s*\+\s*px/.test(html) &&
    /bar\.style\.height\s*=\s*px/.test(html) &&
    /bar\.style\.paddingRight\s*=\s*"112px"/.test(html),
  "markTitlebarBand() 没有写内联的 margin-top/height/padding-right");
ok("退出带内时清掉内联样式（widget 形态不留残留）",
  /bar\.style\.marginTop\s*=\s*""/.test(html));

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
