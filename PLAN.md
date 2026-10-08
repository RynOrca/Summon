# Summon 独立桌面版计划

状态：进行中。确认日期：2026-10-08。

## 目标

构建独立的 Windows 桌面程序。使用 Tauri / WebView2 承载窗口，复用 PI-Desktop 0.16.1 源码中的 Agent 运行核心和对话界面。不依赖已安装的 PI-Desktop 或插件市场。用户确认：窗口内消息、工具调用与思考过程均采用 PI-Desktop 的呈现方式，不沿用 Summon 插件的对话界面。

## 阶段与验收

1. **基础窗口**（源码完成、运行验证受阻）：独立程序提供全局快捷键呼出/隐藏、托盘入口；移动或调整窗口后保存边界，下次呼出和应用重启均恢复；多显示器变化后窗口仍可见。
2. **PI-Desktop 对话界面移植**（待完成）：使用 PI-Desktop 的 `ChatTranscript`、消息行、工具行、思考过程和 Composer 及其样式；为小窗口适配布局。保留来源与许可证信息。独立版使用新的 Tauri 桥接接口。
3. **Agent 接入**（待完成）：复用 PI-Desktop 的 Agent 运行依赖，具备独立的模型配置、会话持久化、消息发送与回复、工具授权和附件处理；不得直接共写 PI-Desktop 的用户数据。
4. **Windows 验收与打包**（待完成）：验证真实窗口、完整对话、快捷键冲突、位置尺寸恢复；生成可运行发行物，记录启动时间与内存占用。

## 实施原则

- 现有 `plugins/local.summon-chat` 保留，独立版放在新目录，避免覆盖可用插件。独立版对话界面以 PI-Desktop 源码为准。
- 每完成一个可验证成果，更新本文件与 `CHANGELOG.md`，再提交清晰的 Git commit。
- 不在真实会话数据上测试破坏性操作；删除类操作需要两步确认。
- 启动 Node.js 进程前，先确认同项目是否已有 Node.js 进程；若有则先询问用户是否关闭。
- 不把 PI-Desktop 安装目录当作开发目录；只从本机源码副本读取所需实现。

## 当前调查

- PI-Desktop 当前源码版本是 0.16.1；Agent 由 Node sidecar、宿主适配层及 Rust host-core 协作，不能只复制一个文件。
- PI-Desktop 的对话界面是 React/TypeScript，`ChatTranscript` 依赖消息状态、国际化和多项共享组件。应按依赖边界移植，不把插件的 `renderer.template.html` 当成独立版界面。
- 默认 Rust 1.91 工具链缺少 manifest；`stable` 1.98.1 可用，构建时使用 `cargo +stable`。本机没有 .NET SDK。
- Tauri Rust 依赖已获取，`cargo check` 与 `cargo build` 成功。当前执行环境中 Windows WebView2 初始化报 `os error 5`；禁用本应用的窗口状态、快捷键和托盘插件后仍相同，实际窗口交互尚未验证。
- 本轮未发现项目内的 `RTK.md`，以用户在对话中提供的规则为准。
