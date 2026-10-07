# 鲸唤 Summon 0.23.0

输入区重新排了：**按钮和项目名在同一行，都在最底下。**

```
[附件条：缩略图 / 文件名]
输入框（整行宽）
图片提示（只有贴了图才出现）
──────────────────────────────
📁 项目名            🔑  ✨  ➤
```

## 为什么

- 原来四个按钮挤在输入框右边，**输入框的实际可用宽度少掉约一条按钮的份**；
- 「项目名一行、按钮另一行」看起来像两块无关的东西 —— 你圈出来的正是这个。

## 顺带删了一个重复入口

纯文件夹图标按钮**删掉了**：左下角那枚 chip 显示的就是当前项目、点它打开的是**同一个菜单**。
同一件事两个入口只会让人犹豫，所以只留 chip。

一行放不下时**先截断项目名**（鼠标悬停能看到完整路径），按钮不会被挤出去 ——
`flex: 0 1 auto; min-width: 0` 是这里的关键，默认的 `min-width: auto` 会让长项目名把按钮顶出面板。
实测 420px 面板下：chip `x=30..124`、三个按钮 `x=332..426`，全在面板内，同一水平线。

## 安装

- `local.summon-chat-0.23.0.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
5e226c851d726e999251aeed8068e0252d54db1cf68efb9b9f3d05cc5cedd211  local.summon-chat-0.23.0.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 界面

| Agent 模式（左下角项目名 + 右侧按钮） | 快捷对话（没有项目时只剩两个按钮） |
|---|---|
| ![Agent](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/transcript-dark.png) | ![快捷对话](https://raw.githubusercontent.com/RynOrca/Summon/main/docs/preview/quick-dark.png) |

`npm run verify` 全绿。
