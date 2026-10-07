# 鲸唤 Summon 0.22.0

快捷对话的读文件工具改叫 **`read`** —— 和 Agent 模式里宿主那个内置工具同名，
两个模式里同一个词，心智负担最小。

## 变更

| 之前 | 现在 |
|---|---|
| `{"tool":"read_file","path":"…"}` | `{"tool":"read","path":"…"}` |

**`read_file` 仍然能用**，它是别名（0.21.0 曾把它写进提示词，换名字不该让正在进行的一轮
对话突然失效）。两种写法解析到同一个工具，时间线里统一显示 `read`。

## 会不会和 Agent 模式的内置 read 打架

不会。宿主给插件工具加命名空间 —— `pluginToolName()` 会拼成
`plugin_local_summon-chat_read`，内置的 `read` 是另一个名字，模型看到的是两个不同的工具。

## 快捷对话现在有四个工具

| 工具 | 什么时候可用 | 是什么 |
|---|---|---|
| `current_time` | **始终可用** | 本地读时钟 + 时区/UTC 偏移/星期 |
| `read`（别名 `read_file`） | **始终可用** | 读工作区里的文本文件（代码 / md / json / 日志） |
| `read_image` | **始终可用** | 只回报路径 / 尺寸 / 格式，并说明模型看不到画面 |
| `web_search` | 角色的「联网搜索」打开时 | 联网搜索 |

`read` 一次最多 24000 字符，截断时会明确告诉模型「后面还有内容」；
越界由宿主报 `PERMISSION_DENIED`，错误原文回灌给模型，它必须如实说读不到。

## 安装

- `local.summon-chat-0.22.0.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
13b148f16d3b9714ed1f7741df07cdeeb52e90e71370722dd6bc63ac876fb15b  local.summon-chat-0.22.0.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

`npm run verify` 全绿，含一条「旧名字 `read_file` 照样执行」的断言。
