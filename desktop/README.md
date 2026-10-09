# Summon 独立桌面版（开发中）

Windows 上的 Tauri / WebView2 窗口。窗口内使用原对话悬浮窗的紧凑布局，消息、工具、思考行和深色配色适配自 PI-Desktop 0.16.1；Agent 使用同版依赖 `@earendil-works/pi-coding-agent@1.0.1`。独立版拥有自己的会话和模型配置目录，不读取或改写 PI-Desktop 用户数据。

## 构建

1. 安装 Rust stable、Node.js 22.19+ 和 Windows WebView2 Runtime。
2. 在 `desktop/agent` 运行 `npm ci`。
3. 在项目根目录运行 `powershell -File desktop/tools/package-portable.ps1 -Output "$env:USERPROFILE\\Downloads\\Summon-portable"`。如果当前环境不能从项目所在盘运行新 exe，先将 `CARGO_TARGET_DIR` 指向 C 盘临时目录再运行构建脚本。
4. 从输出文件夹中的 `Summon.exe` 启动。整个文件夹需要一起保留。2026-10-09 已验证能打开的交付目录是 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009`。

首次使用在顶部模型或设置入口配置模型。左上角可新建对话、打开左侧历史；底部工作目录标签会打开 Windows 文件夹选择窗口。顶部角色入口可选择、编辑和新增角色，选中角色会开启新对话；自定义角色可在三秒内点两次删除。角色保存在 Summon 自己的数据目录，角色说明通过 Agent 系统提示词生效。内置「快捷对话」目前仍使用独立版的同一 Agent 后端，原插件的联网搜索工具尚未接入。其他提供商的 Key 仅在当前 Agent 进程中保留；远程兼容模型的 Key 可加密保存。会话存于系统分配的 Summon 应用数据目录；空会话直到发送首条消息才写入磁盘。读取类工具自动运行；`edit`、`write`、`bash`、`powershell` 每次都会在对话中等待允许或拒绝，等待五分钟、切换会话或停止生成都会自动拒绝。

## 轻量版新增设置

当前验收包：`C:\Users\Orca\Downloads\Summon-lightweight-20261009-complete\Summon.exe`。请保留整个文件夹一起运行。

- 远程模型：在「模型设置」输入电脑 A 的 OpenAI 兼容 `Base URL`、`Model ID` 和 `API Key`，保存后自动选中该模型。兼容接口使用 `openai-completions`；服务器还需支持该协议及所选模型的工具调用。URL 和模型标识写入 Summon 独立的 `models.json`，Key 用 Windows 当前用户 DPAPI 加密保存，换 Windows 账号后需重新输入。
- 桌面：设置中可改全局快捷键，注册失败会提示占用；可打开或关闭开机自启。开机自启使用当前用户的 Windows Run 项，登录后隐藏在托盘，便携包移动后需再运行一次 Summon 才能更新路径。
- 记忆：顶部「记」打开 L1 学习者画像、L2 文本知识库和 L3 跨对话检索，三层各自可关闭。L1 可手工修改；L2 可粘贴或导入 TXT/Markdown，资料可编辑和两步删除；L3 从 Summon 自身最近的会话文件检索相关片段。每轮只放入少量匹配内容，不自动采集外部文件或更改 PI-Desktop 会话。当前不支持 PDF 入库和自动提取画像。

首次使用建议先在电脑 B 的浏览器确认电脑 A 的服务地址可达，再在 Summon 中配置同一地址。若服务需要特定的 OpenAI 兼容变体，当前界面尚不能切换协议类型。

模型设置可调整当前模型支持的思考深度。左侧历史可重命名当前会话，或复制当前会话中的用户与助手文字。

输入区左下角的「＋」可选择图片，也可直接粘贴或拖入图片。每次最多 8 张，单张最多 5 MB；支持 PNG、JPEG、WebP 和 GIF。图片作为结构化内容发送给支持图片输入的模型。

同一入口也支持普通文件。文件先复制到 Summon 独立数据目录下的当前会话附件文件夹，再把路径交给 Agent 的读取工具；当前每个文件最多 5 MB，每次图片和文件合计最多 8 个。会话附件目前不会自动清理，请勿将它当作临时文件保险箱。

窗口呼出快捷键依次尝试 `Alt+Shift+C`、`Alt+Shift+Q`、`Alt+Shift+J`、`F3`。调整位置、尺寸后隐藏或退出会写入 Tauri 窗口状态。用户已确认 C 盘便携包能显示窗口，窗口状态文件已写入位置与尺寸；快捷键和重启恢复仍待验收。

新版只保留一个 Summon 实例；再次双击会呼出已有窗口。更新便携包前，请通过旧版托盘菜单退出所有旧实例，再启动新版，以免旧进程继续占用快捷键。

2026-10-09 的单实例便携包位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-single-instance`；该包与上文首次成功打开的旧版分开放置。

悬浮窗界面版位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-floating-ui`；退出旧版后台实例后，从该文件夹启动 `Summon.exe` 查看新界面。

带左侧历史、文件夹选择和角色预设的新版位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-floating-ui-roles`；请运行此目录中的 `Summon.exe`。

包含思考深度、会话命名和复制对话的最新版位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-session-controls`。

带图片附件的最新版位于 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009-images`。

如果通过 Windows SmartScreen 后仍无窗口，检查便携包文件夹里的 `startup.log`；若没有，再检查 `%TEMP%\\Summon-startup.log`。新版在 Tauri 启动失败时会弹出错误说明；请保留完整便携包文件夹，单独复制 `Summon.exe` 会缺少 Agent 运行文件。WebView2 的数据默认写入便携包的 `data/webview`，文件夹不可写时回退到系统临时目录。

PI-Desktop 来源与许可证见 [PI-DESKTOP-LICENSE](./PI-DESKTOP-LICENSE)。
