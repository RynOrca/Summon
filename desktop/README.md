# Summon 独立桌面版（开发中）

Windows 上的 Tauri / WebView2 窗口。窗口内使用原对话悬浮窗的紧凑布局，消息、工具、思考行和深色配色适配自 PI-Desktop 0.16.1；Agent 使用同版依赖 `@earendil-works/pi-coding-agent@1.0.1`。独立版拥有自己的会话和模型配置目录，不读取或改写 PI-Desktop 用户数据。

## 构建

1. 安装 Rust stable、Node.js 22.19+ 和 Windows WebView2 Runtime。
2. 在 `desktop/agent` 运行 `npm ci`。
3. 在项目根目录运行 `powershell -File desktop/tools/package-portable.ps1 -Output "$env:USERPROFILE\\Downloads\\Summon-portable"`。如果当前环境不能从项目所在盘运行新 exe，先将 `CARGO_TARGET_DIR` 指向 C 盘临时目录再运行构建脚本。
4. 从输出文件夹中的 `Summon.exe` 启动。整个文件夹需要一起保留。2026-10-09 已验证能打开的交付目录是 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009`。

首次使用在顶部模型或设置入口输入提供商和 API Key，刷新模型后选择模型。左上角可新建对话、打开左侧历史；底部工作目录标签会打开 Windows 文件夹选择窗口。顶部角色入口可选择、编辑和新增角色，选中角色会开启新对话；自定义角色可在三秒内点两次删除。角色保存在 Summon 自己的数据目录，角色说明通过 Agent 系统提示词生效。内置「快捷对话」目前仍使用独立版的同一 Agent 后端，原插件的联网搜索工具尚未接入。Key 仅在当前 Agent 进程中保留，重启后需重新输入。会话存于系统分配的 Summon 应用数据目录；空会话直到发送首条消息才写入磁盘。读取类工具自动运行；`edit`、`write`、`bash`、`powershell` 每次都会在对话中等待允许或拒绝，等待五分钟、切换会话或停止生成都会自动拒绝。

窗口呼出快捷键依次尝试 `Alt+Shift+C`、`Alt+Shift+Q`、`Alt+Shift+J`、`F3`。调整位置、尺寸后隐藏或退出会写入 Tauri 窗口状态。用户已确认 C 盘便携包能显示窗口，窗口状态文件已写入位置与尺寸；快捷键和重启恢复仍待验收。

新版只保留一个 Summon 实例；再次双击会呼出已有窗口。更新便携包前，请通过旧版托盘菜单退出所有旧实例，再启动新版，以免旧进程继续占用快捷键。

2026-10-09 的单实例便携包位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-single-instance`；该包与上文首次成功打开的旧版分开放置。

悬浮窗界面版位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-floating-ui`；退出旧版后台实例后，从该文件夹启动 `Summon.exe` 查看新界面。

带左侧历史、文件夹选择和角色预设的新版位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-floating-ui-roles`；请运行此目录中的 `Summon.exe`。

如果通过 Windows SmartScreen 后仍无窗口，检查便携包文件夹里的 `startup.log`；若没有，再检查 `%TEMP%\\Summon-startup.log`。新版在 Tauri 启动失败时会弹出错误说明；请保留完整便携包文件夹，单独复制 `Summon.exe` 会缺少 Agent 运行文件。WebView2 的数据默认写入便携包的 `data/webview`，文件夹不可写时回退到系统临时目录。

PI-Desktop 来源与许可证见 [PI-DESKTOP-LICENSE](./PI-DESKTOP-LICENSE)。
