# summon-4-pi

给 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 做的插件集。本仓库只在本地开发，尚未建 GitHub 远程。

**当前状态**

| 插件 | 状态 |
|---|---|
| `local.summon-widget` | ✅ 悬浮圆球 + 系统级快捷键（`Alt+Shift+S`）。可拖动、可缩放、置顶 |
| `local.summon-chat` | ✅ **鲸唤 Summon** 对话悬浮窗（`Alt+Shift+C`，**常驻置顶**）：Agent 模式（真会话）+ 快捷对话（含联网搜索）、角色预设、Markdown、外观/字号/透明度 |

> **窗口形态的取舍**：宿主在**创建窗口时**按 manifest 决定窗口标志，且不给插件任何 window
> primitive，所以运行时改不了。`alwaysOnTop` 只对 `widget` 生效，而 widget 是透明无边框窗口
> （`resizable: request.resizable ?? !widget`）——**置顶与可靠缩放互斥**。
> 现在按你的选择取**置顶**（`shape: "widget"` + `"alwaysOnTop": true`），窗口不可缩放。
> 圆球插件不受影响，它仍然是可缩放的 panel。

## 界面设计来源

`local.summon-chat` 的界面按随包提供的设计系统 **「鲸唤 Summon 原型源码包 v1.4」** 实现：

- 源包位置：`鲸唤 Summon 原型源码包 v1.4/`（`design.md` 规范 + `index.html` 可交互原型）
- 复用范围：设计 Token（原型 `index.html:7–113`）、内联 SVG 图标 sprite（`115–161`）、
  通用组件与桌面窗口框架 CSS（`168–489`）、窗口结构（`684–840`）
- 精简后的规范：`docs/design-spec.md`

## 结论：没有现成插件

调研了插件中心全部 **31 个已发布插件**：**没有任何一个**声明 `keyboard.globalShortcut` 权限，
也没有悬浮窗类插件。唯一沾边的是 `io.github.catdford.color-picker`，它自己写着
「系统级快捷键会随后续版本加入」。但宿主能力已经齐全，所以这属于「有地基、无人盖房」。

详见 [`docs/plugin-plan.md`](docs/plugin-plan.md) §0。

## 仓库结构

```
summon-4-pi/
├── plugins/
│   ├── local.summon-widget/       ← 悬浮圆球（加载开发插件时选这一层）
│   └── local.summon-chat/         ← 鲸唤 Summon 对话悬浮窗（常驻置顶）
│       ├── renderer/index.html    ←   对话窗口（按设计系统实现）
│       └── views/roles.html       ←   角色编辑器（工作面板视图）
├── 鲸唤 Summon 原型源码包 v1.4/   ← 设计系统与可交互原型（设计来源）
├── tools/
│   ├── smoke-test.mjs             ← 圆球：假宿主跑真实 main.js（54 项断言）
│   ├── smoke-chat.mjs             ← 对话窗：假宿主跑真实 main.js（265 项断言）
│   ├── lint-html-scripts.mjs      ← 界面内联脚本语法 + 叠加层 hidden 检查
│   ├── export-design-base.mjs     ← 从设计源包导出 Token/组件 CSS + 图标 sprite（剔除文档页规则）
│   ├── build-renderer.mjs         ← 拼装 renderer/index.html（--check 校验产物是否过期）
│   ├── check-design-port.mjs      ← 移植保真：Token 覆盖、无自造 Token、sprite、bridge 通道、离线、拖动根元素
│   ├── validate-manifest.mjs      ← 用 PI-Desktop 真实 SDK 校验 manifest
│   ├── check-plugin.mjs           ← 跑真实的 pi-plugin check
│   ├── pack-plugin.mjs            ← 跑真实的 pi-plugin pack，产出 .piplug
│   ├── verify-artifact.mjs        ← 确认是 store-only ZIP（防普通 zip 重打）
│   └── ts-js-resolver.mjs         ← 让 Node 直接跑 devkit 的 TS 源码
├── dist/                          ← 打包产物（.gitignore）
├── docs/
│   ├── plugin-plan.md             ← 圆球计划（Phase 0–5）
│   ├── chat-widget-architecture.md ← 对话窗架构、证据出处、硬限制、阶段表
│   └── api-findings.md            ← Host API 定点调研（Q1–Q5）
└── README.md
```

采用官方插件市场的 `plugins/<id>/` 布局，这样 `docs/` 和 `tools/` 不会被卷进 `.piplug`。

## 两个插件为什么要分开

宿主**不给插件任何 window primitive**（ADR 0081/0092/0093 反复写明 `pluginBridge`
"does not gain window primitives"），窗口的形状和尺寸只能写死在 manifest 里，
运行时改不了。所以「圆球 / 对话窗」只能是两个插件，而不是一个插件里的一个开关。

两个插件的默认快捷键刻意错开（`Alt+Shift+S` / `Alt+Shift+C`），可以同时装。

## 快速开始

```bash
npm test        # 两个插件的 smoke test（258 项断言，假宿主跑真实 main.js）
npm run lint    # 界面内联脚本语法检查
npm run check   # 两个插件都跑真实的 pi-plugin check
npm run pack    # 产出两个 .piplug 到 dist/
npm run verify  # test + lint + check
```

单插件：`npm run test:chat`、`npm run check:chat` 等。

在 PI-Desktop 里：插件页 → 溢出菜单 → **加载开发插件** → 选 `plugins/<id>`。

> ⚠️ 加了新权限后**必须重新加载目录**，热重载不覆盖权限变更。

## 路线 B（仓库 CLI）—— 已达成，且绕开了 `pnpm install`

`packages/plugin-devkit/src/check.ts` 与 `pack.ts` 的整个依赖图只有 Node 内置模块
加上同仓的 `packages/plugin-sdk` 源码，SDK 本身没有运行时依赖。于是
`tools/ts-js-resolver.mjs` 做两件事就够了：

1. TS 源码写 `./walk.js` 而磁盘上是 `walk.ts` → 解析失败时回退到 `.ts`
2. `@pi-desktop/plugin-sdk` 这个 workspace 裸名 → 映射到 `packages/plugin-sdk/src/index.ts`

结果是**真实的** `check()` / `pack()` 逻辑直接跑起来了，省掉了几 GB 的 `node_modules`。

源码检出：`D:\Code\Working-on-it\PI-Desktop-src`（`git clone --depth 1` 自 gitcode 镜像）。
可用 `PI_DESKTOP_SRC` 环境变量覆盖。

## 环境上的两个坑（本机特有）

1. **`hosts` 把 GitHub 全解析到 `127.0.0.1`**（`github.com` / `raw.githubusercontent.com` /
   `api.github.com` 等）。`git clone`、`gh`、`web_fetch` 全部到不了 GitHub。可用镜像：
   - 原始文件：`https://ghfast.top/https://raw.githubusercontent.com/<owner>/<repo>/main/<path>`
   - 备用 CDN：`https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<path>`
   - 仓库镜像（可 `git clone`）：`https://gitcode.com/GitHub_Trending/pid/PI-Desktop.git`
2. **沙箱内 shell 完全没有 TLS**：TCP 能连上 443，但握手一律
   `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。
   沙箱外一切正常。任何需要联网的命令都要在**完全权限**下跑。
