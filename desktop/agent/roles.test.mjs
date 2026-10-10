import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleStore } from "./roles.mjs";

test("角色预设可保存、重载、选择和删除，内置角色受保护", async () => {
  const directory = await mkdtemp(join(tmpdir(), "summon-roles-test-"));
  try {
    const first = new RoleStore(directory);
    await first.load();
    assert.deepEqual(first.list().roles.map((role) => role.id), ["agent", "planner", "quick"]);
    const id = await first.save({ name: "翻译官", system: "只做准确翻译" });
    await first.select(id);

    const second = new RoleStore(directory);
    await second.load();
    assert.equal(second.current().system, "只做准确翻译");
    assert.equal(second.current().name, "翻译官");
    await assert.rejects(second.delete("agent"), /内置角色/);
    await second.delete(id);
    assert.equal(second.activeId, "agent");

    const third = new RoleStore(directory);
    await third.load();
    assert.equal(third.list().roles.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
