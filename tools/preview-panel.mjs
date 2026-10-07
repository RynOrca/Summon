/**
 * Standalone visual preview of the built plugin page.
 *
 * The real page runs inside PI-Desktop, where the preload publishes
 * `--pi-plugin-titlebar-height: 46px` on <html>, the panel is 420×660, and the
 * host draws a 46px drag band (its window-button capsule) at the top. None of
 * that exists in a plain browser, so this glues the page's own markup to a stub
 * bridge and hangs it in a fixed-size shell that reproduces the band:
 *
 *   - the stub answers the channels the UI polls (`bootstrap`, `listModels`,
 *     `listSessions`, `progress`, `hostAppearance`), so the page leaves its
 *     "加载失败" state instead of showing an error card;
 *   - `--pi-plugin-titlebar-height: 46px` is set on <html> exactly like the host
 *     preload does, so the band reservation (and the divider it toggles) is
 *     exercised the way the app does it;
 *   - `#win` is re-anchored to the shell, because the page pins itself with
 *     `position: fixed; inset: 0` — in a browser that means the preview window,
 *     not the simulated 420px panel, and the container queries would not fire.
 *
 * It writes to the OS temp directory (never into the repo) and asserts nothing:
 * `tools/check-design-port.mjs` owns the pass/fail contract, and
 * `tools/inspect-renderer-tokens.mjs` prints the resolved tokens.
 *
 * Run:  node tools/preview-panel.mjs [light|set|transcript|turn] [set]
 *       # then screenshot the printed path, e.g.
 *       # msedge --headless=new --screenshot=out.png --window-size=470,780 file:///<path>
 *
 * `transcript` answers `readTranscript` with a **finished** turn that has thinking,
 * two tool calls (one a provider-hosted web search with source URLs), elapsed time
 * and token usage — i.e. exactly the fields the timeline exists to show.
 *
 * `turn` replays the **live** path the agent actually takes, which is the one that
 * used to break: the page paints the user's own bubble first, then the transcript
 * catches up one step at a time (thinking → tool running → tool done → answer).
 * It is the regression harness for "思考的框一闪然后什么都没有" and for the
 * duplicated user bubble that appeared when the host's message id differed from
 * the local placeholder's. Every other mode renders the empty state.
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const pagePath = path.join(repoRoot, "plugins", "local.summon-chat", "renderer", "index.html");

const mode = ["light", "set", "transcript", "turn", "long", "quick", "typing", "attach"].indexOf(process.argv[2]) !== -1
  ? process.argv[2]
  : (process.argv[3] === "set" ? "set" : "dark");
const theme = mode === "light" ? "light" : "dark";
const view = mode === "set" || process.argv[3] === "set" ? "set" : "chat";
const demoTranscript = mode === "transcript" || mode === "turn" || mode === "typing";
/** `turn` walks the progressive stages instead of returning the finished turn. */
const demoTurn = mode === "turn";
/** `long` fills the message area so the bottom blur seam can be reviewed. */
const demoLong = mode === "long";
/** `quick` drives the plugin's quick-chat flow (send → progress poll → answer). */
const demoQuick = mode === "quick";
/** `typing` feeds the same answer in growing pieces, mid-typewriter. */
const demoTyping = mode === "typing";
/** `attach` pastes two files (an image and a markdown) through the real path. */
const demoAttach = mode === "attach";
/** Quick chat is only reachable through the `quick` role, so make it the default. */
const roleDefaultQuick = demoQuick;
const out = path.join(tmpdir(), `summon-chat-preview-${mode}${view === "set" ? "-set" : ""}.html`);

