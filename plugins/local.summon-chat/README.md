# Summon Chat（鲸唤 Summon）

用系统级快捷键呼出的**对话悬浮窗**。PI-Desktop 插件。

- 插件 id：`local.summon-chat`
- 版本：0.17.0
- 依赖：PI-Desktop **>= 0.16.0**
- 窗口形态：`shape: "widget"` + `alwaysOnTop: true` —— **常驻置顶、不可缩放**
- 界面：按 **「鲸唤 Summon 原型源码包 v1.4」** 设计系统实现

## 两种模式

| 模式 | 本质 | 走什么 |
|---|---|---|
| **Agent** | **就是同一个 agent**：驱动宿主的真实会话，权限、工具、skills、沙盒、模型全部与直接跑 pi agent 一致 | `pi.desktop.invoke`（`desktop.control`） |
| **快捷对话** | 本插件自己跑的多轮补全，**只支持联网搜索**（没有工具执行环境）；技能可在角色预设词里用 `/技能名` 引用，作为背景知识注入 | `pi.agent.complete` + 内置的 DuckDuckGo 搜索循环 |

角色决定用哪种模式：内置 `agent` 是 Agent 模式，`quick` 是快捷对话。

### 快捷对话怎么用技能：在角色预设词里写 `/技能名`

角色编辑器**不再有单独的 skills 字段** —— **System Prompt 本身就是唯一的事实来源**。
在里面用 `/技能名` 引用即可，语法与主窗口 composer 完全一致
（宿主 `packages/shared/src/composer-trigger.ts` 的 `findSkillMentions` 用的就是
`/(^|\s)\/([^\s]+)/g`，再拿这个名字去查技能目录）。

例：`你先按 /tavily-search 的说明确认怎么做，然后回答我的问题。`

实现细节：

- 插件 SDK 里**没有** skill 命名空间（`pi.skill` 不存在），所以走 `desktop.control` 的
  `skill/list` 与 `skill/read` —— 两者风险等级都是 **read**，不弹确认框
- 名称、slug、id 都能命中；最多注入 8 个；**读不到的引用静静跳过**，
  不会因为写错一个技能名就让整轮对话失败
- 注入时会附带「这些只是背景知识、不要复述、不要用 JSON 包裹」的约束 ——
  弱模型把整篇 SKILL.md 当回答吐出来是实测发生过的
- 旧的 `skills` 字段**不再生效**（保留解析只是让旧数据不报错）

## 设计来源

界面不是重新画的，而是**从设计源包移植**的。源包在仓库根的
`鲸唤 Summon 原型源码包 v1.4/`（`design.md` 规范 + `index.html` 可交互原型）。

| 复用内容 | 源包位置 |
|---|---|
| 设计 Token（浅/深两套，31 个） | `index.html:8–112` |
| 内联 SVG 图标 sprite（22 个） | `index.html:115–161` |
| 通用组件 + 桌面窗口框架 CSS | `index.html:169–489` |
| 窗口结构（titlebar / 三态视图 / 抽屉 / 设置） | `index.html:684–840` |
| 精简规范 | `docs/design-spec.md`（425 行，含源文档 16 处矛盾的附录 A） |

**唯一对设计的偏离**：用户要求暗色主题底色为**纯黑**，而设计的暗色底面是 `#191B1F`。
覆写规则集中在导出文件末尾，Token 本身与源包保持逐字节一致。

### 界面是构建产物

`renderer/index.html` 由 `renderer/renderer.template.html` + 导出的设计基座拼装而成，
因为插件页面必须是**单个自包含 HTML**，而 24KB 设计 CSS 不该手抄一遍（抄就是走样的开始）：

```bash
npm run export:design    # 从设计源包导出 docs/port-base.css + docs/port-icons.fragment.html
npm run build:renderer   # 拼装 renderer/index.html（改完模板必须跑）
npm run renderer:check   # 校验产物是否与模板/设计基座一致（已接入 verify）
```

