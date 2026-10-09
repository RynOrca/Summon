import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stageFile } from "./files.mjs";

test("普通附件写入隔离会话目录并拒绝无效数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "summon-files-test-"));
  try {
    const file = await stageFile(directory, "test-session", "..\\secret.txt", Buffer.from("hello").toString("base64"));
    assert.equal((await readFile(file.path)).toString(), "hello");
    assert.equal(relative(directory, file.path).startsWith(".."), false);
    assert.match(file.path, /attachments/);
    await assert.rejects(stageFile(directory, "../escape", "bad.txt", "aGVsbG8="), /标识/);
    await assert.rejects(stageFile(directory, "test-session", "bad.txt", "not base64"), /格式/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
