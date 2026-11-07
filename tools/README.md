# 工具目录

本目录保留服务管理、备份、发布辅助和隔离验证工具，不是客户端安装目录。文件名及位置保持不变，避免破坏任务、脚本和文档引用。

| 文件 | 用途与执行边界 |
| --- | --- |
| `codex-quota-server.ps1` | Windows 服务任务的安装、启停和状态检查；本机服务可能直接引用，保留原路径 |
| `codex-quota-bootcheck.ps1` | 临时开机检查及取证；可能注册任务或写日志，按需执行 |
| `backup.mjs` | SQLite 一致性备份；备份文件不放在工具目录中 |
| `build-ota-release.mjs` | 离线生成签名 OTA 清单及资产；不等于普通 ZIP 安装包，不能混入私钥 |
| `test-client-package.ps1` | 合成仓库内验证统一打包、白名单、成功失败均保留历史包，不访问正式运行环境 |
| `selftest.mjs` | 向指定服务写合成报告，只能用于隔离空库 |
| `test-*.mjs`、`test-*.py`、`test-*.ps1` | 各领域或安装边界验证；按改动范围选择，不批量盲跑 |
| `TemporaryTreeTests.cs` | 配合进程树测试脚本编译的合成驱动源码，不分发到客户端 |

普通设备只需完整解压 `../releases/` 中的最新客户端 ZIP，运行 `Install.cmd`；不复制本目录，也不复制客户端源码和测试工具。

统一 ZIP 入口是 `client-compiled/package.ps1`，自动构建、核对版本和摘要并交付到 `releases/`。构建及测试输出使用独立临时目录，不写入本目录。发布规则和白名单见 [客户端构建安装指南](../docs/CLIENT-BUILD-INSTALL.md)。清理仓库产物不涉及 `%LOCALAPPDATA%\CodexQuota`、`server/data/`、计划任务或现有服务。
