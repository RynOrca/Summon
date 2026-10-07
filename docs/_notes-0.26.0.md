# 对话悬浮窗 Summon 0.26.0

> Summon Chat 0.26.0 — a hotkey-summoned chat window for PI-Desktop that drives a real host session.

## 这是什么

按 `Alt+Shift+C` 呼出的对话浮窗。它**驱动宿主的真实会话**（不是复刻的对话层），所以权限、
工具、skills、沙盒、模型与主窗口完全一致；另有不建会话的「快捷对话」，可以读本地文件、联网搜索。

**What it is:** a floating chat window summoned by `Alt+Shift+C`. Agent mode drives a real
PI-Desktop session (same permissions, tools, sandbox and model as the main window); quick
mode answers from a one-shot completion with local read tools and web search.

## 这一版的变化

- **移除悬浮圆球**：本仓库从此只维护这一个插件（`local.summon-chat`）。
- **README 重写**为正式的产品页：安装、功能、权限与安全说明、已知限制、卸载与残留。
- 显示名统一为 **对话悬浮窗 Summon**（插件 id 仍是 `local.summon-chat`，**没有改 id** ——
  改 id 对宿主来说就是另一个插件，会让已有安装和两个市场都失去延续性）。
- 作者改为 `RynOrca`。

## 功能

| | |
|---|---|
| **处理过程时间线** | 思考内容、工具名与参数、结果、用时、搜索关键词、来源网址、token 用量；默认折叠 |
| **Agent 模式** | 真实会话；发送后显示「正在调用 Bash：…」，疑似等授权时指路主窗口 |
| **附件** | 粘贴/拖入图片与文件；图片走宿主附件通道，支持视觉的模型**真的看到图** |
| **快捷对话** | 本地 `read` 工具 + 联网搜索（DuckDuckGo，Bing 兜底，可自填 Tavily / SearXNG） |
| **角色预设** | System Prompt + 工具开关，可用 `/技能名` 引用技能 |

## 权限

`ui.panel` `ui.view` `keyboard.globalShortcut` `notify` `models.list`
`agent.complete` `desktop.control` `net.fetch` `net.anyHost` `fs.read`

`manifest.fs.read` 只读工作区（`scope: ["**/*"]`）。附件落盘用插件进程的 `node:fs`
写进会话项目的 `.summon/uploads/`，只写那个目录、文件名只保留扩展名 ——
测试里有路径穿越与 24 MB 上限两条断言。无遥测，不保存凭据。

## 安装

- 插件市场搜索 **对话悬浮窗**
- 或下载 `local.summon-chat-0.26.0.piplug`：**插件页 → 溢出菜单 → 安装插件包**

需要 PI-Desktop `>= 0.16.0`。

SHA256：

```
b2dafc33729d2fb09532f668f99bec810045a37265157716e694004dd911f71c  local.summon-chat-0.26.0.piplug
```

## 界面

| 空状态 | 一轮进行中 | 一轮结束 |
|---|---|---|
| ![空状态](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/empty-dark.png) | ![进行中](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/turn-dark.png) | ![时间线](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/transcript-dark.png) |

## 已知限制

- 逐字显示是**表现层效果**，不是流式传输（宿主没有回答文本的增量通道）；真正边跑边出现的是过程。
- 授权卡片只在主窗口 —— 插件事件目录里没有权限事件，也没有「列出待批请求」的操作。
- 快捷对话收不了图片：`pi.agent.complete` 的入参是纯文本。
- panel 形态**不置顶**（换来的是「呼出即可打字」）。

`npm run verify` 全绿：smoke 测试（假宿主跑真实 `main.js`）、第三方动效运行时测试、
内联脚本语法、产物一致性、设计移植保真、真实 `pi-plugin check`。
