import { createInterface } from "node:readline";
import { mkdir, stat, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApprovalGate } from "./approval.mjs";
import { RoleStore } from "./roles.mjs";
import { normalizeImages } from "./images.mjs";
import { stageFile } from "./files.mjs";
import { EndpointStore, REMOTE_PROVIDER, validateEndpoint } from "./endpoint.mjs";
import { MemoryStore } from "./memory.mjs";
import { ProviderStore } from "./providers.mjs";
import { createMemoryAgent } from "./memory-agent.mjs";
import { CapabilityStore } from "./capabilities.mjs";
import { createLearningTools, LEARNING_TOOLS } from "./learning-tools.mjs";
import { LearnerStore, learnerExtension } from "./learner.mjs";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const dataDir = process.env.SUMMON_DATA_DIR;
let cwd = process.env.SUMMON_WORKSPACE || process.cwd();
if (!dataDir) throw new Error("SUMMON_DATA_DIR is required");
await mkdir(dataDir, { recursive: true });
const agentDir = join(dataDir, "agent");
const sessionsDir = join(dataDir, "sessions");
await mkdir(agentDir, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
const neutralWorkspace = join(dataDir, "workspace");
await mkdir(neutralWorkspace, { recursive: true });
const appStatePath = join(dataDir, "app-state.json");
const metadataPath = join(dataDir, "session-meta.json");
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }
async function saveJson(path, value) { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2)); await rename(`${path}.tmp`, path); }
const appState = await readJson(appStatePath, {});
if (appState.provider === "unknown") { delete appState.provider; delete appState.modelId; }
const metadata = await readJson(metadataPath, {});
let projectPath = appState.projectPath || null;
if (projectPath && !(await stat(projectPath).catch(() => null))?.isDirectory()) projectPath = null;
cwd = projectPath || neutralWorkspace;
const roles = new RoleStore(dataDir);
await roles.load();
const endpoint = new EndpointStore(agentDir);
const memory = new MemoryStore(dataDir, sessionsDir);
await memory.load();
const providers = new ProviderStore(agentDir);
await providers.load();
const capabilities = new CapabilityStore(dataDir);
await capabilities.load();
const learner = new LearnerStore(dataDir);
await learner.load();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let runtime;
let session;
let busy = false;
let queue = Promise.resolve();
const approvalGate = createApprovalGate(send);
const memoryAgent = createMemoryAgent({ memory, learner, send, currentSession: () => session, runtime: getRuntime });
const learningTools = createLearningTools({ capabilities, currentWorkspace: () => cwd, roles, send });
const learnerTools = learnerExtension({ learner, memory, currentSession: () => session, send });
let generationStart = null, firstDelta = null, outputTokens = 0, generationMs = 0, missingUsage = false;
function emitTelemetry() {
  const model = session?.model;
  const info = model && runtime ? providers.modelInfo(model.provider, model.id, runtime) : null;
  const usage = session?.getContextUsage();
  const capacity = info?.contextWindow || null;
  const tokens = usage?.tokens ?? null;
  send({ type: "telemetry", tokens, capacity, percent: capacity && tokens !== null ? tokens / capacity * 100 : null, estimated: true, outputTokens: missingUsage ? null : outputTokens || null, tokPerSecond: !missingUsage && generationMs > 0 && outputTokens > 0 ? outputTokens / (generationMs / 1000) : null });
}

async function getRuntime() {
  if (!runtime) {
    runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    try {
      const savedKey = await endpoint.loadKey();
      if (savedKey) await runtime.setRuntimeApiKey(REMOTE_PROVIDER, savedKey);
    } catch (error) {
      send({ type: "credential_error", message: `远程模型凭据无法读取，请重新输入 Key：${error.message}` });
    }
    await providers.install(runtime);
  }
  return runtime;
}

