# 鲸唤 Summon 0.25.1

**你说对了：图片就该直接当附件发。** 上一版那条「让模型调用工具去看图」的路子是我走错了 ——
既绕，又让弱模型在工具名上打转（你截图里的死循环）。

## 正确的是哪条路

`agent/prompt` **本来就接受附件**，而这正是**主窗口贴图走的那一条**：

```ts
// shared：AgentPromptRequest
attachments?: AgentPromptAttachment[];
// AgentPromptAttachment = { path, name, kind: "image" | "file", mimeType?, size? }
```

我之前去找「插件有没有附件通道」，找到 `composer.attachments.add`（只作用于主窗口 composer）
就停住了 —— 没想到**附件参数就在插件已经在调的那个接口上**。

宿主拿到它之后（`prompt-attachments.ts`）：

1. `resolvePromptPath()` 对着**会话的** project / scratch 根解析路径 ——
   `.summon/uploads/…` 在工作区里，能过；
2. 图片读成 base64 **内联**进这一轮：`supportsVision && size <= MAX_INLINE_IMAGE_BYTES`
   → **模型真的看到像素**；
3. 收不到图时（模型不支持视觉 / 文件过大）退化成文件引用，所以界面**提前告诉你**，
   而不是发完才发现。

## 删掉了 `show_image`

它在机制上确实成立（插件工具的 image 块会被还原成内容块，`runtime.ts:1561-1575`，
issue #1360），但：

- 弱模型会在工具名上打转 —— 你截图里那 42 秒就是这样烧掉的；
- **图片是附件，不是工具参数**。绕一圈去让模型"申请看图"本身就是错的设计。

`agent.tool.register` 权限也一并去掉，manifest 回到干净状态。

## 现在的行为

| 场景 | 结果 |
|---|---|
| Agent 模式贴图 + 支持视觉的模型 | 图片作为附件内联，**模型直接看到图** |
| Agent 模式贴图 + 不支持视觉的模型 | 发之前就提示「图片会作为文件路径交给它」 |
| 快捷对话贴图 | 明确拒绝（`agent.complete` 只收文本，那条限制没变） |

## 安装

- `local.summon-chat-0.25.1.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
25a6e4f18104975af22dca98d4717f8a640a7ac1c736dba983a487670e39808d  local.summon-chat-0.25.1.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 校验

`npm run verify` 全绿。新增断言盯着这条链路：`agent/prompt` 的调用里真的带了 `attachments`、
`kind` / `path` / `mimeType` 原样传递、没有 `size` 就不硬塞、形状不合法的条目被丢掉
（不能让宿主收到 `undefined.path`）。