导出的基座**剔除了 24 条文档页规则**（侧栏、品牌区、章节卡片、响应式演示）——
其中 `.brand .logo` 正是规范禁止的字面量 `#fff` 所在，所以这条剔除是必要的而不是洁癖。

## 界面

**呼出即对话**：只有「对话」与「设置」两个视图。设计里的「快捷输入态」被**去掉**了
（那个首页是第一眼看到的空页面，观感差且多一次跳转，直接进对话更顺手）。

### 对话态

顶栏按设计：`新对话 · 历史 · 模型 · 角色 …… 更多 · 设置 · 关闭`。

- 模型 / 角色是**芯片**，点开是设计系统的 `.popmenu`。模型菜单里同时带**思考深度**分组
  （选项只写档位词 `无 / 极简 / 低 / 中 / 高 / 极高 / 最高`，含义在悬停提示里）。
  分组标题（角色 / 模型 / 思考深度）**不是可选项**：没有 hover 与选中底色、没有点击指针，
  并且比选项大 5%（`.75rem` → `.7875rem`）以便一眼区分 —— 之前复用了 `.item`，
  看起来像能点，确实会误导。
- 右缘是**跳转刻度条**：一问一刻度，全部右端对齐同一基线，当前刻度**向左**凸出
  `8px → 12px`、`120ms` 过渡，点击平滑滚动到对应提问。
- 输入区**没有上边框**：靠设计的 `.fade-band > .blurpart` 做渐变高斯模糊，
  文字滚到底部会像被雾化一样淡出。
- 输入框右侧的按钮：**项目文件夹**与**权限模式**（仅 Agent 模式显示）、**增强提示词**
  （`#i-spark`，走宿主的 `prompt/enhance`，write 级不弹确认框）、**发送/停止**键。
- **所有按钮一律无外框、无底色**，与设计里的 `.iconbtn`（设置按钮）行为一致：
  默认全透明，只在悬停时给一层 `surface-2`；主/危险动作改用**文字颜色**区分，不再靠色块。
- **空状态垂直居中**：`.center-block` 自带 `margin:auto`，但 `.msg-area` 是普通块级容器，
  只会水平居中，所以之前「开始对话」贴在顶部；现在空状态时把消息区变成居中 flex。
- **项目文件夹**（Agent 模式）：宿主目录里有整套 `project/list`、`project/get`、
  `project/set`、`project/clear`，都不弹确认框。插件拿不到原生目录选择器，
  所以**列出已保存的项目让你选**，而不是让你手打路径。
- **工具输出默认折叠**：工具消息常常是一大坨原始 JSON 或报错堆栈，只显示一行摘要
  （超过 160 字或 3 行就折叠），点开才看原文，原文自己滚（`max-height: 16rem`）。
- **滚动不会被抢**：只有你本来就在底部时才自动跟到最新；往上翻之后，
  每 1.5s 一次的 transcript 轮询会**保留你的滚动位置**，不再把你拽回底部。
- **更多（☰）菜单**里有**权限模式**：跟随默认 / 每次询问 / 允许编辑 / 全自动，
  改的是当前会话的 `permissionMode`（`session/configure`，`dangerous`，**宿主会弹确认框**）。

## Agent 模式与「直接跑 pi agent」的关系

**Agent 模式就是同一个 agent**，不是复刻：插件不自己跑模型、不自己执行工具，而是驱动宿主的
真实会话（`session/create` / `agent/prompt` / `session/configure` / `agent/abort`），
所以**权限、工具、skills、沙盒、模型、权限模式与主窗口完全一致**。

**唯一的差别**：宿主要求授权时弹的那张卡片（「允许 Bash 运行吗?」）悬浮窗**看不到也答不了**。

原因是接口层面缺数据来源，查证如下：

