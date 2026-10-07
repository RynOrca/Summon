# Summon Chat（鲸唤 Summon）

用系统级快捷键呼出的**对话悬浮窗**。PI-Desktop 插件。

- 插件 id：`local.summon-chat`
- 版本：0.19.0
- 依赖：PI-Desktop **>= 0.16.0**
- 窗口形态：`shape: "panel"` —— **呼出即获得键盘焦点，可直接打字**（可缩放，不置顶）
- 界面：布局移植自 **「鲸唤 Summon 原型源码包 v1.4」**，**配色/字体/圆角换成 PI-Desktop 自己的设计 Token**，主题默认**跟随主软件**

## 快捷键：从「按了没反应」到「按一下必定有反应」

呼出用的是**系统级快捷键**（`keyboard.globalShortcut`），不是插件内快捷键。
按下后走 `命令 → 插件进程 → pi.ui.openPanel / closePanel`。两条修正让它的手感变成
「不管在哪，按下就弹出，再按就关闭」：

**1. 窗口形态从 widget 改成 panel —— 呼出时能拿到键盘焦点。**
宿主建窗时写死了两条互斥的规则（`plugin-panel-host.ts`）：

```ts
alwaysOnTop: widget && request.alwaysOnTop === true,
resizable:   request.resizable ?? !widget,
```

widget 窗口**只能**靠 `show()` 出现在屏幕上，宿主不把键盘焦点给它 —— 于是「按了快捷键，
窗口浮出来了，但打字进不去，还得先用鼠标点一下」，正是「响应不灵敏」的最大来源。
panel 形态下宿主复用同一个窗口时会 `restore() → show() → focus()`，
所以第一下按键就能开始打字。代价是**失去置顶**（host 的 `alwaysOnTop` 只对 widget 生效）。

**2. 窗口「在不在屏幕上」不再靠心跳时长猜。**
旧实现用「2 秒一次心跳 + 6 秒有效期」推断窗口是否可见。但**最小化不会让页面停下来**，
所以那 6 秒里插件认为窗口是可见的，下一按键就去执行关闭 —— 看起来就是「按了没反应」。
现在状态由两端如实上报，互不推断：

| 事实 | 谁上报 |
|---|---|
| 打开了 | 插件进程自己（`openWidget`） |
| 关闭了 | 插件进程自己，且 `closePanel` 解析时页面确实已经销毁（`pageGoneWithin`） |
| 被最小化 / 被遮挡 | 页面 `visibilitychange` → `summon.chat.visibility {visible:false}` |
| 页面要走了 | 页面 `pagehide` → `summon.chat.closed` |

判定就三行：**没开 → 开；开着但不可见 → 显示并聚焦（顺带还原最小化）；开着且可见 → 关。**

**3. 快捷键不再被注册两次。**
manifest 里的 `contributes.globalShortcuts[].default` 会让**宿主**替你注册一个，
插件进程又用 `pi.keyboard.registerGlobalShortcut` 注册一个。默认键相同时第二次被注册表
拒绝，看着无害；可一旦你在设置里录了别的键，插件进程把 `toggle` 挪到新键，**宿主那个
`Alt+Shift+C` 还留着** —— 两个都能呼出，其中一个在界面上根本看不见。
现在 manifest **不声明 `default`**（该字段可选），注册权完全归插件进程。

**4. 录制器生成的是宿主认的语法。**
宿主的键位词表（`packages/shared/src/keyboard-shortcuts.ts`）只有
`Mod / Ctrl / Alt / Shift`，主键是 `A–Z / 0–9 / F1–F12 / Comma / Period / Equal / ArrowUp …`。
旧录制器写的是 `Control`、`Meta`、`=`，宿主 `normalizeKeybinding` 直接返回 null →
`INVALID_ACCELERATOR` —— 表现就是「录了个新键，保存后热键反而没了」。
现在录制器照宿主的词表逐字映射，并在录不出来时**当场说明原因**，不再假装成功。

<details>
<summary>快捷键没生效时按顺序看这四处</summary>

1. **插件设置 → 快捷键**：显示的是**实际生效**的键（不是你想录的那个）。被占用会自动
   退到备选键（`Alt+Shift+C → Alt+Shift+Q → Alt+Shift+J → F3`）并弹提示。
2. **加了新权限后必须重新加载目录**，热重载不覆盖权限变更。
3. `%USERPROFILE%\.pi-desktop\logs\app\plugin.log` 里看
   `keyboard.globalShortcut.register` 的 `ok` 与 `accelerator` 字段 —— 这是最直接的证据。
4. 宿主 `plugin-runtime.ts` 的 `triggerPluginShortcut` 会把命令失败写进同一份审计日志。
</details>

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

界面**结构**是从设计源包移植的，源包在仓库根的
`鲸唤 Summon 原型源码包 v1.4/`（`design.md` 规范 + `index.html` 可交互原型）。

| 复用内容 | 源包位置 |
|---|---|
| 设计 Token（**名字**，浅/深两套，31 个） | `index.html:8–112` |
| 内联 SVG 图标 sprite（22 个） | `index.html:115–161` |
| 通用组件 + 桌面窗口框架 CSS | `index.html:169–489` |
| 窗口结构（三态视图 / 抽屉 / 设置） | `index.html:684–840` |
| 精简规范 | `docs/design-spec.md`（425 行，含源文档 16 处矛盾的附录 A） |

