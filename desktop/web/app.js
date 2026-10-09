// Transcript row structure and disclosure behavior adapted from PI-Desktop 0.16.1.
import { renderMarkdown } from "./markdown.js";
const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const messages = $("messages");
const transcript = $("transcript");
const prompt = $("prompt");
const modelsDialog = $("models-dialog");
let modelCatalog = [];
let reconnectAttempts = 0;
let reconnectTimer;
const historyDrawer = $("history-drawer");
const rolesDialog = $("roles-dialog");
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
let attachments = [];

function status(text) {
  $("status").textContent = text;
  $("status").parentElement.classList.toggle("is-busy", /正在|连接/.test(text));
  $("status").parentElement.classList.toggle("is-error", /断开|出错|失败/.test(text));
}
function updateSendAvailability() { $("send-button").disabled = running || (!prompt.value.trim() && !attachments.length); }
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
function attachmentPreview(content, items) {
  if (!items.length) return;
  const strip = document.createElement("div"); strip.className = "message-attachments";
  for (const item of items) {
    if (item.type === "image" || item.kind === "image") {
      const img = document.createElement("img");
      img.src = `data:${item.mimeType};base64,${item.data}`;
      img.alt = item.name || "图片附件";
      strip.append(img);
    } else {
      const file = document.createElement("span"); file.className = "message-file";
      file.textContent = item.name || "文件附件";
      strip.append(file);
    }
  }
  content.parentElement.append(strip);
}
function renderAttachments() {
  const strip = $("attachment-strip"); strip.replaceChildren();
  strip.hidden = !attachments.length;
  for (const item of attachments) {
    const chip = document.createElement("div"); chip.className = "attachment-chip";
    const img = item.kind === "image" ? document.createElement("img") : null;
    if (img) { img.src = `data:${item.mimeType};base64,${item.data}`; img.alt = ""; }
    const name = document.createElement("span"); name.textContent = item.name;
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "移除图片";
    remove.addEventListener("click", () => { attachments = attachments.filter((candidate) => candidate !== item); renderAttachments(); });
    if (img) chip.append(img);
    chip.append(name, remove); strip.append(chip);
  }
  updateSendAvailability();
}
async function addFiles(files) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) { errorRow(`${file.name} 超过 5 MB`); continue; }
    if (attachments.length >= 8) { errorRow("一次最多添加 8 个附件"); break; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    attachments.push({ kind: allowed.has(file.type) ? "image" : "file", name: file.name || "附件", mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
  }
  renderAttachments();
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
  const blocks = Array.isArray(event.result) ? event.result : event.result?.content || [];
  row.content.textContent += "\n\n结果\n" + (blocks.length ? blocks.filter(b => b.type === "text").map(b => b.text).join("\n") : pretty(event.result));
  for (const block of blocks) if (block.type === "image" && /^image\/(png|jpeg|webp)$/.test(block.mimeType)) { const img = document.createElement("img"); img.src = `data:${block.mimeType};base64,${block.data}`; img.alt = "工具截图"; img.className = "tool-image"; row.content.append(img); }
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
      } else if (block.type === "image" && message.role === "user") {
        if (!content) content = messageRow("user");
        attachmentPreview(content, [block]);
      } else if (block.type === "thinking") {
        disclosure({ kind: "thinking", title: "思考过程", summary: (block.text || "").replace(/\s+/g, " ").slice(0, 120), detail: block.text || "" });
      } else if (block.type === "toolCall") {
        toolStart({ id: block.id, name: block.name, args: block.arguments });
        updateDisclosure(toolRows.get(block.id), "done");
      }
    }
    if (message.role === "user" && content) {
      const marker = "附件文件（可使用 read 工具读取）：\n";
      const index = content.textContent.lastIndexOf(marker);
      if (index === 0 || (index > 1 && content.textContent.slice(index - 2, index) === "\n\n")) {
        const paths = content.textContent.slice(index + marker.length).split("\n").filter((line) => line.startsWith("- "));
        content.textContent = content.textContent.slice(0, index).trimEnd();
        attachmentPreview(content, paths.map((line) => ({
          kind: "file",
          name: line.slice(2).split(/[\\/]/).pop().replace(/^[0-9a-f-]{36}-/, ""),
        })));
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
  const list = $("history-list"); list.replaceChildren();
  function addConversation(parent, item) {
    const button = document.createElement("button"); button.type = "button";
    button.className = "history-item" + (item.id === activeSessionId ? " active" : "");
    button.textContent = item.title || "新对话"; button.title = button.textContent;
    button.onclick = async () => {
      try { await command("open_session", { sessionId: item.id }, true); closeHistory(); prompt.focus(); }
      catch (error) { $("history-error").textContent = String(error); $("history-error").hidden = false; }
    };
    parent.append(button);
  }
  const heading = (text) => { const h = document.createElement("h3"); h.className = "history-section"; h.textContent = text; list.append(h); };
  heading("会话");
  const loose = sessions.filter(item => !item.projectPath);
  loose.forEach(item => addConversation(list, item));
  if (!loose.length) { const e = document.createElement("p"); e.className = "history-empty"; e.textContent = "暂无无项目对话"; list.append(e); }
  heading("项目");
  const projects = new Map();
  for (const item of sessions.filter(item => item.projectPath)) {
    if (!projects.has(item.projectPath)) projects.set(item.projectPath, []);
    projects.get(item.projectPath).push(item);
  }
  for (const [path, items] of projects) {
    const group = document.createElement("details"); group.open = true; group.className = "history-project";
    const title = document.createElement("summary"); title.textContent = "▱ " + path.split(/[\\/]/).filter(Boolean).pop(); title.title = path;
    group.append(title); items.forEach(item => addConversation(group, item)); list.append(group);
  }
}
function renderModels() {
  const list = $("model-list"); list.replaceChildren();
  const search = $("model-search").value.toLowerCase();
  for (const model of modelCatalog.filter(m => `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(search))) {
    const button = document.createElement("button"); button.className = "model-option";
    const title = document.createElement("strong"); title.textContent = model.name || model.id;
    const meta = document.createElement("span"); meta.textContent = `${model.providerName || model.provider} · ${model.contextWindow ? Math.round(model.contextWindow / 1024) + "K 上下文" : "上下文未知"}`;
    button.append(title, meta); button.onclick = async () => {
      try { await command("select_model", { provider: model.provider, model: model.id }, true); modelsDialog.close(); }
      catch (error) { errorRow(String(error)); }
    }; list.append(button);
  }
  if (!list.childElementCount) { const p = document.createElement("p"); p.textContent = "没有可用模型，请先配置提供商。"; list.append(p); }
}
function renderThinkingLevels(levels, selected) {
  const names = { off: "思考关闭", minimal: "最少", low: "低", medium: "中等", high: "高", xhigh: "很高" };
  const picker = $("thinking-level");
  picker.replaceChildren();
  for (const level of levels || []) picker.add(new Option(names[level] || level, level));
  picker.value = selected || "";
  picker.disabled = picker.options.length < 2;
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

  } catch (error) {
    errorRow(String(error));
  }
}
async function newSession() {
  try {
    await command("new_session", { noProject: true }, true);
    closeHistory();
    prompt.focus();
  } catch (error) {
    errorRow(String(error));
  }
}
function onEvent(event) {
  const response = event.payload;
  if (!response || typeof response !== "object") return;
  const handledReply = Boolean(response.id && pending.has(response.id) && ["ack", "error", "done", "conversation", "file_staged"].includes(response.type));
  if (handledReply) {
    const { resolve, reject, timer } = pending.get(response.id); clearTimeout(timer); pending.delete(response.id);
    response.type === "error" ? reject(new Error(response.message)) : resolve(response);
  }
  switch (response.type) {
    case "telemetry": renderTelemetry(response); break;
    case "ready": status("正在读取模型…"); break;
    case "models": modelCatalog = response.models || []; renderModels(); break;
    case "session":
      reconnectAttempts = 0;
      $("model-label").textContent = response.modelName || response.model || "选择模型";
      $("model-button").title = response.model || "选择模型";
      activeSessionId = response.sessionId || "";
      activeSessionName = response.sessionName || "";
      renderThinkingLevels(response.availableThinkingLevels, response.thinkingLevel);
      $("workspace-label").textContent = (response.workspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "无项目";
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
    case "credential_error": errorRow(response.message || "模型凭据无法读取"); break;
    case "knowledge_status": errorRow(response.message); break;
    case "memory_status": if (!running) status(response.status === "organizing" ? "Agent 正在整理记忆…" : "就绪"); break;
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
    case "started": submitted = null; $("token-speed").textContent = "— tok/s"; setRunning(true); break;
    case "done": case "settled":
      setRunning(false); if (thinkingRow) updateDisclosure(thinkingRow, "done");
      assistantRow = null; thinkingRow = null; break;
    case "error":
      if (submitted) {
        submitted.row.remove();
        prompt.value = submitted.text;
        attachments = submitted.images;
        renderAttachments();
        submitted = null;
        refreshEmpty();
      }
      if (!handledReply) errorRow(response.message || "PI Agent 出错");
      setRunning(false); break;
    case "disconnected":
      setRunning(false); status("PI Agent 已断开，正在恢复连接…");
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Agent 连接断开，请重新执行操作")); } pending.clear();
      if (reconnectAttempts < 3) {
        clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => { reconnectAttempts++; void command("init"); }, 600 * (reconnectAttempts + 1));
      } else { status("Agent 启动失败，请检查设置或 agent.log"); }
      break;
  }
}
function renderTelemetry(data) {
  const percent = data.percent === null ? null : Math.min(100, Math.max(0, data.percent));
  $("context-percent").textContent = percent === null ? "?" : `${Math.round(percent)}`;
  $("context-arc").setAttribute("stroke-dasharray", `${(percent || 0) / 100 * 75.4} 75.4`);
  $("context-usage").classList.toggle("near-limit", percent !== null && percent >= 85);
  const detail = `${data.tokens === null ? "用量未知" : "约 " + data.tokens.toLocaleString() + " token"} / ${data.capacity ? data.capacity.toLocaleString() + " token" : "模型容量未知"}${percent === null ? "" : " · " + percent.toFixed(1) + "%"}`;
  $("context-usage").title = "上下文估算：" + detail; $("context-detail").textContent = detail;
  $("token-speed").textContent = data.tokPerSecond ? `${data.tokPerSecond.toFixed(1)} tok/s` : "— tok/s";
}
$("context-usage").onclick = () => $("context-dialog").showModal();
$("context-close").onclick = () => $("context-dialog").close();
document.addEventListener("click", event => {
  const link = event.target.closest?.("a[data-local-file]"); if (!link) return; event.preventDefault();
  void command("resolve_file", { path: link.dataset.localFile }, true).then(r => tauri.core.invoke("open_local_file", { path: r.path })).catch(e => errorRow(String(e.message || e)));
});
function command(type, args = {}, awaitReply = false) {
  if (!tauri) return Promise.reject(new Error("需要在 Tauri 桌面窗口中运行"));
  const id = `chat-${++sequence}`;
  const response = awaitReply ? new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error("操作超时，请检查 Agent 连接")); }, 30000); pending.set(id, { resolve, reject, timer }); }) : Promise.resolve();
  tauri.core.invoke("agent_command", { command: { id, type, ...args } }).catch((error) => {
    if (pending.has(id)) { clearTimeout(pending.get(id).timer); pending.get(id).reject(error); pending.delete(id); }
    else errorRow(String(error));
  });
  return response;
}
$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if ((!text && !attachments.length) || running) return;
  const items = attachments;
  running = true; updateSendAvailability();
  status("正在准备附件…");
  let outgoing = text;
  try {
    const staged = [];
    for (const item of items.filter((item) => item.kind === "file")) {
      const reply = await command("stage_file", { name: item.name, data: item.data }, true);
      staged.push(reply.path);
    }
    if (staged.length) outgoing += `${outgoing ? "\n\n" : ""}附件文件（可使用 read 工具读取）：\n${staged.map((path) => `- ${path}`).join("\n")}`;
  } catch (error) {
    running = false; updateSendAvailability();
    status("就绪"); errorRow(String(error));
    return;
  }
  const userContent = messageRow("user", text);
  attachmentPreview(userContent, items);
  submitted = { text, images: items, row: userContent.closest(".message-row") };
  assistantRow = null; thinkingRow = null;
  attachments = []; renderAttachments();
  prompt.value = ""; prompt.style.height = "auto";
  setRunning(true);
  void command("prompt", { text: outgoing, images: items.filter((item) => item.kind === "image").map(({ data, mimeType }) => ({ type: "image", data, mimeType })) });
});
$("add-image").addEventListener("click", () => $("attachment-picker").click());
$("attachment-picker").addEventListener("change", (event) => {
  void addFiles(Array.from(event.target.files || [])).catch((error) => errorRow(String(error)));
  event.target.value = "";
});
prompt.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files).catch((error) => errorRow(String(error)));
});
$("composer").addEventListener("dragover", (event) => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
$("composer").addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  void addFiles(Array.from(event.dataTransfer.files)).catch((error) => errorRow(String(error)));
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
$("settings-button").addEventListener("click", () => void tauri?.core.invoke("open_settings", { section: "general" }).catch(error => errorRow(String(error))));
$("model-button").addEventListener("click", () => { renderModels(); modelsDialog.showModal(); $("model-search").focus(); });
$("model-search").addEventListener("input", renderModels);
$("models-close").addEventListener("click", () => modelsDialog.close());
$("configure-models").addEventListener("click", () => { modelsDialog.close(); void tauri?.core.invoke("open_settings", { section: "models" }); });
$("thinking-level").addEventListener("change", async () => {
  try { await command("set_thinking_level", { level: $("thinking-level").value }, true); }
  catch (error) { errorRow(String(error)); void command("get_state"); }
});
$("workspace-button").addEventListener("click", () => void chooseWorkspace());
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
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
