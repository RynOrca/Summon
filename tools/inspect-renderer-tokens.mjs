/**
 * Resolve what the built renderer really paints, in a plain Node process.
 *
 * `renderer/index.html` is assembled from three inputs (template → palette
 * overrides, exported design base, icon fragment), so "which declaration wins"
 * is a cascade question, not a reading question. This parses the built CSS,
 * applies the matching rules in source order by specificity, and prints:
 *
 *   - the resolved box of the `#win` surface, which is the part that matters for
 *     layout: the panel must reserve the host's 46px drag band EXACTLY ONCE.
 *     Reserving it twice (a `top` offset plus the host-injected `padding-top`)
 *     would push the topbar 46px too far down.
 *   - the effective dark palette, i.e. which colour the page actually paints.
 *
 * The parser is a real (if small) CSS reader: comments are stripped, braces and
 * parentheses are tracked so `@media` blocks and `rgba(255, 255, 255, …)` values
 * cannot fake a declaration. A regex that ignored nesting reported every token
 * as coming from the bare `:root` defaults, which is exactly the kind of wrong
 * answer this tool exists to prevent.
 *
 * Assertions live in `tools/check-design-port.mjs`; this is the debugging view.
 *
 * Run:  node tools/inspect-renderer-tokens.mjs
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const htmlPath = path.join(repoRoot, "plugins", "local.summon-chat", "renderer", "index.html");
const html = await readFile(htmlPath, "utf8");

const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");

/** Split on a top-level separator only: not inside () or []. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Declarations from one rule body, ignoring anything inside parentheses. */
function parseDeclarations(body) {
  const decls = {};
  for (const chunk of splitTopLevel(body, ";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    // Custom properties carry digits (`--surface-2`), so the name test has to
    // allow them after the first character.
    if (!/^--[a-z0-9-]+$|^[a-z][a-z0-9-]*$/.test(prop) || !value) continue;
    decls[prop] = value;
  }
  return decls;
}

/** Sanity probe for the parser: catches a mis-split before it misleads. */
function selftest() {
  const sample = '[data-theme="dark"] { --bg: #181818; --surface: #212121; --surface-2: #303030; }';
  const parsed = parseRules(sample);
  const decls = parsed[0] ? parsed[0].decls : {};
  return decls["--surface-2"] === "#303030" && decls["--bg"] === "#181818";
}

/** Flat list of style rules. At-rule wrappers carrying rules are recursed into. */
function parseRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];

  function walk(source) {
    let depth = 0;
    let start = 0;
    let bodyStart = -1;
    let prelude = "";
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (char === "{") {
        if (depth === 0) {
          prelude = source.slice(start, i).trim();
          bodyStart = i + 1;
        }
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          const body = source.slice(bodyStart, i);
          if (prelude.startsWith("@")) {
            // @media/@supports/@container wrap rules — descend, but only when the
            // body actually holds blocks. @keyframes bodies never select elements.
            if (!/^@keyframes/i.test(prelude) && body.includes("{")) walk(body);
          } else {
            const selectors = splitTopLevel(prelude, ",");
            const decls = parseDeclarations(body);
            if (selectors.length && Object.keys(decls).length) rules.push({ selectors, decls });
          }
          start = i + 1;
        }
      }
    }
  }

  walk(clean);
  return rules;
}

const rules = parseRules(css);

if (!selftest()) {
  const probe = parseRules('[data-theme="dark"] { --bg: #181818; --surface: #212121; --surface-2: #303030; }');
  console.error("解析器自检失败：token 拆分不正确，下面的数字不可信。");
  console.error("probe:", JSON.stringify(probe));
  process.exit(1);
}

/** Crude specificity: ids > classes/attrs/pseudo > elements. Good enough here. */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/[.[:][\w-]+/g) || []).length;
  const elements = (selector.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) || []).length;
  return ids * 100 + classes * 10 + elements;
}

