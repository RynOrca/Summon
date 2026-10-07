# 鲸唤 Summon 0.25.2

`PATH_OUTSIDE_WORKSPACE` 修了。原因很具体，而且是我上一版留下的。

## 文件写错地方了

`stageUpload` 在页面没给根目录时**退回 `process.cwd()`** —— 而插件进程的 cwd 是
**应用自己的目录**。你这台机器上是：

```
D:\Tools\Pi-Desktop\.summon\uploads\upload-muxu32bbvsrc.png
```

我按你截图里的文件名在硬盘上找到了它。文件确实写成功了，只是**写在了工作区之外**，
而宿主的 `preparePromptAttachments()` 只认**会话的** project / scratch 根，于是：

```
Attachment path is outside the session roots: .summon/uploads/upload-xxx.png
(PATH_OUTSIDE_WORKSPACE)
```

## 现在怎么做

根目录**一律由插件解析**，页面说了不算：

1. `session.get` 的 `projectPath`（会话绑的项目 —— 这才是附件该落的地方）；
2. 退到 `project/get` 的活动项目；
3. **两个都拿不到就不写**，返回 `NO_WORKSPACE` 并告诉你「先去左下角选一个项目文件夹」。

宁可拒绝，也不要写到一个「发得出去但发不出去」的地方。页面传上来的 `root` 一律忽略
（有断言盯着，防止哪天又被信任）。

顺带把那个跑偏的目录删了：`D:\Tools\Pi-Desktop\.summon\`。

## 安装

- `local.summon-chat-0.25.2.piplug` —— 对话浮窗（`Alt+Shift+C`）
- `local.summon-widget-0.2.0.piplug` —— 悬浮圆球（`Alt+Shift+S`）

SHA256：

```
89f69f7bf58fbd4db2d2bcb0b00a779dc6114047b05fb821c64d46cc07cf2d14  local.summon-chat-0.25.2.piplug
fc7e8884786e14b262d99701646988006747311355e18e8e6660b566dca31c93  local.summon-widget-0.2.0.piplug
```

## 校验

`npm run verify` 全绿。新增的断言直接盯着这次的坑：

- 附件落在**会话项目**里，不是进程 cwd（用临时目录当会话项目，比对绝对路径）；
- 页面伪造的 `root` 被忽略；
- 拿不到工作区时**拒绝写入**并给出 `NO_WORKSPACE` 与可操作说明。
