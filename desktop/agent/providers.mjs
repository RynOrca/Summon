import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { protectKey, unprotectKey, EndpointStore } from "./endpoint.mjs";

const presets = [
  { id: "deepseek", name: "DeepSeek", sdk: "deepseek", protocol: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
  { id: "kimi", name: "Kimi", sdk: "moonshotai-cn", protocol: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "minimax", name: "MiniMax", sdk: "minimax", protocol: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
  { id: "doubao", name: "火山引擎", sdk: "volcengine", protocol: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "mimo", name: "小米 MiMo", sdk: "xiaomi", protocol: "openai-completions", baseUrl: "https://api.xiaomimimo.com/v1" },
  { id: "qwen", name: "阿里百炼", sdk: "qwen-token-plan-cn", protocol: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "openai", name: "OpenAI", sdk: "openai", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", sdk: "anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
  { id: "custom", name: "自定义", sdk: null, protocol: "openai-completions", baseUrl: "" },
];
const positive = (...values) => values.find((value) => Number.isFinite(Number(value)) && Number(value) > 0) ? Number(values.find((value) => Number.isFinite(Number(value)) && Number(value) > 0)) : null;

export function normalizeDiscoveredModel(raw, known) {
  const id = String(raw.id || raw.name || "").trim();
  if (!id || id.length > 200) return null;
  const contextWindow = positive(raw.context_window, raw.context_length, raw.max_model_len, raw.max_input_tokens, raw.metadata?.context_window, known?.contextWindow);
  const explicitReasoning = raw.reasoning ?? raw.supports_reasoning ?? raw.capabilities?.reasoning;
  const levels = raw.thinking_levels || raw.reasoning_efforts || raw.supported_reasoning_efforts || raw.metadata?.reasoning_efforts;
  let thinkingLevels = Array.isArray(levels) ? [...new Set(["off", ...levels.filter(level => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))])] : null;
  const format = raw.thinking_format || raw.compat?.thinkingFormat;
  if (["qwen","qwen-chat-template"].includes(format)) thinkingLevels=["off","medium"];
  const reasoning = typeof explicitReasoning === "boolean" ? explicitReasoning : thinkingLevels?.some(level => level !== "off") ? true : known?.reasoning ?? null;
  const compat = ["openai", "qwen", "qwen-chat-template", "deepseek"].includes(format) ? { ...known?.compat, thinkingFormat: format, supportsReasoningEffort: format === "openai" } : known?.compat;
  return { id, name: raw.name || known?.name || id, contextWindow, maxTokens: positive(raw.max_output_tokens, known?.maxTokens), reasoning, thinkingLevels, input: known?.input || ["text"], compat, infoSource: contextWindow || reasoning !== null ? (known ? "catalog+service" : "service") : "unknown" };
}

export class ProviderStore {
  constructor(directory, { protect = protectKey, unprotect = unprotectKey, request = fetch } = {}) {
    this.directory = directory;
    this.path = join(directory, "providers.json");
    this.modelsPath = join(directory, "models.json");
    this.providers = [];
    this.keys = new Map();
    this.protect = protect; this.unprotect = unprotect; this.request = request;
  }
  async load() {
    try { const data = JSON.parse(await readFile(this.path, "utf8")); this.providers = Array.isArray(data.providers) ? data.providers : []; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const legacy = new EndpointStore(this.directory);
      const config = await legacy.config();
      if (config) {
        this.providers.push({ id: "summon-remote", name: "自定义", template: "custom", baseUrl: config.baseUrl, protocol: "openai-completions", models: [normalizeDiscoveredModel({ id: config.modelId })] });
        const key = await legacy.loadKey().catch(() => "");
        if (key) await this.saveKey("summon-remote", key);
        await this.persist();
      }
    }
    for (const provider of this.providers) {
      try { this.keys.set(provider.id, await this.unprotect(await readFile(join(this.directory, `${provider.id}.dpapi`), "utf8"))); }
      catch (error) { if (error.code !== "ENOENT") provider.credentialError = "凭据无法读取，请重新输入"; }
    }
  }
  templates(runtime) {
    const catalog = runtime.getModels();
    return presets.map((preset) => {
      const known = catalog.find((model) => model.provider === preset.sdk && model.api === preset.protocol);
      return { ...preset, baseUrl: preset.baseUrl || known?.baseUrl || "" };
    });
  }
  snapshot() { return this.providers.map((provider) => ({ ...provider, hasKey: Boolean(this.keys.get(provider.id)) })); }
  async persist() { const temporary = `${this.path}.tmp`; await writeFile(temporary, JSON.stringify({ providers: this.providers }, null, 2)); await rename(temporary, this.path); }
  async saveKey(id, key) {
    if (typeof key !== "string" || key.length > 4096) throw new Error("API Key 无效");
    const temporary = join(this.directory, `${id}.dpapi.tmp`);
    await writeFile(temporary, await this.protect(key)); await rename(temporary, join(this.directory, `${id}.dpapi`));
    this.keys.set(id, key);
  }
  async save(input) {
    const template = presets.find((item) => item.id === input.template);
    if (!template) throw new Error("请选择提供商");
    let url;
    try { url = new URL(input.baseUrl.trim()); } catch { throw new Error("请填写有效的 Base URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Base URL 格式无效");
    if (!["openai-completions", "anthropic-messages"].includes(input.protocol)) throw new Error("不支持该接口协议");
    const provider = input.providerId ? this.providers.find((item) => item.id === input.providerId) : null;
    if (input.providerId && !provider) throw new Error("找不到该提供商");
    const record = provider || { id: `summon-${randomUUID()}`, models: [] };
    if (input.key?.trim()) await this.saveKey(record.id, input.key.trim());
    const endpointChanged = record.baseUrl && (record.baseUrl !== url.href.replace(/\/$/, "") || record.protocol !== input.protocol);
    if (endpointChanged) record.models = [];
    Object.assign(record, { name: String(input.name || template.name).slice(0, 60), template: template.id, protocol: input.protocol, baseUrl: url.href.replace(/\/$/, "") });
    delete record.credentialError;
    if (!provider) this.providers.push(record);
    await this.persist(); return record;
  }
  async discover(providerId, runtime) {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("请先保存提供商");
    const headers = provider.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01", "x-api-key": this.keys.get(provider.id) || "" } : { Authorization: `Bearer ${this.keys.get(provider.id) || "no-key"}` };
    const response = await this.request(`${provider.baseUrl}/models`, { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}），请检查地址和凭据`);
    const data = await response.json();
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
    const preset = presets.find((item) => item.id === provider.template);
    const catalog = runtime.getModels().filter((model) => model.provider === preset?.sdk);
    provider.models = list.map((raw) => normalizeDiscoveredModel(raw, catalog.find((model) => model.id === raw.id))).filter(Boolean).slice(0, 300);
    if (!provider.models.length) throw new Error("接口未返回模型，请检查 Base URL 是否包含正确的 API 路径");
    await this.persist(); await this.install(runtime); return provider.models;
  }
  async refreshModel(providerId, id, runtime) {
    const provider=this.providers.find(p=>p.id===providerId);
    if(!provider) throw new Error("找不到该提供商");
    const headers=provider.protocol==="anthropic-messages" ? {"anthropic-version":"2023-06-01","x-api-key":this.keys.get(provider.id)||""} : {Authorization:`Bearer ${this.keys.get(provider.id)||"no-key"}`};
    const response=await this.request(`${provider.baseUrl}/models`,{headers,signal:AbortSignal.timeout(12000)});
    if(!response.ok) throw new Error(`获取配置失败（HTTP ${response.status}）`);
    const data=await response.json(),list=Array.isArray(data.data)?data.data:Array.isArray(data.models)?data.models:Array.isArray(data)?data:[];
    const raw=list.find(m=>(m.id||m.name)===id);
    if(!raw) throw new Error("服务未返回此模型，请刷新模型列表");
    const preset=presets.find(p=>p.id===provider.template);
    const model=normalizeDiscoveredModel(raw,runtime.getModels().find(m=>m.provider===preset?.sdk && m.id===id));
    const index=provider.models.findIndex(m=>m.id===id);
    if(index<0)provider.models.push(model);else provider.models[index]=model;
    await this.persist();await this.install(runtime);return this.modelInfo(providerId,id,runtime);
  }
  async remove(id,runtime) {
    const index=this.providers.findIndex(p=>p.id===id);
    if(index<0)throw new Error("找不到该提供商");
    this.providers.splice(index,1);await this.persist();this.keys.delete(id);
    await unlink(join(this.directory,`${id}.dpapi`)).catch(e=>{if(e.code!=="ENOENT")throw e;});
    const config=await readFile(this.modelsPath,"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return{};throw e;});
    if(config.providers)delete config.providers[id];
    await writeFile(this.modelsPath,JSON.stringify(config,null,2));await this.install(runtime);
    await runtime.setRuntimeApiKey(id,"");
  }
  async updateModel(providerId, input, runtime) {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("找不到该提供商");
    let model = provider.models.find((item) => item.id === input.id);
    if (!model) { model = normalizeDiscoveredModel({ id: input.id }); if (!model) throw new Error("Model ID 无效"); provider.models.push(model); }
    if (input.contextWindow !== undefined) model.contextWindow = positive(input.contextWindow);
    if (typeof input.reasoning === "boolean") model.reasoning = input.reasoning;
    if (input.thinkingFormat) {
      model.reasoning = true;
      if (!["openai", "qwen", "qwen-chat-template", "deepseek"].includes(input.thinkingFormat)) throw new Error("思考协议无效");
      model.compat = { ...model.compat, thinkingFormat: input.thinkingFormat, supportsReasoningEffort: input.thinkingFormat === "openai" };
      if (["qwen", "qwen-chat-template"].includes(input.thinkingFormat)) model.thinkingLevels = ["off", "medium"];
    }
    if (Array.isArray(input.thinkingLevels) && input.thinkingLevels.length && !["qwen", "qwen-chat-template"].includes(model.compat?.thinkingFormat)) {
      if (input.thinkingLevels.some(level => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))) throw new Error("思考档位无效");
      model.thinkingLevels = [...new Set(["off", ...input.thinkingLevels])]; model.reasoning = true;
    }
    model.infoSource = "user";
    await this.persist(); await this.install(runtime);
  }
  async install(runtime) {
    let current = {};
    try { current = JSON.parse(await readFile(this.modelsPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    current.providers ||= {};
    for (const provider of this.providers) {
      if (!provider.models.length) { delete current.providers[provider.id]; continue; }
      current.providers[provider.id] = { baseUrl: provider.baseUrl, api: provider.protocol, models: provider.models.map((model) => ({ id: model.id, name: model.name, ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}), reasoning: model.reasoning === true, input: model.input || ["text"], ...(model.compat ? { compat: model.compat } : {}), ...(model.thinkingLevels ? { thinkingLevelMap: Object.fromEntries(["minimal","low","medium","high","xhigh","max"].map(level => [level,model.thinkingLevels.includes(level) ? level : null])) } : {}) })) };
    }
    const temporary = `${this.modelsPath}.tmp`; await writeFile(temporary, JSON.stringify(current, null, 2)); await rename(temporary, this.modelsPath);
    await runtime.refresh();
    for (const provider of this.providers) await runtime.setRuntimeApiKey(provider.id, this.keys.get(provider.id) || "no-key");
  }
  modelInfo(providerId, id, runtime) {
    const stored = this.providers.find((item) => item.id === providerId)?.models.find((item) => item.id === id);
    const model = runtime.getModel(providerId, id);
    const levels = model ? getSupportedThinkingLevels(model) : ["off"];
    return { contextWindow: model?.contextWindow, reasoning: model?.reasoning, ...stored, provider: providerId, providerName: this.providers.find(item => item.id === providerId)?.name || providerId, thinkingLevels: stored?.thinkingLevels ? levels.filter((level) => stored.thinkingLevels.includes(level)) : levels };
  }
}
