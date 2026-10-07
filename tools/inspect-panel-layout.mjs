/**
 * Print the panel's measured box model from a real browser engine.
 *
 * `inspect-renderer-tokens.mjs` answers "which CSS declaration wins";
 * `measure-layout.mjs` asserts the titlebar band. This one is the diagnostic for
 * "the content looks wrong" — it dumps the viewport, the scroll offsets, the
 * message area's own box, every overflowing descendant and the computed style of
 * the first few message rows.
 *
 * It was written to find a real bug: `.msg-area.is-empty` makes the message list a
 * **centring flex row**, and the new keyed renderer never removed that class, so
 * every message became a shrink-to-fit flex item laid out side by side (the first
 * row measured 42px wide inside a 420px panel). One look at this readout named it.
 *
 * Asserts nothing — pair it with `npm run preview` and screenshot the output.
 *
 * Usage:
 *   node tools/preview-panel.mjs transcript          # writes a preview page
 *   node tools/inspect-panel-layout.mjs <page.html> [screenshot.png]
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const [page, shot] = process.argv.slice(2);
if (!page) {
  console.error("用法：node tools/inspect-panel-layout.mjs <preview.html> [screenshot.png]");
  console.error("先用 npm run preview（或 node tools/preview-panel.mjs transcript）生成页面。");
  process.exit(2);
}
/** Edge ships with Windows; there is no portable path to hard-code instead. */
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error("找不到 msedge.exe（本工具用系统的 Edge 无头模式量页面）。");
  process.exit(2);
}

const probe = `
<script>
window.addEventListener("load", function () {
  setTimeout(function () {
    var area = document.getElementById("msgArea");
    function best(root) {
      var out = [], stack = [root];
      while (stack.length) {
        var el = stack.pop();
        for (var i = 0; i < el.children.length; i++) {
          var c = el.children[i];
          if (c.scrollWidth > c.clientWidth + 2) {
            out.push((c.id || c.className || c.tagName) + " scrollW=" + c.scrollWidth + " clientW=" + c.clientWidth + " rect=" + JSON.stringify(c.getBoundingClientRect()));
            stack.push(c);
          } else { stack.push(c); }
        }
      }
      return out;
    }
    var lines = [];
    lines.push("VIEWPORT " + window.innerWidth + "x" + window.innerHeight);
    lines.push("SCROLL X=" + window.scrollX + " Y=" + window.scrollY);
    lines.push("HTML scrollW " + document.documentElement.scrollWidth + " clientW " + document.documentElement.clientWidth);
    lines.push("BODY scrollW " + document.body.scrollWidth);
    lines.push("WIN rect " + JSON.stringify(document.getElementById("win").getBoundingClientRect()));
    lines.push("AREA scrollW " + area.scrollWidth + " clientW " + area.clientWidth + " rect " + JSON.stringify(area.getBoundingClientRect()));
    var trace = area.querySelector(".trace");
    lines.push("TRACE rect " + (trace ? JSON.stringify(trace.getBoundingClientRect()) : "none"));
    lines.push("AREA computed dir=" + getComputedStyle(area).direction +
      " pos=" + getComputedStyle(area).position +
      " padding=" + getComputedStyle(area).padding +
      " scrollLeft=" + area.scrollLeft);
    var kids = [];
    for (var q = 0; q < Math.min(area.children.length, 6); q++) {
      var k = area.children[q];
      var kcs = getComputedStyle(k);
      kids.push(q + " " + (k.className || k.tagName) + " rect=" + JSON.stringify(k.getBoundingClientRect()) +
        " pos=" + kcs.position + " dir=" + kcs.direction + " tf=" + kcs.transform +
        " margin=" + kcs.margin + " pad=" + kcs.padding + " w=" + kcs.width);
    }
    lines.push("CHILDREN:");
    lines = lines.concat(kids);
    lines.push("OVERFLOW NODES (descendants of msgArea):");
    lines = lines.concat(best(area).slice(0, 24));
    var pre = document.createElement("pre");
    pre.id = "__probe";
    pre.textContent = lines.join("\\n");
    document.body.appendChild(pre);
  }, 1200);
});
<\/script>
`;

const html = (await readFile(page, "utf8")).replace("</body>", probe + "</body>");
const tmp = path.join(path.dirname(page), "probe.html");
await writeFile(tmp, html, "utf8");

const dom = await run(EDGE, [
  "--headless=new", "--disable-gpu", "--virtual-time-budget=4000",
  "--dump-dom", `file:///${tmp.replace(/\\/g, "/")}`,
], { maxBuffer: 40 * 1024 * 1024 });

const match = /<pre id="__probe">([\s\S]*?)<\/pre>/.exec(dom.stdout);
console.log(match ? match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<") : "probe not found");

if (shot) {
  await run(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    `--screenshot=${shot}`, "--window-size=470,790", "--virtual-time-budget=4000",
    `file:///${tmp.replace(/\\/g, "/")}`,
  ]);
  console.log("screenshot " + shot);
}