const built = await readFile(pagePath, "utf8");
const styleBlocks = [...built.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join("\n");
/**
 * The page's `<script>` blocks, in document order — the FIRST one is the vendored
 * third-party bundle (morphicons + the curve loader) and the second is the plugin's
 * own script.
 *
 * ⚠️ They have to be carried over explicitly. The body slice below drops
 * everything in `<head>`, and the vendor bundle lives there on purpose (it is
 * generated code plus its licence banner). A preview without it was silently
 * broken in a way that cost real time: `window.PiCurve` was undefined, so the
 * loader rendered as an **empty span** and every screenshot showed "no loader" —
 * a preview-only artifact that looked exactly like the bug being reported.
 */
const scriptBlocks = [...built.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]);
if (scriptBlocks.length < 2) {
  console.error(`预览失败：产物里应有 2 段内联脚本（第三方动效 + 页面），实际 ${scriptBlocks.length} 段。`);
  process.exit(1);
}
// Strip comments before slicing. The page's <head> carries a prose note that
// quotes `<body>`, and searching the raw text started the slice inside that
// sentence — which produced a page whose markup was nested inside a stray
// <head>, so the stylesheet silently stopped matching the real elements. That
// cost an hour; the self-check below exists so it cannot happen again.
const withoutComments = built.replace(/<!--[\s\S]*?-->/g, "");
const bodyStart = withoutComments.indexOf("<body");
const bodyEnd = withoutComments.indexOf("</body>");
if (bodyStart === -1 || bodyEnd === -1) {
  console.error("预览失败：在产物里找不到 <body> 区间。");
  process.exit(1);
}
const pageMarkup = withoutComments
  .slice(bodyStart, bodyEnd + 7)
  .replace(/^<body[^>]*>/, "")
  .replace(/<\/body>$/, "")
  // 页面自己的脚本在 body 里、要留着；渲染前换成从产物里抽出来的那一段。
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "__PAGE_SCRIPT__");
for (const must of ['id="win"', 'class="topbar"', "__PAGE_SCRIPT__"]) {
  if (!pageMarkup.includes(must)) {
    console.error(`预览失败：抽出的页面片段里没有 ${must}（切片位置不对）。`);
    process.exit(1);
  }
}
const vendorScript = scriptBlocks[0];
const pageScript = scriptBlocks[scriptBlocks.length - 1];
const pageMarkupWithScripts = pageMarkup.split("__PAGE_SCRIPT__").join(pageScript);

/** Answers shaped like the ones `main.js: onPanelInvoke` returns. */
const BOOTSTRAP = {
  ok: true,
  roles: [
    { id: "agent", name: "Agent", builtin: true, mode: "agent", system: "", tools: [], skills: [] },
    {
      id: "quick",
      name: "快捷对话",
      builtin: true,
      mode: "quick",
      system: "你是一个简洁、直接的中文助手。",
      tools: ["web_search"],
      skills: [],
    },
  ],
  problems: [],
  defaultRoleId: "agent",
  shortcut: {
    requested: "Alt+Shift+C",
    active: "Alt+Shift+C",
    registered: true,
    error: null,
    fallbackFrom: null,
  },
  search: { hasCustomEndpoint: false, hasApiKey: false, provider: "duckduckgo" },
  modelKey: "",
  maxToolRounds: 3,
  agentStartMode: "new",
  thinkingDisplayMode: "compact",
  appDefaultModelKey: "qwen3.8-27b-long (Local)",
  hostAppearance: { theme, base: theme, locale: "zh-CN", fontScale: 1 },
  settings: {
    accelerator: "Alt+Shift+C",
    agentStartMode: "new",
    maxToolRounds: 3,
    appearance: "host",
    fontSize: 15,
    opacity: 100,
    searchEndpoint: "",
    hasApiKey: false,
  },
  resumeSessionId: null,
  phase: 4,
  version: "0.19.0",
};

/**
 * A finished Agent turn with everything the timeline renders. Shapes mirror what
 * `main.js: normalizeTranscript` produces out of the host's `session/get`
 * (camelCase MessageRecord fields), so the preview exercises the real code path
 * rather than a convenient fiction.
 */
