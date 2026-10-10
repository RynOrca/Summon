import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
    assert.equal(normalizeDiscoveredModel({id:"levels-only",reasoning_efforts:["low","max"]}).reasoning,true);
    assert.deepEqual(normalizeDiscoveredModel({id:"qwen-local",thinking_format:"qwen-chat-template"}).thinkingLevels,["off","medium"]);
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
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "test-model", context_length: 65536, supports_reasoning: true, reasoning_efforts: ["off", "low", "high"] },{id:"unknown-model",context_length:65536}] })); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (body.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("模拟鉴权失败"))) {
      response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "isolated authentication failure", type: "authentication_error" } })); return;
    }
    const consolidating = body.messages.some(m => typeof m.content === "string" && m.content.includes("记忆整理器"));
    const usedTool = body.messages.some(m => m.role === "tool");
    const lastUser=body.messages.filter(m=>m.role==="user").at(-1);
    if(JSON.stringify(lastUser?.content).includes("QUEUE_START")) await new Promise(r=>setTimeout(r,500));
    let delta, finish;
    if (consolidating) { delta = { content: '{"facts":[{"key":"学习目标","content":"学习线性代数"}],"notes":[{"title":"矩阵","body":"矩阵用于表示线性变换。"}],"learningEvents":[{"kind":"goal","subject":"线性代数","detail":"学习线性代数","evidence":"我在学习线性代数","status":"active"}]}' }; finish = "stop"; }
    else if (body.tools?.length && !usedTool && body.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("记住"))) {
      delta = { tool_calls: [{ index: 0, id: "remember-test", type: "function", function: { name: "remember", arguments: JSON.stringify({ layer: "profile", key: "学习目标", content: "学习线性代数" }) } }] }; finish = "tool_calls";
    } else { delta = { content: "已记住你的学习目标。" }; finish = "stop"; }
    response.setHeader("content-type", "text/event-stream");
    const chunk = (delta, finish_reason = null) => ({ id: "test-completion", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
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
    await mkdir(join(root,"data","agent"),{recursive:true});await writeFile(join(root,"data","agent","settings.json"),JSON.stringify({compaction:{reserveTokens:1024,keepRecentTokens:64}}));
    start(); await until(m => m.type === "ready"); await command("init");
    const provider = await command("save_provider", { template: "custom", name: "隔离测试", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "openai-completions" });
    await command("discover_models", { providerId: provider.providerId });
    assert.equal(messages.filter(m => m.type === "models").at(-1).models.find(m => m.id === "test-model").contextWindow, 65536);
    await command("select_model", { provider: provider.providerId, model: "test-model" });
    await command("select_model", { provider: provider.providerId, model: "test-model", thinkingLevel:"low" });
    assert.equal(messages.filter(m=>m.type==="session").at(-1).thinkingLevel,"low");
    await command("set_thinking_level", { level: "high" });
    const vault = join(root, "test-vault"), skill = join(root, "test-skill"); await mkdir(vault); await mkdir(skill);
    await writeFile(join(vault, "线性代数.md"), "# 矩阵\n\n矩阵可以表示线性变换。\n");
    await writeFile(join(skill, "SKILL.md"), "---\nname: test-study\ndescription: TEST_SKILL_DESCRIPTION\n---\nONLY_BODY_SENTINEL\n");
    await command("configure_capabilities", { vaultPath: vault });
    await command("import_skill", { path: skill });
    const role = await command("save_role", { name: "测试导师", system: "TEST_ROLE_SYSTEM_PRIORITY：用中文教学" });
    const roleId = messages.filter(m => m.type === "roles").at(-1).roles.find(r => r.name === "测试导师").id;
    await command("select_role", { roleId });
    await command("prompt", { text: "请记住，我在学习线性代数" });
    assert.ok(messages.some(m => m.type === "delta" && m.text.includes("记住")));
    assert.ok(messages.some(m => m.type === "tool_end" && m.name !== "other" && !m.isError));
    await until(m => m.type === "memory_status" && m.status === "saved");
    const memory = JSON.parse(await readFile(join(root, "data", "memory.json"), "utf8"));
    assert.equal(memory.facts[0].content, "学习线性代数"); assert.equal(memory.notes[0].title, "矩阵");
    const profile = JSON.parse(await readFile(join(root, "data", "learner.json"), "utf8")); assert.equal(profile.goals[0].subject, "线性代数");
    const prompt = JSON.stringify(requests[0].messages.filter(m => ["system", "developer"].includes(m.role)));
    assert.ok(prompt.includes("TEST_ROLE_SYSTEM_PRIORITY")); assert.ok(prompt.includes("TEST_SKILL_DESCRIPTION")); assert.ok(!prompt.includes("ONLY_BODY_SENTINEL")); assert.ok(prompt.includes("线性代数.md")); assert.ok(prompt.includes("summon-file:"));
    for (const name of ["current_time", "web_search", "fetch_url", "browser", "file_manage", "search_notes", "record_learning_event"]) assert.ok(requests[0].tools.some(t => t.function?.name === name), `missing ${name}`);
    const telemetry = messages.filter(m => m.type === "telemetry" && m.tokPerSecond).at(-1); assert.equal(telemetry.capacity, 65536); assert.ok(telemetry.tokens > 0 && telemetry.percent > 0); assert.equal(telemetry.outputTokens, 40); assert.ok(telemetry.tokPerSecond > 0);
    const skillId = messages.filter(m => m.type === "capabilities").at(-1).state.skills[0].id;
    await command("toggle_skill", { skillId, enabled: false }); await command("prompt", { text: "当前技能已关闭" });
    assert.ok(!JSON.stringify(requests.at(-1).messages.filter(m => ["system", "developer"].includes(m.role))).includes("TEST_SKILL_DESCRIPTION"), "disabled skill must leave effective system prompt");
    assert.ok(requests[0].messages.some(m => ["system", "developer"].includes(m.role) && JSON.stringify(m.content).includes("remember")), JSON.stringify(requests[0].messages[0]));
    assert.equal(requests[0].reasoning_effort, "high");
    const first = messages.filter(m => m.type === "session").at(-1).sessionId;
    const project = join(root, "test-project"); await mkdir(project);
    const readonly=join(project,"readonly");await mkdir(readonly);
    await command("add_readonly",{path:readonly});await command("add_readonly",{path:readonly});
    assert.deepEqual(messages.filter(m=>m.type==="agent_capabilities").at(-1).customReadOnly,[readonly]);
    await command("change_workspace", { path: project }); await command("prompt", { text: "项目对话" });
    await command("new_session", { noProject: true });
    const list = await command("list_sessions");
    assert.ok(list.sessions.some(m => m.id === first && m.projectPath === null));
    assert.ok(list.sessions.some(m => m.projectPath === project));
    await command("open_session", { sessionId: first }); await stop();
    start(); await until(m => m.type === "ready"); await command("init");
    assert.deepEqual(messages.filter(m=>m.type==="agent_capabilities").at(-1).customReadOnly,[readonly]);
    await command("remove_readonly",{path:readonly});assert.deepEqual(messages.filter(m=>m.type==="agent_capabilities").at(-1).customReadOnly,[]);
    assert.equal(messages.filter(m => m.type === "session").at(-1).sessionId, first);
    assert.ok(messages.some(m => m.type === "history" && m.messages.length > 1));
    for(const layer of ["l1","l2","l3"]) await command("memory_enabled", {layer,enabled:false});
    const queueStart=messages.length;
    const runningPrompt=command("prompt",{text:"QUEUE_START"});
    await until(m=>messages.indexOf(m)>=queueStart && m.type==="started");
    await command("queue_message",{text:"STEER_TEST",mode:"steer"});
    await command("queue_message",{text:"FOLLOW_TEST",mode:"followUp"});
    await runningPrompt;
    assert.ok(messages.slice(queueStart).some(m=>m.type==="user_delivered" && m.text==="STEER_TEST"));
    assert.ok(messages.slice(queueStart).some(m=>m.type==="user_delivered" && m.text==="FOLLOW_TEST"));
    assert.ok(requests.some(r=>JSON.stringify(r.messages).includes("STEER_TEST")));
    assert.ok(requests.some(r=>JSON.stringify(r.messages).includes("FOLLOW_TEST")));
    assert.ok(!requests[0].tools.some(t=>["bash","powershell"].includes(t.function?.name)));
    await command("set_approval",{mode:"auto"});await command("set_file_access",{mode:"full"});
    assert.equal(messages.filter(m=>m.type==="agent_capabilities").at(-1).access,"full");
    await command("set_file_access",{mode:"workspace"});
    await command("prompt", { text: "模拟鉴权失败" });
    assert.ok(messages.some(m => m.type === "error" && /authentication|401/.test(m.message)), "SDK 请求失败必须显示错误，不能静默回到就绪");
    assert.equal(messages.filter(m=>m.type==="session").at(-1).autoCompaction,true);
    await command("compact");assert.ok(messages.some(m=>m.type==="compaction" && m.status==="done"));
    await command("archive_session",{sessionId:first});assert.equal((await command("list_sessions")).sessions.find(s=>s.id===first).archived,true);
    await command("archive_session",{sessionId:first,archived:false});assert.equal((await command("list_sessions")).sessions.find(s=>s.id===first).archived,false);
    await command("select_role",{roleId:"planner"});await command("prompt",{text:"Planner 规划测试"});
    const plannerTools=requests.at(-1).tools.map(t=>t.function?.name);assert.ok(!plannerTools.includes("write")&&!plannerTools.includes("mcp_call"));assert.ok(plannerTools.includes("read"));
    assert.match(JSON.stringify(requests.at(-1).messages[0]),/Planner/);
    const plannerId=messages.filter(m=>m.type==="session").at(-1).sessionId;await command("delete_session",{sessionId:plannerId,confirm:true});assert.ok(!(await command("list_sessions")).sessions.some(s=>s.id===plannerId));
    await command("select_role",{roleId});await command("open_session",{sessionId:first});
    const unknown=messages.filter(m=>m.type==="models").at(-1).models.find(m=>m.id==="unknown-model");assert.equal(unknown.reasoning,null);assert.deepEqual(unknown.thinkingLevels,["off","low","medium","high","xhigh"]);
    await command("select_model",{provider:provider.providerId,model:"unknown-model",thinkingLevel:"xhigh"});assert.equal(messages.filter(m=>m.type==="session").at(-1).thinkingLevel,"xhigh");
    await command("prompt",{text:"默认档位验证"});assert.equal(requests.at(-1).reasoning_effort,"xhigh");
    await command("set_thinking_level",{level:"off"});await command("prompt",{text:"关闭默认思考"});assert.ok(!requests.at(-1).reasoning_effort);
    await command("delete_provider",{providerId:provider.providerId});
    assert.ok(!messages.filter(m=>m.type==="models").at(-1).models.some(m=>m.provider===provider.providerId));
    assert.ok(messages.filter(m=>m.type==="history").at(-1).messages.length>1,"删除供应商不能删除会话历史");
  } finally {
    for (const waiter of waiting) clearTimeout(waiter.timer); waiting = [];
    if (child?.exitCode === null) { child.kill(); await once(child, "close"); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
