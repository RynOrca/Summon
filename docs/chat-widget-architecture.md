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

⚠️ 它**必然**在应用内绑定一个命令（`command` 必填、`scope` 只能是 `plugin`）。
若绑定 `summon.toggle`，PI-Desktop 聚焦时一次按键会触发两次 → 已在代码里用 350ms 去抖解决。

### 2.7 快捷键语法没有正式文档

`03-plugin-api.md` 的 keyboard 段只有宿主自己用的 `Alt+Space` 和 `Alt+Shift+W` 两个字面量，
没有修饰键词表。所以默认值选 `Alt+Shift+S`（与已证明可用的 `Alt+Shift+W` 同形），并内置备选链。

---

## 3. 硬限制（做不到的，别当能做的）

| 限制 | 证据 | 后果 |
|---|---|---|
| **没有插件可扩展的聊天渲染器** | GenUI README 原文；bridge 通道表里没有任何 message/session 通道 | transcript 必须**自己渲染**，不会和主窗口一模一样 |
| **没有「插件 → 面板」推送** | `api-findings.md` Q3；宿主的推送事件是固定且宿主发起的（`view:open` 等） | 只能**轮询** `session/get` |
| **没有窗口 primitive** | ADR 0081/0092/0093 反复写明 `pluginBridge` "does not gain window primitives" | 窗口**形状/尺寸只能写死在 manifest**，运行时改不了；圆球与对话窗只能是**两个插件** |
| **插件不提供设置页 HTML** | `02-plugin-manifest-schema.md:16`：「Plugins provide neither Settings HTML nor CSS or JavaScript」 | 角色编辑器只能做在**插件自己的窗口里**；宿主设置页里只能放 `json` 文本框兜底 |
| `agent.complete` 是 `tools: []` | `03-plugin-api.md:588` | 快捷对话**没有函数调用**，联网搜索必须靠**手动工具循环** |

---

## 4. 架构

```
快捷键 / 点击
     │
     ▼
┌──────────────── 悬浮窗 (shape:widget, alwaysOnTop, resizable ~420×620) ────────────────┐
│  顶栏：模式/角色选择器 │ 会话选择 │ 状态（模式·模型，只读）│ 去主窗口 │ ✕              │
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

轮询节奏：悬浮窗打开时 `session/get({id, messageLimit: 30})`，Agent 运行中 1.2s 一次，
空闲 4s 一次；用消息 id 去重，避免重绘与闪烁。

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
| **P2** | 对话浮窗骨架：`local.summon-chat`，`shape:widget`+`alwaysOnTop`+`resizable`，顶栏角色选择器，设置项与角色存储 | ✅ 完成 |
| **P3** | 快捷对话：`agent.complete` 多轮 + 手动工具循环 + 联网搜索 + 模型选择 | ✅ 完成 |
| **P4** | Agent 模式：`session/list` → `session/get` 轮询 → `agent/prompt` → `session/open` | ✅ 完成 |
| **P5** | transcript 渲染：消息气泡、工具调用折叠、运行状态、错误码友好化 | 🚧 基础版完成（纯文本 + 工具行）；Markdown/diff 渲染待做 |
| **P6** | 角色编辑器 UI（工作面板视图）+ 内置角色不可删 | ✅ 完成 |
| **P7** | 打磨、`npm run check` / `pack` / 安装实测 | 🚧 check/pack 完成；待你在应用内实测 |

每个阶段都跑：`node tools/smoke-test.mjs`（假宿主跑真实 main.js）+ `node tools/check-plugin.mjs`（真实 devkit）。

---

## 9. 已定的决策

| 问题 | 决定 |
|---|---|
| **搜索提供方** | **两者都要**：默认走内置 DuckDuckGo（零配置、免 Key）兜底；同时提供自定义端点 + API Key 设置项，填了就用用户的。因此权限里带 `net.anyHost` |
| **Agent 模式默认会话** | **每次呼出新开一个会话**（`session/create` → `agent/prompt`），不污染正在干活的会话；要接续历史就在悬浮窗里从会话列表选 |
| **角色编辑器位置** | **单独的工作面板视图**（`contributes.views` + `ui.view`），编辑体验更好 |
| **快捷键** | 用宿主的 `shortcut` 录制控件；圆球 `Alt+Shift+S`、对话窗 `Alt+Shift+C`，刻意错开以便同时安装 |
| **内置角色** | `agent`（模式锁定 agent）与 `quick`（模式锁定 quick，自带 `web_search`）；不可删，但可改名字/提示词/工具/skills |
| **窗口形态** | `shape: "panel"`（不是 widget）。宿主源码 `resizable: request.resizable ?? !widget` 与 `alwaysOnTop: widget && …` 决定了**置顶与缩放互斥**；用户要缩放+拖动，故选 panel，放弃置顶 |
| **Agent 默认行为** | 设置项 `agentStartMode`（默认 `new`）。窗口里的 `›` 按钮是每次打开的覆盖入口，用于接续历史会话 |
| **角色编辑器只有一处** | `roles` 已从 `contributes.settings` 移除（宿主只能渲染窄小的 JSON 文本框），角色完全由工作面板视图管理；`pi.plugin.setSettings` 对设置键不做校验（`plugin-runtime.ts:4872`），所以移除声明不影响持久化 |

## 10. 待定（不阻塞 P3/P4）

1. **快捷对话的模型**：目前打算用 `pi.models.list` 让用户在设置里选一个默认模型（角色可选
   覆盖）。如果你希望每个角色各自绑一个模型，说一声。
2. **悬浮窗默认尺寸**：现定 420×620（可拖拽缩放）。
3. **搜索的默认 HTTP 语义**：内置 DuckDuckGo 会走 HTML 端点并解析；如果你更希望默认就走
   JSON API（需要 Key），告诉我。
