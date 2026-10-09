import { randomUUID } from "node:crypto";

const MUTATING_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

export function createApprovalGate(send, timeoutMs = 5 * 60 * 1000) {
  const pending = new Map();

  const block = (reason) => ({ block: true, terminate: true, reason });

  function cancel(reason) {
    for (const [requestId, request] of pending) {
      clearTimeout(request.timer);
      request.resolve(block(reason));
      pending.delete(requestId);
      send({ type: "tool_permission_expired", requestId, reason });
    }
  }

  function decide(requestId, decision, reason) {
    const request = pending.get(requestId);
    if (!request) throw new Error("Tool permission request is no longer pending");
    pending.delete(requestId);
    clearTimeout(request.timer);
    request.resolve(decision === "allow" ? undefined : block(reason || "用户拒绝了此操作"));
  }

  function extension(pi) {
    pi.on("tool_call", async (event) => {
      if (!MUTATING_TOOLS.has(event.toolName)) return undefined;
      const requestId = randomUUID();
      send({ type: "tool_permission_request", requestId, toolCallId: event.toolCallId, name: event.toolName, args: event.input });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve(block("等待用户确认超时"));
          send({ type: "tool_permission_expired", requestId, reason: "等待用户确认超时" });
        }, timeoutMs);
        pending.set(requestId, { resolve, timer });
      });
    });
  }

  return { extension, decide, cancel };
}
