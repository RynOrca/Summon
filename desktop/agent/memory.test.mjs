import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./memory.mjs";
import { EndpointStore, validateEndpoint } from "./endpoint.mjs";

test("three memory layers respect their switches and remain editable", async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-memory-test-"));
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const store = new MemoryStore(root, sessions);
    await store.setProfile("我正在学习 Python，喜欢示例。");
    await store.saveNote({ title: "Python 函数", body: "def 定义 Python 函数；参数可以有默认值。" });
    await writeFile(join(sessions, "past.jsonl"), [
      JSON.stringify({ type: "session", id: "past", cwd: root }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Python 函数的默认参数怎么用？" }] } }),
    ].join("\n"));
    const context = await store.context("Python 函数默认参数", "current");
    assert.match(context, /学习者画像/);
    assert.match(context, /知识库资料/);
    assert.match(context, /历史对话片段/);
    await store.setEnabled("l2", false);
    await store.setEnabled("l3", false);
    const narrow = await store.context("Python 函数默认参数", "current");
    assert.match(narrow, /学习者画像/);
    assert.doesNotMatch(narrow, /知识库资料|历史对话片段/);
    const loaded = new MemoryStore(root, sessions);
    await loaded.load();
    assert.equal(loaded.snapshot().enabled.l3, false);
    await loaded.deleteNote(loaded.snapshot().notes[0].id);
    assert.equal(loaded.snapshot().notes.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("remote endpoint stores no plaintext API key in model config", async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-endpoint-test-"));
  try {
    const store = new EndpointStore(root);
    const value = await store.saveConfig("http://192.168.1.8:8000/v1/", "qwen-local");
    assert.equal(value.baseUrl, "http://192.168.1.8:8000/v1");
    assert.deepEqual(await store.config(), value);
    assert.doesNotMatch(await readFile(join(root, "models.json"), "utf8"), /apiKey/);
    assert.throws(() => validateEndpoint("http://user:password@host/v1", "model"));
    if (process.platform === "win32") {
      await store.saveKey("test-key-only");
      assert.equal(await store.loadKey(), "test-key-only");
      assert.doesNotMatch(await readFile(join(root, "endpoint-key.dpapi"), "utf8"), /test-key-only/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
