import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

test("bridge selects an OpenAI-compatible remote model without contacting it", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-bridge-test-"));
  const script = join(dirname(fileURLToPath(import.meta.url)), "bridge.mjs");
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, SUMMON_DATA_DIR: join(root, "data"), SUMMON_WORKSPACE: root },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const seen = [];
  const waiting = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    seen.push(message);
    for (const waiter of waiting) if (waiter.predicate(message)) { waiting.delete(waiter); waiter.resolve(message); }
  });
  function until(predicate) {
    const existing = seen.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiting.add(waiter);
      setTimeout(() => { if (waiting.delete(waiter)) reject(new Error(`Bridge timeout: ${stderr}`)); }, 25000).unref();
    });
  }
  try {
    await until((message) => message.type === "ready");
    child.stdin.write(`${JSON.stringify({ id: "1", type: "init" })}\n`);
    await until((message) => message.type === "history");
    child.stdin.write(`${JSON.stringify({ id: "2", type: "configure_remote", baseUrl: "http://192.168.1.8:8000/v1", modelId: "qwen-local", key: "test-key-only" })}\n`);
    const result = await until((message) => message.id === "2" && ["ack", "error"].includes(message.type));
    assert.equal(result.type, "ack", result.message || stderr);
    assert.ok(seen.some((message) => message.type === "session" && message.model === "summon-remote/qwen-local"));
    assert.ok(seen.some((message) => message.type === "models" && message.models?.some((model) => model.id === "qwen-local")));
  } finally {
    child.stdin.end();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "close");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
