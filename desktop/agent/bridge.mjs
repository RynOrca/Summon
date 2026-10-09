import { createInterface } from "node:readline";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApprovalGate } from "./approval.mjs";
import { RoleStore } from "./roles.mjs";
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
const roles = new RoleStore(dataDir);
await roles.load();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let runtime;
let session;
let busy = false;
let queue = Promise.resolve();
const approvalGate = createApprovalGate(send);

async function getRuntime() {
  if (!runtime) {
    runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
  }
  return runtime;
}

async function openSession(provider, modelId, sessionManager = SessionManager.continueRecent(cwd, sessionsDir)) {
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
    extensionFactories: [approvalGate.extension],
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
    tools: ["read", "ls", "find", "grep", "edit", "write", "bash", "powershell"],
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  session?.dispose();
  session = created.session;
  session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        send({ type: "delta", kind: update.type === "text_delta" ? "text" : "thinking", text: update.delta });
      }
    } else if (event.type === "tool_execution_start") {
      send({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      send({ type: "tool_end", id: event.toolCallId, isError: event.isError, result: event.result });
    } else if (event.type === "agent_settled") {
      send({ type: "settled" });
    }
  });
  send({ type: "session", model: session.model && session.model.provider !== "unknown" ? `${session.model.provider}/${session.model.id}` : null, sessionId: session.sessionId, sessionName: session.sessionName || "", thinkingLevel: session.thinkingLevel, availableThinkingLevels: session.getAvailableThinkingLevels(), workspace: cwd, roleId: roles.activeId });
  send({
    type: "history",
    messages: session.state.messages.map((message) => ({
      role: message.role,
      content: (Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }]).filter((block) =>
        block.type === "text" || block.type === "thinking" || block.type === "toolCall"
      ).map((block) => ({ type: block.type, text: block.text, name: block.name, id: block.id, arguments: block.arguments })),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    })),
  });
}

async function handle(command) {
  const id = command.id;
  try {
    switch (command.type) {
      case "init": {
        const models = await getRuntime();
        const available = await models.getAvailable();
        send({ type: "models", id, models: available.map((model) => ({ provider: model.provider, id: model.id, name: model.name })) });
        send({ type: "roles", ...roles.list() });
        await openSession(command.provider, command.model);
        break;
      }
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
        if (!session.getAvailableThinkingLevels().includes(command.level)) throw new Error("该模型不支持此思考深度");
        session.setThinkingLevel(command.level, { persist: true });
        send({ type: "thinking_level", level: session.thinkingLevel, availableThinkingLevels: session.getAvailableThinkingLevels() });
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
      case "change_workspace": {
        if (busy) throw new Error("Wait for the current response to finish");
        if (typeof command.path !== "string" || !command.path.trim()) throw new Error("Choose a workspace folder");
        const next = resolve(command.path.trim());
        if (!(await stat(next)).isDirectory()) throw new Error("Workspace path is not a folder");
        const previous = cwd;
        const model = session?.model;
        cwd = next;
        try {
          await openSession(model?.provider === "unknown" ? undefined : model?.provider, model?.provider === "unknown" ? undefined : model?.id);
        } catch (error) {
          cwd = previous;
          throw error;
        }
        send({ type: "ack", id });
        break;
      }
      case "list_sessions": {
        const sessions = await SessionManager.list(cwd, sessionsDir);
        send({ type: "sessions", id, sessions: sessions.map((item) => ({
          id: item.id,
          title: item.name || item.firstMessage || "新会话",
          modified: item.modified,
          messageCount: item.messageCount,
        })) });
        break;
      }
      case "new_session": {
        if (busy) throw new Error("Wait for the current response to finish");
        const model = session?.model;
        await openSession(model?.provider === "unknown" ? undefined : model?.provider,
          model?.provider === "unknown" ? undefined : model?.id,
          SessionManager.create(cwd, sessionsDir));
        send({ type: "ack", id });
        break;
      }
      case "open_session": {
        if (busy) throw new Error("Wait for the current response to finish");
        if (typeof command.sessionId !== "string") throw new Error("Session ID is required");
        const path = SessionManager.findById(cwd, command.sessionId, sessionsDir);
        if (!path) throw new Error("Session not found in this workspace");
        const model = session?.model;
        await openSession(model?.provider === "unknown" ? undefined : model?.provider,
          model?.provider === "unknown" ? undefined : model?.id,
          SessionManager.open(path, sessionsDir, cwd));
        send({ type: "ack", id });
        break;
      }
      case "prompt":
        if (busy) throw new Error("A response is already running");
        if (!session) await openSession();
        if (!session.model || session.model.provider === "unknown") throw new Error("Configure an API key and select a model first");
        busy = true;
        send({ type: "started", id });
        try {
          await session.prompt(command.text);
          send({ type: "done", id });
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
session?.dispose();
approvalGate.cancel("Agent 进程已退出");
