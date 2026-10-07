# 对话悬浮窗 —— 架构与阶段计划

> 本文档记录的每条结论都**在 PI-Desktop 0.16.1 的源码/二进制里验证过**，并附了出处。
> 计划里没有"应该可以"这种话——没验证的都写在「未决问题」里。

---

## 1. 目标

一个可快捷键呼出的**对话悬浮窗**，两种模式可切换：

| 模式 | 本质 | 用什么 API |
|---|---|---|
| **Agent** | 驱动**宿主真实的会话**——真沙盒、真工具、真 skill、真权限模式、真模型 | `pi.desktop.invoke` + `desktop.control` |
| **快捷对话** | 插件自己跑的多轮 LLM 对话，支持联网搜索 | `pi.agent.complete`（`tools: []`）+ 手动工具循环 |

外加：**预设角色**（自定义 system prompt / 工具 / 注入的 skill），默认内置 `Agent` 与 `快捷对话` 两个不可删的角色。

---

## 2. 已验证的宿主事实（带证据）

### 2.1 `pi.desktop` 确实实现了

```
plugin-runtime.ts:4954   listOperations: async () => { this.assertPermission(loaded, "desktop.control"); ...
plugin-runtime.ts:4971   invoke:  ... assertPermission(loaded, "desktop.control")
plugin-runtime.ts:493    "desktop.listOperations", "desktop.invoke"   (权限→API 映射)
```

用户机上的 Phase 1 探测也印证了：`piKeys` 里有 `desktop`。

### 2.2 插件能看到**全量**操作目录

```ts
// mcp-control.ts:864  —— 这行只过滤 MCP 外部通道
this.operations = this.controller.operations.filter((operation) => !operation.pluginOnly);
```

`pluginOnly` 只作用于 MCP 外表（`session-collaboration-control.ts` 里六个 `session/collaboration/*`）。
**插件网关拿到的是完整目录。**

### 2.3 我们要用的操作（`mcp-control.ts` 的 `spec(...)` 定义）

| 操作 | 出处 | 说明 | 风险 | 参数 |
|---|---|---|---|---|
| `agent/prompt` | :203 | 把 prompt 发给某会话的 Agent | write | `["request"]` |
| `session/get` | :212 | 读会话 + **一页受限 transcript** | read | `["input"]` = `{id, messageBefore?, messageLimit?, contentLimit?}` |
| `session/list` | :209 | 列出持久会话 | read | `[]` |
| `session/create` | :210 | 新建会话 | write | `["input"]` |
| `session/open` | :213 | 在桌面里打开该会话 | write | `["sessionId"]` |
| `agent/getStatus` | :208 | 读 Agent 运行状态 | read | `["sessionId"]` |
| `session/configure` | :216 | 配置下一轮，**含权限模式** | **dangerous** | `["id","config"]` |
| `session/collaboration/list` | :30 | 列可通信会话（不含 transcript） | read | `{}` |

### 2.4 为什么 `agent/prompt` 能用，而 `collaboration/send` 不能

```ts
// plugin-runtime.ts:5051
const invocation = this.inFlightTool(pluginId);
const result = await this.services.desktopControl.invoke({
  operation, args,
  source: "plugin",
  pluginContext: {
    pluginId,
    ...(invocation?.sessionId ? { sessionId: invocation.sessionId } : {}),
    ...
```

会话来源身份**只在存在进行中的 Agent 工具调用时才注入**。这就是为什么
`session/collaboration/spawn|send` 要求「插件的 Agent 工具调用期间」——它们需要那份 provenance；
而 `agent/prompt` / `session/get` / `session/list` 不需要，**所以悬浮窗（面板来源）可以直接调**。

### 2.5 `dangerous` 操作需要用户原生确认

```ts
// plugin-runtime.ts:5011
if (operationInfo?.risk === "dangerous") {
  if (input.confirm !== true) throw apiError("CONFIRMATION_REQUIRED", ...);
  const consent = this.services.confirmDesktopControl;
  const granted = consent ? await consent({ pluginId, pluginName, operation, description, args }) : false;
  if (!granted) throw apiError("PERMISSION_DENIED", ...);
}
```