### 对设计的偏离（两处，都是有意的）

1. **配色不再是原型的鲸蓝，而是 PI-Desktop 自己的设计 Token。**
   用户要求「插件和主软件风格一致」。所以 Token **名字**照抄原型，**值**换成
   `apps/desktop/src/styles/tokens.css` 那一套：灰阶 `#0d0d0d / #181818 / #212121 / #303030`、
   中性强调色（暗色下 `--ds-accent` = 纯白）、次要文字用白 alpha 阶梯
   （70% / 52% / 38%）、描边 8% / 5% / 14%、字体族 `--font-sans / --font-mono`、
   圆角阶梯 4 / 6 / 8 / 14px。
   主窗口底色 `#181818` 正是 `builtinWindowBackground("dark")`，
   所以插件面板和主软件窗口之间不会出现一条色差缝。
   顺带改掉两处「有色块」的地方，改成主软件的做法：用户气泡是 8% 白 alpha 的柔和气泡
   （`messages.css` 的 `.message-bubble`），发送键是白底圆钮（`composer.css` 的 `.send-btn`）。
2. **顶栏与宿主那一行合并了。** 面板形态下宿主在顶部 46px 画窗口按钮胶囊
   （`PLUGIN_PANEL_TITLEBAR_HEIGHT`）。这段高度省不掉（胶囊在那儿），但**空着就是一排
   没有内容的空白** —— 所以那一排控件被**搬进这条带子，与胶囊同排**，
   并给胶囊让出右侧 112px（96px 宽 + 距右 8px + 8px 余量）。

   三条前提，缺一条控件就点不到：

   - 每个控件都标 `data-pi-plugin-no-drag`。宿主的拖拽地图整条带子覆盖
     （`plugin-panel.ts: installPaintThroughDragMap`），只在它认得的元素上挖洞
     （`input`/`button`/`[tabindex]`/`[data-pi-plugin-no-drag]` …）；
   - 页面声明 `<meta name="pi-plugin-chrome" content="v2">`。不声明时 preload 认为是
     legacy 页面，会给 `<body>` 补一条 `padding-top: 46px !important`
     （`pluginOwnsTitlebarSpacing()`），与本页在 `#win` 上的占位叠成 92px；
   - 位置由 `markTitlebarBand()` 在**运行时**以**内联样式**写进每个 `.topbar`
     （`margin-top: -(band)` / `height: band` / `padding-right: 112px`），
     CSS 里的 `.pi-has-band .topbar` 只作 JS 未执行时的兜底。
     改成内联是有原因的：实测同一条规则在隐藏的设置视图上生效、在可见的聊天视图上被忽略
     （`npm run layout` 会把两个值一起打出来）。内联值不参与层叠竞争，
     「顶栏到底在不在带子里」就不再取决于某条规则有没有胜出。

   顶栏还带一条 1px 的 `--border` 下边框，把带子与内容分开。关闭入口保留 Escape，
   另外宿主胶囊本身就有关闭键。

`tools/check-design-port.mjs` 随之更新：Token **名字**必须仍然齐全且没有自造，
暗色 **值**则断言必须是 `#181818` + 白色强调色；纯白不再是禁用字面量
（主软件的次要文字层本身就是白 alpha）。

还有一条暗色专属的坑：主软件的暗色强调色是**纯白**，而设计基座的选中态是
`.seg button.on{background:var(--accent-fill); color:var(--on-accent)}` ——
两者一拼就是**白底白字**（截图里「跟随系统」那一格是一片空白）。
所以暗色下选中态改用「抬升底色 + 正文色」（`--surface-2` + `--text-primary`），
并加了断言防止再退回 `--accent-fill` 填充；浅色主题沿用基座（深底白字）本来就清楚。

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
- 输入区**没有上边框**：正文滚到底部时**从下往上逐渐淡掉**，到输入区上沿消失。
  这一块前前后后修了三轮，每一轮的教训都不一样：

  | 现象 | 原因 | 现在的做法 |
  |---|---|---|
  | 「模糊的下边界以下还露着文字」 | 带子高 3rem、里面的 `.blurpart` 只高 2rem，带子又整体悬在 composer 上方 → 最后 1rem 是「只有渐变、没有模糊」的区间，正文在那里还是清晰的 | 带子向下越出 composer 上沿 `--fade-overlap`（= 它的 `padding-top`），两者在同一条线上交接 |
  | 「模糊怎么变成这样了，不是原来那种从下往上渐变？」 | 那一轮把 `mask` 去掉、让模糊铺满整条带子，又用「透明→实色」的**渐变底**去补边界以下 —— **渐变底藏不住文字**（它只是盖了一层半透明色），于是文字在底下显示成一块糊糊的黑影 | 模糊用 `mask-image` 淡入（顶部不糊、往下才糊），半径从 8px 收到 5px；真正的「淡出」交回基座那条**颜色渐变** |
  | （同上） | 也让这一块**依赖了 `backdrop-filter`** —— 它只在同一个 backdrop root 内采样，无头 Chromium 里根本不生效，跨平台本来就时灵时不灵 | **渐变负责淡出、模糊只是润色**：模糊不生效时看到的仍然是一条干净的从下往上渐变 |
  | 「滚到底部，模型回复的最后一行被模糊遮住了」 | 反直觉但实测如此：**`padding-bottom` 不会把正文从带子里抬起来** —— 滚到底时内容下边界停在滚动区下边界，内边距只是它**下面**的空白，而带子永远盖住滚动区最下面那 `--fade-h`。只留一个 `--fade-h` 的结果恰好是「末行下沿落在带子最上沿」，字身还在带子里（无头量到末行 bottom 在 `band.top` **以下 17px**） | 内边距改成 `--fade-pad`（= `--fade-h × 1.6` ≈ 5.6rem，**必须大于** `--fade-h`）：末行落在带子上沿往上约 2.1rem，下面是一段干净的空白 |

  三个数字统一由 `--fade-h`（带子高度）、`--fade-overlap`（= 输入区 `padding-top` =
  磨砂带高度）、`--fade-pad`（消息区底部内边距）管理。`npm run preview -- long`
  会生成一个长正文页面并滚到底，专门给这条边截图 / 量尺寸用。
