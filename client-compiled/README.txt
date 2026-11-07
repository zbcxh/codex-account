当前唯一采集器为本目录 C# 5 / .NET Framework 实现。
统一双击入口 Install.cmd 现在提供“1. 单轮（默认）/2. 常驻”；直接回车选择单轮，无效输入重新询问。
已有设备切换模式必须输入 YES 确认；取消不写入。已有禁用任务保持禁用，常驻暂停状态禁止转单轮绕过。
新设备先准备配对与禁用任务，再应用所选模式；选择常驻时不会先执行单轮冷启动。
构建：build.ps1；隔离测试驱动：build-tests.ps1。
统一构建校验和打包：powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\client-compiled\package.ps1（在仓库根目录执行，可传 -Version 和 -BuildId）。成功后新增到 releases/，历史包和摘要全部保留；同编号拒绝覆盖，不安装或启停采集器。
目录分工：本目录的 .cs 是正式共享源码，Install*.ps1、Start-Install.ps1、Install.cmd 是安装入口及依赖；tests/、TestDriver.cs、test-client.py 供隔离验证，不随客户端安装。
bin/、test-output/、test-results.json 是可重新生成的本地构建或验证产物，确认无人使用后可清理，不是运行数据。
安装包统一保存在项目根目录 releases/，保留各版本 ZIP 及其 SHA-256；安装时按版本和构建编号选择完整解压包。
完整解压分发包后运行 Install.cmd；已有设备升级保留 client_id、地址及令牌。
正式入口：CodexQuotaCollector.exe --run；--dry-run 仍会查询官方账号，不能当作离线测试。
直接运行 Install-Client.ps1 默认会启用任务并立即单轮采集；统一入口保留已有禁用/暂停状态，只有获得安装授权才执行。
源码、打包及验证步骤见 ../docs/CLIENT-BUILD-INSTALL.md。
低配常驻候选：--resident，默认CPU硬限额5%，启动/稳定私有提交预算300/200MiB。
常驻转换入口Install-ResidentMode.ps1默认只预览；Apply保留禁用状态，Start另行显式启用。
三次失败后持久暂停；显式--resident --resume才恢复。详情见../docs/LOW-RESOURCE-COLLECTOR.md。
仅通过合成隔离验证，未安装或实测真实官方进程。
手动 OTA 支持：
当前源码包含管理员定向任务、签名校验及独立 CodexQuotaUpdater.exe。
首次可信安装使用 Install-OtaSupport.ps1，默认预览；需要人工核验的 RSA-3072 公钥。
本次分发不包含正式或测试信任根，未配置信任根时不会执行正式 OTA。
具体协议、隔离验证与首次安装边界见 docs/MANUAL-OTA.md。
