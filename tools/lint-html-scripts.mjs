/**
 * Parse-check every inline <script> in the plugin HTML surfaces.
 *
 * These files cannot be exercised by the smoke tests (they need a DOM and the
 * host), but a single syntax error in one of them leaves the window completely
 * dead with no test failure anywhere. Parsing is cheap and catches exactly that.
 *
 * Only parsing happens — nothing is executed, so `document`/`window` need not
 * exist.
 *
 * Run:  node tools/lint-html-scripts.mjs
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const pluginsRoot = path.join(repoRoot, "plugins");

async function findHtml(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await findHtml(full, out);
    } else if (entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Second check: an author `display` rule beats the UA sheet's
// `[hidden] { display: none }`, so any overlay that sets a display value AND is
// toggled with the `hidden` attribute must re-hide itself with a `[hidden]`
// rule. Forgetting that leaves an invisible-looking but fully opaque panel
// covering the whole window — which is exactly how the chat window went blank.
// ---------------------------------------------------------------------------
function checkHiddenOverlays(html, label) {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join("\n")
    // Comments must go first: a "/* ... */" sitting between two rules becomes
    // part of the next selector, and the class would be silently skipped.
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (!styleBlocks.trim()) return 0;

  // Classes whose own rule sets a display value.
  const displayClasses = new Set();
  for (const rule of styleBlocks.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/display\s*:/.test(rule[2])) continue;
    for (const raw of rule[1].split(",")) {
      const single = raw.trim();
      const asClass = /^\.([a-zA-Z0-9_-]+)$/.exec(single);
      if (asClass) displayClasses.add(asClass[1]);
    }
  }

  // Classes on elements that carry the `hidden` attribute in the markup.
  const hiddenClasses = new Set();
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*\shidden(?:\s[^>]*)?>/g)) {
    const classAttr = /class="([^"]*)"/.exec(tag[0]);
    if (!classAttr) continue;
    for (const name of classAttr[1].split(/\s+/)) {
      if (name) hiddenClasses.add(name);
    }
  }

  // Classes that do re-hide themselves. Parsed rule-by-rule rather than with a
  // consuming regex, so a comma-separated selector list (".a[hidden], .b[hidden]")
  // registers every class instead of only the first.
  const reHidden = new Set();
  for (const rule of styleBlocks.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/display\s*:\s*none/.test(rule[2])) continue;
    for (const raw of rule[1].split(",")) {
      const asClass = /^\.([a-zA-Z0-9_-]+)\[hidden\]$/.exec(raw.trim());
      if (asClass) reHidden.add(asClass[1]);
    }
  }

  let problems = 0;
  for (const name of displayClasses) {
    if (!hiddenClasses.has(name) || reHidden.has(name)) continue;
    problems++;
    console.log(`FAIL  ${label} (overlay .${name})`);
    console.log(
      `      .${name} sets a display value and is toggled with the hidden attribute,` +
        ` but has no ".${name}[hidden] { display: none }" rule`,
    );
  }
  return problems;
}

const files = await findHtml(pluginsRoot);
let failures = 0;
let scripts = 0;

for (const file of files) {
  const html = await readFile(file, "utf8");
  const rel = path.relative(repoRoot, file);

  failures += checkHiddenOverlays(html, rel);

  // Inline scripts only; a src= script has no body to parse.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;

  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || "";
    const code = match[2] || "";
    index++;
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (!code.trim()) continue;
    scripts++;

    // Report the line the script starts on, so a failure is findable.
    const line = html.slice(0, match.index).split("\n").length;
    const label = `${rel} (script #${index}, line ${line})`;

    try {
      new vm.Script(code, { filename: label });
      console.log(`PASS  ${label}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${label}`);
      console.log(`      ${err.message}`);
    }
  }
}

// Guard against the check silently passing because nothing was found.
if (scripts === 0) {
  console.log("FAIL  no inline scripts found — the extractor is probably wrong");
  failures++;
}

const sizes = await Promise.all(files.map(async (f) => (await stat(f)).size));
console.log(
  `\n${files.length} HTML file(s), ${scripts} inline script(s), ${sizes.reduce((a, b) => a + b, 0)} bytes`,
);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
