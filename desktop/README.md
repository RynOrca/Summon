# Summon 独立桌面版

轻量的 Windows 悬浮 Agent。Tauri / WebView2 承载界面，PI Agent SDK 运行对话与工具。Summon 使用独立的数据目录，不改写 PI-Desktop 用户数据。

## 当前版本

Git 版本：`summon-learning-desktop-2026-10-09`。
便携包：`C:\Users\Orca\Downloads\Summon-learning-20261009`，运行其中的 `Summon.exe`。保留整个文件夹；更新前通过旧版托盘退出旧实例，再启动新版。再次启动同一应用会呼出已有窗口。

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

## 学习能力与遥测

- **画像**：Agent 使用 `record_learning_event` 或后台整理记录目标、偏好、已学概念、误解和复习事件，必须保留本会话用户原话。来源和事件保存于 learner.json，启动时从事件重建画像。知识状态未经评估保持未知掌握程度，记录学习/复习后建议次日复习；在对话中要求纠正目标、偏好或误解即可更新。
- **技能仓库**：设置选择含 SKILL.md 的目录导入，目录副本存入 Summon 数据目录。可搜索、查看正文和开关；只启用的技能名称/说明进入提示词，Agent 需要时读取正文。目录上限 500 文件 / 10 MB；不跟随符号链接、不导入 node_modules 或 .git。
- **笔记库**：设置选择 Obsidian Vault，只索引 Markdown 原文件（排除 .obsidian/.git 和符号链接）。按标题、路径、标题段落及正文关键词检索，不要求向量模型；修改会在下次查询更新。相关提问自动召回，Agent 可继续使用 search_notes 检索，引用原文件链接及行号并提醒复习。上限 1 万文件 / 100 MB，单文件 1 MB。不在后台修改原笔记。
- **联网工具**：设置→工具填写 Tavily API Key 后启用 web_search / fetch_url，分别使用 basic 搜索/正文提取，返回来源网址；调用使用 Tavily 服务额度。Key 经 Windows DPAPI 保存。current_time 获取系统时区及 UTC。
- **浏览器和文件**：browser 首次使用才启动已安装 Edge 的独立无头配置，可导航、快照、截图、点击、填写，闲置 60 秒退出。点击/填写需确认；不访问用户现有浏览器配置。file_manage 只在当前项目列出目录、复制/移动普通文件，不覆盖目标，笔记库不可作为写入目标。已有 PI read/ls/find/grep/edit/write/bash/powershell 继续可用。
- **本地链接**：Markdown 表格和链接支持。生成 HTML 时 Agent 被要求提供绝对文件链接。点击本地链接在当前项目、Vault 或附件目录中解析，允许的文档类型由 Windows 默认应用打开；不执行链接中的命令，不渲染模型提供的原始 HTML。
- **角色**：角色说明每轮进入系统提示词。笔记、网页与记忆作为参考资料，不能变更系统角色；最终遵守程度仍取决于所用模型的指令能力。
- **占用与速度**：发送旁小圆环点击查看 SDK 上下文估算 token / 模型容量，容量未知则不显示百分比。tok/s = 服务端输出 token / 模型生成时段（包含思考与首 token 等待，排除工具等待），多次模型调用累加生成时段，不使用字符数冒充 token。未返回用量显示“—”。

架构参考：[Inno Agent 学习记忆](https://github.com/hhyqhh/inno-agent/tree/main/apps/inno-agent/src/memory/learner)；借鉴结构，没有复制其实现代码。[Tavily 搜索 API](https://docs.tavily.com/documentation/api-reference/endpoint/search)及[提取 API](https://docs.tavily.com/documentation/api-reference/endpoint/extract)。实时 Tavily 服务与电脑 A 实际模型仍需你自己的 Key / 服务完成使用验证。

PI-Desktop 来源与 LGPL-3.0 许可证见 PI-DESKTOP-LICENSE。
