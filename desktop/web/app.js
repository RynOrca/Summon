// Transcript row structure and disclosure behavior adapted from PI-Desktop 0.16.1.
import { renderMarkdown } from "./markdown.js";
const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
const messages = $("messages");
const transcript = $("transcript");
const prompt = $("prompt");
const settings = $("settings");
let sequence = 0;
let running = false;
let assistantRow = null;
let thinkingRow = null;
let submitted = null;
const toolRows = new Map();
const pending = new Map();

function status(text) { $("status").textContent = text; }
function scrollToLatest() { transcript.scrollTop = transcript.scrollHeight; }
function refreshEmpty() { $("empty-state").hidden = messages.childElementCount > 0; }
function setRunning(value) {
  running = value;
  $("send-button").disabled = value;
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
function restoreHistory(history) {
  messages.replaceChildren(); toolRows.clear(); assistantRow = null; thinkingRow = null;
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
function onEvent(event) {
  const response = event.payload;
  if (!response || typeof response !== "object") return;
  const handledReply = Boolean(response.id && pending.has(response.id) && ["ack", "error", "done"].includes(response.type));
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
      $("workspace").value = response.workspace || "";
      break;
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
prompt.addEventListener("input", () => { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`; });
$("stop-button").addEventListener("click", () => void command("abort"));
$("hide-button").addEventListener("click", () => void tauri?.core.invoke("dismiss"));
$("settings-button").addEventListener("click", () => settings.showModal());
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
$("change-workspace").addEventListener("click", async () => {
  $("settings-error").textContent = "";
  try { await command("change_workspace", { path: $("workspace").value }, true); settings.close(); }
  catch (error) { $("settings-error").textContent = String(error); }
});
if (tauri) {
  tauri.event.listen("agent-event", onEvent).then(() => command("init")).catch((error) => errorRow(String(error)));
} else {
  status("请在 Tauri 桌面窗口中运行");
}
