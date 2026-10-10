# Reed 桌面构建

产品介绍、配置、数据与权限、构建和测试方式见[GitHub README](https://github.com/RynOrca/Reed#readme)。

便携包运行 `Reed.exe`，保留同目录 `agent/` 与 `runtime/`。更新前先通过托盘退出旧版，用户配置保存在 `%APPDATA%\Reed`，不随程序包覆盖。

启动日志位于便携包的 `startup.log`；目录不可写时回退到系统临时目录的 `Reed-startup.log`。Agent 日志位于应用数据目录的 `agent.log`。反馈问题前请删除日志中的私人内容和服务凭据。

第三方许可随包提供，来源见 NOTICE.md。支持 Windows 安装包和便携包，未提供自动更新。首次启动自动迁移旧配置，旧目录保留为备份，已有 Reed 数据不会被覆盖。升级和卸载默认保留用户数据。
