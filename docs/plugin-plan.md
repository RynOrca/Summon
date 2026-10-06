# PI-Desktop 悬浮窗 + 快捷键呼出插件 —— 开发计划

> 目标插件：一个常驻悬浮窗（圆球 / 小面板），可用**系统级快捷键**在任何应用前台时呼出 / 隐藏。
> 依据：[plugin-development.md](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md) 及 `docs/spec/07-plugins/*`
> 本机宿主版本：**PI-Desktop 0.16.1**（`D:\Tools\Pi-Desktop`）

---

## 0. 调研结论（先回答「有没有现成的」）

**结论：没有现成插件。需要自己写。**

已核查的来源与结果：

| 来源 | 覆盖 | 结果 |
|---|---|---|
| 官方插件中心 `plugins.aiuo.net/catalog.json`；GitHub 镜像 `AIUO-Net/pi-desktop-plugins/catalog.json` | **31 个已发布插件**（两处 catalog 合并去重后的全部 id） | 无任何插件提供悬浮窗 |
| `vastsa/pi-desktop-plugins` 源码仓 + README 插件表 | 官方 / 社区 / 演示插件 | 无悬浮窗类插件 |
| 本机已安装插件 `~/.pi-desktop/plugins/registry.json` | 用户实际环境 | 仅 `pi.browser`、`pi.file-manager` 两个内置插件 |
| 对 31 个插件的 `permissions` 数组做关键词检索 | `globalShortcut` / `keyboard.` | **0 命中** —— 没有任何已发布插件申请系统级快捷键权限 |
| 对同一批 catalog 做 `悬浮` / `浮窗` / `widget` / `alwaysOnTop` / `置顶` 检索 | 全文 | 仅命中 `color-picker` 的"未来计划"，见下 |

> 说明：catalog.json **不包含** 各插件的 `ui` 配置块，所以「无人用 `shape: widget`」无法从 catalog 直接证明；
> 但 `permissions` 数组是完整的，因此「无人申请 `keyboard.globalShortcut`」是可靠结论。

关键佐证：catalog 中唯一提到系统级快捷键的是
`io.github.catdford.color-picker`，其更新日志原文写道：

> 「取色器里的『屏幕取色』与**系统级快捷键**会随后续版本加入。」

即：该能力在插件生态里**尚未有人实现**。

同时也确认了**宿主能力已经就绪**（见 §1），所以这属于「有地基、无人盖房」的空档。

---

## 1. 宿主能力盘点

### 1.1 悬浮窗（宿主原生支持）

`plugin-development.md` §5「Floating widgets」明确支持 `"ui": { "shape": "widget" }`：

- 透明、无边框窗口；**没有 46px 拖拽带**，`--pi-plugin-titlebar-height` 为 `0px`
- 空白区域拖动窗口；标准控件或标记 `data-pi-plugin-no-drag` 的元素保持可点击
- **右键**弹出宿主菜单：关闭 / 最小化 / 始终置顶
- `ui.width` / `ui.height` 生效，**最小 120×120**
- `ui.alwaysOnTop` 可让悬浮窗压在其他窗口之上（已在 0.16.1 二进制中确认读取 `manifest.ui.alwaysOnTop`）
- 页面可读 `document.documentElement.dataset.piPluginPanelShape`（`panel` | `widget` | `view`）

### 1.2 系统级快捷键（宿主已实现）

**注意：`plugin-development.md` §6.3 里「Global registration is not supported yet」只针对 `settings` 的 `shortcut` 字段**（那个确实只作用于聚焦窗口）。系统级快捷键是**另一条独立通路**，且已实现。

权限矩阵
（[13-plugin-permissions-matrix.md](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/13-plugin-permissions-matrix.md)）原文：

```
keyboard.globalShortcut | medium | pi.keyboard.registerGlobalShortcut,
unregisterGlobalShortcut, listGlobalShortcuts; contributes.globalShortcuts
| Confirm at install | Host owns Electron globalShortcut; a shortcut only runs
the plugin's own command; conflicts are refused (SHORTCUT_CONFLICT /
SHORTCUT_UNAVAILABLE / INVALID_ACCELERATOR / LIMIT_EXCEEDED, max 8 per plugin);
released on unload/disable/crash
```

