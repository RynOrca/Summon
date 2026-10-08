# 更新记录

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