const DEMO_TRANSCRIPT = {
  ok: true,
  transcript: {
    session: { id: "demo", title: "刘备去世时间", status: "complete", mode: "agent", permissionMode: "ask" },
    sessionId: "demo",
    status: "complete",
    messages: [
      { id: "d1", role: "user", text: "刘备什么时候去世的？" },
      {
        id: "d2", role: "assistant", text: "",
        thinking: "先确认是不是需要联网。刘备的卒年有几个说法（223 年 vs 224 年），必须查证，不能凭记忆答。\n优先看维基百科与百度百科的年份，再用史志类站点交叉验证；如果两处矛盾，就以《三国志》的纪年为准。",
        status: "complete", durationMs: 18400, usage: { inputTokens: 1240, outputTokens: 96, totalTokens: 1336 },
      },
      {
        id: "d3", role: "tool", text: "刘备 去世时间 卒 223年6月10日 白帝城",
        tool: {
          name: "tavily-search",
          callId: "call_1",
          status: "success",
          args: { query: "刘备 去世时间 卒", max_results: 5 },
          result: { exitCode: 0, count: 5, items: [{ url: "https://zh.wikipedia.org/wiki/刘备" }, { url: "https://baike.baidu.com/item/刘备" }] },
          durationMs: 2400,
          completedAt: "2026-10-06T10:25:58.000Z",
        },
      },
      {
        id: "d4", role: "tool", text: "exitCode 0 · 史志信息网 3 条",
        tool: {
          name: "Bash",
          callId: "call_2",
          status: "success",
          args: { command: "rg -n \"章武三年\" docs/三国志/先主传.md" },
          result: { exitCode: 0, lines: 12 },
          durationMs: 380,
        },
      },
      {
        id: "d5", role: "assistant",
        text: "**刘备于 223 年 6 月 10 日（蜀汉章武三年四月二十四日）病逝于白帝城永安宫**，享年 63 岁。\n\n- **地点**：白帝城永安宫（今重庆市奉节县）\n- **死因**：夷陵之战（222 年）兵败后积劳成疾，于章武三年夏四月病逝\n- **安葬**：惠陵\n\n> 来源：维基百科、百度百科、史志信息网。",
        status: "complete", durationMs: 9200,
        usage: { inputTokens: 3980, outputTokens: 420, totalTokens: 4400 },
        hostedSearch: {
          status: "completed",
          rounds: [
            {
              id: "r1", status: "completed", kind: "search", query: "刘备 去世时间 卒",
              sources: [
                { url: "https://zh.wikipedia.org/wiki/刘备", title: "刘备 - 维基百科" },
                { url: "https://baike.baidu.com/item/刘备", title: "刘备 - 百度百科" },
              ],
            },
            { id: "r2", status: "completed", kind: "openPage", query: "先主传 章武三年", url: "https://www.guoxue.com/sanguozhi/xianzhu.htm", sources: [{ url: "https://www.guoxue.com/sanguozhi/xianzhu.htm" }] },
          ],
        },
      },
    ],
  },
};

const light = theme === "light";
const ink = light ? "26,28,31" : "255,255,255";
const pageBg = light ? "#ffffff" : "#181818";

/**
 * The same turn, cut into the stages the host actually writes:
 *   1. only the user's message (the page has already painted its own bubble)
 *   2. the assistant's row appears with `status: "streaming"` and no text yet
 *   3. thinking arrives
 *   4. the tool call lands while it is still `running` (no result, no duration)
 *   5. the tool call finishes
 *   6. the answer text arrives — same message id, so it must update in place
 * Every stage keeps the same ids; only content changes. That is the contract the
 * keyed renderer has to hold, and the one that broke twice.
 */
const TURN_BASE = DEMO_TRANSCRIPT.transcript.messages;
/** A longer reasoning note, so the collapsed "思考过程" row sits inside the shot. */
const LONG_THINKING =
  "先确认是不是需要联网。刘备的卒年有几个说法（223 年 vs 224 年），必须查证，不能凭记忆答。\n" +
  "优先看维基百科与百度百科的年份，再用史志类站点交叉验证；\n" +
  "如果两处矛盾，就以《三国志》的纪年为准，并在回答里点明依据；\n" +
  "另外还要确认逝世地点（白帝城永安宫）与安葬地（惠陵）是否一致；\n" +
  "查完再把结论压成三条要点，不要贴大段原文。";