- **插件能收到的事件只有四个**（`grep plugins.broadcastEvent` 的全集）：
  `appearance:changed`、`session:modelChanged`、`session:turnEnded`、`workspace:changed`
  —— **没有权限事件**。
- `desktop.control` 里**有** `agent/askTool/resolve`（"Answer an Agent question."，`dangerous`），
  可以**回答**授权；但**没有任何操作能列出待处理的授权请求**（`plans/pending` 只管 Plan/Goal 审批）。
  没有待批清单，就画不出卡片。
- 待批数据实际存在于 agent host 的 `pendingApprovals` 快照与 live-voice 的
  `approval.requested` 事件路径，两条都没有对插件开放。

**规避办法（已实现）**：在 ☰ 里把**权限模式**改成「允许编辑」或「全自动」，
这一轮就不需要授权卡片了。若某一轮长时间没有变化，状态行会明确提示
「可能在等主窗口的授权卡片……」并指向这个开关，而不是让你以为它卡死了。

## 悬浮窗目前**看不到**的东西（以及原因）

主窗口有、悬浮窗暂时没有的，都是因为缺一个可用的数据来源，而不是没做界面：

| 主窗口有 | 悬浮窗 | 原因 |
|---|---|---|
| 「需要权限 / 允许 Bash 运行吗?」内联授权卡片 | ❌（改为状态行提示 + 权限模式开关） | 见上一节：可以回答，但没有任何操作能列出待批请求 |
| 上下文用量 | ❌ | `session/get` 与 `agent/getStatus` 的返回没有公开契约；没实测出稳定字段前不猜 |
| 工具时间线（调用 / 运行 / 退出码） | ⚠️ 部分 | 只能从 transcript 的 `tool` 消息读到文本，读不到结构化的命令与退出码 |

**增强提示词已做**（`prompt/enhance`，`write` 级），**权限模式已做**（`session/configure` 的
`permissionMode`）。这两条证据明确，所以做了。
- 流式期间输入框上方出现**实时状态行**：`正在思考…` / `正在搜索「…」…（第 2 轮）` /
  `正在调用工具…`。快捷对话的相位由插件上报（窗口轮询），Agent 模式取自会话消息的真实 `status`。

### 历史侧栏

点顶栏「历史」滑出（`240ms cubic-bezier(0.2,0,0,1)`），带搜索框。列表**分两组**：

| 分组 | 来源 | 说明 |
|---|---|---|
| **悬浮窗对话（快捷模式）** | 插件自己的设置 | 快捷对话是本插件跑的，**不是宿主会话**，所以 `session/list` 里天然没有它 —— 插件自己记（最多 12 段、每段 20 条消息、单条 1000 字，上限裁剪后才写进设置） |
| **宿主会话（Agent 模式）** | 宿主的 `session/list` | 就是主窗口里那些会话，点一条即接续（轮询 transcript） |

**这里只做读取与接续，不提供删除** —— 删会话在宿主里是 `dangerous` 操作，插件没有对应通道。

### 设置态

左侧 5 个分区：

| 分区 | 内容 |
|---|---|
| 角色预设 | 列表 + 内联编辑（名称 / System Prompt 多行，可用 `/技能名` 引用技能 / **联网搜索开关**）。新建与删除**立即落盘**，编辑用「保存角色」 |
| 快捷键 | 点按键框直接**录制**（Esc 取消），显示当前生效状态与冲突告警 |
| 外观 | 主题（浅色 / 深色 / 跟随系统）、字号（小 13px / **标准 15px** / 大 17px / 特大 19px）、整体透明度（100/95/90/80%） |
| 搜索 | 搜索轮次上限、自定义端点、API Key |
| 通用 | Agent 默认行为（新开 / 接续）、思考过程详略（只读，跟随主窗口）、快捷键状态 |

保存有成功 Toast 与失败横幅双反馈。这些设置与宿主插件设置页**是同一份数据**。

## 与主窗口保持一致

