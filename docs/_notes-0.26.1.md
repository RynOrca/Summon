# 对话悬浮窗 Summon 0.26.1

> Summon Chat 0.26.1 — same plugin, with the reviewer's questions answered inside the package.

0.26.0 已进审核队列；这一版**只是把给人工评审的说明写进包内 manifest**，功能与 0.26.0 完全一致。

## 为什么要再发一版

控制台的审计对两个权限报 `MAN013`：

```
unknown permission requires host-policy review: keyboard.globalShortcut
unknown permission requires host-policy review: net.anyHost
```

原因不是包有问题，而是**审核服务没有跟上宿主 SDK 的权限词表**：

| | |
|---|---|
| 宿主 `PLUGIN_PERMISSIONS` 里确实有这两个权限 | ✅ |
| 已发布的 52 个插件里用过 `keyboard.globalShortcut` 的 | **0 个** |
| 已发布的 52 个插件里用过 `net.anyHost` 的 | **0 个** |

审核服务只认得「已发布插件用过的那 31 个权限名」，这两个它没见过，于是标成 unknown。
而它们对本插件都是**必需**的：前者就是「按 `Alt+Shift+C` 呼出」这件事本身，
后者是自填搜索端点（Tavily / SearXNG）。

既然进人工队列，就把评审要问的话直接写进 `manifest.safetyNotes`（宿主 schema 支持这个字段，
中英双语），不用再往返：

- 为什么需要系统级快捷键（产品本体；卸载即释放；被占用依次回落 `Alt+Shift+Q` / `Alt+Shift+J` / `F3`）；
- 为什么需要 `net.anyHost`（自填端点；留空时只访问 `manifest.net.domains` 里声明的域名）；
- 数据行为（无遥测、无账号、不存凭据；搜索词只发给搜索端点；插件绝不应答宿主授权弹窗）；
- 文件行为（工作区只读；附件写会话项目的 `.summon/uploads/`，磁盘名由插件生成）。

## 新增：打包自检

`PKG012`（文件名与包内身份不符）和 `MAN013` 都发生在**包**上，而「改 manifest」和「打包」
是两个独立步骤，容易悄悄漂移。所以加了 `tools/verify-package.mjs`：

```
npm run verify:package     # 或 npm run verify:release（pack + 自检）
```

它逐条比对**包内**与**源目录**，并复现控制台的两条硬要求：

```
PASS  包内 id 与源一致              PASS  description 非空
PASS  包内 version 与源一致         PASS  safetyNotes 非空（人工评审读的就是它）
PASS  文件名 == <id>-<version>.piplug  PASS  zh-CN safetyNotes 非空
PASS  包内权限与源一致              PASS  author 不是占位值
PASS  manifest.json 是 store-only    PASS  包内容 == 插件目录内容（不多不少）
```

## 安装

- `local.summon-chat-0.26.1.piplug` —— **上传时请用这个文件名**（控制台按
  `<id>-<version>.piplug` 校验，改短会报 `PKG012`）
- 手动安装：**插件页 → 溢出菜单 → 安装插件包**

SHA256：

```
443ab329ffb85b19ed890c0978e8d8bcc9a9ac1adc59202f12f2f60d05828a60  local.summon-chat-0.26.1.piplug
```

## 提审用的 source pin

| 字段 | 值 |
|---|---|
| `pluginId` | `local.summon-chat` |
| `repository` | `https://github.com/RynOrca/Summon` |
| `path` | `plugins/local.summon-chat` |
| `ref` | `refs/tags/chat-v0.26.1` |
| `version` | `0.26.1` |
| `assetUrl` | `https://github.com/RynOrca/Summon/releases/download/chat-v0.26.1/local.summon-chat-0.26.1.piplug` |
| `sha256` | `443ab329ffb85b19ed890c0978e8d8bcc9a9ac1adc59202f12f2f60d05828a60` |

`npm run verify` 与 `npm run verify:package` 全绿。
