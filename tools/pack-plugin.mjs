/**
 * Run the REAL `pi-plugin pack` straight from the PI-Desktop TypeScript source,
 * producing an installable `.piplug` — no `pnpm install`, no devkit build.
 *
 * Same resolver trick as check-plugin.mjs (see ts-js-resolver.mjs).
 *
 * A `.piplug` is a *store-only* (uncompressed) ZIP; a normal `zip` produces an
 * archive the installer rejects. This produces the correct artifact.
 *
 * Run:  node tools/pack-plugin.mjs [--out <dir>]
 * Env:  PI_DESKTOP_SRC=<path to PI-Desktop checkout>
 */

import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

// Usage: node tools/pack-plugin.mjs [pluginDir] [--out <dir>]
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outValue = outIndex !== -1 ? args[outIndex + 1] : null;
// Only skip the token after --out when --out is actually present; otherwise
// outIndex is -1 and outIndex + 1 would wrongly discard the plugin argument.
const positional = args.filter(
  (arg, i) => !arg.startsWith("--") && (outIndex === -1 || i !== outIndex + 1),
);
const pluginArg = positional[0] || "plugins/local.summon-chat";
const pluginDir = path.resolve(repoRoot, pluginArg);

// Default the artifact outside the plugin dir, so the plugin folder stays clean
// and `dist` never becomes part of the package it is packing.
const outDir = outValue ? path.resolve(outValue) : path.join(repoRoot, "dist");

const piSrc = process.env.PI_DESKTOP_SRC || "D:/Code/Working-on-it/PI-Desktop-src";
const packEntry = path.join(piSrc, "packages", "plugin-devkit", "src", "pack.ts");

if (!existsSync(packEntry)) {
  console.error(`devkit pack not found at:\n  ${packEntry}\n`);
  console.error("Clone PI-Desktop first, or set PI_DESKTOP_SRC.");
  process.exit(2);
}

process.env.PI_DESKTOP_SRC = piSrc;
register(new URL("./ts-js-resolver.mjs", import.meta.url).href);

const { pack } = await import(pathToFileURL(packEntry).href);

console.log(`packing   ${path.relative(repoRoot, pluginDir)}`);
console.log(`outDir    ${outDir}`);
console.log(`using     ${packEntry}\n`);

const result = await pack(pluginDir, { outDir });

for (const [key, value] of Object.entries(result)) {
  if (key === "manifest") continue; // already validated by check-plugin.mjs
  console.log(`${key}: ${JSON.stringify(value)}`);
}

const artifact = result.filePath ?? result.packagePath ?? result.path ?? result.file;
if (artifact && existsSync(artifact)) {
  const { statSync } = await import("node:fs");
  const size = statSync(artifact).size;
  console.log(`\nPASS  wrote ${artifact} (${size} bytes)`);
  console.log("Install it with:  Plugins -> overflow menu -> Install plugin package");
} else {
  console.log("\nCould not determine the artifact path from the result fields above.");
}