- **输入框固定 140px（约 6 行），按钮跟在它右下方**：就是最简单的一行 flex 布局
  （textarea 在左、四个按钮靠右并贴住输入框下沿），内容多了在框内滚动。
  「Enter 发送 · Shift+Enter 换行」那行提示**已按用户要求删除**，它占的高度并进输入区；
  忙时的语义（Enter 是排队还是引导）改由 composer 上方的状态行说明。

  ⚠️ **高度只能有一个来源，布局也别"做大"** —— 这两条都踩过，都留了断言：

  | 错误做法 | 后果 |
  |---|---|
  | `autoGrow` 与 `flex: 1 1 auto` 同时管高度 | `scrollHeight` 读到的是被撑开后的高度，再写回 height → 输入区一路涨到四五百像素 |
  | 把 composer 做成 `flex-direction: column` 把按钮推到窗口最底 | 按钮下面空出一大片 |

  现在：`fitComposerInput()` 用内联样式把高度钉成 140px（`.bare-input.comp` 与基座
  同特异性，写 CSS 会被源码顺序压掉），**没有** `autoGrow(chatInput)`、**没有** flex
  撑满、**没有** `flex-direction: column`，三条都有断言拦着。
- 输入框右侧的按钮：**项目文件夹**与**权限模式**（仅 Agent 模式显示）、**增强提示词**
  （`#i-spark`，走宿主的 `prompt/enhance`，write 级不弹确认框）、**发送/停止**键。
- **所有按钮一律无外框、无底色**，与设计里的 `.iconbtn`（设置按钮）行为一致：
  默认全透明，只在悬停时给一层 `surface-2`；主/危险动作改用**文字颜色**区分，不再靠色块。
- **空状态垂直居中**：`.center-block` 自带 `margin:auto`，但 `.msg-area` 是普通块级容器，
  只会水平居中，所以之前「开始对话」贴在顶部；现在空状态时把消息区变成居中 flex。
  ⚠️ 这个「居中 flex」必须**有消息时立刻摘掉**：`.msg-area.is-empty` 是
  `display:flex; flex-direction:row`，一旦漏摘，每条消息会变成一个**收缩到内容宽度**的
  flex 项并**并排**排开（实测 420px 的面板里第一条消息只有 42px 宽、时间线 166px 宽，
  横向还溢出到负坐标）。旧的 `addMessage()` 顺手摘过它，改成按 id 对齐渲染之后没人摘了 ——
  现在 `renderKeyed()` 在画第一条消息前先 `classList.remove("is-empty")`。
- **项目文件夹**（Agent 模式）：宿主目录里有整套 `project/list`、`project/get`、
  `project/set`、`project/clear`，都不弹确认框。插件拿不到原生目录选择器，
  所以**列出已保存的项目让你选**，而不是让你手打路径。
- **工具输出默认折叠**：工具消息常常是一大坨原始 JSON 或报错堆栈，只显示一行摘要
  （超过 160 字或 3 行就折叠），点开才看原文，原文自己滚（`max-height: 16rem`）。
- **渲染是增量的**：transcript 与快捷对话都走 `renderKeyed()`，**按消息 id 对齐** ——
  只有真正变了的那一行才重建 DOM。工具行因此可以「跑着出现」（`tool_start` 先落一行
  running、`tool_end` 再补结果），而滚动位置、折叠状态、正在播的动效都不会被重绘打断。
- **滚动不会被抢**：只有你本来就在底部时才自动跟到最新；往上翻之后轮询会**保留你的滚动位置**。
  消息区还固定 `overflow-x: hidden`：一条被压平的长 URL 或没有断点的命令原文都曾把整块
  内容推出左边界（时间线 `rect.x = -63`），看起来像「面板被裁了一刀」。
- **更多（☰）菜单**里有**权限模式**：跟随默认 / 每次询问 / 允许编辑 / 全自动，
  改的是当前会话的 `permissionMode`（`session/configure`，`dangerous`，**宿主会弹确认框**）。

### 处理过程：把「它做了什么」画出来

这是这一版的主要改动。以前工具调用只显示一行被压平的文本，**工具名、关键词、来源网址、
用时全部被丢掉**；现在每次提问的回答前面有一条可折叠的**时间线**（`docs/preview/transcript-dark.png`）：