→ 在悬浮窗里改**权限模式/模型**（`session/configure`）**每次都会弹宿主原生确认框**。
这是宿主刻意的防提示注入设计，绕不过去。折中：悬浮窗里只**显示**当前模式/模型 + 一个「去主窗口改」按钮。

### 2.6 快捷键录制器确实存在

```tsx
// PluginSettingsSheet.tsx:245
<button className="plugins-shortcut-recorder" onClick={...}
        onKeyDown={(event) => recordingKey === setting.key && recordShortcut(event, setting)}>
```

`type: "shortcut"` 的设置项渲染成**按键录制按钮**。录制值与 `contributes.globalShortcuts` 同语法
（manifest §7 规则 13/18：same modifier-plus-key / F-key grammar）。

> **它并不执行命令。** 插件的 `scope: "plugin"` shortcut 只是被存储的一份设置
> （`PluginSettingsSheet.tsx:146` 只做 `setValue`），宿主没有把它接到 `plugin.call` /
> 命令执行上。所以「一次按键触发两次」这个假设不成立，`TOGGLE_DEBOUNCE_MS` 现在只是
> 防宿主重复投递的保险。键位语法见 `packages/shared/src/keyboard-shortcuts.ts`：
> 修饰键只有 `Mod / Ctrl / Alt / Shift`（**没有 Control / Meta**），主键是
> `A–Z / 0–9 / F1–F12 / Comma / Period / Equal / Minus / Space / ArrowUp …`。
> 录制器必须按这份词表生成，否则宿主 `normalizeKeybinding` 返回 null →
> `INVALID_ACCELERATOR`（表现：录了新键，保存后热键没了）。

### 2.8 窗口可见性：没有「面板是否打开」的 API

```ts
// plugin-panel-host.ts
alwaysOnTop: widget && request.alwaysOnTop === true,
resizable:   request.resizable ?? !widget,
async open(request) { const existing = this.windows.get(...); ... existing.show(); existing.focus(); }
async close(pluginId) { win.close(); await pageGoneWithin(page); }
```

三点推论：

1. `open()` 会**复用**同一个窗口并 `restore() → show() → focus()`：所以「没开就开、
   开成最小化就再 show 一次」都是同一条幂等路径，快捷键的二段语义可以建立在它上面。
2. `close()` 解析时页面**确实已经销毁**，所以「关闭」是权威状态，不会被迟到的页面回调翻案。
3. 页面 `visibilitychange`（最小化会让它变 `hidden`）与 `pagehide` 是唯一的第二信息源。
   **心跳不能替代它**：最小化不会让渲染进程停下，心跳照发，
   于是「页面还活着」被误当成「窗口在屏幕上」——这就是旧实现按键没反应的成因。

### 2.7 快捷键语法没有正式文档

`03-plugin-api.md` 的 keyboard 段只有宿主自己用的 `Alt+Space` 和 `Alt+Shift+W` 两个字面量，
没有修饰键词表 —— 但**源码里有**：`packages/shared/src/keyboard-shortcuts.ts` 的
`normalizeKeybinding` / `isAllowedKeybinding` / `isReservedKeybinding` 就是权威语法。
默认值选 `Alt+Shift+C`（与已证明可用的 `Alt+Shift+W` 同形），并内置备选链
`Alt+Shift+C → Alt+Shift+Q → Alt+Shift+J → F3`。

---

## 3. 硬限制（做不到的，别当能做的）

