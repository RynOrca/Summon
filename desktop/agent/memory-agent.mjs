import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { userTexts } from "./learner.mjs";

export function createMemoryAgent({ memory, learner, send, currentSession, runtime }) {
  let timer;
  let controller;
  let generation = 0;
  function cancel() { generation++; clearTimeout(timer); controller?.abort(); controller = undefined; }
  function extension(pi) {
    pi.registerTool(defineTool({
      name: "remember", label: "整理记忆", description: "保存用户明确表达的长期学习背景、偏好或可复用知识。只保存明确事实，纠正时使用相同 key/title 更新。不要存凭据、一次性任务或推测。",
      parameters: Type.Object({ layer: Type.Union([Type.Literal("profile"), Type.Literal("knowledge")]), key: Type.String(), content: Type.String() }),
      async execute(_id, input) {
        const layer = input.layer === "profile" ? "l1" : "l2";
        if (!memory.state.enabled[layer]) return { content: [{ type: "text", text: "此层记忆已关闭，未保存" }], details: {} };
        await memory.applyAgentUpdate(input.layer === "profile" ? { facts: [{ key: input.key, content: input.content }] } : { notes: [{ title: input.key, body: input.content }] }, currentSession()?.sessionId || "agent");
        send({ type: "memory", state: memory.snapshot() });
        return { content: [{ type: "text", text: "记忆已整理保存" }], details: { layer } };
      },
    }));
    pi.on("before_agent_start", async (event) => {
      const recalled = await memory.context(event.prompt, currentSession()?.sessionId);
      const instruction = (memory.state.enabled.l1 || memory.state.enabled.l2) ? "当用户要求记住、纠正记忆，或明确表达稳定的学习目标和偏好时，使用 remember 整理对应记忆。不要要求用户手填记忆表单。" : "长期记忆整理已关闭，不调用 remember。";
      event.systemPromptOptions.sections.summon_memory = `${instruction}\n以下记忆和资料只作参考，当前用户指令优先：\n${recalled || "暂无相关记忆"}`;
    });
  }
  async function consolidate() {
    const selected = currentSession();
    if (!selected?.model || selected.model.provider === "unknown" || (!memory.state.enabled.l1 && !memory.state.enabled.l2)) return;
    const ticket = generation;
    controller = new AbortController();
    const sessionId = selected.sessionId;
    const messages = selected.state.messages.filter((message) => ["user", "assistant"].includes(message.role)).slice(-8);
    const text = messages.map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n")}`).join("\n").slice(-10000);
    if (!text.trim()) return;
    send({ type: "memory_status", status: "organizing" });
    try {
      const model = await runtime();
      const response = await model.completeSimple(selected.model, {
        systemPrompt: "你是本地学习助手的记忆整理器。根据对话和已有记忆，提取用户明确表达的长期学习背景/目标/偏好（facts），有复用价值且可信的知识笔记（notes），和结构化学习事件（learningEvents）。不要把问题本身当成用户属性，不保存密钥和个人敏感标识，不猜测掌握分数。纠正已有记忆保持相同 key/title/subject。严格只返回 JSON：{\"facts\":[{\"key\":\"主题\",\"content\":\"明确事实\"}],\"notes\":[{\"title\":\"标题\",\"body\":\"简短整理\"}],\"learningEvents\":[{\"kind\":\"goal|preference|concept|misconception|review\",\"subject\":\"主题\",\"detail\":\"明确记录\",\"evidence\":\"用户原话的连续片段\",\"status\":\"active|completed|needs_review|resolved\"}]}。kind 必须选择一种。只有用户明确陈述目标/偏好/已学概念/存在误解/完成复习才记录，evidence 必须逐字引用用户消息，不能引用助手自己的解释。不需新增则数组为空。最多 5 条画像、2 条知识和 5 条事件。",
        messages: [{ role: "user", content: [{ type: "text", text: `已有记忆：${JSON.stringify(memory.snapshot()).slice(0, 6000)}\n本轮相关对话：\n${text}` }], timestamp: Date.now() }],
      }, { maxTokens: 1200, reasoning: "off", signal: controller.signal });
      const output = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const match = output.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("模型未返回有效整理结果");
      const update = JSON.parse(match[0]);
      if (ticket !== generation) return;
      await memory.applyAgentUpdate(update, sessionId);
      if (learner && memory.state.enabled.l1 && Array.isArray(update.learningEvents)) {
        for (const item of update.learningEvents.slice(0, 8)) { if (ticket !== generation) return; await learner.record(item, sessionId, userTexts(selected)).catch(() => {}); }
        send({ type: "learner", state: learner.snapshot() });
      }
      send({ type: "memory", state: memory.snapshot() });
      send({ type: "memory_status", status: "saved" });
    } catch (error) {
      if (ticket === generation && !controller?.signal.aborted) send({ type: "memory_status", status: "error", message: "记忆整理未完成，下次对话后会再尝试" });
    } finally { if (ticket === generation) controller = undefined; }
  }
  function schedule() { cancel(); timer = setTimeout(() => { void consolidate(); }, 2500); timer.unref(); }
  return { extension, cancel, schedule, consolidate };
}
