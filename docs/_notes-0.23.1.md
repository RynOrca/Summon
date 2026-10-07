# 鲸唤 Summon 0.23.1

三处改动，都是你直接指出来的。

## 1. 输入区那两条线去掉了

按钮上方那条分隔线删了（你说丑），更早那条也一起去掉。按钮紧贴输入区，本来就够清楚。

![](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/quick-dark.png)

## 2. 快捷对话不再接受图片

粘贴或拖入图片会被**明确拒绝**：

> 快捷对话收不了图片 —— 换成 Agent 模式粘贴，那边的模型真的能看图。

拖入图片时光标也是「禁止」，而不是给一个 copy 光标、松手才弹提示 —— 一个点了没用的入口比没有更糟。
文本文件照常可以上传，`read` 工具会读。

### 为什么是拒绝，而不是「存下来让模型自己去找」

因为**这一层会把图丢掉**：

1. Agent 模式能看图，靠的是宿主 `Read` 工具返回的 `images` 数组被还原成**真的图片块**
   （`agent-runtime/src/runtime.test.ts:10846`）。
2. 快捷对话走 `pi.agent.complete` —— **裸补全**，请求里 `tools: []`，模型没有工具。
3. `pluginCompleteContext()` 把每条消息压成字符串（`plugin-agent-complete.ts:143`）：
   `const content = String(message.content ?? "").trim();` —— 这是插件消息**唯一**的入口，
   所以 `{type:"image"}` 块永远进不去。

我做的 `read` 是**我自己的文字代理**（模型输出一行 JSON、我读文件、结果当文字回灌），
所以「让模型自己去目录里找」落到的仍然是文字代理，不是真的图片块。

**要看图就用 Agent 模式。** 那边是真实的 agent 运行时，图片真的到得了模型。

## 安装

- `local.summon-chat-0.23.1.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
9a0739ffd638bbbd6e8cf588be7a233823c1064b4816d570aa6b0c9d2c76e0f0  local.summon-chat-0.23.1.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

`npm run verify` 全绿，另加三条渲染层断言盯着「只在非 Agent 模式拒绝」「两条路都拦」「拒绝时指路 Agent 模式」。
