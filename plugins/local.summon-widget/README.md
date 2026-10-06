# Summon Widget

PI-Desktop 悬浮窗 + 系统级快捷键插件。

- 插件 id：`local.summon-widget`
- 版本：0.2.0（Phase 2 + 3 已完成）
- 依赖：PI-Desktop **>= 0.16.0**（实测 0.16.1 / Electron 43.6.0）

一个透明、置顶的悬浮圆球，可用**系统级快捷键**在任何应用前台时呼出 / 隐藏。

## 加载 / 重新加载

**首次加载**：插件页 → 页头溢出菜单 → **加载开发插件** → 选 **本目录**
（`plugins/local.summon-widget`，即含 `manifest.json` 的那一层）。

> ⚠️ **本次更新加了新权限（`keyboard.globalShortcut`、`notify`），必须重新加载一次。**
> 新增权限**不会**热重载生效——宿主会停下热重载并要求重新加载目录以审核新授权。
> 之前加载过 0.1.0 的话，请先卸载/禁用，再重新加载本目录。

**之后**的改动会自动热重载（约 300ms 防抖），但**改权限**永远要重新加载。

## 用法

| 动作 | 结果 |
|---|---|
| `Alt+Shift+S`（默认，**全局**） | 呼出 / 隐藏悬浮圆球 |
| 点圆球 | 隐藏（可在设置里关掉这个行为） |
| 拖圆球以外的透明区域 | 移动窗口 |
| 右键圆球 | 宿主菜单：关闭 / 最小化 / 始终置顶 |
| 命令面板 `Ctrl+K` | `Summon: Toggle / Open / Close Widget`、`Summon: Shortcut Status` |

## 设置

设置 → 扩展 → 悬浮窗呼出：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `accelerator` | **shortcut（按键录制）** | `Alt+Shift+S` | 点一下按钮，然后直接按组合键即可录制。改完立刻生效 |
| `dismissOnClick` | boolean | `true` | 点圆球即隐藏；关掉后点圆球只弹一条快捷键提示 |

**为什么用 `shortcut` 类型？** 宿主的设置页对 `shortcut` 字段会渲染成**按键录制按钮**
（`PluginSettingsSheet.tsx` 里的 `plugins-shortcut-recorder`），而不是让你手打字符串。
这个类型自带的应用内绑定**只作用于聚焦窗口**，所以插件另外读它的值去调
`pi.keyboard.registerGlobalShortcut`，做真正的系统级注册。

**副作用要处理**：`shortcut` 字段**必然**在应用内也绑一个命令，于是 PI-Desktop 聚焦时
一次按键会到达两次（应用内 + 全局），不去抖就会互相抵消、表现为"按了没反应"。
代码里用 350ms 去抖吞掉重复的那次；额外好处是全局注册失败时，应用内那条路径还能兜底。

默认值选 `Alt+Shift+S` 是有理由的：宿主自己占用的是 `Alt+Space` 和 `Alt+Shift+W`，
所以「修饰键+修饰键+字母」这种写法**在你这台机器上被证明可用**。
快捷键的完整语法官方**没有文档**，所以代码里带了备选链
（`Alt+Shift+S` → `Alt+Shift+P` → `CommandOrControl+Shift+Space` → `F2`），
首选被占用时会自动退到下一个并弹提示。

## 两个设计要点（都是被宿主限制逼出来的）

宿主有两个已确认的事实（见 `../../docs/api-findings.md`）：

1. **`pi.ui.closePanel()` 在插件进程侧确实存在** → 开关自己的悬浮窗不需要任何轮询。
2. **没有任何「我的面板现在开着吗」的查询 API**，而且宿主自己也能打开这个面板
   （插件行上的按钮），插件命令看不到 → 单纯记一个 `isOpen` 布尔值会**失真**。
   Phase 1 的探测就抓到了这个：`pluginProcessIsOpenFlag` 是 `false`，但面板明明开着。

所以改用**心跳派生存活性**：圆球每 2 秒发一次 `summon.heartbeat`，插件用它判断
「窗口还在不在」（6 秒没心跳就认为关了）。这样无论窗口是被谁打开的、甚至页面被
硬杀掉没走 `pagehide`，快捷键都是对的。

## 本地校验（不需要 PI-Desktop，也不需要 pnpm install）

```bash
npm test        # 用假宿主 pi 跑真实 main.js —— 47 项断言
npm run check   # 跑 PI-Desktop 源码里真实的 pi-plugin check
npm run pack    # 跑真实的 pi-plugin pack，产出 .piplug
```

`check` / `pack` 直接以 TypeScript 源码运行 devkit（`tools/ts-js-resolver.mjs`
负责把 `.js` 说明符解析到 `.ts`，并把 `@pi-desktop/plugin-sdk` 映射到源码），
所以**不需要 `pnpm install`**。需要 PI-Desktop 源码检出，默认路径
`D:/Code/Working-on-it/PI-Desktop-src`，可用 `PI_DESKTOP_SRC` 覆盖。

当前产物：`dist/local.summon-widget-0.2.0.piplug`，4 个文件（`manifest.json`、`main.js`、
`renderer/index.html`、`README.md`），store-only ZIP。

> SHA-256 由 `npm run pack` 打印，这里**故意不写死**——因为本文件本身也在包里，
> 改一个字就会改哈希，写死必然过期。

## 文件

| 文件 | 作用 |
|---|---|
| `manifest.json` | `ui.shape: "widget"` + `alwaysOnTop` + `globalShortcuts` + 设置 |
| `main.js` | 命令、快捷键注册与回退、心跳存活性、`onPanelInvoke` 通道 |
| `renderer/index.html` | 透明圆形悬浮球（自绘形状 + 光晕，空白处可拖拽） |
