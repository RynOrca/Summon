# 鲸唤 Summon 0.20.0

Agent 模式的三处「看起来坏了」：项目文件夹选了没用、工具行显示一坨原始 JSON、顶上多一行开发提示。

## 修复

### 1. 选了项目文件夹但没用 —— 这是真的少了一步

`project/set` 改的是**宿主当前活动项目**（主窗口那一个），**它不会把悬浮窗这条会话绑过去**。
会话的工作目录由 `session` 自己的 `projectPath` 决定（`session-launch.ts` 用它定 cwd、
项目指令链与项目记忆）。而插件的建会话请求**从来没带 `projectPath`** ——
`session/create` 的 schema 里本来就有这一项。

两件事叠在一起：新会话落在宿主的默认项目下，界面上又没有任何地方显示当前项目是哪个，
所以「选了、也提示成功了，但没有任何变化」。

现在：

| 时机 | 做什么 |
|---|---|
| 选项目 | `project/set`（主窗口活动项目同步切换）+ `project/get` |
| 还没有会话 | 路径交给 `session/create` 的 `projectPath`，会话一出生就绑好 |
| 已有会话 | `session/moveProject` 挪过去（`write` 级、不弹确认框；只对空闲会话有效，跑着时如实提示「这一轮结束后再切」） |
| 显示 | 输入框**左下角**一枚 chip：`summon-4-pi`，悬停看完整路径，点一下换一个；只在 Agent 模式出现 |

chip 显示的是**会话实际绑定的那个**（读 `session/get`），不是本地意图 —— 以宿主为准。
选择会记进插件设置，下次呼出接着用。

### 2. 工具行是一坨截断的原始 JSON

Agent 模式的工具行以前把**结果原文**压成一行截断显示：

```
{"bytes":498,"header":["国庆快乐.md#1969"],"path":"国庆快乐.md",… （1287 字，点击展开）
```

前 120 个字里没有一个字有用，而且看起来像坏了。现在标题取**结构化结果里那一项有用的值**，
顺序是「具体值优先于『成功』」——`{ok:true}` 这类通用形状排在最后，否则会把退出码、
改动行数盖掉：

```
退出码 0 · +22 / -0 · 3 条 · 4096 字节 · D:\…\国庆快乐.md · 失败原因
```

原文整段收进可折叠的 `<pre>`，默认收起。

### 3. 顶上的「开发提示 · 顶部 46px 为拖拽区」

那行字是宿主 preload 画的，**只在 `pi-plugin-chrome=v2`（safe-area）且面板以开发模式加载时**
出现。本页已经在往这条带子里画自己的顶栏、也逐个控件标了 `data-pi-plugin-no-drag`，
所以声明 **v3（paint-through）** 才是它真正的形状：宿主把胶囊浮在页面上、由页面提供
拖拽/非拖拽区域，那行提示就不再画。

### 顺带修掉的一条竞态

宿主在一轮真正结束时广播 `session:turnEnded`。之前页面只在 `status === running` 时才跟着
轮询，而**最后一轮助手消息有可能在宿主把 status 翻成 idle 之后才落盘** —— 那样最后一段
输出永远不显示。现在收到这个事件就对当前会话补两次刷新（+250ms / +1500ms）。

## 安装

两个插件可以同时装。在 PI-Desktop 里：**插件页 → 溢出菜单 → 安装插件包**。

- `local.summon-chat-0.20.0.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
6403a0c6960262bb29cbdbc1552983f54d3e017de7b7ca93796e25013417ef19  local.summon-chat-0.20.0.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 界面

| 当前项目文件夹（Agent 模式，输入框左下角） | 工具行标题 + 原始输出折叠 |
|---|---|
| ![项目](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/transcript-dark.png) | ![快捷对话](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/quick-dark.png) |

## 校验

`npm run verify` 全绿。这一版新增的断言：`projectPath` 真的进了 `session/create`、
已有会话会走 `session/moveProject`（已在目标项目则不挪）、挪不动时消息照发、
`currentProject` 的「会话优先、待选兜底」两条来源。

> 上一版 0.19.0 的资产已经公开，所以这一版按新版本号发布，没有原地覆盖。
