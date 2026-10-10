import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const builtins = [
  { id: "agent", name: "Agent", system: "你是 Agent，负责理解用户任务、执行获准操作并验证结果。用中文清晰回复，遵守权限范围和当前角色的系统规则。", builtin: true },
  { id: "planner", name: "Planner", system: "你是 Planner，只负责分析、调查和制定计划。你可以读取资料、检索知识与查看当前时间；不能创建、修改、移动或删除文件，也不能执行有副作用的工具。即使用户要求立即执行，也应输出可执行的步骤与验收条件，说明需要切换 Agent 才能实施。用中文回复。", builtin: true },
  { id: "quick", name: "快捷对话", system: "你是一个简洁、直接的中文助手。", builtin: true },
];

export function normalizeBindings(value) {
  if (!Array.isArray(value) || value.length > 30) throw new Error("每个角色最多绑定 30 个技能");
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item.skillId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(item.skillId) || typeof item.required !== "boolean" || ids.has(item.skillId)) throw new Error("技能绑定无效或重复");
    ids.add(item.skillId); return {skillId:item.skillId, required:item.required};
  });
}

export class RoleStore {
  constructor(directory,config=null) {
    this.config=config;
    this.path = join(directory, "roles.json");
    this.roles = builtins.map((role) => ({ ...role, skills: [] }));
    this.activeId = "agent";
  }

  async load() {
    let saved;
    try { saved = this.config ? await this.config.get("roles",this.path,this.list()) : JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!saved || !Array.isArray(saved.roles)) throw new Error("角色预设文件无效");
    for (const role of saved.roles) {
      if (!role || typeof role.id !== "string" || typeof role.name !== "string" || typeof role.system !== "string") continue;
      if (builtins.some(item=>item.id===role.id)) {
        const builtin = this.roles.find((item) => item.id === role.id);
        builtin.name = role.name.slice(0, 60) || builtin.name;
        builtin.system = role.system.slice(0, 20000);
        builtin.skills = normalizeBindings(role.skills || []);
      } else if (/^role-[a-z0-9-]{1,64}$/.test(role.id) && this.roles.length < 50) {
        this.roles.push({ id: role.id, name: role.name.slice(0, 60), system: role.system.slice(0, 20000), builtin: false, skills: normalizeBindings(role.skills || []) });
      }
    }
    if (this.roles.some((role) => role.id === saved.activeId)) this.activeId = saved.activeId;
  }

  list() { return { roles: this.roles.map((role) => ({ ...role, skills: role.skills.map(s=>({...s})) })), activeId: this.activeId }; }
  current() { return this.roles.find((role) => role.id === this.activeId); }

  async persist() {
    if(this.config){await this.config.set("roles",this.list());return;}
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.list(), null, 2), "utf8");
    await rename(temporary, this.path);
  }

  async save(input) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const system = typeof input.system === "string" ? input.system.trim() : "";
    if (!name || name.length > 60 || system.length > 20000) throw new Error("角色名称或说明长度不合适");
    const skills = input.skills === undefined ? undefined : normalizeBindings(input.skills);
    if (input.roleId) {
      const role = this.roles.find((item) => item.id === input.roleId);
      if (!role) throw new Error("找不到该角色");
      role.name = name;
      role.system = system;
      if (skills !== undefined) role.skills = skills;
      await this.persist();
      return role.id;
    }
    if (this.roles.length >= 50) throw new Error("角色数量已达到上限");
    const id = `role-${randomUUID()}`;
    this.roles.push({ id, name, system, builtin: false, skills: skills || [] });
    await this.persist();
    return id;
  }

  async select(id) {
    if (!this.roles.some((role) => role.id === id)) throw new Error("找不到该角色");
    this.activeId = id;
    await this.persist();
  }

  async delete(id) {
    const role = this.roles.find((item) => item.id === id);
    if (!role || role.builtin) throw new Error("内置角色不可删除");
    this.roles = this.roles.filter((item) => item.id !== id);
    if (this.activeId === id) this.activeId = "agent";
    await this.persist();
  }
}
