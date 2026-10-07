# 鲸唤 Summon 0.24.0

**Agent 模式跑在主窗口，但悬浮窗现在会说清楚它此刻在干什么。**

## 状态行不再是「正在思考…」

发送之后，输入框上方那行（带曲线加载动效）显示的是**具体动作**：

```
正在调用 tavily-search：刘备 去世时间 卒…
正在思考：先确认是不是需要联网。刘备的卒年有几个说法（223 vs 224），必须查证…
```

时间线里正在跑的那一步也在说「正在调用」：标签用主色、图标用强调色，不留白让人以为卡住。

## 需要授权时会指路

某个工具停留超过 20 秒且一行都没新增，状态行会说：

> 「Bash」还没有结果 —— 如果主窗口弹出了授权卡片，去那里点允许（悬浮窗看不到那张卡片）

**为什么不能直接在悬浮窗里授权**：插件事件目录里没有权限事件，也没有「列出待批请求」的操作
（`agent/askTool/resolve` 只能**回答**授权，没有清单就画不出卡片）。所以能做的是**第一时间
告诉你该去哪儿点**，而不是让它看起来卡死。

## 修掉的两个真 bug

1. **正在调用的工具被画成「已完成」**。`stepsFromMessages` 原来把工具状态写成
   「error/denied → error、其余 → success」，`running` 直接丢了。
2. **工具开始跑时，思考那一行被顶掉**。`traceStepKey` 对 `step.live` 一律返回 `"live"`，
   而一轮里有很多 live 步骤（思考、正在调用的工具…），它们撞在同一个键上互相覆盖。
   键现在带 kind / round / label。

## 为什么是 400ms 轮询而不是推送

宿主的插件事件全集只有四个（appearance / modelChanged / turnEnded / workspace），
**没有**轮次内的事件。实时性来自宿主**边跑边落盘**的那份 transcript：工具行在 tool_start
就以 `status: "running"` 落盘，tool_end 再补结果。所以轮次运行期间把轮询压到 400ms
（停下退回 1.5s），每次只是一个 `session/get`（read 级、不弹确认框）。

## 安装

- `local.summon-chat-0.24.0.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
8417b450123ee471a2f671d6b36f098d266919864f186e0425dc7bc5b0af1319  local.summon-chat-0.24.0.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 界面

![一轮进行中](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/turn-dark.png)

`npm run verify` 全绿。
