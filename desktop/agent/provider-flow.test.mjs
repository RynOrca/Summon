import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { ProviderStore, normalizeDiscoveredModel } from "./providers.mjs";
import { MemoryStore } from "./memory.mjs";
import { createMemoryAgent } from "./memory-agent.mjs";

test("discovery leaves missing metadata unknown and clears obsolete endpoint models", async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-provider-test-"));
  try {
    assert.equal(normalizeDiscoveredModel({ id: "unlisted" }).contextWindow, null);
    assert.equal(normalizeDiscoveredModel({ id: "unlisted" }).reasoning, null);
    const runtime = { getModels: () => [], refresh: async () => {}, setRuntimeApiKey: async () => {} };
    const store = new ProviderStore(root, { protect: async key => `encrypted:${key}`, unprotect: async key => key.slice(10), request: async () => ({ ok: true, json: async () => ({ data: [{ id: "test", context_length: 65536, supports_reasoning: true, reasoning_efforts: ["off", "low", "high"] }] }) }) });
    await store.load(); const provider = await store.save({ template: "custom", baseUrl: "http://127.0.0.1:12345/v1", protocol: "openai-completions", key: "isolated-key" });
    await store.discover(provider.id, runtime);
    assert.equal(provider.models[0].contextWindow, 65536);
    assert.deepEqual(provider.models[0].thinkingLevels, ["off", "low", "high"]);
    assert.ok(!(await readFile(store.path, "utf8")).includes("isolated-key"));
    await store.save({ providerId: provider.id, template: "custom", baseUrl: "http://127.0.0.1:12346/v1", protocol: "openai-completions" }); await store.install(runtime);
    assert.equal(JSON.parse(await readFile(store.modelsPath, "utf8")).providers[provider.id], undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelled background consolidation cannot write delayed results", async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-memory-cancel-"));
  try {
    const memory = new MemoryStore(root, root); await memory.load();
    let finish, called; const started = new Promise(resolve => { called = resolve; });
    const agent = createMemoryAgent({ memory, send: () => {}, currentSession: () => ({ model: { provider: "test" }, sessionId: "isolated", state: { messages: [{ role: "user", content: "我学习数学" }] } }), runtime: async () => ({ completeSimple: async () => { called(); return new Promise(resolve => { finish = resolve; }); } }) });
    const task = agent.consolidate(); await started; agent.cancel();
    finish({ content: [{ type: "text", text: '{"facts":[{"key":"目标","content":"被取消的结果"}],"notes":[]}' }] }); await task;
    assert.equal(memory.snapshot().facts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real PI bridge: discover, stream, remember, background memory, projects and restart", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-full-flow-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "test-model", context_length: 65536, supports_reasoning: true, reasoning_efforts: ["off", "low", "high"] }] })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (body.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("模拟鉴权失败"))) {
      response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "isolated authentication failure", type: "authentication_error" } })); return;
    }
    const consolidating = body.messages.some(m => typeof m.content === "string" && m.content.includes("记忆整理器"));
    const usedTool = body.messages.some(m => m.role === "tool");
    let delta, finish;
    if (consolidating) { delta = { content: '{"facts":[{"key":"学习目标","content":"学习线性代数"}],"notes":[{"title":"矩阵","body":"矩阵用于表示线性变换。"}]}' }; finish = "stop"; }
    else if (!usedTool && body.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("记住"))) {
      delta = { tool_calls: [{ index: 0, id: "remember-test", type: "function", function: { name: "remember", arguments: JSON.stringify({ layer: "profile", key: "学习目标", content: "学习线性代数" }) } }] }; finish = "tool_calls";
    } else { delta = { content: "已记住你的学习目标。" }; finish = "stop"; }
    response.setHeader("content-type", "text/event-stream");
    const chunk = (delta, finish_reason = null) => ({ id: "test-completion", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let child, seq = 0, messages = [], waiting = [], stderr = "";
  const script = process.env.SUMMON_TEST_BRIDGE || join(dirname(fileURLToPath(import.meta.url)), "bridge.mjs");
  function start() {
    messages = []; stderr = "";
    child = spawn(process.env.SUMMON_TEST_NODE || process.execPath, [script], { cwd: root, env: { ...process.env, SUMMON_DATA_DIR: join(root, "data"), SUMMON_WORKSPACE: root }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", chunk => { stderr += chunk; });
    createInterface({ input: child.stdout }).on("line", line => { const message = JSON.parse(line); messages.push(message); for (const waiter of [...waiting]) if (waiter.predicate(message)) { waiting = waiting.filter(w => w !== waiter); clearTimeout(waiter.timer); waiter.resolve(message); } });
  }
  function until(predicate) {
    const found = messages.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const waiter = { predicate, resolve }; waiter.timer = setTimeout(() => { waiting = waiting.filter(w => w !== waiter); reject(new Error(`Timeout: ${stderr}; last messages: ${JSON.stringify(messages.slice(-3))}`)); }, 25000); waiting.push(waiter); });
  }
  async function command(type, args = {}) {
    const id = `full-${++seq}`; child.stdin.write(JSON.stringify({ type, id, ...args }) + "\n");
    const result = await until(m => m.id === id && ["ack", "done", "error", "sessions"].includes(m.type));
    assert.notEqual(result.type, "error", result.message || stderr); return result;
  }
  async function stop() { if (!child || child.exitCode !== null) return; const closed = once(child, "close"); child.stdin.end(); await closed; }
  try {
    start(); await until(m => m.type === "ready"); await command("init");
    const provider = await command("save_provider", { template: "custom", name: "隔离测试", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "openai-completions" });
    await command("discover_models", { providerId: provider.providerId });
    assert.equal(messages.filter(m => m.type === "models").at(-1).models.find(m => m.id === "test-model").contextWindow, 65536);
    await command("select_model", { provider: provider.providerId, model: "test-model" });
    await command("set_thinking_level", { level: "high" });
    await command("prompt", { text: "请记住，我在学习线性代数" });
    assert.ok(messages.some(m => m.type === "delta" && m.text.includes("记住")));
    assert.ok(messages.some(m => m.type === "tool_end" && m.name !== "other" && !m.isError));
    await until(m => m.type === "memory_status" && m.status === "saved");
    const memory = JSON.parse(await readFile(join(root, "data", "memory.json"), "utf8"));
    assert.equal(memory.facts[0].content, "学习线性代数"); assert.equal(memory.notes[0].title, "矩阵");
    assert.ok(requests[0].messages.some(m => ["system", "developer"].includes(m.role) && JSON.stringify(m.content).includes("remember")), JSON.stringify(requests[0].messages[0]));
    assert.equal(requests[0].reasoning_effort, "high");
    const first = messages.filter(m => m.type === "session").at(-1).sessionId;
    const project = join(root, "test-project"); await mkdir(project);
    await command("change_workspace", { path: project }); await command("prompt", { text: "项目对话" });
    await command("new_session", { noProject: true });
    const list = await command("list_sessions");
    assert.ok(list.sessions.some(m => m.id === first && m.projectPath === null));
    assert.ok(list.sessions.some(m => m.projectPath === project));
    await command("open_session", { sessionId: first }); await stop();
    start(); await until(m => m.type === "ready"); await command("init");
    assert.equal(messages.filter(m => m.type === "session").at(-1).sessionId, first);
    assert.ok(messages.some(m => m.type === "history" && m.messages.length > 1));
    await command("prompt", { text: "模拟鉴权失败" });
    assert.ok(messages.some(m => m.type === "error" && /authentication|401/.test(m.message)), "SDK 请求失败必须显示错误，不能静默回到就绪");
  } finally {
    for (const waiter of waiting) clearTimeout(waiter.timer); waiting = [];
    if (child?.exitCode === null) { child.kill(); await once(child, "close"); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
