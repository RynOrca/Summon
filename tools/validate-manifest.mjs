/**
 * Validate the plugin manifest with the REAL validator from the PI-Desktop
 * source tree (packages/plugin-sdk), instead of eyeballing the published spec.
 *
 * The published spec (docs/spec/07-plugins/02-plugin-manifest-schema.md) is
 * stale: it does not list `ui.shape` or `ui.alwaysOnTop`, yet the shipped host
 * reads them. The SDK is the source of truth.
 *
 * Run:  node tools/validate-manifest.mjs [path-to-sdk-index.ts]
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const pluginArg = process.argv[3] || "plugins/local.summon-widget";
const manifestPath = path.resolve(repoRoot, pluginArg, "manifest.json");

const sdkPath =
  process.argv[2] ||
  "D:/Code/Working-on-it/PI-Desktop-src/packages/plugin-sdk/src/index.ts";

if (!existsSync(sdkPath)) {
  console.error(`SDK validator not found at:\n  ${sdkPath}\n`);
  console.error("Pass the path explicitly, or clone PI-Desktop first:");
  console.error("  git clone --depth 1 https://gitcode.com/GitHub_Trending/pid/PI-Desktop.git ../PI-Desktop-src");
  process.exit(2);
}

// The SDK's TS sources import "./x.js" while the file on disk is x.ts; teach
// Node that rewrite before importing them.
register(new URL("./ts-js-resolver.mjs", import.meta.url).href);

const sdk = await import(pathToFileURL(sdkPath).href);
const { validateManifest } = sdk;

if (typeof validateManifest !== "function") {
  console.error("plugin-sdk did not export validateManifest");
  process.exit(2);
}

const raw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(raw);

console.log(`validating ${path.relative(repoRoot, manifestPath)}`);
console.log(`against    ${sdkPath}\n`);

const result = validateManifest(manifest);

if (!result.ok) {
  console.log("FAIL  manifest rejected");
  console.log(`      ${result.error}`);
  process.exit(1);
}

console.log("PASS  manifest accepted by the real validator\n");

// Echo the normalized widget fields — this is what the host will actually use.
const ui = result.manifest?.ui ?? {};
console.log("normalized ui:");
for (const key of ["shape", "panel", "width", "height", "alwaysOnTop", "resizable"]) {
  console.log(`  ${key.padEnd(12)} ${JSON.stringify(ui[key])}`);
}

const shortcuts = result.manifest?.contributes?.globalShortcuts ?? [];
console.log("\nnormalized globalShortcuts:");
for (const s of shortcuts) {
  console.log(`  id=${s.id} command=${s.command} default=${JSON.stringify(s.default)}`);
}

console.log(`\npermissions: ${JSON.stringify(result.manifest?.permissions ?? [])}`);
