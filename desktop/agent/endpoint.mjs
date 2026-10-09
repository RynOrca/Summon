import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REMOTE_PROVIDER = "summon-remote";

function powerShell(script, input) {
  if (process.platform !== "win32") throw new Error("凭据保存目前仅支持 Windows");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (data) => { output += data; });
    child.stderr.setEncoding("utf8").on("data", (data) => { errors += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors.trim() || "Windows 凭据保护失败")));
    child.stdin.end(input);
  });
}

export function validateEndpoint(baseUrl, modelId) {
  if (typeof baseUrl !== "string" || typeof modelId !== "string") throw new Error("请填写 Base URL 和 Model ID");
  const parsed = new URL(baseUrl.trim());
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Base URL 必须是无账号、查询参数和片段的 HTTP(S) 地址");
  const id = modelId.trim();
  if (!id || id.length > 200 || /[\r\n]/.test(id)) throw new Error("Model ID 无效");
  return { baseUrl: parsed.href.replace(/\/$/, ""), modelId: id };
}

export class EndpointStore {
  constructor(agentDirectory) {
    this.modelsPath = join(agentDirectory, "models.json");
    this.keyPath = join(agentDirectory, "endpoint-key.dpapi");
  }

  async config() {
    let saved;
    try { saved = JSON.parse(await readFile(this.modelsPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const provider = saved?.providers?.[REMOTE_PROVIDER];
    const modelId = provider?.models?.[0]?.id;
    return provider?.baseUrl && modelId ? { baseUrl: provider.baseUrl, modelId } : null;
  }

  async loadKey() {
    let encrypted;
    try { encrypted = await readFile(this.keyPath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return ""; throw error; }
    return powerShell("Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($d))", encrypted);
  }

  async saveKey(key) {
    if (typeof key !== "string" || !key.trim() || key.length > 4096) throw new Error("API Key 无效");
    const encrypted = await powerShell("Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($e))", key.trim());
    const temporary = `${this.keyPath}.${process.pid}.tmp`;
    await writeFile(temporary, encrypted, "utf8");
    await rename(temporary, this.keyPath);
  }

  async saveConfig(baseUrl, modelId) {
    const config = validateEndpoint(baseUrl, modelId);
    let current = {};
    try { current = JSON.parse(await readFile(this.modelsPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    current.providers ||= {};
    current.providers[REMOTE_PROVIDER] = {
      baseUrl: config.baseUrl,
      api: "openai-completions",
      models: [{ id: config.modelId, name: config.modelId }],
    };
    const temporary = `${this.modelsPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(current, null, 2), "utf8");
    await rename(temporary, this.modelsPath);
    return config;
  }
}