清单契约
（[02-plugin-manifest-schema.md](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/02-plugin-manifest-schema.md)）：

```ts
/** One system-wide accelerator a plugin declares (`keyboard.globalShortcut`). */
type PluginGlobalShortcutContrib = {
  id: string;        // ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$，插件内唯一
  command: string;   // 必须在 contributes.commands 中声明
  default?: string;  // 加载后宿主自动注册；省略则由 pi.keyboard 稍后注册
};
```

命令式 API（从 0.16.1 的 `app.asar` 中确认存在）：

```js
pi.keyboard.registerGlobalShortcut(input)   // -> id
pi.keyboard.unregisterGlobalShortcut(id)
pi.keyboard.listGlobalShortcuts()
```

约束汇总：

- 权限 `keyboard.globalShortcut`（**medium**，安装时确认）
- 最多 **8 个**快捷键 / 插件；超限 `LIMIT_EXCEEDED`
- 只允许修饰键 + 键位的加速器语法（与 settings 的 `shortcut` 同语法）
- 冲突会被拒绝：`SHORTCUT_CONFLICT` / `SHORTCUT_UNAVAILABLE` / `INVALID_ACCELERATOR`
- **快捷键只能触发插件自己的命令**，不能直接开窗 → 必须走「命令」这一层
- 插件卸载 / 禁用 / 崩溃时自动释放

### 1.3 与「插件内快捷键」的区别（别选错）

| 方式 | 声明 | 生效范围 | 能否呼出未聚焦的窗口 |
|---|---|---|---|
| settings `type: "shortcut"` | `contributes.settings[]` | 仅 PI-Desktop 聚焦时 | ❌ 不能 |
| **系统级快捷键** | `contributes.globalShortcuts[]` 或 `pi.keyboard.*` | **全局** | ✅ 能 |

本插件必须用后者。

---

## 2. 方案设计

### 2.1 插件身份

```
id:      local.summon-widget        （私有插件用 local. 前缀；发布则用 com.<you>.summon-widget）
name:    悬浮窗呼出 / Summon
version: 0.1.0
engines: { "piDesktop": ">=0.16.0" }   ← 本机 0.16.1，widget + globalShortcut 均可用
```

### 2.2 交互流程

```
[系统级快捷键]  →  contributes.globalShortcuts.command
                        ↓
                 pi.commands.register 中的 run()
                        ↓
              toggle：未开 → pi.ui.openPanel() 显示悬浮窗
                      已开 → 通过 bridge 通道让面板自关 / 宿主 ui.closePanel
```

### 2.3 manifest.json 草案

```json
{
  "schemaVersion": 1,
  "id": "local.summon-widget",
  "name": "悬浮窗呼出",
  "version": "0.1.0",
  "description": "A floating orb you can summon from anywhere with a global hotkey.",
  "i18n": {
    "en": { "name": "Summon Widget", "description": "A floating orb you can summon from anywhere with a global hotkey." },
    "zh-CN": { "name": "悬浮窗呼出", "description": "用系统级快捷键在任何界面呼出 / 隐藏悬浮窗。" }
  },
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "shape": "widget",
    "width": 160,
    "height": 160,
    "alwaysOnTop": true,
    "title": { "en": "Summon", "zh-CN": "呼出" }
  },
  "contributes": {
    "commands": [
      { "id": "summon.toggle", "title": "Summon: Toggle Widget", "keywords": ["summon", "widget", "呼出"] },
      { "id": "summon.open",   "title": "Summon: Open Widget" },
      { "id": "summon.close",  "title": "Summon: Close Widget" }
    ],
    "globalShortcuts": [
      { "id": "toggle", "command": "summon.toggle", "default": "CommandOrControl+Shift+Space" }
    ],
    "settings": [
      {
        "key": "toggleShortcut",
        "title": "呼出快捷键",
        "type": "shortcut",
        "default": "CommandOrControl+Shift+Space",
        "command": "summon.toggle",
        "scope": "plugin"
      }
    ]
  },
  "permissions": ["ui.panel", "keyboard.globalShortcut", "notify"],
  "activationEvents": ["onCommand:summon.toggle", "onStartup"]
}
```

> `activationEvents` 加 `onStartup` 是为了让快捷键在「没有打开任何项目 / 窗口刚启动」时也能用。

### 2.4 main.js 草案（骨架）

