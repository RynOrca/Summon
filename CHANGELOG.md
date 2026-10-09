# 更新记录

## 2026-10-09 · Git 版本 `summon-portable-user-verified-2026-10-09`

- 用户确认 C 盘便携包已成功显示窗口；启动日志记录窗口创建和初始化完成，窗口状态文件已写入位置与尺寸。
- 将相同 exe 和完整运行文件复制到 `C:\\Users\\Orca\\Downloads\\Summon-portable-20261009`，交付目录不含测试日志和 WebView2 缓存；更新构建及验收说明。

## 2026-10-09 · Git 版本 `summon-webview-startup-diagnostics-2026-10-09`

- 将 Tauri 主窗口改为显式创建，给 WebView2 指定便携包内数据目录，并在目录不可写时回退到临时目录。
- 捕获 Tauri 初始化时的 panic；启动日志写在 exe 同目录，失败时显示具体错误，解决旧版静默退出且日志缺失的问题。
- 打包脚本支持指定 C 盘构建目录；当前环境 D 盘新复制的 exe 无法执行。C 盘测试版可进入程序，但 WebView2 在无图形测试环境中报 `0x8000FFFF`，真实桌面验收待完成。

## 2026-10-09 · Git 版本 `summon-startup-diagnostics-2026-10-09`

- 启动时写入 `%LOCALAPPDATA%\\Summon\\startup.log`，启动失败显示错误弹窗和日志位置，避免正式版静默退出。
- 托盘创建失败不再中断窗口启动，并在日志中记录；便携包加入 Agent 授权模块，修正缺文件导致的 Agent 启动失败。
- Rust 编译检查及正式版构建通过。当前执行环境中的程序启动被系统环节阻滞，窗口是否正常显示仍需在用户机器验证。

## 2026-10-08 · Git 版本 `summon-tool-approval-2026-10-08`

- 为 `edit`、`write`、`bash`、`powershell` 工具加入 PI Agent `tool_call` 授权拦截和界面允许/拒绝按钮。
- 授权请求五分钟超时，切换会话、停止生成或 Agent 退出时自动拒绝；读取类工具继续直接运行。
- 静态脚本检查、隔离 Agent 启动、无效授权请求拒绝和 Rust `cargo check` 通过。

## 2026-10-08 · Git 版本 `summon-session-management-2026-10-08`

- 增加新建会话、列出当前工作目录的历史会话和打开会话；在切换时恢复聊天记录。
- 以隔离的持久化测试会话验证列表、打开和历史消息恢复，不调用真实模型。

## 2026-10-08 · Git 版本 `summon-workspace-switch-2026-10-08`

- 在模型设置中增加工作目录输入；Agent 验证目录后按目录续接独立会话，只读工具在所选目录运行。
- 使用隔离测试会话验证有效目录切换和无效路径拒绝。

## 2026-10-08 · Git 版本 `summon-pi-ui-agent-2026-10-08`

- 将独立版占位页替换为按 PI-Desktop 0.16.1 消息、工具调用、思考过程与 Composer 结构适配的对话界面，加入安全 Markdown 渲染。
- 新增 PI Agent Node 桥接与 Tauri 事件通道，支持模型选择、临时 API Key、独立会话续接、流式回复和只读工具事件。
- 新增自带 Node 与 Agent 依赖的 Windows 便携包构建脚本，并附上 PI-Desktop 许可证。
- 将用户指定的 openhanako 巡检、长期记忆、联网搜索及助理/伴侣体验加入后续计划，安排在当前版本完成后研究与融合。
- 静态脚本检查、Rust 编译、Agent 初始化协议及便携包内置 Node 启动通过；当前环境 WebView2 仍返回系统错误 5，实际窗口和真实模型对话尚未验证。

## 2026-10-08 · Git 版本 `summon-desktop-shell-2026-10-08`

- 新增 Tauri 窗口工程骨架，配置窗口尺寸持久化、快捷键呼出、托盘入口与隐藏行为。
- 加入独立窗口的临时验证页面；后续界面按用户最新要求改为 PI-Desktop 对话组件与样式，Agent 接入仍待完成。
- Rust 类型编译和可执行程序构建成功；当前执行环境启动 WebView2 时返回 `os error 5`，窗口交互未完成验证。

## 2026-10-08 · Git 版本 `summon-desktop-plan-2026-10-08`

- 记录已确认的独立 Summon 桌面版计划：Tauri / WebView2 窗口、现有悬浮窗界面及 PI Agent 后端。
- 标出窗口、界面、Agent、打包四个验收阶段及当前环境调查结果。