if (mode === "transcript") {
  DEMO_TRANSCRIPT.transcript.messages = TURN_BASE.map((m) =>
    m.id === "d2" ? Object.assign({}, m, { thinking: LONG_THINKING }) : m,
  );
}
const stage = (ids, patch) => ({
  ok: true,
  transcript: Object.assign({}, DEMO_TRANSCRIPT.transcript, {
    status: ids.length < TURN_BASE.length ? "running" : "complete",
    messages: TURN_BASE.filter((m) => ids.indexOf(m.id) !== -1).map((m) => Object.assign({}, m, (patch || {})[m.id] || {})),
  }),
});
const TURN_STAGES = [
  stage(["d1"]),
  stage(["d1", "d2"], { d2: { thinking: "", durationMs: null } }),
  stage(["d1", "d2"]),
  stage(["d1", "d2", "d3"], {
    d3: {
      text: "",
      tool: { name: "tavily-search", callId: "call_1", status: "running", args: { query: "刘备 去世时间 卒", max_results: 5 }, result: null, durationMs: null },
    },
  }),
  stage(["d1", "d2", "d3"]),
  stage(["d1", "d2", "d3", "d5"], { d5: { hostedSearch: null } }),
  stage(["d1", "d2", "d3", "d5"]),
];

/**
 * The answer arriving in growing pieces.
 *
 * This is the regression harness for "正式输出被强制截断": the host checkpoints a
 * streaming reply every 1.5s, so the panel sees the same message id with more text
 * each poll — which used to hit the rebuild path *while the typewriter was still
 * writing*, leaving the reveal latched onto a node that had been thrown away. The
 * visible result was a sentence cut off mid-word.
 */
const TYPING_PARTS = (() => {
  const full = DEMO_TRANSCRIPT.transcript.messages.find((m) => m.id === "d5").text;
  return [40, 140, Math.floor(full.length * 0.6), full.length].map((n) => full.slice(0, n));
})();
const TYPING_STAGES = [
  stage(["d1"]),
  ...TYPING_PARTS.map((cut, i) =>
    stage(["d1", "d3", "d5"], {
      d3: { text: "", thinking: "", tool: { name: "tavily-search", callId: "call_1", status: "done", args: { query: "刘备 去世时间 卒" }, result: { ok: true }, durationMs: 2400 } },
      d5: { text: cut, status: "streaming", hostedSearch: null },
    }),
  ),
  // The settled row: same id, complete text.
  stage(["d1", "d3", "d5"], { d3: { text: "", thinking: "", tool: { name: "tavily-search", callId: "call_1", status: "done", args: { query: "刘备 去世时间 卒" }, result: { ok: true }, durationMs: 2400 } }, d5: { hostedSearch: null } }),
];

/**
 * A long answer, so the message area actually scrolls and the bottom blur seam
 * has something to act on. `--virtual-time-budget` + the auto-scroll below puts
 * the screenshot at the bottom of the scroll, which is the only place the seam
 * can be judged.
 */
const LONG_PARAGRAPHS = Array.from({ length: 14 }, (_, i) =>
  `第 ${i + 1} 段：这是一段用来撑起滚动区域的正文，目的是让消息区真的溢出，` +
  "这样输入框上沿那条「从下往上逐渐糊掉」的过渡带才有东西可以作用。" +
  "它本身没有别的意思，只是测试素材。"
);
const LONG_TRANSCRIPT = {
  ok: true,
  transcript: {
    session: { id: "demo", title: "长文", status: "complete", mode: "agent", permissionMode: "ask" },
    sessionId: "demo",
    status: "complete",
    messages: [
      { id: "L1", role: "user", text: "给我一段足够长的回答，用来检查底部的雾化过渡。" },
      { id: "L2", role: "assistant", text: LONG_PARAGRAPHS.map((p) => p + "\n").join("\n"), status: "complete", durationMs: 4200 },
    ],
  },
};
/**
 * Where to park the scroll before the screenshot.
 *   long → the very bottom, which is the only place the blur seam shows
 * Other modes leave it alone: the page scrolls itself (`.msg-area` has
 * `scroll-behavior: smooth`, so fighting it from outside loses the race).
 */
