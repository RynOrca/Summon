# 鲸唤 Summon 0.21.0

悬浮窗现在能收文件了：**粘贴 / 拖入图片、md、任何文件**，快捷对话也多了两个本地工具能读本机文件。

## 先说一条硬限制

**图片没法直接喂给模型。** 查证过：

- `pi.agent.complete` 的入参是纯文本（`messages: {role, content: string}[]`），**没有图片字段**；
- 宿主唯一的附件通道 `composer.attachments.add` 只作用于**主窗口**的 composer 草稿，
  悬浮窗是独立窗口，够不着那个 bridge。

所以哪怕换了支持图片的模型，插件也没有一条路把像素交过去。**但你要的效果还是能做**——
走宿主本来就支持的那条路：**把文件放进工作区，把路径写进消息**。
Agent 模式下由 Agent 自己的 `read` 工具去读，多模态识别在 Agent 那边完成，那边本来就能看图。

## 新增

- **粘贴 / 拖入文件**：输入框上方出现附件栏，图片给缩略图，其它给文件名 + 大小。
  发送时附件以 `@路径` 跟在正文后面（和主窗口 composer 的引用语法一致）。
  - 拖入：`pluginBridge.getDroppedFilePath` → `fs.registerDropped` → `fs.readRange` 取字节；
  - 粘贴截图：直接从 `paste` 事件的 `File` 读（它本来就没有路径）；
  - 落地：由插件进程写进工作区 `.summon/uploads/`。
- **快捷对话的 `read_file`**：读工作区里的文本文件（代码 / md / json / 日志），
  一次最多 24000 字符，截断时会明确告诉模型「后面还有内容」。**不需要联网**。
- **快捷对话的 `read_image`**：回报路径 / 尺寸 / 格式，并明确要求模型「不要编造画面内容」
  —— 接口给不了像素，就不该让它装作看见了。

## 需要知道的三件事

- 附件落盘的**写字节用的是插件进程里的 `node:fs`**，不是 `pi.fs`：宿主给插件的写接口只有
  `fs.writeText`（写死 UTF-8，写不了图片）。宿主自己的安全说明写明插件 main 跑在
  `utilityProcess` 里、带原生 Node 能力（宿主自带的 pi.file-manager 也这么做）。
  所以边界由插件自己守：**只写 `.summon/uploads/`，写到磁盘的文件名只保留扩展名**，
  其余自己生成 —— 页面的输入拼不出这个目录之外的路径。测试里有 `../../evil.sh` 与
  超限两条断言。
- `.summon/` 会出现在你的项目里（只在你发过附件之后），删掉它没有任何副作用。
- 新的 `fs.read` 权限只读工作区（`scope: ["**/*"]`），没有声明写权限。

## 参数

| | 上限 |
|---|---|
| 单个文件 | 24 MB |
| 一次附件数 | 8 个 |
| `read_file` 单次读取 | 24000 字符（超出会标注截断） |

## 安装

两个插件可以同时装。在 PI-Desktop 里：**插件页 → 溢出菜单 → 安装插件包**。

- `local.summon-chat-0.21.0.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
51751edeababb356cf827dccf0a0335f1f3688083fd9d696afbce70b6ed41c50  local.summon-chat-0.21.0.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 界面

![附件：图片缩略图 + 文件名](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/attach-dark.png)

## 校验

`npm run verify` 全绿。这一版新增的断言：`read_file` 读到内容并回灌给模型（角色不开联网也能用）、
截断时明确标注、越界读被 `PERMISSION_DENIED` 挡住、`read_image` 明确告知模型看不到图、
附件写进 `.summon/uploads/`、文件名不含原名（防路径穿越）、超过 24 MB 被拒。
