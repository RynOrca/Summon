/**
 * Run the REAL `pi-plugin check` logic against the plugin, straight from the
 * PI-Desktop TypeScript source — no `pnpm install`, no devkit build.
 *
 * `pi-plugin check` is `check()` in packages/plugin-devkit/src/check.ts, and its
 * whole dependency graph is Node builtins + the local plugin-sdk source, so a
 * resolver hook is enough to run it (see ts-js-resolver.mjs).
 *
 * This validates far more than JSON syntax: manifest schema, referenced files,
 * permissions, path containment, symlinks, package size and file count.
 *
 * Run:  node tools/check-plugin.mjs
 * Env:  PI_DESKTOP_SRC=<path to PI-Desktop checkout>
 */

import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const pluginArg = process.argv[2] || "plugins/local.summon-chat";
const pluginDir = path.resolve(repoRoot, pluginArg);

const piSrc = process.env.PI_DESKTOP_SRC || "D:/Code/Working-on-it/PI-Desktop-src";
const checkEntry = path.join(piSrc, "packages", "plugin-devkit", "src", "check.ts");

if (!existsSync(checkEntry)) {
  console.error(`devkit check not found at:\n  ${checkEntry}\n`);
  console.error("Clone PI-Desktop first, or set PI_DESKTOP_SRC:");
  console.error("  git clone --depth 1 https://gitcode.com/GitHub_Trending/pid/PI-Desktop.git ../PI-Desktop-src");
  process.exit(2);
}

// The resolver reads this to locate the SDK source.
process.env.PI_DESKTOP_SRC = piSrc;
register(new URL("./ts-js-resolver.mjs", import.meta.url).href);

const { check } = await import(pathToFileURL(checkEntry).href);

console.log(`checking  ${path.relative(repoRoot, pluginDir)}`);
console.log(`using     ${checkEntry}\n`);

const result = await check(pluginDir);

const errors = result.errors ?? [];
const warnings = result.warnings ?? [];

function printIssues(label, issues) {
  if (issues.length === 0) {
    console.log(`${label}: none`);
    return;
  }
  console.log(`${label}: ${issues.length}`);
  for (const issue of issues) {
    console.log(`  [${issue.code}] ${issue.message}`);
  }
}

printIssues("errors", errors);
console.log();
printIssues("warnings", warnings);

// Anything else the result carries (counts, resolved paths) is useful context.
const extra = Object.fromEntries(
  Object.entries(result).filter(([k]) => k !== "errors" && k !== "warnings"),
);
if (Object.keys(extra).length > 0) {
  console.log("\nother result fields:");
  console.log(JSON.stringify(extra, null, 2));
}

console.log(
  errors.length === 0
    ? "\nPASS  pi-plugin check reports no errors"
    : `\nFAIL  ${errors.length} error(s)`,
);

process.exit(errors.length === 0 ? 0 : 1);