```js
let isOpen = false;

async function open() {
  await pi.ui.openPanel({ title: "Summon" });   // 唯一参数就是 title
  isOpen = true;
}

async function close() {
  await pi.ui.closePanel();                     // 插件进程侧确实存在（api-findings Q2）
  isOpen = false;
}

async function onLoad() {
  await pi.commands.register({ id: "summon.open",  title: "Summon: Open Widget",  run: open });
  await pi.commands.register({ id: "summon.close", title: "Summon: Close Widget", run: close });
  await pi.commands.register({
    id: "summon.toggle",
    title: "Summon: Toggle Widget",
    run: async () => { isOpen ? await close() : await open(); },
  });

  // 通常不需要下面这一步：manifest 里 contributes.globalShortcuts[].default
  // 会在「对应的命令注册成功」之后由宿主自动注册（api-findings Q5）。
  // 只有「运行时换键」或「不写 default」时才需要命令式注册：
  const result = await pi.keyboard.registerGlobalShortcut({
    id: "toggle",
    accelerator: "CommandOrControl+Shift+Space",  // 注意字段名是 accelerator，不是 default
    command: "summon.toggle",                     // 必须已经注册过，否则抛 INVALID_ARGUMENT
  });
  // 失败是「返回」而不是「抛出」：
  if (!result.registered) {
    await pi.ui.notify({ message: "快捷键注册失败：" + result.error });
  }
}

// 面板关闭时上报，保持 isOpen 准确（见 §2.6）
async function onPanelInvoke(channel) {
  if (channel === "summon.closed") { isOpen = false; return { ok: true }; }
  return { ok: false, error: "UNKNOWN_CHANNEL" };
}

async function onUnload() {
  // 快捷键在 unload / 禁用 / 崩溃时由宿主自动释放，通常无需手动注销
  await pi.commands.unregister("summon.open");
  await pi.commands.unregister("summon.close");
  await pi.commands.unregister("summon.toggle");
  isOpen = false;
}

module.exports = { onLoad, onUnload, onPanelInvoke };
```

> **三处容易写错的地方**（都是 `docs/api-findings.md` 定下的）：
> 1. 命令式注册的字段是 **`accelerator`**，不是 manifest 里的 `default`
> 2. 注册失败**返回** `{ registered: false, error }`，**不抛异常** —— 用 `try/catch` 抓不到
> 3. `pi.ui.notify` 需要 `notify` 权限（所以 §2.3 的 permissions 里带了它）

### 2.5 renderer/index.html 要点

- 页面**背景必须透明**，只画自己的形状（`border-radius: 50%` + 自绘阴影），窗口才会"消失"在形状后面
- 不要加 46px 顶部内边距（widget 模式没有拖拽带）
- 可点击元素加 `data-pi-plugin-no-drag`，其余空白区域用于拖动
- 面板里**没有全局 `pi`**，只有 `window.pluginBridge`（`invoke` 通道）

```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>Summon</title>
    <style>
      html, body { margin: 0; height: 100%; background: transparent; }
      #orb {
        width: 120px; height: 120px; margin: 20px; border-radius: 50%;
        display: grid; place-items: center; cursor: pointer;
        background: radial-gradient(circle at 30% 30%, #6ea8ff, #1b3a6b);
        box-shadow: 0 8px 28px rgba(0,0,0,.45);
      }
    </style>
  </head>
  <body>
    <div id="orb" data-pi-plugin-no-drag>…</div>
    <script>
      document.getElementById("orb").addEventListener("click", async () => {
        await window.pluginBridge.invoke("ui.showToast", { message: "hi" });
      });
    </script>
  </body>
</html>
```

### 2.6 Toggle 设计（已由 [`api-findings.md`](api-findings.md) 定稿）

**已查清的事实：**

1. **`pi.ui.closePanel()` 在插件进程侧确实存在。**
   `03-plugin-api.md` §3 ui：`pi.ui.closePanel(): Promise<void>`（无参数、无 id）；
   §6.1 明确写着 *"A plugin may still close its own widget through `ui.closePanel()`."*
   → **toggle 不需要心跳/轮询**，插件进程可以直接开关自己的面板。

2. **没有「面板是否已打开」的查询 API。** 没有 `listPanels` / `isPanelOpen` / `getPanelState`。
   插件必须自己维护 `isOpen`。

