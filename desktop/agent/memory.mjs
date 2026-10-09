import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_PROFILE = 6000;
const MAX_NOTES = 100;
const MAX_NOTE_BODY = 20000;
const defaultState = () => ({ enabled: { l1: true, l2: true, l3: true }, profile: "", notes: [] });
const historyCache = new Map();

function terms(text) {
  const normalized = String(text).toLowerCase();
  const words = normalized.match(/[a-z0-9_]{2,}/g) || [];
  const han = (normalized.match(/[\p{Script=Han}]+/gu) || []).flatMap((part) =>
    part.length < 2 ? [part] : Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)));
  return [...new Set([...words, ...han])].slice(0, 80);
}

function score(query, text) {
  const haystack = String(text).toLowerCase();
  return terms(query).reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

function extractText(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return "";
  const content = message.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content
    .filter((block) => block?.type === "text").map((block) => block.text || "").join(" ") : "";
}

async function recentHistory(root, query, currentSessionId) {
  const files = [];
  async function visit(directory, depth) {
    if (depth > 3 || files.length >= 200) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await visit(root, 0);
  const newest = (await Promise.all(files.map(async (path) => ({ path, info: await stat(path).catch(() => null) }))))
    .filter(({ info }) => info && info.size <= 1024 * 1024)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 100);
  const candidates = [];
  for (const { path, info } of newest) {
    if (!info || info.size > 1024 * 1024) continue;
    let cached = historyCache.get(path);
    if (!cached || cached.modified !== info.mtimeMs || cached.size !== info.size) {
      const raw = await readFile(path, "utf8").catch(() => "");
      const lines = raw.split("\n");
      let sessionId = "";
      try { sessionId = JSON.parse(lines[0]).id || ""; } catch { /* skip malformed header */ }
      const contents = [];
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== "message") continue;
        const content = extractText(entry.message).replace(/\s+/g, " ").trim();
        if (content) contents.push(content.slice(0, 500));
      }
      cached = { modified: info.mtimeMs, size: info.size, sessionId, contents };
      historyCache.set(path, cached);
    }
    if (cached.sessionId === currentSessionId) continue;
    for (const content of cached.contents) {
      const relevance = score(query, content);
      if (relevance) candidates.push({ relevance, modified: info.mtimeMs, content: content.slice(0, 500) });
    }
  }
  candidates.sort((a, b) => b.relevance - a.relevance || b.modified - a.modified);
  return candidates.slice(0, 3).map((item) => item.content);
}

export class MemoryStore {
  constructor(directory, sessionsDirectory) {
    this.path = join(directory, "memory.json");
    this.sessionsDirectory = sessionsDirectory;
    this.state = defaultState();
  }

  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!saved || typeof saved !== "object") throw new Error("记忆文件无效");
    this.state.enabled = Object.fromEntries(["l1", "l2", "l3"].map((key) => [key, saved.enabled?.[key] !== false]));
    this.state.profile = typeof saved.profile === "string" ? saved.profile.slice(0, MAX_PROFILE) : "";
    this.state.notes = Array.isArray(saved.notes) ? saved.notes.filter((note) =>
      typeof note?.id === "string" && typeof note.title === "string" && typeof note.body === "string")
      .slice(0, MAX_NOTES).map((note) => ({ id: note.id, title: note.title.slice(0, 100), body: note.body.slice(0, MAX_NOTE_BODY) })) : [];
  }

  snapshot() { return structuredClone(this.state); }

  async persist() {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), "utf8");
    await rename(temporary, this.path);
  }

  async setEnabled(layer, enabled) {
    if (!["l1", "l2", "l3"].includes(layer) || typeof enabled !== "boolean") throw new Error("无效的记忆开关");
    this.state.enabled[layer] = enabled;
    await this.persist();
  }

  async setProfile(profile) {
    if (typeof profile !== "string" || profile.length > MAX_PROFILE) throw new Error("学习者画像最多 6000 字");
    this.state.profile = profile.trim();
    await this.persist();
  }

  async saveNote(input) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!title || title.length > 100 || !body || body.length > MAX_NOTE_BODY) throw new Error("标题或资料内容长度不合适");
    const existing = input.noteId && this.state.notes.find((note) => note.id === input.noteId);
    if (input.noteId && !existing) throw new Error("找不到该资料");
    if (!existing && this.state.notes.length >= MAX_NOTES) throw new Error("资料数量已达到上限");
    if (existing) Object.assign(existing, { title, body });
    else this.state.notes.push({ id: randomUUID(), title, body });
    await this.persist();
  }

  async deleteNote(id) {
    const count = this.state.notes.length;
    this.state.notes = this.state.notes.filter((note) => note.id !== id);
    if (count === this.state.notes.length) throw new Error("找不到该资料");
    await this.persist();
  }

  async context(query, currentSessionId) {
    const parts = [];
    if (this.state.enabled.l1 && this.state.profile) parts.push(`学习者画像（用户可编辑）：\n${this.state.profile}`);
    if (!terms(query).length) return parts.join("\n\n").slice(0, 5000);
    if (this.state.enabled.l2) {
      const matches = this.state.notes.map((note) => ({ note, relevance: score(query, `${note.title} ${note.body}`) }))
        .filter((item) => item.relevance > 0).sort((a, b) => b.relevance - a.relevance).slice(0, 3);
      if (matches.length) parts.push(`相关知识库资料：\n${matches.map(({ note }) => `【${note.title}】${note.body.slice(0, 900)}`).join("\n")}`);
    }
    if (this.state.enabled.l3) {
      const matches = await recentHistory(this.sessionsDirectory, query, currentSessionId);
      if (matches.length) parts.push(`相关历史对话片段（仅供参考，可能过时）：\n${matches.map((item) => `- ${item}`).join("\n")}`);
    }
    return parts.join("\n\n").slice(0, 5000);
  }
}