```
▸ 已处理 9.2s 2 次搜索
  ▸ ✦ 思考过程（精简 · 共 96 字，展开看全文）
  ▸ ⌕ 联网搜索「刘备 去世时间 卒」  2 个来源
  ▸ ◎ 打开网页「先主传 章武三年」  1 个来源
    输入 4.0k · 输出 420
```

**外观与主窗口那一条「已处理 15s 2 个工具」一致**：没有外框、没有底色，只是一行灰字 +
若干可展开的步骤行，左侧是设计源包自己的 `#i-spark`。第一版做成了带边框和 `--surface`
底色的卡片，用户看到后明确要求改掉。

**它不会在答案出现后消失，默认是折叠的。** 折叠策略改过两次，两次都是用户报的：

| 报的现象 | 当时的原因 | 现在的做法 |
|---|---|---|
| 「思考过程和调用工具的那个消失了，要留着的呀」 | 原来「跑完就收起成一行」，连步骤行一起藏了 | 只要有过程就把**步骤行都列出来**，不再自动收起 |
| 「在模型输出正式回复后，思考过程和工具调用就消失了」（**快捷对话**） | 作答后 `clearLiveTrace()` 把实时那块收掉，再**只按 `res.trace` 重画** —— 而思考步骤不在 `res.trace` 里（那条只有搜索轮次），于是思考那几行凭空消失 | `agent.lastTurnSteps`（这一轮上报过的**全部**步骤）原样留进最终时间线，`res.trace` 只在后面补搜索轮次 |

现在的默认状态是**折叠**（用户要求「默认折叠，手动展开」）：标题一行 + 若干步骤行，
`▸` 点开看参数 / 结果 / 来源网址。仍在跑、且确实有内容可展开的那一步默认摊开
（此刻「它现在在干什么」是唯一想知道的事）。用户自己展开/收起过的行，之后的轮询会尊重。

几条从用户反馈里改出来的细节：

| 反馈 | 原因 | 做法 |
|---|---|---|
| 「思考里面为什么是『正在思考』，而不是思考内容」 | 时间线把 `thinking` 当摘要、把**阶段文案**当内容 —— 那句话是插件的进度提示，不是模型想过什么 | 有真实思考文本时，`label` 用内容摘要、展开后**直接是全文**；只有阶段文案时就用它当标题（那是阶段名，不是内容） |
| 「展开后前面又加一个『思考』，占位置」 | 明细里画了一个 `思考 │ …` 的两列网格 | 换成 `.trace-think`：**直接就是内容**，没有前缀标签，用 `pre-wrap` 保留模型自己的换行 |
| 「前面图标颜色改成灰色」 | `.trace-step.ok .si` 用了 `--success`，跑完一条整排绿勾，比正文还抢眼 | 压成与其它图标同一个灰（`--text-disabled`），只有出错那一行保留红色 |
| 「正式输出被强制截断」 | 宿主每 1.5s 落一次流式检查点，同一 id 的正文会**变长**；这一路的 `rebuildRow` 会在打字机还在跑时把正文换掉，而 `entry.textNode` 还指着**已经被替换掉的旧节点** —— 之后每帧都写进一个不在文档里的节点，正文永远停在被打断的那个字上 | 重建前先 `finishReveal(old)` 收尾，再整段渲染新的正文 |

**「正式输出被强制截断」这条有专门的回归工具**：`npm run preview -- typing`
会把同一条回答按 40 / 140 / 60% / 100% 四段依次喂进去（模拟流式检查点），
末段必须是完整正文。无头实测：`renderedLen=124`、结尾是「安葬：惠陵来源：维基百科、百度百科、史志信息网。」。

耗时低于 5ms 的不显示 —— 那只是 `Date.now()` 的分辨率，不是「耗时」。
正在跑的那一行的加载动效**不会被重画打断**：动画节点是复用的，不是每次新建。

数据**全部来自宿主 `session/get` 已经落盘的字段**，一条都不用猜（`sessions.rs` 的
`MessageRecord` → `record_to_ui` 已把它们往返）：

| 显示 | 字段 |
|---|---|
| 标题里的「已处理 9.2s」 | `responseDurationMs`（每个助手轮求和） |
| 「思考过程」 | `thinking` |
| 工具行（名字 / 参数 / 结果 / 状态 / 用时） | `toolName` / `toolArgs` / `toolResult` / `toolStatus` / `toolDurationMs` |
| 搜索关键词与来源网址 | `hostedSearch.rounds[].{query,url,sources[].url}`（**厂商托管搜索**） |
| 快捷对话的搜索轨迹 | 插件自己上报的 `progress.steps`（它没有 transcript） |
| 底部的输入/输出 token | `usage.{inputTokens,outputTokens,reasoningTokens}` |

两种模式走**同一条渲染路径**，差别只在数据来源：Agent 模式读 transcript 的工具行，
快捷对话读插件上报的实时步骤。`toolArgs`/`toolResult` 里没有公开契约，所以网址是按
「是不是 http(s) URL」递归捞的，不是按字段名猜的。

### 加载动效与图标形变