3. **没有「插件 → 面板」的推送通道。** 唯一被文档化的方向是面板 → 插件
   （`pluginBridge.invoke(...)` → `onPanelInvoke(channel, payload)`）。真实内置插件也是这么用的：
   `pi.file-manager` 的 README 自己写道「宿主**只有一条**推给视图的通道（`view:open`）」，
   而那条是**宿主**发起的，不是插件发起的。

4. 用户通过**宿主窗口控件 / 右键菜单**关闭悬浮窗时，插件进程**收不到通知** →
   `isOpen` 会失真，表现为快捷键"按了没反应"。

**定稿设计（全部走公开 API，无轮询）：**

```
快捷键 → 命令 → 插件进程
   if (!isOpen)  await pi.ui.openPanel({ title })  ; isOpen = true
   else          await pi.ui.closePanel()          ; isOpen = false
```

**`isOpen` 失真的修法**——面板页在 `pagehide` 时主动上报（这覆盖了用户点关闭按钮 /
右键菜单关闭的情况，比心跳便宜得多）：

```js
// renderer/index.html（面板页）
window.addEventListener("pagehide", () => {
  window.pluginBridge.invoke("summon.closed", {});
});

// main.js（插件进程）
async function onPanelInvoke(channel) {
  if (channel === "summon.closed") { isOpen = false; return { ok: true }; }
}
```

**仍未文档化、需要实测的点：**

1. `pi.ui.openPanel()` 对已打开的同一面板是**聚焦复用**还是**再开一个**？
   spec 只是**暗示**单面板（`ui.panel` 只有一个 html 入口、`closePanel` 无 id、
   lifecycle §4 "Close panel" 用单数），**从未明说**。
   → 骨架里的 `isOpen` 守卫已经能兜住"再开一个"这个最坏情况。
2. `pi.ui.openPanel()` **只接受 `{ title }`** —— 没有 width / height / 位置 / alwaysOnTop 参数
   → 尺寸与置顶只能写在 `manifest.json` 的 `ui` 里。
3. 悬浮窗能否出现在鼠标位置 / 屏幕角落。

> 骨架 `plugins/local.summon-widget` 已经把这几点做成了**界面上可见的探测输出**：
> 加载后打开面板、点「重新探测 API」即可读数，不必翻日志。**不要凭猜。**

---

## 3. 目录结构

采用官方插件市场的 `plugins/<id>/` 布局，这样 `docs/` 与 `tools/` 不会被卷进 `.piplug` 包：

```
summon-4-pi/
├── plugins/local.summon-widget/     ← 插件本体（「加载开发插件」时选这一层）
│   ├── manifest.json
│   ├── main.js
│   ├── renderer/index.html
│   └── README.md
├── tools/
│   └── smoke-test.mjs               ← 用假宿主 pi 跑真实 main.js（21 项断言）
├── docs/
│   ├── plugin-plan.md               ← 本文件
│   └── api-findings.md              ← Host API 定点调研（Q1–Q5）
└── README.md
```

注意：`.piplug` 分发包必须包含**可直接执行的 JS/HTML/CSS**。宿主**不会**安装依赖或编译 TypeScript——用 TS 或第三方包必须先打包进插件目录。

---

## 4. 分阶段实施计划

### Phase 0 · 前置准备 ✅ 已选路线 B（本地，暂不建远程仓库；推迟到 Phase 5 执行）

> **当前决定：路线 B 推迟到真正要打包（Phase 5）时再做。**
> Phase 2 / 3 先用应用内的「加载开发插件」迭代——**不需要网络**，也不受下面这个 TLS 限制影响。

**关键约束：本机没有 PI-Desktop 源码检出，且官方 devkit（`@pi-desktop/plugin-devkit`）未随安装包分发**
（已确认 `app.asar.unpacked` 下无 `@pi-desktop` 包，`pi-plugin` CLI 不可用）。

**已选定路线 B（仓库 CLI），先在本地做，暂不建 GitHub 仓库。** 但实测发现一个硬阻塞：

