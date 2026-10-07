# 对话悬浮窗 Summon

> 一个全局快捷键呼出的对话浮窗，接你的真实 PI-Desktop 会话 —— 过程、附件、权限，全都看得见。

给 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 写的插件。按一下 `Alt+Shift+C`，悬浮窗出现在
任何界面之上（panel 形态），**呼出即可打字**；它驱动的是宿主的**真实会话**，不是复刻的对话层。

<p align="center">
  <img src="docs/preview/empty-dark.png" width="240" alt="空状态" />
  <img src="docs/preview/turn-dark.png" width="240" alt="一轮进行中的处理过程" />
  <img src="docs/preview/transcript-dark.png" width="240" alt="一轮结束后的时间线" />
</p>

| 插件 | 快捷键 | 说明 |
|---|---|---|
| **对话悬浮窗 Summon**<br>`local.summon-chat` | `Alt+Shift+C` | Agent 模式（真实会话）+ 快捷对话（本地 `read` / 联网搜索）+ 角色预设 + 处理过程时间线 + 附件（图片 / 文件） |

## 安装

### 从插件市场（推荐）

PI-Desktop → **插件页 → 插件市场**，搜索 **对话悬浮窗** 或 `local.summon-chat`。

### 手动安装

到 [Releases](https://github.com/RynOrca/Summon/releases) 下载 `.piplug`，然后
**插件页 → 溢出菜单 → 安装插件包**。

> 需要 PI-Desktop `>= 0.16.0`。

## 功能

### 处理过程时间线

每次回答前面一条可折叠的时间线，数据全部来自宿主**已经落盘**的字段：
思考内容、工具名与参数、结果、用时、搜索关键词、来源网址、token 用量。
默认折叠，点开看细节 —— 而不是把一大坨原始 JSON 糊在屏幕上。

### Agent 模式 = 真实会话

权限、工具、skills、沙盒、模型与主窗口**完全一致**，因为它就是同一个会话。
发送后悬浮窗会显示**此刻在干什么**（`正在调用 Bash：rg -n …`），并在疑似等待授权时
提示你去主窗口点允许 —— 那张授权卡片插件看不到，我们如实说明而不是让它看起来卡死。

### 附件

粘贴或拖入文件即可。**图片走宿主的附件通道**（和主窗口贴图同一条路），
支持视觉的模型会**真的看到图**；不支持时会提前提示，而不是发完才发现。
文件落在会话项目下的 `.summon/uploads/`。

### 快捷对话

不建会话、直接问：本地 `read` 工具能读工作区文件，`web_search` 能联网
（内置 DuckDuckGo + Bing 兜底，也支持自填 Tavily / SearXNG 等端点）。
**快捷对话不接受图片** —— `agent.complete` 只收文本，我们选择明确拒绝而不是假装修好了。

### 角色预设

为不同类型的提问保存 System Prompt 与工具开关；System Prompt 里可用 `/技能名` 引用技能。

## 权限与安全

| 权限 | 用途 |
|---|---|
| `ui.panel` / `ui.view` | 对话窗口 / 角色编辑器 |
| `keyboard.globalShortcut` | 系统级呼出 |
| `notify` | 状态提示 |
| `models.list` | 模型菜单 |
| `agent.complete` | 快捷对话（消耗你的额度） |
| `desktop.control` | Agent 模式（驱动宿主会话） |
| `net.fetch` / `net.anyHost` | 联网搜索（后者允许自填端点） |
| `fs.read` | 读工作区文件（`read` 工具、拖入附件的字节） |

`manifest.fs.read` 只声明了读（`{ root: "workspace", scope: ["**/*"] }`）；
`clipboard.read`、`fs.write`、`agent.tool.register` 都**没有**声明 —— 用不到就不声明，
`pi-plugin check` 也会对未使用的权限报警。

**安全说明**

- **网络**：只访问你在设置里指定的搜索端点，以及内置的 DuckDuckGo / Bing。不发送任何凭据，
  不把文件内容外发 —— 除非你自己把某个端点配成了会接收内容的服务。
- **文件读**：限工作区（`scope: ["**/*"]`）；越界由宿主拒绝并如实回灌给模型。
- **文件写**：附件落地用**插件进程里的 `node:fs`** 写进会话项目的 `.summon/uploads/`
  （宿主的 `pi.fs` 只有 UTF-8 的 `writeText`，写不了图片字节）。因此**边界由插件自己守**：
  只写那个目录，写到磁盘的文件名只保留扩展名、其余自己生成，页面的输入拼不出目录之外的路径。
  测试里有 `../../evil.sh` 与 24 MB 上限两条断言。
- **会话**：Agent 模式通过宿主已有的 `desktop.control` 操作驱动会话，不绕过宿主的权限模式、
  沙盒与授权卡片；需要授权时插件只提示你去主窗口处理，不会替你答应。
- **无遥测**、无后台服务、不保存任何凭据。

## 卸载与残留

插件自身的设置随卸载移除。附件留在 `.summon/uploads/` 里（**不会**自动删除）——
确认不再需要时直接删掉 `.summon/` 目录即可。

## 开发

```bash
npm test          # 两个插件的 smoke 测试（假宿主跑真实 main.js）
npm run verify    # test + 第三方动效 + lint + 产物一致性 + 设计移植 + 真实 pi-plugin check
npm run pack      # 产出 .piplug 到 dist/
npm run preview   # 生成离线预览页（turn / quick / attach / set / light …）
```

改界面改 `plugins/local.summon-chat/renderer/renderer.template.html`
（`renderer/index.html` 是 `npm run build:renderer` 的产物）。
在 PI-Desktop 里开发：**插件页 → 溢出菜单 → 加载开发插件 → 选 `plugins/<id>`**。
加了新权限后必须**重新加载目录**，热重载不覆盖权限变更。

细节文档：[架构与硬限制](docs/chat-widget-architecture.md) ·
[Host API 调研](docs/api-findings.md) · [设计规范](docs/design-spec.md) ·
[插件 README](plugins/local.summon-chat/README.md)

## 已知限制

- **逐字显示不是流式传输**：宿主给插件的三条路都没有回答文本的增量通道，所以
  「一个字一个字出现」是表现层效果；真正边跑边出现的是**过程**。证据见
  [架构文档 §3.1](docs/chat-widget-architecture.md)。
- **授权卡片只在主窗口**：插件事件目录里没有权限事件，也没有「列出待批请求」的操作，
  所以悬浮窗只能提示你去主窗口处理。
- **快捷对话收不了图片**：`pi.agent.complete` 的入参是纯文本。
- **不置顶**：panel 形态换来的是「呼出即可打字」，置顶只有 widget 能拿到。

## 设计来源

界面**结构**按随包提供的设计系统「鲸唤 Summon 原型源码包 v1.4」实现，**配色与字号**
换成 PI-Desktop 自己的设计 Token（灰阶、中性强调色、白 alpha 文字阶梯），默认跟随主软件主题。

两段第三方动效以内联方式打包（面板必须是单个自包含 HTML），源码与许可证见
[docs/vendor/](docs/vendor/)：

| 文件 | 上游 | 用在哪 |
|---|---|---|
| `morphicons.js` | [guillermolg00/morphicons](https://github.com/guillermolg00/morphicons) (MIT) | 发送键的 Send↔Stop 形变 |
| `curve-loader.js` | [Paidax01/math-curve-loaders](https://github.com/Paidax01/math-curve-loaders) (MIT) | 「正在思考 / 正在搜索」的曲线加载动效 |

## 许可证

[MIT](LICENSE) © Orca。第三方组件的许可证与出处见 [NOTICE.md](NOTICE.md)。