- **模型**：插件通过 `settings/get` 读主窗口的 `defaultProviderId` / `defaultModelId`，
  你没显式选过时就用主窗口那个（芯片悬停会写明）。
- **思考过程详略**：跟随主窗口的 `thinkingDisplayMode` —— `compact` 给精简摘要（点开看全文），
  `detailed` 直接给全文。
- **思考深度**：选项来自会话的 `supportedThinkingLevels`，没有会话时回退到所选模型的
  `thinkingLevels`，默认值沿用宿主自己的规则（有 `medium` 用 `medium`，否则第一档），
  并按 `off → minimal → low → medium → high → xhigh → max` **强制排序**。

## Markdown

助手回复会渲染标题、粗体、斜体、行内代码、代码块、有序/无序列表、引用、链接、分隔线。
**只创建 DOM 节点，从不拼 `innerHTML`** —— 模型输出是不可信内容；链接只放行 `http(s)`。

## 权限

| 权限 | 风险 | 用途 |
|---|---|---|
| `ui.panel` / `ui.view` | low | 对话窗口 / 角色编辑器视图 |
| `keyboard.globalShortcut` | medium | 系统级呼出 |
| `notify` | low | 状态提示 |
| `models.list` | medium | 模型菜单 |
| `agent.complete` | high | 快捷对话（花你的额度） |
| `desktop.control` | high | Agent 模式 |
| `net.fetch` / `net.anyHost` | high | 联网搜索（后者允许自填端点） |

`check` 会对 `net.fetch` / `net.anyHost` 报一条 high-risk 提示 —— 那是预期的。

## 窗口形态：widget（常驻置顶，不可缩放）

```ts
resizable:   request.resizable ?? !widget,
alwaysOnTop: widget && request.alwaysOnTop === true,
transparent: widget,
```

**置顶与可靠缩放互斥**，且窗口标志是宿主创建窗口时按 manifest 定的、插件运行时改不了。
本插件取**置顶**：可拖动，**不能拖边框缩放**。想要可缩放的窗口就用 `local.summon-widget`（圆球）。

### 窗口大小只能改 manifest，设置页里改不了

当前 `ui.width: 360`、`ui.height: 660`。

**这不是没做，是做不到**：窗口尺寸由宿主在**创建窗口时**从 manifest 读取，
而 `window.pluginBridge` 不提供任何 window primitive（宿主 ADR 0081/0092/0093），
`desktop.control` 的操作目录里也没有窗口几何一项（明确写着 window/OS control stay out）。
插件自己改 manifest 也不行 —— 插件目录在宿主侧，`fs.write` 的作用域是工作区。

**要改就编辑 `manifest.json` 的 `ui.width` / `ui.height`，然后重新加载插件。**
宽度低于 400px 会触发设计系统的容器查询：模型/角色芯片只留图标，设置的分区导航转成横排。

## 为什么快捷对话是「受理 + 轮询」而不是直接等结果

宿主给**每一次面板调用**都定了 **30 秒硬超时**：`plugin-runtime.ts` 里
`PLUGIN_PANEL_TIMEOUT_MS = 30_000`，超时即报
`plugin local.summon-chat did not answer pi-plugin-panel-invoke` 并取消该调用。

而快捷对话一轮要做：**联网搜索 + 最多 N 轮 `agent.complete`**，单轮上限是
`PLUGIN_COMPLETE_TIMEOUT_MS = 90_000`。**同步等必然超时** —— 这正是之前
「发送失败：… did not answer call」的成因，不是网络问题。

所以：

- `sendQuick` 只回 `{ ok: true, accepted: true, turnId }` 就**立刻返回**；
- 模型在后台跑，页面每 400ms 轮询 `summon.chat.progress`；
- `inFlight` 转 `false` 时，从 `progress.result` 取答案（失败则在 `progress.error`）。