async function openSession(provider, modelId, sessionManager) {
  memoryAgent.cancel();
  if (!sessionManager) {
    if (session) sessionManager = session.sessionManager;
    else {
      const saved = (await SessionManager.listAll(sessionsDir)).find((item) => item.id === appState.activeSessionId);
      sessionManager = saved ? SessionManager.open(saved.path, sessionsDir, cwd) : SessionManager.create(cwd, sessionsDir);
    }
  }
  approvalGate.cancel("会话已切换，工具操作未执行");
  const models = await getRuntime();
  const model = provider && modelId ? models.getModel(provider, modelId) : undefined;
  if (provider && modelId && !model) throw new Error(`Unknown model: ${provider}/${modelId}`);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: capabilities.enabledSkills(),
    extensionFactories: [approvalGate.extension, memoryAgent.extension, learningTools.extension, learnerTools],
    appendSystemPromptOverride: (base) => {
      const instructions = roles.current()?.system;
      return instructions ? [...base, instructions] : base;
    },
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model,
    tools: ["read", "ls", "find", "grep", "edit", "write", "bash", "powershell", "remember", "record_learning_event", ...LEARNING_TOOLS],
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  session?.dispose();
  session = created.session;
  metadata[session.sessionId] = { projectPath };
  Object.assign(appState, { activeSessionId: session.sessionId, projectPath, provider: session.model?.provider, modelId: session.model?.id });
  await saveJson(metadataPath, metadata); await saveJson(appStatePath, appState);
  session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") { generationStart = performance.now(); firstDelta = null; }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const n = event.message.usage?.output;
      if (Number.isFinite(n) && n > 0) { outputTokens += n; generationMs += Math.max(1, performance.now() - (generationStart ?? firstDelta ?? performance.now())); }
      else if (event.message.stopReason !== "error" && event.message.content?.some(b => b.type === "text" || b.type === "thinking")) missingUsage = true;
      emitTelemetry();
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        firstDelta ??= performance.now();
        send({ type: "delta", kind: update.type === "text_delta" ? "text" : "thinking", text: update.delta });
      }
    } else if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
      send({ type: "error", message: event.message.errorMessage || "模型请求失败，请检查服务地址、凭据和模型信息" });
    } else if (event.type === "tool_execution_start") {
      send({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      send({ type: "tool_end", id: event.toolCallId, isError: event.isError, result: event.result });
    } else if (event.type === "agent_settled") {
      send({ type: "settled" });
    }
  });
  emitSession();
  outputTokens = 0; generationMs = 0; missingUsage = false; emitTelemetry();
  send({
    type: "history",
    messages: session.state.messages.map((message) => ({
      role: message.role,
      content: (Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }]).filter((block) =>
        block.type === "text" || block.type === "thinking" || block.type === "toolCall" || block.type === "image"
      ).map((block) => ({ type: block.type, text: block.text, name: block.name, id: block.id, arguments: block.arguments, data: block.data, mimeType: block.mimeType })),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    })),
  });
}

function thinkingLevels() {
  const model = session?.model;
  return model && runtime ? providers.modelInfo(model.provider, model.id, runtime).thinkingLevels : ["off"];
}
function emitSession() {
  if (!session) return;
  send({ type: "session", model: session.model && session.model.provider !== "unknown" ? `${session.model.provider}/${session.model.id}` : null, modelName: session.model?.provider !== "unknown" ? session.model?.name || session.model?.id : null, sessionId: session.sessionId, sessionName: session.sessionName || "", thinkingLevel: session.thinkingLevel, availableThinkingLevels: thinkingLevels(), workspace: projectPath, roleId: roles.activeId });
}
async function emitState() {
  const models = await getRuntime();
  const available = await models.getAvailable();
  send({ type: "models", models: available.map((model) => ({ ...providers.modelInfo(model.provider, model.id, models), provider: model.provider, id: model.id, name: model.name })) });
  send({ type: "providers", providers: providers.snapshot(), templates: providers.templates(models) });
  send({ type: "roles", ...roles.list() });
  send({ type: "memory", state: memory.snapshot() });
  send({ type: "learner", state: learner.snapshot() });
  send({ type: "capabilities", state: capabilities.snapshot() });
  emitSession();
}

