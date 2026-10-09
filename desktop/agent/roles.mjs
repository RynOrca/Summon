import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const builtins = [
  { id: "agent", name: "Agent", system: "", builtin: true },
  { id: "quick", name: "快捷对话", system: "你是一个简洁、直接的中文助手。", builtin: true },
];

export class RoleStore {
  constructor(directory) {
    this.path = join(directory, "roles.json");
    this.roles = builtins.map((role) => ({ ...role }));
    this.activeId = "agent";
  }

  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!saved || !Array.isArray(saved.roles)) throw new Error("角色预设文件无效");
    for (const role of saved.roles) {
      if (!role || typeof role.id !== "string" || typeof role.name !== "string" || typeof role.system !== "string") continue;
      if (role.id === "agent" || role.id === "quick") {
        const builtin = this.roles.find((item) => item.id === role.id);
        builtin.name = role.name.slice(0, 60) || builtin.name;
        builtin.system = role.system.slice(0, 20000);
      } else if (/^role-[a-z0-9-]{1,64}$/.test(role.id) && this.roles.length < 50) {
        this.roles.push({ id: role.id, name: role.name.slice(0, 60), system: role.system.slice(0, 20000), builtin: false });
      }
    }
    if (this.roles.some((role) => role.id === saved.activeId)) this.activeId = saved.activeId;
  }

  list() { return { roles: this.roles.map((role) => ({ ...role })), activeId: this.activeId }; }
  current() { return this.roles.find((role) => role.id === this.activeId); }

  async persist() {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.list(), null, 2), "utf8");
    await rename(temporary, this.path);
  }

  async save(input) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const system = typeof input.system === "string" ? input.system.trim() : "";
    if (!name || name.length > 60 || system.length > 20000) throw new Error("角色名称或说明长度不合适");
    if (input.roleId) {
      const role = this.roles.find((item) => item.id === input.roleId);
      if (!role) throw new Error("找不到该角色");
      role.name = name;
      role.system = system;
      await this.persist();
      return role.id;
    }
    if (this.roles.length >= 50) throw new Error("角色数量已达到上限");
    const id = `role-${randomUUID()}`;
    this.roles.push({ id, name, system, builtin: false });
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