| 限制 | 证据 | 后果 |
|---|---|---|
| **没有插件可扩展的聊天渲染器** | GenUI README 原文；bridge 通道表里没有任何 message/session 通道 | transcript 必须**自己渲染**，不会和主窗口一模一样 |
| **没有「插件 → 面板」推送** | `api-findings.md` Q3；宿主的推送事件是固定且宿主发起的（`view:open` 等） | 只能**轮询** `session/get` |
| **没有流式增量（回答文本）** | 见下面 §3.1 | 逐字显示只能是**表现层效果**；过程（工具行）是真的边跑边出现 |
| **没有窗口 primitive** | ADR 0081/0092/0093 反复写明 `pluginBridge` "does not gain window primitives" | 窗口**形状/尺寸只能写死在 manifest**，运行时改不了；圆球与对话窗只能是**两个插件**。同一处还决定了：**只有 widget 能置顶**，而 widget 的 `show()` 不给键盘焦点——所以「置顶」与「呼出即可打字」二选一 |
| **插件不提供设置页 HTML** | `02-plugin-manifest-schema.md:16`：「Plugins provide neither Settings HTML nor CSS or JavaScript」 | 角色编辑器只能做在**插件自己的窗口里**；宿主设置页里只能放 `json` 文本框兜底 |
| `agent.complete` 是 `tools: []` | `03-plugin-api.md:588` | 快捷对话**没有函数调用**，联网搜索必须靠**手动工具循环** |

### 3.1 回答文本没有增量通道（2026-10 复核，PI-Desktop 0.16.1 源码）

「为什么答案总是先完整出现、再一个字一个字铺开」的完整答案。三条路都走不通：

| 路 | 证据 |
|---|---|
| `agent.complete` | `PluginCompleteInput` 只有 `modelKey / thinkingLevel / system / messages / includeSessionContext`，`PluginCompleteResult` 只是一次性 `text`（`packages/plugin-sdk/src/index.ts:768`）。没有回调、没有 stream 选项；宿主侧 `runAgentComplete` 里 `await this.services.complete(...)` 之后才取 `result.text`（`plugin-runtime.ts:4135`） |
| `session/get` | 读的是**落盘 transcript**：`sessions::get_session_with_options` → `transcripts::read_transcript_window_with_layout` 只读 `<session>.jsonl`。正在生成的回复写在 `<session>.inflight.json` 检查点里（`InflightCheckpointer` → `session.saveInflightMessage`，间隔 `INFLIGHT_CHECKPOINT_INTERVAL_MS = 1500`），**没有任何 RPC 读回它**（全仓只有 `session.saveInflightMessage` 与 `session.recoverInflightMessages` 两个 inflight 入口，后者只在 turn 结束时把检查点**升格**进 transcript） |
| 事件 | `plugins.broadcastEvent(...)` 的**全集**只有四处：`appearance:changed`（`app-lifecycle.ts:658`）、`workspace:changed`（`index.ts:440`）、`session:modelChanged`（`session-ipc.ts:560`）、`session:turnEnded`（`plugin-services.ts:536`）。宿主内部的 `message_update` 只发到渲染进程自己的 store（`session-runtime.ts` 的 `applyMessageUpdate`），插件拿不到 |

**所以能拿到的是「过程」，不是「正文」**：工具调用是**边跑边落盘**的
（`tool_start` 先落一行 `status: "running"`、`tool_end` 再补 `toolStatus` / `toolResult` /
`toolDurationMs`），所以 `session/get` 轮询能看到工具行**逐条出现**。这一版把轮询在轮次
运行中从 1.5s 加快到 0.6s，并且把工具行渲染成时间线（工具名 / 参数 / 结果 / 退出码 / 用时）。

**要真流式只有一条路**：让用户填一个兼容 OpenAI 的 `base_url + key`，插件用
`net.fetch` / `pi.net.ws` 直连 SSE。那是新功能（还要新权限），不是渲染层的修正。

### 3.2 但这一版**能**显示的（同一批字段）

`MessageRecord` → `record_to_ui` 的往返里，这些字段一直是齐的，只是旧实现把它们全丢了：

