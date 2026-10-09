// Transcript row structure and disclosure behavior adapted from PI-Desktop 0.16.1.
import { renderMarkdown } from "./markdown.js";
const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const messages = $("messages");
const transcript = $("transcript");
const prompt = $("prompt");
const settings = $("settings");
const historyDrawer = $("history-drawer");
const rolesDialog = $("roles-dialog");
let roles = [];
let activeRoleId = "agent";
let editingRoleId = null;
let activeSessionId = "";
let activeSessionName = "";
let sequence = 0;
let running = false;
let assistantRow = null;
let thinkingRow = null;
let submitted = null;
const toolRows = new Map();
const permissionRows = new Map();
const pending = new Map();

function status(text) {
  $("status").textContent = text;
  $("status").parentElement.classList.toggle("is-busy", /正在|连接/.test(text));
  $("status").parentElement.classList.toggle("is-error", /断开|出错|失败/.test(text));
}
function updateSendAvailability() { $("send-button").disabled = running || !prompt.value.trim(); }
function scrollToLatest() { transcript.scrollTop = transcript.scrollHeight; }
function refreshEmpty() { $("empty-state").hidden = messages.childElementCount > 0; }
function setRunning(value) {
  running = value;
  updateSendAvailability();
  $("stop-button").hidden = !value;
  status(value ? "PI 正在回复…" : "就绪");
}
function errorRow(message) {
  const row = document.createElement("div");
  row.className = "message-error";
  row.textContent = message;
  messages.append(row);
  refreshEmpty(); scrollToLatest();
}
function messageRow(role, text = "") {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  row.setAttribute("role", "article");
  row.setAttribute("aria-label", role === "user" ? "用户消息" : "助手消息");
  const col = document.createElement("div"); col.className = "message-col";
  const bubble = document.createElement("div"); bubble.className = "message-bubble";
  const content = document.createElement("div");
  content.className = role === "user" ? "message-user-text" : "prose-chat";
  if (role === "assistant") renderMarkdown(content, text);
  else content.textContent = text;
  bubble.append(content); col.append(bubble); row.append(col); messages.append(row);
  refreshEmpty(); scrollToLatest();
  return content;
}
function disclosure({ kind, title, summary = "", detail = "", state = "done", id }) {
  const row = document.createElement("div"); row.className = `tool-row ${kind}`;
  const head = document.createElement("button"); head.type = "button"; head.className = "tool-row-header";
  head.setAttribute("aria-expanded", "false");
  const icon = document.createElement("span"); icon.className = "tool-row-icon"; icon.textContent = kind === "thinking" ? "✧" : "⌁";
  const name = document.createElement("span"); name.className = "tool-row-name"; name.textContent = title;
  if (state === "running") name.classList.add("running");
  const brief = document.createElement("span"); brief.className = "tool-row-summary"; brief.textContent = summary;
  const indicator = document.createElement("span"); indicator.className = `tool-row-state is-${state}`;
  const dot = document.createElement("span"); dot.className = "tool-row-state-dot";
  const label = document.createElement("span"); label.textContent = state === "running" ? "运行中" : state === "error" ? "失败" : "完成";
  indicator.append(dot, label);
  const caret = document.createElement("span"); caret.className = "tool-row-caret"; caret.textContent = "›";
  head.append(icon, name, brief, indicator, caret);
  const body = document.createElement("div"); body.className = "tool-row-body"; body.hidden = true;
  if (id) body.id = `detail-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const content = document.createElement("div"); content.className = "tool-row-content"; content.textContent = detail;
  body.append(content); row.append(head, body); messages.append(row);
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    row.classList.toggle("open", !body.hidden);
    head.setAttribute("aria-expanded", String(!body.hidden));
  });
  refreshEmpty(); scrollToLatest();
  return { row, head, name, brief, indicator, label, content };
}
function updateDisclosure(row, state) {
  row.name.classList.toggle("running", state === "running");
  row.indicator.className = `tool-row-state is-${state}`;
  row.label.textContent = state === "running" ? "运行中" : state === "error" ? "失败" : "完成";
}
function pretty(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function toolStart(event) {
  const detail = pretty(event.args);
  const row = disclosure({ kind: "tool", title: event.name || "工具", summary: detail.replace(/\s+/g, " ").slice(0, 120), detail, state: "running", id: event.id });
  toolRows.set(event.id, row);
}
function toolEnd(event) {
  const row = toolRows.get(event.id);
  if (!row) return;
  row.content.textContent = `${row.content.textContent}\n\n结果\n${pretty(event.result)}`;
  updateDisclosure(row, event.isError ? "error" : "done");
  scrollToLatest();
}
function permissionRequest(event) {
  const row = disclosure({
    kind: "permission",
    title: `允许 ${event.name || "工具"}？`,
    summary: "等待确认",
    detail: pretty(event.args),
    state: "running",
    id: event.requestId,
  });
  const actions = document.createElement("div");
  actions.className = "permission-actions";
  const allow = document.createElement("button");
  allow.type = "button"; allow.className = "permission-allow"; allow.textContent = "允许";
  const deny = document.createElement("button");
  deny.type = "button"; deny.className = "permission-deny"; deny.textContent = "拒绝";
  actions.append(allow, deny); row.row.append(actions);
  const decide = async (decision) => {
    allow.disabled = true; deny.disabled = true;
    row.brief.textContent = decision === "allow" ? "已允许" : "已拒绝";
    updateDisclosure(row, decision === "allow" ? "done" : "error");
    try { await command("tool_decision", { requestId: event.requestId, decision }, true); }
    catch (error) { errorRow(String(error)); }
  };
  allow.addEventListener("click", () => void decide("allow"));
  deny.addEventListener("click", () => void decide("deny"));
  permissionRows.set(event.requestId, { ...row, allow, deny });
}
function restoreHistory(history) {
  messages.replaceChildren(); toolRows.clear(); permissionRows.clear(); assistantRow = null; thinkingRow = null;
  for (const message of history) {
    if (message.role === "toolResult") {
      toolEnd({ id: message.toolCallId, isError: message.isError, result: message.content });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    let content = null;
    for (const block of message.content || []) {
      if (block.type === "text") {
        if (!content) content = messageRow(message.role);
        if (message.role === "assistant") {
          content._source = (content._source || "") + (block.text || "");
          renderMarkdown(content, content._source);
        } else content.textContent += block.text || "";
      } else if (block.type === "thinking") {
        disclosure({ kind: "thinking", title: "思考过程", summary: (block.text || "").replace(/\s+/g, " ").slice(0, 120), detail: block.text || "" });
      } else if (block.type === "toolCall") {
        toolStart({ id: block.id, name: block.name, args: block.arguments });
        updateDisclosure(toolRows.get(block.id), "done");
      }
    }
  }
  refreshEmpty(); scrollToLatest();
}
function closeHistory() {
  historyDrawer.hidden = true;
  $("history-overlay").hidden = true;
}
function openHistory() {
  historyDrawer.hidden = false;
  $("history-overlay").hidden = false;
  $("history-error").hidden = true;
  void command("list_sessions");
}
function renderSessions(sessions) {
  const list = $("history-list");
  list.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "还没有保存的对话";
    list.append(empty);
    return;
  }
  for (const item of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.textContent = String(item.title || "新对话").slice(0, 80);
    button.title = button.textContent;
    button.addEventListener("click", async () => {
      try {
        await command("open_session", { sessionId: item.id }, true);
        closeHistory();
        prompt.focus();
      } catch (error) {
        $("history-error").textContent = String(error);
        $("history-error").hidden = false;
      }
    });
    list.append(button);
  }
}
function renderThinkingLevels(levels, selected) {
  const names = { off: "关闭", minimal: "最少", low: "低", medium: "中等", high: "高", xhigh: "很高" };
  const picker = $("thinking-level");
  picker.replaceChildren();
  for (const level of levels || []) picker.add(new Option(names[level] || level, level));
  picker.value = selected || "";
  $("set-thinking-level").disabled = picker.options.length < 2;
}
function roleError(error) {
  $("role-error").textContent = String(error);
  $("role-error").hidden = false;
}
function renderRoles() {
  const list = $("roles-list");
  list.replaceChildren();
  const active = roles.find((role) => role.id === activeRoleId);
  $("role-label").textContent = active?.name || "Agent";
  for (const role of roles) {
    const row = document.createElement("div");
    row.className = `role-item${role.id === activeRoleId ? " active" : ""}`;
    const use = document.createElement("button");
    use.type = "button"; use.className = "role-item-name";
    use.textContent = `${role.name}${role.id === activeRoleId ? " · 当前" : ""}`;
    use.title = "使用此角色";
    use.addEventListener("click", async () => {
      try { await command("select_role", { roleId: role.id }, true); rolesDialog.close(); prompt.focus(); }
      catch (error) { roleError(error); }
    });
    const edit = document.createElement("button");
    edit.type = "button"; edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      editingRoleId = role.id;
      $("role-name").value = role.name;
      $("role-system").value = role.system || "";
      $("role-editor").hidden = false;
      $("role-name").focus();
    });
    row.append(use, edit);
    if (!role.builtin) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "role-delete"; remove.textContent = "删除";
      let confirmTimer;
      remove.addEventListener("click", async () => {
        if (!remove.classList.contains("confirm")) {
          remove.classList.add("confirm"); remove.textContent = "确认删除";
          confirmTimer = setTimeout(() => { remove.classList.remove("confirm"); remove.textContent = "删除"; }, 3000);
          return;
        }
        clearTimeout(confirmTimer);
        try { await command("delete_role", { roleId: role.id }, true); if (editingRoleId === role.id) $("role-editor").hidden = true; }
        catch (error) { roleError(error); }
      });
      row.append(remove);
    }
    list.append(row);
  }
}
async function chooseWorkspace() {
  try {
    const path = await tauri.core.invoke("choose_workspace");
    if (!path) return;
    await command("change_workspace", { path }, true);
    if (settings.open) settings.close();
  } catch (error) {
    if (settings.open) $("settings-error").textContent = String(error);
    else errorRow(String(error));
  }
}
async function newSession() {
  try {
    await command("new_session", {}, true);
    closeHistory();
    prompt.focus();
  } catch (error) {
    errorRow(String(error));
  }
}
function onEvent(event) {
  const response = event.payload;
  if (!response || typeof response !== "object") return;
  const handledReply = Boolean(response.id && pending.has(response.id) && ["ack", "error", "done", "conversation"].includes(response.type));
  if (handledReply) {
    const { resolve, reject } = pending.get(response.id); pending.delete(response.id);
    response.type === "error" ? reject(new Error(response.message)) : resolve(response);
  }
  switch (response.type) {
    case "ready": status("正在读取模型…"); break;
    case "models": {
      const picker = $("model-picker"); picker.replaceChildren(new Option("自动选择", ""));
      for (const model of response.models || []) picker.add(new Option(`${model.provider} / ${model.name || model.id}`, `${model.provider}/${model.id}`));
      break;
    }
    case "session":
      $("model-label").textContent = response.model || "选择模型";
      activeSessionId = response.sessionId || "";
      activeSessionName = response.sessionName || "";
      renderThinkingLevels(response.availableThinkingLevels, response.thinkingLevel);
      $("workspace").value = response.workspace || "";
      $("workspace-label").textContent = (response.workspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "工作目录";
      $("workspace-button").title = response.workspace || "切换工作目录";
      if (response.roleId) { activeRoleId = response.roleId; renderRoles(); }
      void command("list_sessions");
      break;
    case "thinking_level": renderThinkingLevels(response.availableThinkingLevels, response.level); break;
    case "session_name":
      if (response.sessionId === activeSessionId) activeSessionName = response.name || "";
      void command("list_sessions");
      break;
    case "roles":
      roles = response.roles || [];
      activeRoleId = response.activeId || "agent";
      renderRoles();
      break;
    case "sessions": renderSessions(response.sessions || []); break;
    case "history": restoreHistory(response.messages || []); status("就绪"); break;
    case "delta": {
      if (response.kind === "thinking") {
        if (!thinkingRow) thinkingRow = disclosure({ kind: "thinking", title: "思考过程", state: "running" });
        thinkingRow.content.textContent += response.text || "";
        thinkingRow.brief.textContent = thinkingRow.content.textContent.replace(/\s+/g, " ").slice(0, 120);
      } else {
        if (!assistantRow) assistantRow = messageRow("assistant");
        assistantRow._source = (assistantRow._source || "") + (response.text || "");
        renderMarkdown(assistantRow, assistantRow._source);
      }
      scrollToLatest(); break;
    }
    case "tool_start": toolStart(response); break;
    case "tool_end": toolEnd(response); break;
    case "tool_permission_request": permissionRequest(response); break;
    case "tool_permission_expired": {
      const row = permissionRows.get(response.requestId);
      if (row) {
        row.brief.textContent = response.reason || "已超时";
        row.allow.disabled = true;
        row.deny.disabled = true;
        updateDisclosure(row, "error");
        permissionRows.delete(response.requestId);
      }
      break;
    }
    case "started": submitted = null; setRunning(true); break;
    case "done": case "settled":
      setRunning(false); if (thinkingRow) updateDisclosure(thinkingRow, "done");
      assistantRow = null; thinkingRow = null; break;
    case "error":
      if (submitted) {
        submitted.row.remove();
        prompt.value = submitted.text;
        submitted = null;
        refreshEmpty();
      }
      if (!handledReply) errorRow(response.message || "PI Agent 出错");
      setRunning(false); break;
    case "disconnected": status("PI Agent 已断开"); setRunning(false); break;
  }
}
function command(type, args = {}, awaitReply = false) {
  if (!tauri) return Promise.reject(new Error("需要在 Tauri 桌面窗口中运行"));
  const id = String(++sequence);
  const response = awaitReply ? new Promise((resolve, reject) => pending.set(id, { resolve, reject })) : Promise.resolve();
  tauri.core.invoke("agent_command", { command: { id, type, ...args } }).catch((error) => {
    if (pending.has(id)) { pending.get(id).reject(error); pending.delete(id); }
    else errorRow(String(error));
  });
  return response;
}
$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || running) return;
  const userContent = messageRow("user", text);
  submitted = { text, row: userContent.closest(".message-row") };
  assistantRow = null; thinkingRow = null;
  prompt.value = ""; prompt.style.height = "auto";
  setRunning(true);
  void command("prompt", { text });
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
prompt.addEventListener("input", () => {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 150)}px`;
  updateSendAvailability();
});
$("stop-button").addEventListener("click", () => void command("abort"));
$("hide-button").addEventListener("click", () => void tauri?.core.invoke("dismiss"));
$("header-new-chat").addEventListener("click", () => void newSession());
$("history-new-chat").addEventListener("click", () => void newSession());
$("history-button").addEventListener("click", openHistory);
$("history-close").addEventListener("click", closeHistory);
$("history-overlay").addEventListener("click", closeHistory);
$("history-rename").addEventListener("click", () => {
  if (!activeSessionId) return;
  $("rename-name").value = activeSessionName;
  $("rename-error").hidden = true;
  $("rename-dialog").showModal();
  $("rename-name").focus();
});
$("history-copy").addEventListener("click", async () => {
  try {
    const reply = await command("copy_session", {}, true);
    if (!reply.text) throw new Error("当前对话没有可复制的文字");
    await navigator.clipboard.writeText(reply.text);
    $("history-error").textContent = "已复制当前对话";
    $("history-error").hidden = false;
  } catch (error) {
    $("history-error").textContent = String(error);
    $("history-error").hidden = false;
  }
});
$("rename-close").addEventListener("click", () => $("rename-dialog").close());
$("rename-save").addEventListener("click", async () => {
  try {
    await command("rename_session", { name: $("rename-name").value }, true);
    $("rename-dialog").close();
  } catch (error) {
    $("rename-error").textContent = String(error);
    $("rename-error").hidden = false;
  }
});
$("settings-button").addEventListener("click", () => settings.showModal());
$("model-button").addEventListener("click", () => { settings.showModal(); $("model-picker").focus(); });
$("workspace-button").addEventListener("click", () => void chooseWorkspace());
$("settings-close").addEventListener("click", () => settings.close());
$("save-key").addEventListener("click", async () => {
  const provider = $("provider").value.trim(); const key = $("api-key").value.trim();
  $("settings-error").textContent = "";
  try { await command("set_key", { provider, key }, true); $("api-key").value = ""; await command("init", { provider }); }
  catch (error) { $("settings-error").textContent = String(error); }
});
$("select-model").addEventListener("click", async () => {
  const value = $("model-picker").value;
  if (!value) return;
  const slash = value.indexOf("/");
  $("settings-error").textContent = "";
  try { await command("select_model", { provider: value.slice(0, slash), model: value.slice(slash + 1) }, true); settings.close(); }
  catch (error) { $("settings-error").textContent = String(error); }
});
$("set-thinking-level").addEventListener("click", async () => {
  $("settings-error").textContent = "";
  try { await command("set_thinking_level", { level: $("thinking-level").value }, true); settings.close(); }
  catch (error) { $("settings-error").textContent = String(error); }
});
$("change-workspace").addEventListener("click", () => void chooseWorkspace());
$("role-button").addEventListener("click", () => { $("role-error").hidden = true; renderRoles(); rolesDialog.showModal(); });
$("roles-close").addEventListener("click", () => rolesDialog.close());
$("roles-new").addEventListener("click", () => {
  editingRoleId = null;
  $("role-name").value = "";
  $("role-system").value = "";
  $("role-editor").hidden = false;
  $("role-name").focus();
});
$("role-cancel").addEventListener("click", () => { $("role-editor").hidden = true; editingRoleId = null; });
$("role-save").addEventListener("click", async () => {
  $("role-error").hidden = true;
  try {
    await command("save_role", { roleId: editingRoleId, name: $("role-name").value, system: $("role-system").value }, true);
    $("role-editor").hidden = true;
    editingRoleId = null;
  } catch (error) { roleError(error); }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !historyDrawer.hidden) closeHistory();
});
updateSendAvailability();
if (tauri) {
  tauri.event.listen("agent-event", onEvent).then(() => command("init")).catch((error) => errorRow(String(error)));
} else {
  status("请在 Tauri 桌面窗口中运行");
}