const SCROLL_TO = demoLong ? 100000 : 0;
/**
 * The project the preview pretends the session is bound to.
 *
 * ⚠️ It is injected into the page stub, so the page can reference it. Naming a
 * Node-side `const` inside that template looked fine and silently produced the
 * empty state instead: the page threw `ReferenceError`, `refreshProject`'s
 * `.catch` swallowed it, and the chip drew 「未选择项目」. Same class of bug as
 * the missing vendor bundle — the preview is wrong, and it looks like the code.
 */
const DEMO_PROJECT = "D:\\Code\\Working-on-it\\summon-4-pi";

/**
 * The quick-chat stub. Quick chat does not go through `readTranscript` at all —
 * the page calls `sendQuick` (which only acknowledges) and then polls
 * `progress` for the steps and the answer. That is the path in the user's
 * report, and the only way to reproduce it outside the app.
 *
 * It has to live **inside** the generated page (see `QUICK_STUB` below): it is
 * mutated per call, and the page's own script is where the calls happen.
 */
const QUICK_STUB = `
            var QUICK = {
              asked: false,
              polls: 0,
              accept: function () {
                this.asked = true;
                this.polls = 0;
                return { ok: true, accepted: true, turnId: "qp1" };
              },
              reply: function () {
                if (!this.asked) {
                  return { ok: true, progress: { turnId: "qp1", phase: "idle", inFlight: false, result: null, error: null, round: 0, steps: [] } };
                }
                if (this.polls++ < 2) {
                  return { ok: true, progress: {
                    turnId: "qp1", phase: "searching", detail: "正在搜索「深圳 今天 天气」…", round: 1, inFlight: true,
                    steps: [
                      { kind: "thinking", phase: "thinking", detail: "正在思考…", round: 0, status: "done", tookMs: 1, at: Date.now() - 900 },
                      { kind: "search", phase: "searching", query: "深圳 今天 天气", round: 1, status: "running", at: Date.now() },
                    ],
                  } };
                }
                return { ok: true, progress: {
                  turnId: "qp1", phase: "done", detail: "", round: 1, inFlight: false,
                  steps: [
                    { kind: "thinking", phase: "thinking", detail: "正在思考…", round: 0, status: "done", tookMs: 1, at: Date.now() - 15000 },
                    { kind: "search", phase: "searching", query: "深圳 今天 天气", round: 1, status: "error", tookMs: 15000, at: Date.now() - 15000 },
                    { kind: "thinking", phase: "thinking", detail: "正在思考（第 2 轮）…", round: 1, status: "done", tookMs: 1, at: Date.now() - 600 },
                  ],
                  // Exactly what main.js returns when the search failed: the model
                  // still answers, and \`trace\` records the failed round.
                  result: {
                    ok: true,
                    text: "联网搜索这边没成功，没抓到实时数据，所以我没法给你今天深圳的准确天气。\\n\\n" +
                      "**先说大背景。** 深圳属于亚热带季风气候，这个季节的特点很明显：\\n\\n" +
                      "- 回暖明显，白天常在 20 多度，早晚偏凉。\\n" +
                      "- 湿度开始爬升，空气越来越「黏」。\\n\\n" +
                      "**所以给你几点出门参考：**\\n\\n" +
                      "1. 带把折叠伞。\\n2. 穿薄外套加内搭。\\n",
                    modelKey: "qwen3.8-27b-long (Local)",
                    roleId: "quick",
                    trace: [{
                      round: 1, tool: "web_search", query: "深圳 今天 天气", ok: false,
                      provider: null, count: 0, error: "SEARCH_FAILED",
                      // 与 main.js 的 builtInSearch 一致：把每一家的原因逐条带上。
                      failures: ["duckduckgo 连不上（ENOTFOUND）", "bing 连不上（ETIMEDOUT）"],
                      message: "内置搜索没成功：duckduckgo 连不上（ENOTFOUND）；bing 连不上（ETIMEDOUT）。可以在插件设置里填自己的搜索端点。",
                      results: [],
                    }],
                    searched: true,
                    usage: null,
                  },
                } };
              },
            };
`;
const html = `<!doctype html>
<html lang="zh-CN" data-theme="${theme}" style="--pi-plugin-titlebar-height: 46px" data-pi-plugin-panel-shape="panel">
  <head>
    <meta charset="UTF-8" />
    <title>Summon Chat · 420×660 preview (${theme})</title>
    <script>
      // Preview chrome only: surface page errors in the DOM so a headless run can
      // tell "nothing rendered" apart from "it threw".
      window.__errs = [];
      window.addEventListener("error", function (e) { window.__errs.push(String(e.message) + " @" + e.lineno); });
      window.addEventListener("unhandledrejection", function (e) { window.__errs.push("rejection " + String(e.reason)); });
    <\/script>
    <style>
      /* Preview chrome only — never shipped. */
      html, body { margin: 0; background: ${light ? "#e8e8e8" : "#0a0a0a"}; }
      .preview { padding: 18px; font-family: system-ui, sans-serif; }
      .shell { width: 420px; height: 660px; box-sizing: border-box; background: ${pageBg}; box-shadow: 0 0 0 1px ${light ? "#c9c9c9" : "#444"}; position: relative; overflow: hidden; }
      /* The host's own 46px drag band, with its three window buttons. */
      .band { position: absolute; inset: 0 0 auto 0; height: 46px; z-index: 5; }
      .capsule { position: absolute; top: 9px; right: 8px; display: flex; gap: 1px; width: 96px; height: 28px; box-sizing: border-box; border: 1px solid rgba(${ink},.16); border-radius: 999px; padding: 1px; background: rgba(${ink},.06); }
      .capsule i { flex: 1 1 0; height: 24px; border-radius: 7px; position: relative; }
      .capsule i::before { content: ""; position: absolute; inset: 0; margin: auto; width: 10px; height: 1px; background: rgba(${ink},.58); }
      .capsule i.mx::before { height: 10px; width: 10px; background: none; border: 1px solid rgba(${ink},.58); }
      .capsule i.cl::before { background: none; }
      .capsule i.cl::after { content: ""; position: absolute; inset: 0; margin: auto; width: 11px; height: 1px; background: rgba(${ink},.58); transform: rotate(45deg); }
      .page { position: absolute; inset: 0; }
      /* The page pins itself with fixed + inset:0 (= the browser viewport here);
         re-anchor it to this shell so the 420px container queries and the
         bottom-right send button behave as inside the panel.
         padding-top is intentionally 0: the page's topbar now takes the band
         itself (it carries margin-top: calc(-1 * var(--band))). */
      #win { position: absolute !important; inset: 0 !important; width: 420px; height: 660px; }
      /* Approximate the host's drag map. The host covers its 46px band with
         drag segments and punches a hole for every visible element carrying
         data-pi-plugin-no-drag, so those controls stay clickable while the rest
         of the band drags the window. The hatching marks the segments; the
         hit test below proves each control is above them. */
      .band .hatch { position: absolute; inset: 0; pointer-events: none; background-image: repeating-linear-gradient(45deg, rgba(${ink},.06) 0 1px, transparent 1px 7px); }
      .capsule { -webkit-app-region: no-drag; }
      .label { color: ${light ? "#555" : "#9a9a9a"}; font-size: 12px; margin-top: 8px; max-width: 420px; line-height: 1.7; }
      code { font-family: ui-monospace, Consolas, monospace; }
    </style>
${styleBlocks}
  </head>
  <body>
    <div class="preview">
      <div class="shell">
        <div class="page">
          <script>
          (function () {
            var BOOTSTRAP = ${JSON.stringify(demoQuick && roleDefaultQuick ? Object.assign({}, BOOTSTRAP, { defaultRoleId: "quick" }) : BOOTSTRAP)};
${demoQuick ? QUICK_STUB : ""}
            var DEMO = ${demoTranscript ? JSON.stringify(DEMO_TRANSCRIPT) : (demoLong ? JSON.stringify(LONG_TRANSCRIPT) : "null")};
            // The progressive stages the live agent path goes through. Each poll
            // returns the next one, so the page renders the same sequence the app
            // does: local bubble → thinking → tool running → tool done → answer.
            var TURN_STAGES = ${demoTurn ? JSON.stringify(TURN_STAGES) : "[]"};
            var TYPING_STAGES = ${demoTyping ? JSON.stringify(TYPING_STAGES) : "[]"};
            var TURN_I = 0;
            // 页面里要用，所以必须注入进来（不能直接引用 Node 那边的同名常量）。
            var DEMO_PROJECT = ${JSON.stringify(DEMO_PROJECT)};
            // In transcript/turn mode the page resumes a session on boot, which
            // routes through the same readTranscript → renderKeyed path the app uses.
            if (DEMO) BOOTSTRAP.resumeSessionId = "demo";
            window.pluginBridge = {
              on: function () { return function () {}; },
              // ⚠️ 第二个参数必须收：页面调用的 pluginBridge.invoke(channel, payload)
              // 是真的会传 payload 的，而这里的桩一开始只写了 channel。新加的
              // stageUpload / fs.readPreview 一引用 args 就抛 ReferenceError，
              // 被页面的 .catch 吞掉 —— 表现是「粘贴了但什么都没发生」。
              // 预览工具自身的错，和上次漏带第三方 bundle 是同一类。
              invoke: function (channel, args) {
                window.__channels = window.__channels || [];
                window.__channels.push(channel);
                if (channel === "summon.chat.bootstrap") return Promise.resolve(BOOTSTRAP);
                if (channel === "summon.chat.listModels") {
                  return Promise.resolve({
                    ok: true, models: [
                      { key: "qwen3.8-27b-long (Local)", label: "qwen3.8-27b-long (Local)", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium", supportsReasoning: true },
                    ], selected: "qwen3.8-27b-long (Local)", isExplicit: false, appDefaultKey: "qwen3.8-27b-long (Local)", fromAppDefault: true,
                  });
                }
                if (channel === "summon.chat.listSessions") return Promise.resolve({ ok: true, sessions: [], quick: [] });
                // The composer's bottom-left project chip (Agent mode) and the
                // project menu both read these two.
                if (channel === "summon.chat.currentProject") {
                  return Promise.resolve({ ok: true, path: DEMO_PROJECT, source: "session" });
                }
                if (channel === "summon.chat.listProjects") {
                  return Promise.resolve({
                    ok: true,
                    projects: [{ name: "summon-4-pi", path: DEMO_PROJECT }],
                    currentPath: DEMO_PROJECT,
                  });
                }
                if (channel === "summon.chat.readTranscript") {
                  if (DEMO && ${demoTurn}) return Promise.resolve(TURN_STAGES[Math.min(TURN_I++, TURN_STAGES.length - 1)]);
                  if (DEMO && ${demoTyping}) return Promise.resolve(TYPING_STAGES[Math.min(TURN_I++, TYPING_STAGES.length - 1)]);
                  return Promise.resolve(DEMO || { ok: true, transcript: { messages: [] } });
                }
                if (channel === "summon.chat.stageUpload") {
                  // Stand in for the plugin process writing the bytes: the chip only
                  // needs a workspace-relative path back, plus the byte count.
                  const bytes = args && args.bytes;
                  const size = ArrayBuffer.isView(bytes) ? bytes.byteLength
                    : (args && args.text ? String(args.text).length : 0);
                  return Promise.resolve({
                    ok: true,
                    path: ".summon/uploads/upload-preview" + (args && args.isImage ? ".png" : ".txt"),
                    fullPath: "D:\\\\summon\\\\.summon\\\\uploads\\\\upload-preview",
                    bytes: size,
                    name: (args && (args.displayName || args.name)) || "file",
                  });
                }
                if (channel === "fs.readPreview") {
                  // A 1x1 blue PNG, so an image chip shows a real thumbnail.
                  return Promise.resolve({
                    kind: "image",
                    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                    size: 68,
                  });
                }
                if (channel === "summon.chat.progress") {
                  if (${demoQuick}) return Promise.resolve(QUICK.reply());
                  return Promise.resolve({ ok: true, progress: { phase: "idle", inFlight: false, result: null, error: null, turnId: "", round: 0, steps: [] } });
                }
                if (channel === "summon.chat.sendQuick") {
                  if (${demoQuick}) return Promise.resolve(QUICK.accept());
                  return Promise.resolve({ ok: false, message: "preview stub" });
                }
                if (channel === "summon.chat.hostAppearance") {
                  return Promise.resolve({ ok: true, appearance: BOOTSTRAP.hostAppearance });
                }
                return Promise.resolve({ ok: true });
              },
            };
            // "set" renders the settings view (role editor, segmented controls).
            // The view switcher lives inside the page's IIFE, so this clicks the
            // gear button — the same path a user takes.
            if ("${view}" === "set") {
              window.addEventListener("load", function () {
                var gear = document.getElementById("btnSettings");
                if (gear) gear.click();
              });
            }
            // Park the scroll where the interesting edge is: the bottom for the
            // blur seam, a little above it for the trace shot. Retried on a timer
            // because the transcript arrives asynchronously.
            if (${SCROLL_TO} !== 0) {
              var park = function () {
                var area = document.getElementById("msgArea");
                if (!area) return;
                area.scrollTop = ${SCROLL_TO} < 0
                  ? Math.max(0, area.scrollHeight - area.clientHeight + ${SCROLL_TO})
                  : ${SCROLL_TO};
              };
              [200, 600, 1200, 2000].forEach(function (t) { setTimeout(park, t); });
            }
            // Quick chat: type a message and press the send key, i.e. exactly what
            // a user does. The page then polls on a 400ms setInterval — which
            // headless virtual time never advances — so the reply is driven
            // explicitly here instead, with the same progress payload shape.
            if (${demoAttach}) {
              // 驱动**真实**的粘贴路径：合成一个带图片 File 的剪贴板事件，
              // 页面自己走 FileReader → stageUpload → chip。截图里那一枚 chip
              // 就是这么来的，不是为了截图手画的 DOM。
              setTimeout(function () {
                try {
                  var png = atob("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAP0lEQVR42mNkYPhfz0BFwDiqYVTDqIZRDaMaRjWMagDRAAA7nQGBuJ9m4wAAAABJRU5ErkJggg==");
                  var bytes = new Uint8Array(png.length);
                  for (var i = 0; i < png.length; i++) bytes[i] = png.charCodeAt(i);
                  var dt = new DataTransfer();
                  dt.items.add(new File([bytes], "截图 2026-10-07.png", { type: "image/png" }));
                  dt.items.add(new File(["# 国庆快乐\\n"], "国庆快乐.md", { type: "text/markdown" }));
                  document.getElementById("chatInput").dispatchEvent(
                    new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
                } catch (err) { /* 预览：合成事件不可用就算了 */ }
              }, 400);
            }
            if (${demoQuick}) {
              setTimeout(function () {
                var input = document.getElementById("chatInput");
                input.value = "今天深圳的天气怎么样";
                input.dispatchEvent(new Event("input"));
                document.getElementById("sendKey").click();
                // The page polls on a 400ms interval, which headless virtual
                // time never advances — so each tick is stepped by hand through the
                // page's own hook, with the same payload shape.
                var n = 0;
                (function step() {
                  if (n++ > 12 || !window.__summonPollQuick) return;
                  Promise.resolve(window.__summonPollQuick(true)).then(function (fin) {
                    if (!fin) setTimeout(step, 40);
                  });
                })();
              }, 300);
            }
          })();
          <\/script>
          <!-- 第三方动效：产物里它在 <head>，这里必须显式带回，否则 window.PiCurve /
               window.PiMorph 都是 undefined，加载动效会渲染成一个空 span。 -->
${vendorScript}
${pageMarkupWithScripts}
        </div>
        <div class="band">
          <div class="capsule"><i></i><i class="mx"></i><i class="cl"></i></div>
        </div>
      </div>
      <div class="label">
        panel 420×660 · 顶部 46px 是宿主的拖拽带（右上角胶囊），本预览用同样的
        <code>--pi-plugin-titlebar-height</code> 复现它。
      </div>
    </div>
  </body>
</html>
`;

await writeFile(out, html, "utf8");
console.log(out);