async function handle(command) {
  const id = command.id;
  try {
    switch (command.type) {
      case "init": {
        const remoteConfig = await endpoint.config();
        send({ type: "endpoint", config: remoteConfig, hasKey: await endpoint.loadKey().then(Boolean).catch(() => false) });
        if (!session) await openSession(command.provider || appState.provider || (remoteConfig ? REMOTE_PROVIDER : undefined), command.model || appState.modelId || remoteConfig?.modelId);
        await emitState();
        send({ type: "ack", id });
        break;
      }
      case "get_state":
        await emitState(); send({ type: "ack", id }); break;
      case "configure_capabilities":
      case "import_skill":
      case "toggle_skill": {
        if (busy) throw new Error("请等待当前回复结束");
        if (command.type === "configure_capabilities") await capabilities.configure(command);
        if (command.type === "import_skill") await capabilities.importSkill(command.path);
        if (command.type === "toggle_skill") await capabilities.toggleSkill(command.skillId, command.enabled);
        const model = session?.model;
        if (session) await openSession(model?.provider === "unknown" ? undefined : model?.provider, model?.provider === "unknown" ? undefined : model?.id);
        await emitState(); send({ type: "ack", id }); break;
      }
      case "search_notes":
        send({ type: "ack", id, results: await capabilities.searchNotes(command.query || "", 8) }); break;
      case "skill_detail": {
        const skill = capabilities.state.skills.find(s => s.id === command.skillId);
        if (!skill) throw new Error("技能不存在");
        send({ type: "ack", id, text: (await readFile(join(skill.path, "SKILL.md"), "utf8")).slice(0, 100000) }); break;
      }
      case "resolve_file":
        send({ type: "ack", id, path: await capabilities.resolveFile(command.path, cwd) }); break;
      case "save_provider": {
        if (busy) throw new Error("请等待当前回复结束");
        const saved = await providers.save(command);
        await providers.install(await getRuntime());
        await emitState(); send({ type: "ack", id, providerId: saved.id });
        break;
      }
      case "discover_models": {
        if (busy) throw new Error("请等待当前回复结束");
        await providers.discover(command.providerId, await getRuntime());
        await emitState(); send({ type: "ack", id });
        break;
      }
      case "update_model": {
        if (busy) throw new Error("请等待当前回复结束");
        await providers.updateModel(command.providerId, command.model, await getRuntime());
        await emitState(); send({ type: "ack", id });
        break;
      }
      case "configure_remote": {
        if (busy) throw new Error("请先等待当前回复结束");
        validateEndpoint(command.baseUrl, command.modelId);
        if (command.key) await endpoint.saveKey(command.key);
        else if (!(await endpoint.loadKey())) throw new Error("请填写 API Key");
        const config = await endpoint.saveConfig(command.baseUrl, command.modelId);
        const models = await getRuntime();
        await models.refresh();
        await models.setRuntimeApiKey(REMOTE_PROVIDER, await endpoint.loadKey());
        const available = await models.getAvailable();
        send({ type: "models", models: available.map((model) => ({ provider: model.provider, id: model.id, name: model.name })) });
        await openSession(REMOTE_PROVIDER, config.modelId);
        send({ type: "endpoint", config, hasKey: true });
        send({ type: "ack", id });
        break;
      }
      case "memory_enabled":
        memoryAgent.cancel();
        await memory.setEnabled(command.layer, command.enabled);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_profile":
        await memory.setProfile(command.profile);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_note_save":
        await memory.saveNote(command);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_note_delete":
        memoryAgent.cancel();
        await memory.deleteNote(command.noteId);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_fact_delete":
        memoryAgent.cancel(); await memory.deleteFact(command.key);
        send({ type: "memory", state: memory.snapshot() }); send({ type: "ack", id }); break;
      case "memory_consolidate":
          if (busy) throw new Error("请等待当前回复结束");
          if (!session?.model || session.model.provider === "unknown") throw new Error("请先配置并选择模型");
          if (!session.state.messages.some(message => message.role === "user")) throw new Error("请先进行对话，再整理记忆");
          if (!memory.state.enabled.l1 && !memory.state.enabled.l2) throw new Error("请先开启画像或知识库记忆");
        memoryAgent.cancel(); void memoryAgent.consolidate(); send({ type: "ack", id }); break;
      case "save_role": {
        if (busy) throw new Error("请先等待当前回复结束");
        const roleId = await roles.save(command);
        if (roleId === roles.activeId) {
          const model = session?.model;
          await openSession(model?.provider === "unknown" ? undefined : model?.provider,
            model?.provider === "unknown" ? undefined : model?.id);
        }
        send({ type: "roles", ...roles.list() });
        send({ type: "ack", id });
        break;
      }
      case "select_role": {
        if (busy) throw new Error("请先等待当前回复结束");
        await roles.select(command.roleId);
        const model = session?.model;
        await openSession(model?.provider === "unknown" ? undefined : model?.provider,
          model?.provider === "unknown" ? undefined : model?.id,
          SessionManager.create(cwd, sessionsDir));
        send({ type: "roles", ...roles.list() });
        send({ type: "ack", id });
        break;
      }
      case "delete_role": {
        if (busy) throw new Error("请先等待当前回复结束");
        const wasActive = roles.activeId === command.roleId;
        await roles.delete(command.roleId);
        if (wasActive) {
          const model = session?.model;
          await openSession(model?.provider === "unknown" ? undefined : model?.provider,
            model?.provider === "unknown" ? undefined : model?.id,
            SessionManager.create(cwd, sessionsDir));
        }
        send({ type: "roles", ...roles.list() });
        send({ type: "ack", id });
        break;
      }
      case "set_key": {
        if (!command.provider || !command.key) throw new Error("Provider and API key are required");
        await (await getRuntime()).setRuntimeApiKey(command.provider, command.key);
        send({ type: "ack", id });
        break;
      }
      case "select_model":
        if (busy) throw new Error("Wait for the current response to finish");
        await openSession(command.provider, command.model);
        send({ type: "ack", id });
        break;
      case "set_thinking_level": {
        if (busy) throw new Error("请先等待当前回复结束");
        if (!session) throw new Error("会话尚未就绪");
        if (!thinkingLevels().includes(command.level)) throw new Error("该模型不支持此思考深度");
        session.setThinkingLevel(command.level, { persist: true });
        send({ type: "thinking_level", level: session.thinkingLevel, availableThinkingLevels: thinkingLevels() });
        send({ type: "ack", id });
        break;
      }
      case "rename_session": {
        if (busy) throw new Error("请先等待当前回复结束");
        if (!session) throw new Error("会话尚未就绪");
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name || name.length > 100) throw new Error("请输入不超过 100 字的会话名称");
        session.setSessionName(name);
        send({ type: "session_name", sessionId: session.sessionId, name });
        send({ type: "ack", id });
        break;
      }
      case "copy_session": {
        if (!session) throw new Error("会话尚未就绪");
        const lines = [];
        for (const message of session.state.messages) {
          if (message.role !== "user" && message.role !== "assistant") continue;
          const content = typeof message.content === "string" ? message.content :
            (message.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("\n");
          if (content.trim()) lines.push(`${message.role === "user" ? "你" : "PI"}：${content.trim()}`);
        }
        send({ type: "conversation", id, text: lines.join("\n\n") });
        break;
      }
      case "stage_file": {
        if (!session) await openSession();
        const file = await stageFile(dataDir, session.sessionId, command.name, command.data);
        send({ type: "file_staged", id, ...file });
        break;
      }
      case "change_workspace": {
        if (busy) throw new Error("Wait for the current response to finish");
        if (typeof command.path !== "string" || !command.path.trim()) throw new Error("Choose a workspace folder");
        const next = resolve(command.path.trim());
        if (!(await stat(next)).isDirectory()) throw new Error("Workspace path is not a folder");
        const previous = cwd;
        const previousProject = projectPath;
        const model = session?.model;
        cwd = next;
        projectPath = next;
        try {
          await openSession(model?.provider === "unknown" ? undefined : model?.provider, model?.provider === "unknown" ? undefined : model?.id, SessionManager.create(cwd, sessionsDir));
        } catch (error) {
          cwd = previous;
          projectPath = previousProject;
          throw error;
        }
        send({ type: "ack", id });
        break;
      }
      case "list_sessions": {
        const sessions = await SessionManager.listAll(sessionsDir);
        send({ type: "sessions", id, sessions: sessions.map((item) => ({
          id: item.id,
          title: item.name || item.firstMessage || "新会话",
          modified: item.modified,
          messageCount: item.messageCount,
          projectPath: metadata[item.id] ? metadata[item.id].projectPath : ((item.cwd === neutralWorkspace || item.cwd === process.env.SUMMON_WORKSPACE) ? null : item.cwd),
        })) });
        break;
      }
      case "new_session": {
        if (busy) throw new Error("Wait for the current response to finish");
        const model = session?.model;
        if (command.noProject) { projectPath = null; cwd = neutralWorkspace; }
        await openSession(model?.provider === "unknown" ? undefined : model?.provider,
          model?.provider === "unknown" ? undefined : model?.id,
          SessionManager.create(cwd, sessionsDir));
        send({ type: "ack", id });
        break;
      }
      case "open_session": {
        if (busy) throw new Error("Wait for the current response to finish");
        if (typeof command.sessionId !== "string") throw new Error("Session ID is required");
        const info = (await SessionManager.listAll(sessionsDir)).find((item) => item.id === command.sessionId);
        if (!info) throw new Error("找不到该会话");
        projectPath = metadata[info.id] ? metadata[info.id].projectPath : ((info.cwd === neutralWorkspace || info.cwd === process.env.SUMMON_WORKSPACE) ? null : info.cwd);
        cwd = projectPath || neutralWorkspace;
        await openSession(undefined, undefined, SessionManager.open(info.path, sessionsDir, cwd));
        send({ type: "ack", id });
        break;
      }
      case "prompt":
        if (busy) throw new Error("A response is already running");
        if (!session) await openSession();
        if (!session.model || session.model.provider === "unknown") throw new Error("Configure an API key and select a model first");
        if (typeof command.text !== "string") throw new Error("消息文字无效");
        const images = normalizeImages(command.images);
        if (!command.text.trim() && !images.length) throw new Error("请输入消息或添加图片");
        busy = true;
        outputTokens = 0; generationMs = 0; missingUsage = false;
        memoryAgent.cancel();
        send({ type: "started", id });
        try {
          await session.prompt(command.text, { images });
          emitTelemetry();
          send({ type: "done", id });
          memoryAgent.schedule();
        } finally {
          busy = false;
        }
        break;
      case "abort":
        approvalGate.cancel("用户停止了当前操作");
        if (session) await session.abort();
        send({ type: "ack", id });
        break;
      case "tool_decision": {
        approvalGate.decide(command.requestId, command.decision, command.reason);
        send({ type: "ack", id });
        break;
      }
      default:
        throw new Error(`Unknown command: ${command.type}`);
    }
  } catch (error) {
    send({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  }
}

send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    send({ type: "error", message: "Invalid JSON command" });
    continue;
  }
  if (command.type === "abort" || command.type === "tool_decision") {
    void handle(command);
  } else {
    queue = queue.then(() => handle(command));
  }
}
await queue;
memoryAgent.cancel();
learningTools.close();
session?.dispose();
approvalGate.cancel("Agent 进程已退出");