function matches(surfaceSelector, selector, options) {
  const s = selector.trim();
  if (surfaceSelector === ":root") {
    // The page root is <html>: `:root`, `html`, `[data-theme=…]`, `*`. With
    // `options.theme`, only the blocks that apply in that theme are kept.
    const isRoot = /^(:root|html|\*)/.test(s) || /^:root\[/.test(s) || /^\[data-theme/.test(s);
    if (!isRoot) return false;
    // `[data-theme="dark"]` and `[data-theme=dark]` are both legal.
    const themeSelector = /\[data-theme=["']?([\w-]+)["']?\]/.exec(s);
    if (!themeSelector) return true;
    return options && options.theme ? themeSelector[1] === options.theme : false;
  }
  // #win: `#win` / `.win`, optionally behind a theme/root prefix. A descendant
  // rule (`.win .titlebar`) targets a child, not the surface itself — matching
  // those would report a child's `height` as the surface's.
  const last = s.split(/\s+|>/).filter(Boolean).pop() || "";
  return last === "*" || /^#win$/.test(last) || /^\.win$/.test(last);
}

function resolve(surfaceSelector, options) {
  const out = new Map();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (!matches(surfaceSelector, selector, options)) continue;
      const weight = specificity(selector);
      for (const [prop, value] of Object.entries(rule.decls)) {
        const previous = out.get(prop);
        if (!previous || weight >= previous.weight) out.set(prop, { value, weight, from: selector });
      }
    }
  }
  return out;
}

const win = resolve("#win");
const BOX_PROPS = [
  "position",
  "inset",
  "top",
  "margin-top",
  "padding-top",
  "border-radius",
  "background",
];

console.log(`rules: ${rules.length}   built page: ${path.relative(repoRoot, htmlPath)}\n`);
console.log("resolved #win box (last matching declaration wins):");
for (const prop of BOX_PROPS) {
  const hit = win.get(prop);
  console.log(
    `  ${prop.padEnd(14)} ${(hit ? hit.value : "<not set>").padEnd(38)} ${hit ? "← " + hit.from : ""}`,
  );
}

console.log("\ndrag-band accounting (the host band must be reserved exactly once):");
const offsets = ["inset", "top", "margin-top", "padding-top"]
  .map((prop) => ({ prop, value: (win.get(prop) || {}).value }))
  .filter(({ value }) => value && !/^(0(px)?|auto|none)$/.test(value));
for (const prop of ["inset", "top", "margin-top", "padding-top"]) {
  const value = (win.get(prop) || {}).value;
  if (value) console.log(`  #win ${prop.padEnd(12)} ${value}`);
}
console.log(
  `  reserving the band: ${
    offsets.length === 1
      ? "once ✅  (" + offsets[0].prop + ": " + offsets[0].value + ")"
      : offsets.length === 0
        ? "NEVER ⚠️"
        : "TWICE ⚠️  (" + offsets.map((o) => o.prop).join(" + ") + ")"
  }`,
);
console.log(
  `  opts out of the host's additive body padding: ${
    /<meta[^>]+name=["']pi-plugin-chrome["'][^>]+content=["']v2["']/i.test(html)
      ? "v2 meta ✅"
      : "absent ⚠️"
  }`,
);

const rootTokens = resolve(":root");
const darkTokens = resolve(":root", { theme: "dark" });
function token(name) {
  const hit = darkTokens.get(name) || rootTokens.get(name);
  return hit ? hit.value : "<not set>";
}

console.log("\neffective dark palette (theme blocks beat the bare :root defaults):");
for (const name of [
  "--bg",
  "--surface",
  "--surface-2",
  "--border",
  "--border-strong",
  "--text-primary",
  "--text-secondary",
  "--text-disabled",
  "--accent",
  "--accent-fill",
  "--on-accent",
]) {
  console.log(`  [${darkTokens.has(name) ? "theme" : "root "}] ${name.padEnd(18)} ${token(name)}`);
}
for (const name of ["--font-ui", "--font-code"]) {
  console.log(`  [root ] ${name.padEnd(18)} ${token(name)}`);
}
