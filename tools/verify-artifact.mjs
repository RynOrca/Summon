/**
 * Verify a packed `.piplug` really is what the installer accepts.
 *
 * A `.piplug` must be a *store-only* ZIP (compression method 0 for every entry).
 * Normal `zip` defaults use deflate, and PI-Desktop rejects such an archive —
 * so this catches the one failure mode that has nothing to do with the manifest.
 *
 * Run:  node tools/verify-artifact.mjs [path/to/file.piplug]
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const distDir = path.join(repoRoot, "dist");

async function resolveArtifact() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (!existsSync(distDir)) return null;
  const entries = await readdir(distDir);
  const piplugs = entries.filter((f) => f.endsWith(".piplug")).sort();
  if (piplugs.length === 0) return null;
  return path.join(distDir, piplugs[piplugs.length - 1]);
}

const artifact = await resolveArtifact();
if (!artifact || !existsSync(artifact)) {
  console.error("No .piplug found. Run `npm run pack` first, or pass a path.");
  process.exit(2);
}

const buffer = await readFile(artifact);
const LOCAL_HEADER = 0x04034b50;

let offset = 0;
let entries = 0;
let deflated = 0;
const names = [];

while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === LOCAL_HEADER) {
  const method = buffer.readUInt16LE(offset + 8);
  const compressedSize = buffer.readUInt32LE(offset + 18);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);

  const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
  names.push(name);
  entries++;
  if (method !== 0) deflated++;

  offset += 30 + nameLength + extraLength + compressedSize;
  if (compressedSize === 0 && nameLength === 0) break;
}

const { size } = await stat(artifact);
console.log(`artifact  ${path.relative(repoRoot, artifact)}`);
console.log(`bytes     ${size}`);
console.log(`entries   ${entries}`);
for (const name of names) console.log(`  ${name}`);

let failures = 0;
if (entries === 0) {
  console.log("\nFAIL  no ZIP entries parsed — is this really a ZIP?");
  failures++;
}
if (deflated > 0) {
  console.log(`\nFAIL  ${deflated} entry/entries use compression; a .piplug must be store-only.`);
  console.log("      Re-pack with `npm run pack` — do not re-zip with a generic zip tool.");
  failures++;
}
if (!names.includes("manifest.json")) {
  console.log("\nFAIL  manifest.json is not at the package root.");
  failures++;
}

console.log(failures === 0 ? "\nPASS  store-only ZIP with manifest.json at the root" : "");
process.exit(failures === 0 ? 0 : 1);