- 状态行与时间线里正在跑的那一行用的是**曲线粒子加载器**（`docs/vendor/curve-loader.js`，
  移植自 [Paidax01/math-curve-loaders](https://github.com/Paidax01/math-curve-loaders)）：
  7 瓣玫瑰线 + 64 个拖尾粒子，4.6s 一圈、4.2s 呼吸、28s 自转。设计基座原来的
  `.statusline .spin` 是 **0.8s 转一圈**的圆环，用户反馈「太快了」—— 换成这套节奏。

  ⚠️ **它必须无条件画出来。** 之前写成「`prefers-reduced-motion` 就不装」，而
  `prefers-reduced-motion: reduce` 只该关掉**动画**，不该让一个**状态指示器整个消失**
  （用户看到的就是「没加载动效」）。现在照样建 SVG、画出静止那一帧（`PiCurve.create(box,
  { animate: false })`），只是不跑 rAF。`tools/check-vendor-effects.mjs` 里有一条专门断言
  「`animate:false` 仍然画出 SVG 与轨迹，但不再重画」。
  morphicons 那边同理：`reducedMotion: "user"` 是「直接到位」，不是不渲染。
- **发送键 ↔ 停止键是形变**而不是换图标（`docs/vendor/morphicons.js`）：纸张路径按弹簧
  物理插值成方块，中途的几何是实时算出来的。morphicons 要求**描边**几何（`fill:none` +
  `stroke`、统一 24×24 网格），而设计源包的 22 个图标都是填充型，所以这两个图标是照原型
  轮廓手写的描边版本；它**不会**替你拒绝填充几何（只是变形结果不对），所以
  `tools/check-vendor-effects.mjs` 里专门有一条断言守住「模板从不把填充图标交进去」。
  动效装不上时**保留原来的 `<use>` 图标**：装饰不该让一个操作入口变成空白按钮。

## 工具：`current_time` 与 `web_search`

宿主给插件的 `agent.complete` 是 `tools: []` —— **没有函数调用**。所以工具循环是**约定**做的：
模型输出一行 JSON 申请工具，插件执行，把结果当成一条 user 消息回灌。两个工具：

| 工具 | 什么时候可用 | 是什么 |
|---|---|---|
| `current_time` | **始终可用**（不看角色的联网开关） | 本地读时钟 + 时区/UTC 偏移/星期，**不走网、不花钱** |
| `web_search` | 角色的「联网搜索」打开时 | 见下面「搜索」一节 |

### 为什么值得给一个「读时间」工具

模型不知道今天是几号。后果很具体：

- 问「深圳今天天气」→ 它照训练数据答，或者搜一个**过期的年份**；
- 「今年是哪一年」「明天是周几」「这周还剩几天」→ 只能猜。

给一次准确时间就够：相对日期（下周五、三天后）模型自己会算。所以提示词里明确写着
**回答任何与「今天 / 现在 / 最新 / 今年 / 这周」相关的问题之前先调用它**，
并要求搜索关键词里涉及年份时用真实年份。

几个实现上的取舍：

- **每轮只给一次**（`clockGiven`）：它是个常量，再问一次也是同样的答案，而每多问一次就是
  一次模型调用（宿主**每分钟只放 8 次**）。给过之后就从可用列表里摘掉。
- **不占搜索的轮次额度**：搜索由用户可调的 `maxToolRounds` 管；时钟有自己的
  `MAX_TOOL_CALLS`（6 次）当绝对上限。⚠️ 第一版把时钟闸门写成 `rounds >= maxRounds`，
  而**不开联网时 maxRounds 是 0** → `0 >= 0` 直接把这一支掐掉：角色越「干净」越用不了
  时间工具。smoke 里专门有一条「角色 tools:[] 也能读到时间」盯着这个。
- **时区靠量不靠猜**：用 `Intl.DateTimeFormat` 的 `timeZoneName: "shortOffset"` 反解偏移，
  夏令时会跟着对；拿不到时退回 `-getTimezoneOffset()` 自己算。
- **回灌的是「今天几号」而不是「现在几点」**：时间线那一行点开是完整时间戳，
  模型拿到的除了时间戳还有一句「相对日期自己推算，不必再调用本工具」。

时间线里它是一行 `当前时间：2026-10-06 周二`（`provider: "local"`），
`tools/smoke-chat.mjs` 用假时钟（`withFakeClock`）把它钉成确定性断言。

## 搜索（快捷对话的联网）

**三层，按顺序**：自填端点（有就只用它）→ DuckDuckGo → **Bing**。

### 自填端点：Tavily 这类必须用 POST

**「装了 tavily 还是搜不到」的直接原因在这里。** 老实现一律 `GET <endpoint>?q=…`，
而 `api.tavily.com/search` **只接受 POST** —— 实测：

```
GET  https://api.tavily.com/search            → 405 Method Not Allowed
POST https://api.tavily.com/search            → 401（key 无效）/ 200（正常）
```

405 被老实现归成 `HTTP_405` 且**没有任何说明**，看起来就和「没配一样」。
现在按端点识别提供方（host 是 `tavily.com`，或 key 形如 `tvly-…`），换成正确姿势：

| | Tavily | 其它（SearXNG 等） |
|---|---|---|
| 方法 | `POST` | `GET` |
| 路径 | 只写域名会自动补 `/search` | 原样，缺 `q=`/`query=` 就补上 |
| Key | `Authorization: Bearer <key>` | 同左 |
| 体 | `{query, max_results}` | — |

参考实现是 `tavily-python`：POST `https://api.tavily.com/search`、Bearer 头、
响应 `{results:[{title,url,content}]}` —— `mapCustomResults` 本来就能认这个形状。

Tavily 的两个特殊状态也直接告诉用户，而不是丢个 `HTTP_4xx`：

| 状态 | 说明 |
|---|---|
| 401 | API Key 不对或没填 |
| 405 | 这个端点不接受 GET（提示可能是只收 POST 的 API） |
| 432 | Tavily 用量已达上限 |
| 433 | Tavily 需要付费计划 |

设置页的「搜索」分区现在也写清了要填什么（`https://api.tavily.com`、key 形如 `tvly-…`）。

### 内置：DuckDuckGo 优先，Bing 兜底

**DuckDuckGo 在不少网络里根本连不上** —— 本机实测 `html` / `lite` / `api` 三个域名
**全部超时**，于是内置搜索整体失效，用户看到的就是「问了好几个问题都无法联网」。
Bing 在这里是通的（HTTP 200、10 条结果、解析稳定），所以拿它当免配置兜底。

**失败时必须说清是哪一步挂的。** 以前无论哪种失败都归成一个 `SEARCH_FAILED` 加一句
「没解析到结果」，而实际原因完全不同 —— 三种要做的事也不同：

| 失败 | 含义 | 用户该怎么办 |
|---|---|---|
| `duckduckgo 连不上（ETIMEDOUT/ENOTFOUND）` | 网络到不了那家 | 换端点 / 挂代理 |
| `duckduckgo 返回 HTTP 429/403` | 被限流或挡了 | 等一会儿 / 换端点 |
| `duckduckgo 的页面里没解析到结果` | 页面结构变了 | 报 issue（解析器要更新） |

每次尝试的原因都记进 `trace[].failures`，并拼进 `message`；时间线里那一行点开
「结果」就是这几条。`tools/smoke-chat.mjs` 覆盖了「Tavily POST」「DDG 两次失败 → Bing 成功」
「三家全挂」「自填端点 405/401/432 各自的说明」几条路径。manifest 的 `net.domains`
里加了 `www.bing.com`（自填端点靠 `net.anyHost`）。

> Bing 是**抓页面**、不是承诺过的 API，解析器只依赖 `li.b_algo` 里的 `<h2><a>` 与 `<p>`；
> 结构一变就会走上面第三行那条「没解析到结果」，然后退到用户自填的端点。

### 为什么不走 `pi.browser` / agent-reach

查过宿主源码，`pi.browser` 是**可用**的（`plugin-runtime.ts:5647`，整个命名空间：
`navigate / snapshot / click / fill / evaluate / screenshot / console / cdp`），
权限是 `browser.cdp`，而且它还提供了 **`evaluate`** —— 也就是说确实可以在页面上下文里
取搜索结果，绕开抓 HTML 的脆弱性。但作为**搜索后端**有三个硬伤：

1. **它是有界面的浏览器**。面板形态下这是同一个应用的 Browser 面板，搜一次就会把用户的
   Browser 面板导航走、并抢一次可见布局；`browserContext` 更是宿主在「Agent 工具调用期间」
   才注入的（和 `session/collaboration/*` 同一条规则），悬浮窗来源拿到的是一条独立的
   session/tab。
2. **要新权限 + 重载**：`browser.cdp` 不在当前 manifest 里，加权限必须**重新加载插件目录**
   （热重载不覆盖权限变更）。
3. **慢**：navigate + wait + snapshot 一次几秒，而快捷对话是「先搜索再答」的同步链路。

另外它并没有解决**额度**问题（Tavily 的 432/433 是账号层面的），只是换了一条取页面的路。
所以这一版没做；要做的话它更适合当**「打开这个链接看看」的兜底**，而不是搜索后端。
`agent-reach` 是本机 CLI 形态的技能（走它自己的后端 + 凭证），插件进程调不到，
也不该替用户去读那些凭证。

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
| 上下文用量（占了多少窗口） | ❌ | `session/get` 与 `agent/getStatus` 的返回没有公开契约；**单轮** token 用量已经能看到（`usage` 字段），但「上下文还剩多少」没有稳定字段，不猜 |
| **逐字流式输出** | ❌（见下节） | 插件侧没有任何增量通道 |

**已经看到的部分**：工具时间线（调用 / 参数 / 结果 / 退出码 / 用时）与厂商托管搜索的
关键词和来源网址 —— 见上面「处理过程」一节。**增强提示词已做**（`prompt/enhance`，`write` 级），
**权限模式已做**（`session/configure` 的 `permissionMode`）。这两条证据明确，所以做了。
- 流式期间输入框上方出现**实时状态行**：`正在思考…` / `正在搜索「…」…（第 2 轮）` /
  `正在调用工具…`。快捷对话的相位由插件上报（窗口轮询），Agent 模式取自会话消息的真实 `status`。
  ⚠️ 这一行必须**压住**底部雾化过渡带：带子为了盖住滚到底的正文会向下越出 composer 上沿
  （`--fade-overlap`），而越出的那一段正好是状态行所在的位置 —— 结果「正在思考…」被
  自己的渐变色压暗、看起来像被糊掉了。所以它 `position: relative; z-index: 4`（带子是 2）
  并且**自带实底** `var(--bg)`：抬上去但不给底，带子的渐变色照样透上来。

### 关于「流式」：哪些是真的，哪些不是

**回答文本的逐字显示是表现层效果，不是流式传输。** 这一点必须写清楚，因为它决定了
「为什么答案总是先完整出现、再一个字一个字铺开」。

插件侧**没有任何增量通道**，三条路都查过：

| 路 | 为什么不行 |
|---|---|
| `agent.complete`（快捷对话） | 入参只有 `modelKey/system/messages`，返回一次性 `text`；没有回调、没有 `stream` 选项（`PluginCompleteInput`，`plugin-sdk`） |
| `session/get`（Agent 模式） | 读的是落盘 transcript，而**正在生成**的回复只写在 `<session>.inflight.json` 检查点里 —— host-core 的 `read_transcript_window_with_layout` 只读 transcript 文件，`get_session_with_options` 也不合并 inflight |
| 事件 | `plugins.broadcastEvent` 的全集只有四个（`appearance:changed` / `session:modelChanged` / `session:turnEnded` / `workspace:changed`），没有逐字事件；宿主内部的 `message_update` 只发给渲染进程的 store |

所以界面实际做的是：

- **过程是真的边跑边出现**：宿主把 `tool_start` 落成一行 running、`tool_end` 再补结果，
  所以工具行会**逐条**冒出来；Agent 模式的轮询在轮次运行中从 1.5s 加快到 **0.6s**
  （停下来就退回 1.5s，不白烧 CPU）。快捷对话每 400ms 读插件上报的 `progress.steps`。
- **回答文本**在宿主给出完整答案之后才开始逐字显示：按固定时长铺开（`500ms–2.8s`，
  长回答封顶），同一轮只对**新增**的那条生效（打开历史会话不会把老回答重打一遍）。
  文本**不重排**：逐字只往文本节点末尾追加字符；打完之后才交给 Markdown 渲染器
  （逐字渲染 Markdown 会把 `**` 这类中间态画成字面量），打字的 DOM 在 `#msgArea`
  外，所以不影响滚动。

如果以后要接**真流式**，唯一可行的路是让用户在设置里填一个兼容 OpenAI 的
`base_url + key`，插件用 `net.fetch` / `pi.net.ws` 直连 SSE —— 那是新功能，不是这一版的修正。

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
| 角色预设 | 列表 + 内联编辑（名称 / System Prompt 多行，可用 `/技能名` 引用技能 / **当前时间**（始终可用，灰显）/ **联网搜索开关**）。新建与删除**立即落盘**，编辑用「保存角色」 |
| 快捷键 | 点按键框直接**录制**（Esc 取消），显示当前生效状态与冲突告警 |
| 外观 | 主题（**跟随主软件** / 深色 / 浅色 / 跟随系统）、字号（小 13px / **标准 15px** / 大 17px / 特大 19px）、整体透明度（100/95/90/80%） |
| 搜索 | 搜索轮次上限、自定义端点、API Key |
| 通用 | Agent 默认行为（新开 / 接续）、思考过程详略（只读，跟随主窗口）、快捷键状态 |

保存有成功 Toast 与失败横幅双反馈。这些设置与宿主插件设置页**是同一份数据**。

## 与主窗口保持一致

- **配色 / 主题**：默认「跟随主软件」。宿主有两条通道，两条都用上了：
  `pi.app.getAppearance()` 取一份快照（`{ theme, base, locale }`，见 SDK 的
  `PluginAppearance`），页面上的 `appearance:changed` 事件负责实时跟随 ——
  主软件切主题/换语言时插件立刻跟着变，不用重开窗口。
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

## 窗口形态：panel（呼出即可打字，不置顶）

```ts
resizable:   request.resizable ?? !widget,          // panel → 可缩放
alwaysOnTop: widget && request.alwaysOnTop === true, // 只有 widget 能置顶
transparent: widget,                                 // 只有 widget 透明
```

窗口标志是宿主**创建窗口时**按 manifest 定的、插件运行时改不了，所以「置顶」「透明」
「可缩放」「呼出即得焦点」四件事里，panel 与 widget 各拿一半：

| | panel（本插件） | widget |
|---|---|---|
| 呼出时拿到键盘焦点 | ✅ | ❌ 要先用鼠标点一下 |
| 可缩放 | ✅（`resizable` 默认 true） | ❌ |
| 置顶 | ❌ | ✅ |
| 透明 | ❌ | ✅ |

本插件选 **panel**：快捷键呼出的东西必须第一下就能打字。
（圆球 `local.summon-widget` 仍是 widget —— 它本来就不需要键盘输入。）

### 窗口大小只能改 manifest，设置页里改不了

当前 `ui.width: 420`、`ui.height: 660`。

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
npm test               # 假宿主跑真实 main.js（圆球 + 对话窗，含 transcript 富字段与实时时间线）
npm run test:vendor    # 第三方动效在假 DOM 上真的跑一遍（形变插值 / 曲线加载器）
npm run lint           # 界面内联脚本语法 + 叠加层 hidden 检查
npm run design         # 移植保真：Token 名齐全、无自造 Token（几何变量白名单）、暗色 = 主软件灰阶、拖拽带只占位一次、sprite、通道、离线、拖动根元素
npm run renderer:check # 产物是否与模板/设计基座一致
npm run check          # 真实 pi-plugin check
npm run verify         # 以上全部
```

三个排查用的工具（不做断言，只把事实打出来）：

```bash
npm run tokens        # 解析产物 CSS 的层叠，打印 #win 的最终盒模型 + 暗色实际生效的调色板
npm run preview       # 生成一个 420×660 + 46px 宿主拖拽带的离线预览页
                      #   node tools/preview-panel.mjs light       浅色
                      #   node tools/preview-panel.mjs set         设置态
                      #   node tools/preview-panel.mjs transcript  已完成的「处理过程」时间线
                      #   node tools/preview-panel.mjs turn        **边跑边出现**的那条路径
                      #   node tools/preview-panel.mjs quick       快捷对话（sendQuick + progress 轮询）
                      #   node tools/preview-panel.mjs typing      同一条回答分 4 段喂进来：查「正文被截断」
                      #   node tools/preview-panel.mjs long        长正文 + 自动滚到底：看/量底部雾化那条边
npm run layout        # 用真实浏览器引擎量：顶栏是否落在拖拽带里、6 个控件是否真的点得到（需要另开一个 headless 浏览器访问它打印的地址）
node tools/inspect-panel-layout.mjs <preview.html> [shot.png]
                      # 用系统 Edge 无头模式量预览页：盒模型、溢出节点、前几行的计算样式。
                      # 「面板被裁了一刀」那个 bug 就是它一眼指出来的（.msg-area 还挂着 is-empty）。
```

`turn` 是**回归用的那一个**：它按真实顺序把一轮拆成「本地气泡 → 思考 → 工具 running →
工具完成 → 回答」逐个喂进去，专门盯住两个已经踩过的坑 ——
**用户气泡重复一个**（宿主回来的 id 与本地占位不同）、**回答是个空占位**
（`makeAssistantContent` 在有 thinking 时不再画正文）。`docs/preview/turn-dark.png` 就是它。

> 无头浏览器不会绘制，`requestAnimationFrame` 可能一帧都不跑（本机实测 0 帧）。
> 所以打字机带一个看门狗：启动后 600ms 内一帧都没跑到就直接把整段填上，
> 而不是留一个永远空着的占位。**动画不能成为「内容是否显示」的唯一开关。**

> ⚠️ **预览页必须把第三方脚本一起带过去。** 产物里 `morphicons.js` + `curve-loader.js`
> 在 `<head>`，而预览只抽 `<body>` —— 漏掉它们时 `window.PiCurve` / `window.PiMorph`
> 都是 `undefined`，加载动效渲染成**一个空 span**：截图看上去「没有动效」，
> 和真的 bug 一模一样，白白排查了一轮。现在 `preview-panel.mjs` 把两段脚本都抽出来、
> 按文档顺序放回页面，并且有条自检（少于 2 段内联脚本就直接报错）。

`docs/preview/` 里的截图就是 `npm run preview` + 无头 Edge 的产物。

## 已知限制

1. **不置顶**（panel 形态的代价，见上；置顶只有 widget 能拿到，而 widget 呼出时不给焦点）。
2. **回答文本不是真流式**：宿主不给插件任何增量通道，所以逐字显示是表现层效果；
   **过程**（工具调用 / 搜索关键词 / 来源网址 / 用时）是真的边跑边出现。详见上面
   「关于「流式」」一节 —— 那里列了三条路各自为什么不行。
3. **transcript 富渲染仍有限**：文本气泡 + 时间线；没有 diff 视图、没有工具参数的分栏高亮。
4. **`session/get` 没有官方契约**，`normalizeTranscript()` 按 `UiMessage`/`SessionDetail`
   类型解析并保留了对 part 数组的兜底；显示不对改那一个函数即可。
   `toolArgs` / `toolResult` / `hostedSearch` 的形状同样没有契约，所以网址是按
   「是不是 http(s) URL」递归捞的，**不按字段名猜**。
5. **改已有会话的模型/思考深度会弹宿主原生确认框**（`session/configure` 是 `dangerous`）；
   新建会话不弹（档位直接进 `session/create`）。
6. **快捷对话拿不到思考文本**：`agent.complete` 只回 `text`，所以那边的思考过程只是
   插件自己的阶段行（「正在思考（第 2 轮）…」）+搜索轨迹，**不会伪造**模型的想法。
7. **快捷对话的「停止」是软停止**：`agent.complete` 的入参里没有 `AbortSignal`，
   那一次模型调用停不下来。界面只放弃这一轮（结果丢弃、不记历史），并**如实这么写**。
   Agent 模式是真的 `agent/abort`。
8. **圆球插件（`local.summon-widget`）没跟着改**：它仍然是 widget 形态、仍然用
   心跳时长推断可见性、manifest 里也仍然声明了 `default`（会和插件进程的注册撞成两个键）。
   它需要的是圆球而不是输入框，所以形态那条要单独判断；后两条是同一个缺陷，
   要改的话照 `main.js` 里 `panelOpen` 那段和 manifest 的 `globalShortcuts` 抄即可。
