# 第三方声明

## Reed 原创代码与品牌素材

仓库原创代码按根目录 LICENSE（MIT）发布。Reed 一苇品牌图由项目维护者提供，两套浅深色原画位于 desktop/design/branding，透明运行资源由轮廓蒙版提取，未重新生成图内画面。

## PI-Desktop 界面改编

`desktop/web/style.css` 中的设计令牌、消息与输入区样式，以及 `desktop/web/app.js` 中的对话行与折叠交互，改编自 PI-Desktop 0.16.1。

- 来源：https://github.com/earendil-works/pi-desktop
- 许可证：LGPL-3.0，完整文本保留在 `desktop/PI-DESKTOP-LICENSE`。
- 修改：独立悬浮窗口布局、模型与角色选择、图片预览、队列、审批、学习记忆、笔记引用及品牌外观。

这些改编部分保留上游许可证；根目录 MIT 声明不替代它们的许可证。分发相应部分或包含它们的应用时，应保留上游声明及 LGPL 所要求的源码与修改权利。

## PI Agent SDK 与 MCP

依赖 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-mcp`，版本在 desktop/agent/package-lock.json 固定。各包遵循安装包附带的许可证，便携包保留 node_modules 中的声明。

## Marked

Markdown 渲染使用 Marked，MIT License；完整文本位于 `desktop/web/vendor/MARKED-LICENSE`。前端库与该文本随源码保留。

## Tauri 与其他依赖

Tauri 及 Rust / npm 依赖各自遵循包内许可证。依赖列表由 Cargo.lock 和 package-lock.json 记录。本仓库不是 PI-Desktop 插件发行包。