```
responseDurationMs   → 「已处理 9.2s」
thinking             → 时间线里的「思考过程」
toolName / toolArgs / toolResult / toolStatus / toolDurationMs / toolCompletedAt
                     → 工具行（名字 / 参数 / 结果 / 退出码 / 用时）
hostedSearch.rounds[].{query,url,sources[].url}
                     → 厂商托管搜索的关键词与来源网址
usage.{inputTokens,outputTokens,reasoningTokens}
                     → 底部用量行
status: "streaming"  → 「这一轮还在写」
modelSystem          → 内部模型指令，**不是**聊天行（旧实现会把它的正文当回答画出来）
```

出处：`crates/host-core/src/sessions.rs` 的 `ui_to_record`（:328）与 `record_to_ui`（:479），
`packages/shared/src/types/messages.ts` 的 `UiMessage` / `HostedSearch`。

---

## 4. 架构

```
快捷键 / 点击
     │
     ▼
┌──────────────── 对话浮窗 (shape:panel, resizable 420×660, 呼出即聚焦) ────────────────┐
│  顶栏：新对话 │ 历史 │ 模型 chip │ 角色 chip │           更多 │ 设置               │
│  transcript 视图（Agent 模式）或 对话气泡（快捷对话模式）                             │
│  输入框                                                                              │
└───────────────┬──────────────────────────────────────────────────────────────────────┘
                │ window.pluginBridge.invoke("summon.*", …)   ← 唯一被文档化的方向
                ▼
        插件进程 main.js
                │
    ┌───────────┴────────────┐
    │ Agent 模式             │ 快捷对话模式
    ▼                        ▼
pi.desktop.invoke        pi.agent.complete  (+ 手动工具循环)
 · session/list           · models.list 选模型
 · session/get (轮询)     · 联网搜索 → pi.net.fetch
 · agent/prompt           · 角色 system prompt
 · session/open
 · agent/getStatus
    │
    ▼
宿主真实会话：沙盒 / 工具 / skill / 权限 / 模型 全部由宿主负责
```

轮询节奏：悬浮窗打开时 `session/get({id, messageLimit: 30})`，Agent 运行中 1.5s 一次；
快捷对话进度 500ms 一次。用消息 id 去重，避免重绘与闪烁。
心跳 2s 一次，但它**只表示页面还活着**，不再参与「窗口是否可见」的判断（见 §2.8）。

---

## 5. 角色预设模型

```jsonc
// 存在插件设置 key = "roles"（type: "json"，作为无 UI 时的兜底）
{
  "version": 1,
  "roles": [
    { "id": "agent",   "name": "Agent",   "builtin": true,  "mode": "agent" },
    { "id": "quick",   "name": "快捷对话", "builtin": true,  "mode": "quick",
      "system": "…", "tools": ["web_search"], "skills": [] },
    { "id": "role-1",  "name": "翻译助手", "builtin": false, "mode": "quick",
      "system": "你是翻译…", "tools": [], "skills": ["release-notes"] }
  ]
}
```

- `builtin: true` 的两个（`agent` / `quick`）**不可删**，UI 上禁掉删除按钮
- `mode` 决定这个角色走哪条链路；`tools` / `skills` 只对 `quick` 有意义
  （Agent 模式的工具/skill 由**真实会话**决定，插件管不着——这也是它"真"的原因）
- `skills` 对快捷对话的含义：把 `pi.skill.read` 读到的正文拼进 system prompt
  （`skill.list` / `skill.read` 是 bridge 通道；插件进程里对应 `pi.skill.*`）
- 存在插件私有设置里（`pi.plugin.getSettings/setSettings`），跟着插件 id 走

### 角色编辑器放哪

**只能放在插件自己的窗口里**（见 §3）。所以：
- 悬浮窗里加一个「管理角色」入口（或
- 单独一个 `contributes.views` 工作面板视图，`ui.view` 权限，编辑体验更舒服）

宿主设置页里保留一个 `roles` 的 `json` 文本框作为兜底与直接编辑入口。

---

## 6. 快速对话的联网搜索

`agent.complete` 不支持函数调用，所以走**手动工具循环**：

