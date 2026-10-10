const $ = id => document.getElementById(id);
import { icon, windowHandles } from "./icons.js";
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
const headings = { general: ["通用", "窗口与快捷键"], models: ["模型", "选择提供商，连接你的模型"], memory: ["记忆", "由 Agent 整理的学习信息"], vault: ["笔记库", "引用你的 Obsidian 笔记，回到原文复习"], skills: ["技能仓库", "管理 Agent 可用的技能"], tools: ["工具", "搜索、浏览器与文件能力"], roles: ["角色", "角色说明作为系统指令，每轮生效"], about: ["关于", "轻量的个人 Agent 入口"] };
headings.mcp=["MCP","按需加载外部工具"];
headings.security = ["权限与范围", "文件范围与审批方式分别管理"]; headings.agent = ["Agent 能力", "实际加载的工具、扩展、技能与 MCP 状态"];
let agentCapabilities = {};
function renderAgent(state = agentCapabilities) {
  agentCapabilities = state;renderMcp(state.mcp||[]); $("approval-mode").value = state.approval || "manual"; $("file-access").value = state.access || "workspace";
  $("security-workspace").textContent = state.workspace || ""; $("security-readonly").textContent = state.readOnly?.filter(p=>!state.customReadOnly?.includes(p)).join("\n") || "未连接只读目录";
  $("agent-summary").textContent = `${state.tools?.filter(t=>t.active).length || 0} 个可用工具 · ${capabilities.skills?.filter(s=>s.enabled).length || 0} 个启用技能 · 终端已关闭`;
  $("agent-extensions").textContent = "内置扩展：" + (state.extensions || []).join("、"); $("agent-mcp").textContent = state.mcp?.length ? "MCP：" + state.mcp.map(s=>s.name+(s.connected?"（已连接）":"（按需）")).join("、") : "MCP：未连接服务器。现有浏览器、搜索和文件能力通过内置工具提供。";
  $("custom-readonly").replaceChildren();
  for(const path of state.customReadOnly||[]){const row=element("div",undefined,"readonly-item"),label=element("span",path);const remove=element("button","移除","secondary");remove.onclick=()=>action(()=>command("remove_readonly",{path}));row.append(label,remove);$("custom-readonly").append(row);}
  $("agent-tool-list").replaceChildren(); const query = $("agent-tool-query").value.toLowerCase();
  for (const tool of state.tools || []) { if (!(tool.name + " " + tool.description).toLowerCase().includes(query)) continue; const row = element("div", undefined, "card tool-capability"), title = element("h3", tool.name), status = element("span", tool.active ? "可用" : "未启用", "profile-status"); title.append(status); row.append(title, element("p", tool.description), element("small", "操作范围：" + tool.scope)); $("agent-tool-list").append(row); }
}
$("add-readonly").onclick=()=>action(async()=>{const path=await tauri.core.invoke("choose_workspace");if(path)await command("add_readonly",{path});});
$("agent-tool-query").oninput = () => renderAgent(); $("refresh-agent").onclick = () => action(()=>command("get_state"));
$("approval-mode").onchange = () => action(async()=>{try { await command("set_approval",{mode:$("approval-mode").value}); notice("审批方式已更新，适用于后续工具调用。"); } catch(e) { renderAgent(); throw e; }});
$("file-access").onchange = () => action(async()=>{try { await command("set_file_access",{mode:$("file-access").value}); notice("文件权限范围已更新。"); } catch(e) { renderAgent(); throw e; }});
let capabilities = {};
function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function renderCapabilities(state) {
  capabilities = state;
  $("vault-path").textContent = state.vaultPath || "未选择笔记库";
  $("web-enabled").checked = state.webEnabled; $("browser-enabled").checked = state.browserEnabled;
  $("tavily-state").textContent = state.keyError || (state.hasSearchKey ? "Key 已加密保存" : "尚未配置 Key");
  $("tavily-key").placeholder = state.hasSearchKey ? "已保存；留空保留当前 Key" : "输入 Tavily Key";
  renderSkills();
}
function renderSkills() {
  const query = $("skill-query").value.toLowerCase(); $("skill-list").replaceChildren();
  for (const skill of capabilities.skills || []) {
    if (!(skill.name + " " + skill.description).toLowerCase().includes(query)) continue;
    const row = element("div", undefined, "setting-row"), info = element("div"), title = element("h3", skill.name), description = element("p", skill.description);
    const view = element("button", "查看说明", "secondary"); view.onclick = () => action(async () => { const r = await command("skill_detail", { skillId: skill.id }); $("skill-detail").hidden = false; $("skill-detail").textContent = r.text; });
    info.append(title, description, view); const toggle = element("input"); toggle.type = "checkbox"; toggle.className = "switch"; toggle.checked = skill.enabled; toggle.setAttribute("aria-label", "启用 " + skill.name);
    toggle.onchange = () => action(async () => { try { await command("toggle_skill", { skillId: skill.id, enabled: toggle.checked }); } catch(e) { toggle.checked = !toggle.checked; throw e; } }); row.append(info, toggle); $("skill-list").append(row);
  }
  if (!(capabilities.skills || []).length) $("skill-list").append(element("p", "尚未导入技能。选择包含 SKILL.md 的本地目录即可。", "hint"));
}
$("skill-query").oninput = renderSkills;
$("import-skill").onclick = () => action(async () => { const path = await tauri.core.invoke("choose_workspace"); if (path) { await command("import_skill", { path }); notice("技能已导入并启用。当前会话保留，下一次回复即可使用。"); } });
$("choose-vault").onclick = () => action(async () => { const vaultPath = await tauri.core.invoke("choose_workspace"); if (vaultPath) { await command("configure_capabilities", { vaultPath }); notice("笔记库已连接，相关提问时会主动检索。"); } });
$("disconnect-vault").onclick = () => action(async () => { await command("configure_capabilities", { vaultPath: null }); $("vault-results").replaceChildren(); });
$("save-tavily").onclick = () => action(async () => { if (!$("tavily-key").value.trim()) throw new Error("请填写 Tavily Key"); await command("configure_capabilities", { key: $("tavily-key").value, webEnabled: true }); $("tavily-key").value = ""; notice("搜索 Key 已保存，联网搜索已开启。"); });
for (const [id, key] of [["web-enabled", "webEnabled"], ["browser-enabled", "browserEnabled"]]) $(id).onchange = () => action(async () => { try { await command("configure_capabilities", { [key]: $(id).checked }); } catch(e) { $(id).checked = !$(id).checked; throw e; } });
$("vault-search-form").onsubmit = event => { event.preventDefault(); void action(async () => {
  const r = await command("search_notes", { query: $("vault-query").value }); $("vault-results").replaceChildren();
  for (const hit of r.results || []) { const row = element("div", undefined, "card"), link = element("button", `${hit.title} · 第 ${hit.startLine}–${hit.endLine} 行`, "note-link"); link.onclick = () => action(async () => { const file = await command("resolve_file", { path: hit.url }); await tauri.core.invoke("open_local_file", { path: file.path }); }); row.append(link, element("p", hit.content, "note-excerpt")); $("vault-results").append(row); }
  if (!r.results?.length) $("vault-results").append(element("p", "没有匹配段落。可以尝试笔记标题或更具体的关键词。", "hint"));
}); };
function renderLearner(profile) {
  const groups = [["学习目标", profile.goals || []], ["知识状态", profile.knowledge || []], ["误解记录", profile.misconceptions || []], ["学习偏好", profile.preferences || []]];
  $("learner-overview").replaceChildren(); $("learner-profile").replaceChildren();
  for (const [title, items] of groups) {
    const count = element("div", undefined, "profile-count"); count.append(element("span", title), element("strong", String(items.length))); $("learner-overview").append(count);
    const section = element("details", undefined, "profile-section"); section.open = true; section.append(element("summary", `${title} · ${items.length}`));
    for (const item of items) {
      const row = element("div", undefined, "memory-item"), info = element("div");
      info.append(element("h3", item.subject), element("p", item.detail), element("small", "依据：“" + item.evidence + "” · 会话 " + (item.source || "").slice(0, 8)));
      if (item.nextReview) info.append(element("p", "建议复习：" + new Date(item.nextReview).toLocaleDateString() + " · 掌握程度尚未评估", "hint"));
      const status = element("span", ({active:"进行中",completed:"已完成",needs_review:"待复习",resolved:"已纠正"})[item.status] || "已记录", "profile-status"); row.append(info, status); section.append(row);
    }
    if (!items.length) section.append(element("p", "Agent 会根据对话中的明确陈述自动整理。", "hint")); $("learner-profile").append(section);
  }
}
function showSection(section) {
  if (!headings[section]) section = "general";
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== section;
  for (const button of document.querySelectorAll("nav button")) button.classList.toggle("active", button.dataset.section === section);
  [$("page-title").textContent, $("page-description").textContent] = headings[section]; notice("");
  document.querySelector("main").scrollTop = 0;
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
    const row=element("div",undefined,"provider-row");
    const remove=deletionButton("删除",async()=>{await command("delete_provider",{providerId:provider.id});if(providerId===provider.id){providerId=null;editing=null;$("provider-form").hidden=true;}notice("提供商配置已删除，对话历史保留。");});remove.setAttribute("aria-label",`删除 ${provider.name}`);row.append(button,remove);$("providers").append(row);
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
    const use = document.createElement("button"); use.className = "secondary"; use.textContent = "获取配置";
    use.onclick = () => action(async () => {
      use.disabled=true;use.textContent="获取中…";
      try { const selectedProvider=providerId;const reply=await command("refresh_model",{providerId:selectedProvider,modelId:model.id});const config=reply.modelInfo;notice(`已获取 ${model.name||model.id} 的配置。${config.reasoning==null?"服务未提供思考能力，请在下方补充。":""}`);
        $("manual-model").value=model.id;$("manual-context").value=config.contextWindow||"";$("manual-reasoning").value=config.reasoning==null?"unknown":config.reasoning?"yes":"no";$("thinking-format").value=config.compat?.thinkingFormat||"";$("manual-levels").value=config.reasoning?config.thinkingLevels?.filter(l=>l!=="off").join(", ")||"":"";
        document.querySelector(".advanced").open=true;$("manual-model").scrollIntoView({block:"nearest"});
      } finally {use.disabled=false;use.textContent="获取配置";}
    });
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
  if ($("manual-levels").value.trim()) model.thinkingLevels = $("manual-levels").value.split(/[,，\s]+/).filter(Boolean);
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
      if (r.type === "learner") renderLearner(r.state);
      if (r.type === "capabilities") renderCapabilities(r.state);
      if(r.type==="mcp_status"){agentCapabilities.mcp=r.servers;renderMcp(r.servers);}
      if (r.type === "agent_capabilities") { renderAgent(r); if($("notice").textContent.includes("Agent 连接断开")) notice(""); }
      if (r.type === "roles") renderRoles(r.roles || []);
      if (r.type === "memory_status") $("memory-status").textContent = ({ organizing:" 正在整理…", saved:" 已整理", error:" 整理失败，可稍后重试" })[r.status] || "";
      if (r.type === "disconnected") { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Agent 连接断开")); } pending.clear(); notice("Agent 连接断开，请在主对话窗口恢复连接后重试。", true); }
    });
    const prefs = await tauri.core.invoke("desktop_preferences"); savedShortcut = prefs.activeShortcut || prefs.shortcut || ""; $("shortcut").textContent = savedShortcut || "录入快捷键"; $("autostart").checked = prefs.autostart === true;
    await command("get_state");
  });
} else notice("请在 Summon 桌面应用中打开设置。", true);
for (const button of document.querySelectorAll("nav button")) button.prepend(icon(({general:"settings",models:"model",memory:"memory",vault:"book",skills:"skill",tools:"tools",security:"shield",agent:"activity",mcp:"tools",roles:"role",about:"info"})[button.dataset.section]));
$("close").replaceChildren(icon("close")); windowHandles(tauri);