Agent 模式不受影响：`agent/prompt` 本来就只回「已受理」，真正的输出来自 transcript 轮询。

**测试也钉住了这个契约**（`tools/smoke-chat.mjs`）：`sendQuick` 必须带 `turnId`、
不得同步返回 `text`、进行中再发送要回 `BUSY`、轮询必须能取到答案。

## 生成期间的交互：停止、排队、引导

生成中发送键会变成**停止键**（设计里就有 `.sendkey.stop` / `#i-stop`）。按模式分两种语义：

| 模式 | 停止 | 生成中按 Enter |
|---|---|---|
| **Agent** | **真中止** —— 调用宿主的 `agent/abort`（`{sessionId, turnId?}`，风险等级 `write`，**不弹确认框**），然后刷新 transcript 让界面追上 | **直接发送**，作为对正在跑的这一轮的**引导** |
| **快捷对话** | **只能放弃这一轮** —— `agent.complete` 的入参里没有 `AbortSignal`，这一次模型调用**停不下来** | **排队**，本轮结束后自动发出 |

快捷对话的「停止」必须如实说明：界面打上 `.stopped-tag`，文案是
「已停止等待（单次模型调用无法中断，本轮结果不再计入）」——不假装停掉了。
被取消的轮次**结果丢弃、不记进历史**，而且它后台跑完时的进度回调**不会**再把进度点亮
（`setProgress` 见到 `cancelled` 直接返回，否则页面会又开始等一个用户已经停掉的轮次）。

排队中的消息显示在输入框上方，点一下：Agent 模式立即发送（引导），快捷对话则移出队列。

## 模型输出的两道防线

本地端点、小模型的实际输出比接口契约脏，所以插件侧（而不是界面侧）做了两件事，
这样它们能被 smoke 测试覆盖：

1. **内容块 JSON 剥壳**：有的端点把回复包成
   `{"content":[{"type":"text","text":"…"}]}`，直接渲染就是一坨 JSON。整段是这个形状时
   剥出正文、多个块用空行拼接；解析失败或形状不对**原样保留**，绝不吞掉内容。
   快捷对话与 transcript 两条路径共用同一个 `unwrapModelText`。
2. **技能文档不被复述**：角色的 skills 会把 SKILL.md 正文注入 system prompt，
   而弱模型很容易**把整篇文档当回答吐出来**（实测发生过）。所以注入时会明确声明
   「这些只是背景知识」、禁止复述、并禁止用 JSON 包裹回复。

## 本地校验

```bash
npm test              # 54 + 265 项断言（假宿主跑真实 main.js）
npm run lint          # 界面内联脚本语法 + 叠加层 hidden 检查
npm run design        # 移植保真：Token 覆盖、无自造 Token、sprite、通道、离线、拖动根元素
npm run renderer:check# 产物是否与模板/设计基座一致
npm run check         # 真实 pi-plugin check
npm run verify        # 以上全部
```

## 已知限制

1. **不能拖边框缩放**（widget 形态的代价，见上）。
2. **transcript 富渲染仍有限**：文本气泡 + 工具行 + 折叠思考块；没有 diff、工具参数折叠。
3. **`session/get` 没有官方契约**，`normalizeTranscript()` 按 `UiMessage`/`SessionDetail`
   类型解析并保留了对 part 数组的兜底；显示不对改那一个函数即可。
4. **轮询而非流式**：宿主没有插件可用的推送通道。
5. **改已有会话的模型/思考深度会弹宿主原生确认框**（`session/configure` 是 `dangerous`）；
   新建会话不弹（档位直接进 `session/create`）。
6. **快捷对话拿不到思考文本**：`agent.complete` 只回 `text`，所以那边只有状态指示与搜索轨迹，
   **不会伪造**思考过程。
7. **设计基座的 `.sendkey.stop`（停止键）未接**：插件没有取消 `agent.complete` 的通道，
   所以忙时只是禁用发送键，不假装能停止。