```
1. system prompt 里声明可用工具，并要求需要时只输出一行 JSON：
     {"tool":"web_search","query":"…"}
2. 插件解析模型输出
   ├─ 是工具调用 → 执行搜索 → 把结果作为一条 user 消息追加（标注为工具结果）
   │                → 再调 agent.complete  → 回到 2（最多 N 轮，默认 3）
   └─ 否则 → 就是最终回答，渲染出来
3. 兜底：N 轮后仍要工具 → 告诉用户"搜索轮次用尽"
```

**搜索提供方**（`net.fetch` 需要 `manifest.net.domains` 白名单，写死的域名）：
- 方案 A：自带一个 SearXNG / 自建实例 → 需要 `net.anyHost`（高风险）让用户在设置里填地址
- 方案 B：Tavily / Brave / SerpAPI → 需要用户填 API key，域名预先声明
- 方案 C：DuckDuckGo HTML 端点（无需 key，但脆、要解析 HTML）

建议：**默认内置方案 C 的域名**，同时提供 `net.anyHost` 让用户填自己的端点/Key。
搜索这块在「未决问题」里等你定。

---

## 7. 权限清单（一个都不能少）

| 权限 | 风险 | 用途 |
|---|---|---|
| `ui.panel` | low | 悬浮窗本体 |
| `keyboard.globalShortcut` | medium | 系统级呼出 |
| `notify` | low | 状态提示 |
| `desktop.control` | **high** | Agent 模式（`pi.desktop.invoke`） |
| `agent.complete` | **high** | 快捷对话（花你的额度） |
| `models.list` | medium | 模型选择器 |
| `net.fetch` | **high** | 联网搜索 |
| `net.anyHost` | **high** | 允许用户自填搜索端点（可选） |
| `fs.read`（可选） | medium | 会话 transcript 里引用工作区文件 |
| `ui.view`（可选） | low | 独立的工作面板视图用来编辑角色 |

> 装的时候会连弹这么多高风险确认——这是宿主设计，不是我能省的。建议先只开
> `ui.panel` + `keyboard.globalShortcut` + `desktop.control` + `agent.complete` + `models.list` + `net.fetch`。

---

## 8. 阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 圆球插件：悬浮窗形态 + 系统级快捷键 + check/pack 全绿 | ✅ 完成 |
| **P1** | 快捷键改用宿主录制器（`type: "shortcut"`）+ 去抖 | ✅ 完成 |
| **P2** | 对话浮窗骨架：`local.summon-chat`，顶栏角色选择器，设置项与角色存储 | ✅ 完成（形态在 P8 由 widget 改为 panel） |
| **P3** | 快捷对话：`agent.complete` 多轮 + 手动工具循环 + 联网搜索 + 模型选择 | ✅ 完成 |
| **P4** | Agent 模式：`session/list` → `session/get` 轮询 → `agent/prompt` → `session/open` | ✅ 完成 |
| **P5** | transcript 渲染：消息气泡、工具调用折叠、运行状态、错误码友好化 | 🚧 基础版完成（纯文本 + 工具行）；Markdown/diff 渲染待做 |
| **P6** | 角色编辑器 UI（工作面板视图）+ 内置角色不可删 | ✅ 完成 |
| **P7** | 打磨、`npm run check` / `pack` / 安装实测 | 🚧 check/pack 完成；待你在应用内实测 |
| **P8** | 与主软件统一 + 快捷键手感（用户反馈驱动） | ✅ 完成：panel 形态（呼出即聚焦）、可见性由页面如实上报、快捷键只注册一次、录制器改用宿主语法、配色换主软件 Token、默认跟随主软件主题 |
| **P9** | 反馈驱动的一轮：底部雾化过渡带接缝、处理过程时间线（工具 / 搜索关键词 / 来源网址 / 用时 / 用量）、增量渲染 + 逐字揭示、曲线加载动效与图标形变 | ✅ 完成：见 `plugins/local.summon-chat/README.md` 的「处理过程」与「关于「流式」」两节；限制与证据见本文 §3.1/§3.2 |

