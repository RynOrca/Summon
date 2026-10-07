# 鲸唤 Summon 0.25.0

**悬浮窗里贴的图，Agent 现在真的看得见了。**

## 为什么会不一样

你那两张截图把事情说清楚了：主窗口能看到图，悬浮窗只给了模型**一个路径** ——
而文字不会变成像素。模型那句「我拿到的只是文件路径，读出来是二进制」是**诚实的**，
不是它不会。

但插件还有另一条路，而且我查证过它确实通：

- 宿主把**插件工具**交给真实 agent 会话（`session-launch.ts:649` 的 `pluginTools`）；
- **工具结果里的 image 块会被还原成真正的内容块**（`runtime.ts:1561-1575`，注释原文
  *"Plugin tools may return a bare content-block array; restore its text and image blocks
  so a restart does not flatten them into JSON"*，issue #1360）。

这和主窗口贴图是**同一个机制**（宿主 Read 工具返回 `images` 数组 → `toolResultFromUi`
还原成 image 块，issue #1073）。

## 这一版做了什么

`main.js` 注册了 **`show_image`** 工具：读图后返回

```js
[{ type: "text",  text: "图片 …(68 字节，image/png) 如下。" },
 { type: "image", data: "<纯 base64>", mimeType: "image/png" }]
```

模型调用它，就真的看见了那张图。

附件里带图片时，消息会**点名要求先调用它** —— 只给路径的话，模型很可能就着路径作答：

```
（附件：@.summon/uploads/upload-x1.png）
（图片不是文字，**先调用 show_image 工具把图显示出来**，再回答与图片有关的问题：
 show_image(path: ".summon/uploads/upload-x1.png")）
```

读不到时它返回一段**说明**而不是抛异常 ——「这个文件读不到」本身是模型该知道、
并且该如实转述的信息，不该让这一轮直接失败。

## 权限

新增 `agent.tool.register`（high risk，装的时候会请你确认）。同时**去掉**了
`clipboard.read` 和 `fs.write`：两者都没被用到（粘贴走浏览器的 `paste` 事件，
附件落盘走插件进程里的 `node:fs`），`pi-plugin check` 会报 unused 提示，留着不诚实。

## 安装

- `local.summon-chat-0.25.0.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
5d378e40589f16cb8419c1a39468669cc3d8861de20fe05d3c14a4495bac63e9  local.summon-chat-0.25.0.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 校验

`npm run verify` 全绿，含一组 `show_image` 的断言：注册成功、返回内容块数组、
第二块是 `image`、data 是**纯 base64**（没有 `data:` 前缀）、读不到时返回文字而不是抛异常。

> 一点需要知道的：这一步依赖**模型愿意调用工具**。消息里点名了，但弱模型可能仍只读路径。
> 失败时它会如实说读不到（而不是编造画面），这是踩坑时能看出来的信号。