> **沙箱内的 shell 完全没有 TLS。** TCP 能连上 443，但握手一律失败：
> `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。
> 实测**沙箱外一切正常**（`jsdelivr` 200、`registry.npmjs.org` 200、`git ls-remote` 成功）。
> 因此任何需要联网的命令（`git clone` 等）**必须把会话切到「完全权限 (full access)」**才能跑。
>
> **后续实测结论：`pnpm install` 其实不需要跑。** devkit 的 `check` / `pack`
> 依赖图只有 Node 内置模块 + 同仓 SDK 源码，直接用 Node 跑 TS 源码即可，
> 见 Phase 5 与 `tools/ts-js-resolver.mjs`。所以只需要一次 `git clone`。

路线 B 的具体命令（`gitcode` 镜像用来绕开本机 hosts 对 github.com 的封锁）：

```bash
git clone https://gitcode.com/GitHub_Trending/pid/PI-Desktop.git
cd PI-Desktop && pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin check  ../summon-4-pi/plugins/local.summon-widget
pnpm pi-plugin pack   ../summon-4-pi/plugins/local.summon-widget
```

环境：Node.js ≥ 22.19（本机 v24.15.0 ✅）、pnpm ≥ 10。

> 路线 A（应用内「加载开发插件」）**不需要**网络，所以骨架验证不必等路线 B。

### Phase 1 · 最小可运行骨架 ✅ 已完成

产物：`plugins/local.summon-widget/`（`manifest.json` + `main.js` + `renderer/index.html`），
外加 `tools/smoke-test.mjs`（用假宿主 `pi` 跑**真实** `main.js`，21 项断言全绿）。

骨架除了「命令能开面板」之外，还额外承担了探测职责——因为 §2.6 的两个问题官方文档是空白的：
面板打开后会自动调用 `summon.probe`，把宿主真实 API 渲染在界面上。

**验收**：`node tools/smoke-test.mjs` 全绿 ✅；在 PI-Desktop 里加载本目录、命令面板能搜到并打开面板 ⏳ 待你在应用内确认。

### Phase 2 · 改成悬浮窗 ✅ 已完成

1. manifest 的 `ui` 加 `"shape": "widget"`、`width/height`（最小 120）、`alwaysOnTop: true`
2. HTML 改透明背景 + 圆形形状，加 `border-radius: 50%` 与自绘阴影
3. 验证：空白处能拖动窗口；右键出宿主菜单（关闭/最小化/置顶）；可点元素不被拖拽吃掉

**验收**：窗口只剩一个圆球，背景完全透明；拖动、右键菜单、置顶均正常。

> ⚠️ 开发面板会有"46px 拖拽带"的提示 —— 那是 `panel` 形态的行为，切到 `widget` 后应消失；若没消失说明 `shape` 没生效。

### Phase 3 · 接通系统级快捷键（核心）✅ 已完成

1. manifest 加 `"keyboard.globalShortcut"` 权限 + `contributes.globalShortcuts`
2. **重点：加权限不会热重载生效** —— 宿主会停下热重载并要求重新加载目录以审核新授权
3. 在 main.js 里实现 toggle（见 §2.6，需先实测确认复用行为）
4. 处理冲突：捕获 `SHORTCUT_CONFLICT` / `INVALID_ACCELERATOR`，用 `pi.ui.showToast` 告知并回退
5. 验证：**把 PI-Desktop 最小化，在浏览器/编辑器里按快捷键，悬浮窗应出现**

**验收**：宿主机在前台但 PI-Desktop 未聚焦时，快捷键仍能呼出/隐藏悬浮窗。

### Phase 4 · 打磨

- 快捷键可在设置里改（`type: "shortcut"` 字段会生成控件）
- 记住悬浮窗位置（`pi.plugin.getDataPath()` + `fs.write`，需 `fs.write` 权限与 `manifest.fs` 范围）
- 加第二个快捷键（如"直接提问"），注意 8 个上限
- 失败降级：快捷键注册失败时保留命令面板路径可用
- 中英双语 `i18n`

### Phase 5 · 校验、打包、发布 ✅ 校验与打包已完成（且**无需 pnpm install**）

**已完成：**

- `npm run check` → 用**真实**的 devkit `check()`：**零 error、零 warning**
  （校验了 manifest schema、引用文件存在性、权限、路径包含、符号链接、包体积与文件数）
- `npm run pack` → `dist/local.summon-widget-0.2.0.piplug`
  （4 个文件 / 26220 字节 / store-only ZIP，SHA-256 `4ba4f5dc…`）
- `npm run validate` → 用真实 SDK 的 `validateManifest` 复核
- `npm test` → 47 项断言全绿

**关键发现：根本不需要 `pnpm install`。** devkit 的 `check.ts` / `pack.ts` 依赖图
只有 Node 内置模块 + 同仓的 `plugin-sdk` 源码，而 SDK 本身没有运行时依赖。
于是 `tools/ts-js-resolver.mjs` 只做两件事就让真实逻辑跑起来了：
`./walk.js` → `walk.ts` 的回退解析，以及 `@pi-desktop/plugin-sdk` → 源码路径的映射。
省掉了几 GB 的 `node_modules`。

**仍待你在应用内完成的验收：**

1. 装 `.piplug` 实测 → 禁用/启用 → 卸载，确认贡献点干净消失
2. 发布（可选）：插件中心 <https://plugins.aiuo.net>，需要「带 tag 的源码仓库 +
   绑定仓库 + 未发布过的版本号」；`pi.` / `demo.` 是保留命名空间

---

## 5. 风险与坑

| 风险 | 说明 | 对策 |
|---|---|---|
| **快捷键被占用** | 首选键可能与输入法/其他软件冲突 → 返回 `SHORTCUT_CONFLICT` | 默认选 `Alt+Shift+S`（宿主自己用 `Alt+Space` / `Alt+Shift+W`，所以这种写法已被证明可用）；代码内置备选链 `Alt+Shift+S → Alt+Shift+P → CommandOrControl+Shift+Space → F2`，自动降级并 toast；设置里可改 |
| **加权限后热重载失效** | 新增 `keyboard.globalShortcut` 不属于热重载范围 | 改完权限**重新加载目录**，否则一直 `PERMISSION_DENIED` |
| **toggle 语义不明** | `openPanel` 可能重复开窗 | Phase 3 先实测；用 `isOpen` 状态兜底 |
| **全局快捷键无宿主窗口时失效** | 无窗口时插件进程可能不在 | `activationEvents` 加 `onStartup`；必要时用 `contributes.services` + `background.service` 保持常驻 |
| **透明窗点击穿透/拖拽冲突** | 空白拖动 vs 控件点击 | 交互元素标 `data-pi-plugin-no-drag` |
| **没有 devkit** | 无法 `check`/`pack` | 走应用内开发插件路线；发布前再 clone 源码跑 devkit |
| **宿主版本** | 需要 ≥ 0.16.0 才有 widget + globalShortcut | `engines.piDesktop` 声明；README 写清 |
| macOS 辅助功能授权 | Electron `globalShortcut` 在 macOS 可能需要用户授权 | 在 README 中说明 |

---

## 6. 工作量估计

| 阶段 | 内容 | 预估 |
|---|---|---|
| Phase 0 | 前置 / 环境 | 0.5h |
| Phase 1 | 骨架 + 命令 + 面板 | 1h |
| Phase 2 | 悬浮窗化 | 1–2h |
| Phase 3 | 全局快捷键 + toggle | 2–4h（含实测确认） |
| Phase 4 | 打磨 | 2–3h |
| Phase 5 | 校验打包发布 | 1h |
| **合计** | | **约 1 个工作日** |

---

## 附：本机 GitHub 访问受限时的取证方法

本机 `hosts` 把 `github.com` / `raw.githubusercontent.com` / `api.github.com` 等解析到 `127.0.0.1`，
且沙箱内 shell 的 HTTPS 不可用（`schannel SEC_E_NO_CREDENTIALS`）。
可用镜像替代：

- 原始文件：`https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<path>`
- GitHub 代理：`https://ghfast.top/https://raw.githubusercontent.com/<owner>/<repo>/main/<path>`
- 目录树 JSON：`https://data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@main?structure=flat`
- 官方文档站：<https://pi-docs.aiuo.net>

## 附：参考链接

- [插件开发指南 plugin-development.md](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md)
- [清单 Schema](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/02-plugin-manifest-schema.md)
- [权限矩阵](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/13-plugin-permissions-matrix.md)
- [示例插件](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins)
- [插件市场源码仓 vastsa/pi-desktop-plugins](https://github.com/vastsa/pi-desktop-plugins)
- [插件中心](https://plugins.aiuo.net)