每个阶段都跑：`node tools/smoke-test.mjs`（假宿主跑真实 main.js）+ `node tools/check-plugin.mjs`（真实 devkit）。

---

## 9. 已定的决策

| 问题 | 决定 |
|---|---|
| **搜索提供方** | **两者都要**：默认走内置 DuckDuckGo（零配置、免 Key）兜底；同时提供自定义端点 + API Key 设置项，填了就用用户的。因此权限里带 `net.anyHost` |
| **Agent 模式默认会话** | **每次呼出新开一个会话**（`session/create` → `agent/prompt`），不污染正在干活的会话；要接续历史就在悬浮窗里从会话列表选 |
| **角色编辑器位置** | **单独的工作面板视图**（`contributes.views` + `ui.view`），编辑体验更好 |
| **快捷键** | 用宿主的 `shortcut` 录制控件（但**不指望它执行命令**，它只是设置项）；圆球 `Alt+Shift+S`、对话窗 `Alt+Shift+C`，刻意错开以便同时安装；实际注册由插件进程独自完成 |
| **内置角色** | `agent`（模式锁定 agent）与 `quick`（模式锁定 quick，自带 `web_search`）；不可删，但可改名字/提示词/工具/skills |
| **窗口形态** | `shape: "panel"`。宿主源码 `resizable: request.resizable ?? !widget` 与 `alwaysOnTop: widget && …` 决定了**置顶与「呼出即可打字」互斥**；快捷键呼出的东西必须第一下就能输入，故选 panel（可缩放、呼出即得焦点），放弃置顶 |
| **可见性判定** | 不再用心跳时长推断。插件进程自己维护 `panelOpen`（open/close 两处赋值），页面 `visibilitychange` 上报 `summon.chat.visibility`、`pagehide` 上报 `summon.chat.closed`。判定：没开→开；开着但不可见→显示并聚焦；开着且可见→关 |
| **快捷键注册方** | **只有插件进程**。manifest 的 `contributes.globalShortcuts[].default` 会让宿主也注册一个，用户改键后旧键留在宿主侧变成第二个隐形热键，所以**不声明 `default`** |
| **录制器语法** | 照宿主 `packages/shared/src/keyboard-shortcuts.ts` 的词表逐字映射（`Mod/Ctrl/Alt/Shift` + `A–Z/0–9/F1–F12/Comma/Period/…`）。旧录制器写的 `Control`/`Meta` 会被宿主判为 `INVALID_ACCELERATOR` |
| **界面配色** | Token 名沿用设计源包；**值**换成主软件 `apps/desktop/src/styles/tokens.css`（灰阶 + 中性强调色 + 白 alpha 文字阶梯 + 主软件字体/圆角）。默认「跟随主软件」：`pi.app.getAppearance()` 取快照 + `appearance:changed` 实时跟随 |
| **Agent 默认行为** | 设置项 `agentStartMode`（默认 `new`）。窗口里的 `›` 按钮是每次打开的覆盖入口，用于接续历史会话 |
| **角色编辑器只有一处** | `roles` 已从 `contributes.settings` 移除（宿主只能渲染窄小的 JSON 文本框），角色完全由工作面板视图管理；`pi.plugin.setSettings` 对设置键不做校验（`plugin-runtime.ts:4872`），所以移除声明不影响持久化 |

## 10. 待定（不阻塞 P3/P4）

1. **快捷对话的模型**：目前打算用 `pi.models.list` 让用户在设置里选一个默认模型（角色可选
   覆盖）。如果你希望每个角色各自绑一个模型，说一声。
2. **悬浮窗默认尺寸**：现定 420×620（可拖拽缩放）。
3. **搜索的默认 HTTP 语义**：内置 DuckDuckGo 会走 HTML 端点并解析；如果你更希望默认就走
   JSON API（需要 Key），告诉我。
