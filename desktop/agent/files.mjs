import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

export async function stageFile(directory, sessionId, name, data) {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error("会话标识无效");
  if (typeof name !== "string" || !name.trim()) throw new Error("文件名无效");
  if (typeof data !== "string" || !data || data.length > 7_000_000 || data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("文件内容格式或大小无效");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > 5 * 1024 * 1024) throw new Error("文件超过 5 MB");
  const safeName = basename(name).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 100) || "file";
  const targetDir = join(directory, "attachments", sessionId);
  await mkdir(targetDir, { recursive: true });
  const path = join(targetDir, `${randomUUID()}-${safeName}`);
  await writeFile(path, bytes, { flag: "wx" });
  return { path, name: safeName };
}
