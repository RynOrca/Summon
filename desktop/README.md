# Summon 独立桌面版

轻量的 Windows 悬浮 Agent。Tauri / WebView2 承载界面，PI Agent SDK 运行对话与工具。Summon 使用独立的数据目录，不改写 PI-Desktop 用户数据。

## 当前版本

Git 版本：`summon-settings-agent-memory-2026-10-09`。
便携包：`C:\Users\Orca\Downloads\Summon-reworked-20261009`，运行其中的 `Summon.exe`。保留整个文件夹；更新前通过旧版托盘退出旧实例，再启动新版。再次启动同一应用会呼出已有窗口。

## 配置和使用

- **独立设置窗口**：顶部齿轮打开通用、模型、记忆、角色与关于。关闭设置不退出应用。
- **统一提供商配置**：模型页先选择提供商卡片或自定义，再填写名称、协议、Base URL 和 API Key。本地、电脑 A 与云服务使用同一流程；支持 OpenAI 及 Anthropic 兼容协议。无鉴权服务可留空 Key。Key 使用当前 Windows 用户的 DPAPI 加密保存，已有 Key 留空保留。
- **模型发现**：点击“获取模型与信息”会保存配置并请求 `/models`。服务返回的上下文长度与思考能力优先，已知提供商可补充 PI 模型目录。接口仅返回 ID 时显示未知；展开补充项填写 Model ID、上下文、思考能力和协议。Qwen 的 `chat_template_kwargs` / `enable_thinking` 变体支持二档开关。发现失败不会自动切换当前对话的模型。
- **聊天工具栏**：模型选择器支持搜索，紧邻的思考档位选择器只提供当前模型支持的选项。角色入口用于选择和快速管理；完整编辑也在设置中。
- **项目与历史**：左侧历史分为无项目会话及按文件夹分组的项目会话。新对话默认无项目，底部文件夹入口选择项目目录；打开历史会恢复会话与项目。空会话在发送消息后才落盘。支持当前会话改名和整段复制。
- **快捷键**：通用页点击快捷键按钮，直接按组合键录入；Esc 取消，失去焦点也取消。全局注册冲突会提示；保存后重启保留。首次默认依次尝试 Alt+Shift+C、Alt+Shift+Q、Alt+Shift+J、F3。
- **开机自启**：通用页开启后写入当前用户 Windows Run 项，登录时隐藏驻留托盘。便携包移动后再次运行应用会刷新路径。
- **窗口**：点击主窗内弹窗之外或按 Esc 关闭弹窗。滚动条隐藏，鼠标滚轮、触控板与键盘滚动仍可用。标题栏关闭后驻留托盘。

## Agent 记忆

由 Agent 整理，设置中查看结果、控制三层开关和两步删除；无需手填画像或知识笔记。在对话中可直接要求记住或纠正。

1. L1：明确的学习背景、目标与稳定偏好，精简后每轮注入。
2. L2：Agent 归档可复用知识笔记，以本地文本匹配检索。
3. L3：从 Summon 历史会话检索相关片段，保留会话来源。

Agent 可调用 `remember` 工具即时更新。回复结束 2.5 秒后，用当前模型后台整理最近对话；下一次提问、切换会话或关闭记忆会取消尚未完成的整理。后台整理失败不会阻塞回答，也不会部署向量数据库。原版手工画像和笔记会迁移保留。当前不能保证模型永远正确提取事实，可以在对话中纠正或在设置删除。

## 文件和工具

输入区“＋”支持图片和普通文件，支持粘贴和拖放，每次最多 8 个、每个最多 5 MB。图片作为结构化内容发给模型；普通文件复制到隔离会话附件目录后由 Agent 读取。附件不会自动清理。

读取工具可直接运行；edit、write、bash、powershell 每次会询问允许或拒绝，五分钟超时、停止或切换会话自动拒绝。Agent 的记忆更新不修改外部项目文件。

## 诊断

Agent 启动使用便携包内置 Node 和桥接模块，记录路径、stderr 和退出码。中断后最多自动尝试恢复三次，并恢复会话；已发送的用户任务不会自动重发。

日志：便携包目录 `startup.log`（不可写时 `%TEMP%/Summon-startup.log`），应用数据目录 `%APPDATA%/dev.rynorca.summon/agent.log`。启动失败会提供错误说明。模型请求失败也会在聊天中显示。

## 构建与验收

Node.js 22.19+、Rust stable、WebView2 Runtime。先在 desktop/agent 执行 npm ci，再运行 desktop/tools/package-portable.ps1。当前环境从 D 盘执行新 exe 会失败，因此 Cargo target 和桌面验收包使用 C 盘临时目录；构建脚本设置 stable 工具链。

隔离测试：`node --test --test-isolation=none desktop/agent/*.test.mjs`。
真实桌面验收脚本：desktop/tools/desktop-acceptance.cjs，需要设置 SUMMON_TEST_PACKAGE 和 SUMMON_PLAYWRIGHT_PATH。脚本只启动、终止自己的测试实例，使用 SUMMON_TEST_DATA_DIR 隔离数据、窗口状态和单实例锁，并通过测试用 WebView2 调试端口验证界面。正式启动没有调试端口。

本轮完整 PI 模拟 API 链路与真实桌面操作已验证：模型发现、流式回复、思考档位、Agent 记忆、项目分类、快捷键录入和 Agent 中断恢复。截图与报告在项目 dist/acceptance。电脑 A 的真实回复、实际速度和 Windows 重登自启尚未验收。

PI-Desktop 来源与 LGPL-3.0 许可证见 PI-DESKTOP-LICENSE。