let editingMcp=null;
function renderMcp(servers){$("mcp-list").replaceChildren();for(const server of servers){const row=element("div",undefined,"card");row.append(element("h3",server.name),element("p",`${server.transport} · ${server.enabled?"启用":"停用"} · ${server.connected?"已连接":"按需连接"}`));
const edit=element("button","编辑","secondary");edit.onclick=()=>{editingMcp=server.id;$("mcp-name").value=server.name;$("mcp-transport").value=server.transport;$("mcp-url").value=server.url||"";$("mcp-command").value=server.command||"";$("mcp-args").value=JSON.stringify(server.args||[]);$("mcp-enabled").checked=server.enabled;$("mcp-key").value="";syncMcpTransport();};
const discover=element("button","发现工具","secondary");discover.onclick=()=>action(async()=>{discover.disabled=true;try{await command("discover_mcp",{serverId:server.id});notice("工具发现完成；空闲后自动断开。");}finally{discover.disabled=false;}});
const remove=deletionButton("删除",()=>command("delete_mcp",{serverId:server.id}));row.append(edit,discover,remove);if(server.tools?.length)row.append(element("pre",JSON.stringify(server.tools,null,2),"mcp-tools"));$("mcp-list").append(row);}}
$("mcp-new").onclick=()=>{editingMcp=null;$("mcp-form").reset();syncMcpTransport();};
$("mcp-form").onsubmit=e=>{e.preventDefault();void action(async()=>{await command("save_mcp",{serverId:editingMcp,name:$("mcp-name").value,transport:$("mcp-transport").value,url:$("mcp-url").value,command:$("mcp-command").value,args:JSON.parse($("mcp-args").value),key:$("mcp-key").value,enabled:$("mcp-enabled").checked});$("mcp-key").value="";notice("MCP 配置已保存，尚未启动服务器。");});};

function syncMcpTransport(){const http=$("mcp-transport").value==="http";$("mcp-http-fields").hidden=!http;$("mcp-key-field").hidden=!http;$("mcp-stdio-fields").hidden=http;}
$("mcp-transport").onchange=syncMcpTransport;syncMcpTransport();
