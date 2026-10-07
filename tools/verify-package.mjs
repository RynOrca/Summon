/**
 * Check one packed `.piplug` against its source directory.
 *
 * Why this exists: the plugin center audits the **package**, and two of its checks
 * bit us in one round of review — the file name must match the packaged manifest
 * (`PKG012`), and the manifest is what the reviewer actually reads (`MAN013` asked
 * why two permissions exist). Editing `manifest.json` and packing are separate
 * steps while the package is what gets uploaded, so the two can drift without
 * anything failing locally.
 *
 *   node tools/verify-package.mjs dist/local.summon-chat-0.26.1.piplug
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const pkgArg = process.argv[2];
if (!pkgArg) {
  console.error("用法：node tools/verify-package.mjs <path/to/xxx.piplug> [插件目录]");
  process.exit(1);
}
const pkgPath = path.resolve(pkgArg);
const pluginDir = path.resolve(process.argv[3] || "plugins/local.summon-chat");

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
}

/**
 * Read the package's entries.
 *
 * A `.piplug` is a **store-only** ZIP (see tools/verify-artifact.mjs), so bytes sit
 * right after each local file header. Walking the headers instead of reading the
 * central directory also proves the file really is store-only.
 */
function readZipEntries(buf) {
  const entries = new Map();
  let i = 0;
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      i++;
      continue;
    }
    const method = buf.readUInt16LE(i + 8);
    const compressed = buf.readUInt32LE(i + 18);
    const size = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    const dataAt = i + 30 + nameLen + extraLen;
    entries.set(name, { method, compressed, size, dataAt });
    i = dataAt + compressed;
  }
  return entries;
}

const buf = await readFile(pkgPath);
const entries = readZipEntries(buf);
const fileName = path.basename(pkgPath);

console.log(`=== ${fileName} ===`);

const manifestEntry = entries.get("manifest.json");
check("包里含 manifest.json", !!manifestEntry);
if (!manifestEntry) process.exit(1);
check("manifest.json 是 store-only（未压缩）", manifestEntry.method === 0,
  `方法号 ${manifestEntry.method} —— 用普通 zip 重打会破坏 .piplug 契约`);

const packaged = JSON.parse(buf.toString("utf8", manifestEntry.dataAt, manifestEntry.dataAt + manifestEntry.size));
const source = JSON.parse(await readFile(path.join(pluginDir, "manifest.json"), "utf8"));

check("包内 id 与源一致", packaged.id === source.id, `包内 ${packaged.id} / 源 ${source.id}`);
check("包内 version 与源一致", packaged.version === source.version,
  `包内 ${packaged.version} / 源 ${source.version} —— 改了 manifest 要重新 pack`);
// 控制台的两条硬要求，逐字对齐，省掉一轮审核往返：
check("文件名 == <id>-<version>.piplug", fileName === `${packaged.id}-${packaged.version}.piplug`,
  `上传时用的名字必须是 ${packaged.id}-${packaged.version}.piplug`);
check("包内权限与源一致",
  JSON.stringify(packaged.permissions) === JSON.stringify(source.permissions),
  `包内 ${(packaged.permissions || []).join(",")} / 源 ${(source.permissions || []).join(",")}`);

// 人工评审读的就是这几个字段，空了就等于让评审来问你。
check("description 非空", typeof packaged.description === "string" && packaged.description.length > 40);
check("safetyNotes 非空（人工评审读的就是它）",
  typeof packaged.safetyNotes === "string" && packaged.safetyNotes.length > 200,
  "manifest.safetyNotes 缺失或过短");
check("zh-CN safetyNotes 非空", typeof packaged.i18n?.["zh-CN"]?.safetyNotes === "string" &&
  packaged.i18n["zh-CN"].safetyNotes.length > 100);
check("author 不是占位值", !!packaged.author && packaged.author !== "local", `author=${packaged.author}`);

// 包内容：应只有插件自己的文件，不该把仓库卷进去。
const names = [...entries.keys()].sort();
const expected = (await readdir(pluginDir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(pluginDir, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
  .sort();
check("包内容 == 插件目录内容（不多不少）",
  JSON.stringify(names) === JSON.stringify(expected),
  `包内 ${names.length} 个：${names.join(", ")}\n        目录 ${expected.length} 个：${expected.join(", ")}`);

const total = (await Promise.all(expected.map(async (rel) => (await stat(path.join(pluginDir, rel))).size)))
  .reduce((a, b) => a + b, 0);
console.log(`  INFO  ${names.length} 个文件 · ${buf.length} 字节 · sha256 ${createHash("sha256").update(buf).digest("hex")}`);
void total;

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
