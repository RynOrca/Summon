const $ = id => document.getElementById(id);
const tauri = window.__TAURI__;
let sequence = 0, templates = [], providers = [], editing = null, providerId = null, recording = false, savedShortcut = "", memory = {}, roleId = null;
const pending = new Map();
function notice(text, error = false) { $("notice").hidden = !text; $("notice").textContent = text; $("notice").classList.toggle("error", error); }
async function action(work) { try { await work(); } catch (error) { notice(String(error.message || error), true); } }
function command(type, args = {}) {
  const id = `settings-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("操作超时，请检查 Agent 连接")); }, 30000);
    pending.set(id, { resolve, reject, timer });
    tauri.core.invoke("agent_command", { command: { type, id, ...args } }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
}
const headings = { general: ["通用", "窗口与快捷键"], models: ["模型", "选择提供商，连接你的模型"], memory: ["记忆", "由 Agent 整理的学习信息"], roles: ["角色", "自定义任务与回答风格"], about: ["关于", "轻量的个人 Agent 入口"] };
function showSection(section) {
  if (!headings[section]) section = "general";
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== section;
  for (const button of document.querySelectorAll("nav button")) button.classList.toggle("active", button.dataset.section === section);
  [$("page-title").textContent, $("page-description").textContent] = headings[section]; notice("");
}
function editProvider(template, provider = null) {
  editing = template; providerId = provider?.id || null;
  $("provider-form").hidden = false; $("provider-heading").textContent = template.name;
  $("provider-name").value = provider?.name || template.name;
  $("base-url").value = provider?.baseUrl || template.baseUrl || "";
  $("protocol").value = provider?.protocol || template.protocol;
  $("api-key").value = ""; $("api-key").placeholder = provider?.hasKey ? "已保存；留空保留当前 Key" : "无鉴权服务可留空";
  renderProviderModels(provider?.models || []);
  $("provider-form").scrollIntoView({ behavior: "smooth", block: "start" });
  $("base-url").focus(); notice("");
}
function renderProviders() {
  $("providers").replaceChildren();
  for (const provider of providers) {
    const button = document.createElement("button"); button.className = "configured";
    const title = document.createElement("span"); title.textContent = provider.name;
    const info = document.createElement("small"); info.textContent = `${provider.models.length} 个模型 · ${provider.credentialError || "编辑配置"}`;
    button.append(title, info); button.onclick = () => editProvider(templates.find(t => t.id === provider.template) || templates.find(t => t.id === "custom"), provider);
    $("providers").append(button);
  }
  if (!providers.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "选择下方提供商开始配置。"; $("providers").append(p); }
  $("templates").replaceChildren();
  for (const template of templates) {
    const button = document.createElement("button"); button.className = "template-card";
    const mark = document.createElement("span"); mark.className = "provider-mark"; mark.textContent = ({ deepseek: "D", kimi: "K", minimax: "M", doubao: "火", mimo: "mi", qwen: "Q", custom: "C", openai: "◎", anthropic: "A" })[template.id] || template.name[0];
    const label = document.createElement("span"); label.textContent = template.name;
    const hint = document.createElement("small"); hint.textContent = template.id === "custom" ? "任意兼容接口" : "配置连接与凭据";
    label.append(hint); button.append(mark, label); button.onclick = () => editProvider(template); $("templates").append(button);
  }
  if (providerId) renderProviderModels(providers.find(p => p.id === providerId)?.models || []);
}
function renderProviderModels(models) {
  $("discovered-models").replaceChildren();
  for (const model of models) {
    const row = document.createElement("div"); row.className = "model-info";
    const info = document.createElement("div"), name = document.createElement("strong"), detail = document.createElement("small");
    name.textContent = model.name || model.id;
    const source = ({ service:"服务返回", "catalog+service":"服务 / PI 目录", user:"手动补充", unknown:"服务未提供能力信息" })[model.infoSource] || "PI 目录";
    detail.textContent = `${model.contextWindow ? model.contextWindow.toLocaleString() + " 上下文" : "上下文未知"} · ${model.thinkingLevels?.join(" / ") || (model.reasoning === true ? "支持思考" : model.reasoning === false ? "不支持思考" : "思考能力未知")} · ${source}`;
    info.append(name, detail);
    const use = document.createElement("button"); use.className = "secondary"; use.textContent = "使用";
    use.onclick = () => action(async () => { await command("select_model", { provider: providerId, model: model.id }); notice(`已使用 ${model.name || model.id}，思考档位可在对话窗口选择。`); });
    row.append(info, use); $("discovered-models").append(row);
  }
}
async function saveProvider() {
  if (!$("provider-form").reportValidity()) throw new Error("请填写必需信息");
  const reply = await command("save_provider", { providerId, template: editing.id, name: $("provider-name").value, protocol: $("protocol").value, baseUrl: $("base-url").value, key: $("api-key").value });
  providerId = reply.providerId; $("api-key").value = ""; $("api-key").placeholder = "已保存；留空保留当前 Key";
}
$("provider-form").onsubmit = event => { event.preventDefault(); void action(async () => { await saveProvider(); notice("配置已保存，点击获取模型与信息。"); }); };
$("discover").onclick = () => action(async () => {
  $("discover").disabled = true; notice("正在连接服务并获取模型信息…");
  try { await saveProvider(); await command("discover_models", { providerId }); renderProviderModels(providers.find(p => p.id === providerId)?.models || []); notice("已获取模型列表。接口缺失的能力信息显示为未知。"); }
  finally { $("discover").disabled = false; }
});
$("manual-save").onclick = () => action(async () => {
  await saveProvider(); const value = $("manual-reasoning").value;
  const model = { id: $("manual-model").value.trim(), ...($("manual-context").value ? { contextWindow: Number($("manual-context").value) } : {}), ...(value !== "unknown" ? { reasoning: value === "yes" } : {}), thinkingFormat: $("thinking-format").value };
  await command("update_model", { providerId, model }); notice("模型信息已保存。");
});
$("cancel-provider").onclick = () => { $("provider-form").hidden = true; editing = null; providerId = null; };
function deletionButton(label, work) {
  const button = document.createElement("button"); button.className = "secondary"; button.textContent = label; let timer;
  button.onclick = () => {
    if (!button.classList.contains("confirm")) { button.classList.add("confirm"); button.textContent = "确认删除"; timer = setTimeout(() => { button.classList.remove("confirm"); button.textContent = label; }, 3000); return; }
    clearTimeout(timer); void action(work);
  }; return button;
}
function renderMemory() {
  for (const layer of ["l1", "l2", "l3"]) $(layer).checked = memory.enabled?.[layer] !== false;
  for (const [id, entries] of [["facts", memory.facts || []], ["notes", memory.notes || []]]) {
    const list = $(id); list.replaceChildren();
    for (const item of entries) {
      const row = document.createElement("div"); row.className = "memory-item";
      const content = document.createElement("div"), title = document.createElement("h3"), text = document.createElement("p"), source = document.createElement("small");
      title.textContent = item.title || item.key; text.textContent = item.body || item.content;
      source.textContent = item.updated ? `更新于 ${new Date(item.updated).toLocaleString()}${item.source ? " · 来源会话 " + item.source.slice(0, 8) : ""}` : "已有记忆";
      content.append(title, text, source); row.append(content, deletionButton("删除", () => command(id === "facts" ? "memory_fact_delete" : "memory_note_delete", id === "facts" ? { key: item.key } : { noteId: item.id }))); list.append(row);
    }
    if (!entries.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "尚无内容，Agent 会从对话中整理。"; list.append(p); }
  }
}
for (const layer of ["l1", "l2", "l3"]) $(layer).onchange = () => action(async () => { try { await command("memory_enabled", { layer, enabled: $(layer).checked }); } catch(error) { $(layer).checked = !$(layer).checked; throw error; } });
$("organize").onclick = () => action(async () => { await command("memory_consolidate"); notice("Agent 已开始整理当前对话。"); });
function renderRoles(roles) {
  $("role-list").replaceChildren();
  for (const role of roles) {
    const row = document.createElement("div"); row.className = "memory-item";
    const name = document.createElement("strong"); name.textContent = role.name;
    const edit = document.createElement("button"); edit.className = "secondary"; edit.textContent = "编辑";
    edit.onclick = () => { roleId = role.id; $("role-name").value = role.name; $("role-system").value = role.system || ""; $("role-form").scrollIntoView(); };
    row.append(name, edit);
    if (!role.builtin) row.append(deletionButton("删除", () => command("delete_role", { roleId: role.id })));
    $("role-list").append(row);
  }
}
$("role-new").onclick = () => { roleId = null; $("role-form").reset(); $("role-name").focus(); };
$("role-form").onsubmit = event => { event.preventDefault(); void action(async () => { await command("save_role", { roleId, name: $("role-name").value, system: $("role-system").value }); roleId = null; $("role-form").reset(); notice("角色已保存，可在对话窗口选择。"); }); };
$("autostart").onchange = () => action(async () => { try { await tauri.core.invoke("set_autostart", { enabled: $("autostart").checked }); } catch(error) { $("autostart").checked = !$("autostart").checked; throw error; } });
async function finishRecording() { recording = false; $("shortcut").textContent = savedShortcut || "录入快捷键"; await tauri.core.invoke("capture_shortcut", { active: false }); }
$("shortcut").onclick = () => action(async () => { if (recording) return; await tauri.core.invoke("capture_shortcut", { active: true }); recording = true; $("shortcut").textContent = "请按下组合键…"; $("shortcut").focus(); });
document.addEventListener("keydown", event => {
  if (!recording) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === "Escape") { void action(finishRecording); return; }
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
  const modifiers = [event.ctrlKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.metaKey ? "Super" : ""].filter(Boolean);
  const key = event.code === "Space" ? "Space" : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code;
  if (!modifiers.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) { notice("请使用组合键或 F1–F24。", true); return; }
  recording = false;
  void action(async () => { try { savedShortcut = await tauri.core.invoke("set_shortcut", { shortcut: [...modifiers, key].join("+") }); notice("快捷键已保存。"); } finally { await finishRecording(); } });
});
window.addEventListener("blur", () => { if (recording) void action(finishRecording); });
$("close").onclick = () => action(async () => { if (recording) await finishRecording(); await tauri.core.invoke("dismiss"); });
for (const button of document.querySelectorAll("nav button")) button.onclick = () => showSection(button.dataset.section);
showSection(window.SUMMON_SETTINGS_SECTION || "general");
if (tauri) {
  void action(async () => {
    await tauri.event.listen("settings-section", event => { showSection(event.payload); void command("get_state").catch(error => notice(String(error), true)); });
    await tauri.event.listen("agent-event", event => {
      const r = event.payload;
      if (r.id && pending.has(r.id) && ["ack", "error"].includes(r.type)) { const p = pending.get(r.id); clearTimeout(p.timer); pending.delete(r.id); r.type === "error" ? p.reject(new Error(r.message)) : p.resolve(r); }
      if (r.type === "providers") { templates = r.templates || []; providers = r.providers || []; renderProviders(); }
      if (r.type === "memory") { memory = r.state; renderMemory(); }
      if (r.type === "roles") renderRoles(r.roles || []);
      if (r.type === "memory_status") $("memory-status").textContent = ({ organizing:" 正在整理…", saved:" 已整理", error:" 整理失败，可稍后重试" })[r.status] || "";
      if (r.type === "disconnected") { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Agent 连接断开")); } pending.clear(); notice("Agent 连接断开，请在主对话窗口恢复连接后重试。", true); }
    });
    const prefs = await tauri.core.invoke("desktop_preferences"); savedShortcut = prefs.activeShortcut || prefs.shortcut || ""; $("shortcut").textContent = savedShortcut || "录入快捷键"; $("autostart").checked = prefs.autostart === true;
    await command("get_state");
  });
} else notice("请在 Summon 桌面应用中打开设置。", true);
