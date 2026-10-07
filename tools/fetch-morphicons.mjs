/**
 * Vendor the `morphicons` runtime into docs/vendor/morphicons.js.
 *
 * Why vendor at all: the plugin page must be a SINGLE self-contained HTML (the
 * host serves exactly one sandboxed page and gives it no other resource
 * channel), so an npm dependency cannot be `import`ed at runtime — it has to be
 * inlined. And why *this* script rather than a copy-paste: the package is ESM
 * with internal chunk imports, and the renderer needs one classic script. The
 * transform below is mechanical and re-runnable, so a version bump is a
 * one-line change here instead of a hand-merge.

 * What it does:
 *   1. download + verify the npm tarball (integrity from the registry);
 *   2. concatenate the three chunks `morphicons/dom` re-exports, in dependency
 *      order, dropping `import`/`export` statements (they are all in-bundle
 *      references, so the names still resolve inside one IIFE);
 *   3. wrap it in an IIFE exposing `window.PiMorph = { createMorph, canonicalD }`.
 *
 * Run:  node tools/fetch-morphicons.mjs
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const OUT = path.join(repoRoot, "docs", "vendor", "morphicons.js");

const VERSION = "1.7.1";
const TARBALL = `https://registry.npmjs.org/morphicons/-/morphicons-${VERSION}.tgz`;

/**
 * Chunk order is the dependency order inside the bundle:
 * spring (scheduler + math) → normalize (parsers) → dom (the rAF driver +
 * `createMorph`) → controller (the binding-agnostic controller).
 *
 * `dist/dom.js` is the entry the package's `morphicons/dom` export points at — it
 * is where `canonicalD` and `createMorph` actually live, so it has to be part of
 * the bundle rather than only the chunks it imports. Every cross-chunk reference
 * is a plain identifier, so removing the import statements is safe as long as
 * all chunks end up in the same function scope.
 */
const CHUNKS = [
  "dist/spring-CFHloqPP.js",
  "dist/normalize-CYnN3Npw.js",
  "dist/dom.js",
  "dist/controller-CXZuwJ_M.js",
];

/**
 * The bundle must end up defining exactly the API the page uses. Asserting it
 * here is cheap; discovering it as a silent `PiMorph is undefined` in the app is
 * not (which is how the missing `dist/dom.js` was found).
 */
const REQUIRED = ["function createMorph(", "function canonicalD(", "requestAnimationFrame("];

/** Strip ESM syntax; keep every declaration in the shared IIFE scope. */
function stripModuleSyntax(code) {
  return code
    // `import { a as b } from "./x.js";` and bare `import "./x.js";`
    .replace(/^\s*import\s+[^;\n]*?from\s*["'][^"']+["']\s*;?\s*$/gm, "")
    .replace(/^\s*import\s+["'][^"']+["']\s*;?\s*$/gm, "")
    // `export { a as b, c };` (the build's own re-export tail)
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
    // `export function f`, `export const x = …`, `export class C`
    .replace(/^(\s*)export\s+(function|const|let|var|class)\b/gm, "$1$2");
}

const tmp = await mkdtemp(path.join(tmpdir(), "morphicons-"));
try {
  const tgz = path.join(tmp, "morphicons.tgz");
  const response = await fetch(TARBALL, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  await writeFile(tgz, Buffer.from(await response.arrayBuffer()));

  // bsdtar ships with Windows 10+ and reads .tgz directly; the app's own
  // packaging path already relies on it (tools/verify-artifact.mjs).
  await run("tar", ["-xzf", tgz, "-C", tmp], { windowsHide: true });

  const pieces = [];
  for (const chunk of CHUNKS) {
    const full = path.join(tmp, "package", chunk);
    const raw = await readFile(full, "utf8");
    const stripped = stripModuleSyntax(raw);
    if (/\bimport\s|\bexport\s/.test(stripped)) {
      throw new Error(`chunk ${chunk} still contains module syntax after stripping`);
    }
    pieces.push(`/* ---- ${chunk} ---- */\n${stripped.trim()}`);
  }

  const pkg = JSON.parse(await readFile(path.join(tmp, "package", "package.json"), "utf8"));
  const banner = `/* ------------------------------------------------------------------------
 * morphicons v${pkg.version} —— SVG 路径形变动效（弹簧物理插值）
 * 上游：https://github.com/guillermolg00/morphicons   许可证：MIT
 * 原作者：Guillermo（guillermolg.com）
 *
 * 本文件由 tools/fetch-morphicons.mjs 生成，请勿手改。
 * 生成方式：把 npm 包 dist/ 里 morphicons/dom 依赖的三个 chunk 按依赖顺序
 * 拼接、去掉 import/export（都在同一个 IIFE 作用域内，名字仍然解析得到），
 * 最后只对外暴露一个命名空间。除了这一步「ESM → 经典脚本」的机械转换，
 * 算法与常量一字未改。
 *
 * 用法（页面内）：
 *   const m = PiMorph.createMorph(pathEl, '<path d="…"/> ', { reducedMotion: "user" });
 *   m.morphTo('<path d="…"/>', "snappy");
 *
 * 注意：传入的路径必须是**描边**几何（fill="none" + stroke），同一条子路径
 * 数量不要差太多。填充型图标虽然能解析，但过渡途中读起来是错的 —— 所以本插件
 * 只为这几个位置手写了描边图标：Menu↔X、Send↔Stop、chevron 翻转。
 * ------------------------------------------------------------------------ */
`;
  const footer = `
window.PiMorph = { createMorph: createMorph, canonicalD: canonicalD, version: ${JSON.stringify(pkg.version)} };
})();
`;

  const bundle = `${banner}(function () {\n"use strict";\n${pieces.join("\n\n")}\n${footer}`;
  for (const needle of REQUIRED) {
    if (!bundle.includes(needle)) {
      throw new Error(`bundle is missing ${needle} — the chunk list is out of date`);
    }
  }
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, bundle, "utf8");
  console.log(`wrote ${path.relative(repoRoot, OUT)}`);
  console.log(`  morphicons ${pkg.version}, ${CHUNKS.length} chunks, ${bundle.length} bytes`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
