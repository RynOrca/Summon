import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("角色说明、会话命名与思考深度调用真实 PI Agent SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "summon-session-controls-"));
  let session;
  try {
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const sessionsDir = join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionsDir)]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true,
      appendSystemPromptOverride: (base) => [...base, "ROLE_TEST_INSTRUCTION"],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
      sessionManager: SessionManager.create(cwd, sessionsDir), tools: [],
    }));
    assert.match(session.systemPrompt, /ROLE_TEST_INSTRUCTION/);
    session.setSessionName("会话测试");
    assert.equal(session.sessionName, "会话测试");
    const levels = session.getAvailableThinkingLevels();
    assert.ok(levels.length > 0);
    session.setThinkingLevel(levels[0]);
    assert.equal(session.thinkingLevel, levels[0]);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
