# 编译采集器：源码编译、测试包制作与安装指南

低配常驻候选见 [LOW-RESOURCE-COLLECTOR.md](LOW-RESOURCE-COLLECTOR.md)，原单轮入口保持。

本文是操作指南，阅读或提交本文不会执行命令。示例需在实际构建、验证、安装获得授权后分别执行。

## 1. 环境与源码位置

- Windows x64、Windows PowerShell 5.1、系统 .NET Framework。
- 系统编译器：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`。缺失时构建脚本报错，不会自动安装；无需安装 Visual Studio。
- 程序为 C# 5 / .NET Framework EXE，不是 Native AOT，也不是 Linux 客户端。
- 完整项目根目录示例：`D:\zhoubc\projects\tools\codex-accounts`。

| 文件 | 用途 |
|---|---|
| `client-compiled/QuotaClient.cs` | 配置、DPAPI、可靠队列、上报和周期确认 |
| `client-compiled/QuotaPrototype.cs` | 当前采集器共享 RPC、超时和账号归属校验 |
| `client-compiled/build.ps1` | 构建正式入口 EXE |
| `client-compiled/build-tests.ps1` | 额外构建隔离测试驱动，不自动运行测试 |
| `client-compiled/Install-Client.ps1` | 直接安装编译版，支持新设备配对及已有设备升级 |

正式源码、共享实现与隔离测试统一在 `client-compiled/`。源码受 Git 管理；运行目录 `%LOCALAPPDATA%\CodexQuota` 和分发目录与源码分开。

## 2. 从源码编译 EXE

打开 Windows PowerShell 5.1，普通权限即可构建；安装才需要管理员权限。

```powershell
cd 'D:\zhoubc\projects\tools\codex-accounts'
$repo = (Get-Location).Path
$build = Join-Path 'D:\zhoubc\tools\builds' ('quota-' + [Guid]::NewGuid().ToString('N'))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\client-compiled\build.ps1 -OutputDirectory $build
if ($LASTEXITCODE -ne 0) { throw '构建失败，停止后续操作' }
```

输出：`$build\CodexQuotaCollector.exe`。构建不会安装、启动采集或上报，不会更新已安装程序。
不要将输出指向正式监控目录、Codex 安装目录或 `.codex` 凭据目录。

如需同时生成测试驱动，用下面入口替代上面的构建命令：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\client-compiled\build-tests.ps1 -OutputDirectory $build
if ($LASTEXITCODE -ne 0) { throw '构建失败，停止后续操作' }
```

它同时生成 `QuotaClientTestDriver.exe`，仍不运行测试。测试驱动不能放进分发包。

## 3. 验证与版本标识

构建成功不等于验证通过。源码改变后，不可沿用旧 EXE 的通过结论。
必要验证范围：无阶段日志写入、必要日志、RPC超时及身份不一致失败关闭、队列/DPAPI/HTTPS/周期兼容、隔离新装和升级，以及获准后的本机真实上报。

发布前记录 Git 提交及源码 SHA-256。工作区未提交时必须明确标记，不能仅用 HEAD 冒充产物源码版本。
本项目曾从 PowerShell 7 经 Python 启动 5.1，继承错误模块路径导致安全模块加载失败；测试启动器应只给5.1子进程配置适用模块路径，不改系统环境或安全策略。
初始化专项、性能复测和长期观察与必要功能验证分开安排。

## 4. 分发包与目录管理

统一入口（在仓库根目录用 Windows PowerShell 5.1 执行）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\client-compiled\package.ps1
# 指定发布版本；不传BuildId时自动使用本次UTC编译时间。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\client-compiled\package.ps1 -Version 1.0.0
```

脚本在独立临时目录构建采集器和升级器，核对程序集版本与构建编号、白名单和ZIP全部条目的SHA-256，记录源码摘要和未提交状态，交付后保留全部历史包及摘要。同编号拒绝覆盖，并发发布由文件锁隔离，成功或失败均不删除旧发布。它不执行采集、安装、配对、计划任务变更或服务启停；这些静态产物检查不等于设备安装和真实上报验收。

客户端 ZIP 安装包统一放在项目根目录 `releases/`，保留各版本 ZIP 及其同名 `.sha256.txt`。该目录被 Git 忽略，是本机交付目录；不能只把安装包留在临时目录。

构建、测试驱动和打包暂存使用独立临时目录。普通 EXE 构建不等于安装包，不把整个构建目录压缩。正式包保留以下白名单和目录结构：

- `Install.cmd`、`Start-Install.ps1`、`Install-Mode.Core.ps1`：统一入口及模式编排。
- `Install-Client.ps1`、`Install-ResidentMode.ps1`：配对、升级与模式转换。
- `Install-OtaSupport.ps1`、`Install-OtaSupport.Core.ps1`：可选 OTA 入口及依赖，不包含信任根或密钥。
- `bin/CodexQuotaCollector.exe`、`bin/CodexQuotaUpdater.exe`：同一构建的程序。
- `README.txt`、`manifest.json`：说明及版本、构建编号、源码提交、未提交状态和各文件 SHA-256。

先在全新暂存目录组包，核对 ZIP 白名单、清单摘要和必要验证结果，再复制到 `releases/`；复核复制后的 ZIP 摘要并写同名摘要文件。不自动删除任何历史包或摘要，新版未通过验证时不影响原交付包。

包内不包含配置、bootstrap、配对码、令牌、auth.json、DPAPI 文件、数据库、队列、日志、备份、测试驱动、合成状态或旧 PowerShell 采集器；不对仓库或运行目录整体压缩。发布版本、构建编号和程序摘要以本次程序集属性及清单为准。

| 目录或文件 | 保留与用途 |
| --- | --- |
| client-compiled/*.cs | 正式共享源码及合成测试驱动源码，保留 |
| client-compiled/Install*.ps1、Start-Install.ps1、Install.cmd | 安装入口和依赖，保留 |
| client-compiled/build*.ps1、tests/、test-client.py | 构建与验证工具，保留 |
| client-compiled/bin/、test-output/、test-results.json | 可再生成的中间产物，确认不在使用后可清理 |
| tools/ | 服务管理、备份和验证工具，保留原位置，详见该目录 README |
| releases/ | 各版本安装包及摘要，不存中间 EXE 和测试结果 |

普通设备只需完整解压最新 ZIP，运行 Install.cmd，不复制源码或工具目录。清理不涉及 %LOCALAPPDATA%\CodexQuota、server/data/、服务部署目录、计划任务或凭据。历史源码从 Git 获取；未提交产物不能仅凭 HEAD 冒充可重建版本。

## 5. 页面生成设备配对码

管理员打开服务器面板“接入管理 → 生成配对码”：

- 单次：用于一台设备，默认10分钟有效，成功接入后消耗。
- 限时：指定开始/结束时间，期间可接入多台。
- 永久：可重复使用，直到撤销。

填写备注和时间，使用当前 bootstrap 管理口令授权。生成后复制配对码，明文只展示一次。
只向安装人员提供配对码；bootstrap保留管理权限，不分发、不写入安装包。
撤销或到期只阻止后续配对，不影响已有设备令牌上报。

## 6. 新电脑安装

推荐双击方式：完整解压后双击 **Install.cmd**，在UAC提示中允许同一Windows用户提权，输入服务器HTTP/HTTPS地址、设备名称，再在隐藏输入处输入面板生成的配对码。安装结果窗口会停留，按Enter关闭。不要直接从ZIP预览运行。

必须使用登录Codex的同一Windows用户。若UAC要求输入另一个管理员账号且改变了用户SID，启动器会停止，避免凭据安装到其他用户。

下面保留管理员终端方式，适合传入固定参数或排错：

1. 安装并正常登录官方 Codex 桌面版；确认能访问服务器。
2. 完整解压测试包，不在ZIP预览中运行。
3. 使用登录Codex的同一Windows用户，以管理员身份打开 **Windows PowerShell 5.1**，进入解压目录。
4. 执行下面命令，在隐藏输入处填页面配对码：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Client.ps1 `
  -Server 'http://192.168.18.8:8787' -Label '测试电脑A'
```

服务器地址也支持 `https://你的域名` 及路径前缀，不能填 `/#/settings` 页面路由；HTTPS采用系统证书校验。
省略Server会在新设备上提示输入；省略Label默认使用电脑名称。
安装器创建本机随机client_id和DPAPI令牌，不登录或切换Codex账号。
新设备配对和任务安装成功后，会在释放安装锁后直接运行采集器一次，并展示送达、排队、已有采集运行中或失败结果。之后由计划任务按初始约5分钟周期继续运行，再按服务器确认周期调整。
安装器只备份当前程序、配置、凭据和任务定义，不备份历史数据。包不提供旧采集器回退入口。

## 7. 已有设备升级

可直接双击新包 Install.cmd。识别已有令牌后不再询问服务器或配对码，沿用原 client_id、设备令牌、服务地址与名称，并启用任务及直接采集上报一次。不要先卸载，也不要删除本机配置来升级。

在同一Windows用户下，以管理员身份进入新包目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Client.ps1
```

沿用原client_id、服务器地址和设备令牌，无需配对码；原配置文件不重写，任务身份和周期保持。新旧设备都自动启用本机已禁用的采集任务，读回确认并释放安装锁后直接运行EXE一次；不再仅提交计划任务启动请求。只有采集器返回sent_report=true才显示已送达；网络或鉴权失败显示已排队及HTTP状态，collector_busy显示已有采集运行中。实际送达仍可结合面板最近成功上报时间核对。若任务启用失败或动作被其他程序替换，停止触发并报错。
不要先卸载，不要运行旧卸载脚本，也不要复制其他电脑的 `%LOCALAPPDATA%\CodexQuota`。
若更换Windows用户，原DPAPI令牌可能无法读取，应停止排查，不删除配置强制接入。

## 8. 确认上报正常

等待首次运行后，在目标电脑检查：

```powershell
Get-ScheduledTask -TaskName CodexQuotaMonitor | Get-ScheduledTaskInfo |
  Format-List LastRunTime,LastTaskResult,NextRunTime
Get-Content "$env:LOCALAPPDATA\CodexQuota\logs\report.log" -Tail 10
```

任务最近运行时间应更新、返回0；日志应有 `compiled report_ok_account_`。
面板“客户端额度”应出现正确设备并在线，账号归属应与该电脑当前登录一致；设置中实际周期应已确认。
返回0不能单独证明上报送达，必须结合成功日志和面板。采集器非常驻，每轮退出，平时看不到进程属正常。
阶段计时和 `performance.jsonl` 写入已移除；旧性能文件不继续追加，也不会自动删除。

## 9. 常见故障

- 配对403：检查是否误用了bootstrap、码是否到期/撤销/已被其他设备消耗。
- 配对响应丢失：保留本机配置，使用同码同client_id短期重试，仍受有效期/撤销限制。
- 配对409：已有身份缺少安全重配证明，保留配置和令牌，不删除client_id或冒用他人配置。
- 权限/模块错误：确认使用系统Windows PowerShell5.1和管理员身份，不关闭安全策略或放宽凭据目录权限来绕过。
- 任务正常但面板没更新：检查HTTP/HTTPS地址、网络、最近日志和实际周期，不先清空队列。

反馈时提供脱敏错误码、任务返回码及发生时间，不发送bootstrap、配对码、令牌或登录凭据文件。
## 10. 页面迁移上报服务器地址

先将服务端升级到支持迁移协议的版本，再更新需要迁移的电脑采集器。已有设备只运行本包 Install-Client.ps1，不填写新 Server，不重新配对，保留原 client_id 和设备令牌。安装器不会通过升级参数强制更换既有服务地址。

1. 在目标服务安全迁移已有设备授权库，部署与当前服务兼容的程序；新空库不能直接接收原设备令牌。本功能不搬运数据库。
2. 确认设备能访问目标域名；推荐有效系统信任证书的 HTTPS。填写基础地址，例如 https://quota.example.com，可带路径前缀，不填页面 # 路由、口令或查询参数。
3. 在旧面板打开“系统设置 → 迁移上报服务器”，管理授权后读取配置。先选一台测试设备保存目标，确认后再设置默认值或其他设备。
4. 设备下次成功上报后校验目标持有同一设备令牌，再验证 client_id 和令牌鉴权；全部成功才保存 server_url。连接、证书、目标证明或身份校验失败均保留原地址。禁止自动重定向和 HTTPS 降级。
5. 旧面板查看“已确认地址”和状态；在新面板确认该设备随后有成功上报。只有地址确认不能单独证明额度上报已经送达新服务。
6. 等待离线设备全部确认前保持旧服务可访问。已迁移设备在新服务配置回迁；取消默认/清除覆盖不会自动撤回已保存地址。

本次本机已验证同服务地址迁移与回迁、不可达目标/HTTPS握手失败/错误令牌证明保护。有效证书 HTTPS 的跨服务器端到端迁移尚未实测，其他电脑仍需实际接入测试。详细接口和回退边界见项目 docs/SERVER-MIGRATION.md。

## 11. 安装包删除与空路径排错

安装完成并关闭窗口后，可以删除下载的ZIP和解压目录。计划任务使用 `%LOCALAPPDATA%\CodexQuota\bin\CodexQuotaCollector.exe`，不依赖桌面的安装源目录。不要删除整个 `%LOCALAPPDATA%\CodexQuota`：里面有设备配置、DPAPI加密令牌、待上报队列和必要日志。

如果旧包报“Join-Path 的 Path 为空”，发生在默认参数初始化，尚未进入配对与安装。新版将默认EXE路径移到脚本体解析，并从 PSCommandPath / MyInvocation 文件路径回退，不以当前工作目录猜测EXE。也可在管理员PowerShell显式指定：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Client.ps1 `
  -Server 'http://192.168.18.8:8787' -Label '测试电脑' `
  -ExecutablePath "$((Get-Location).Path)\bin\CodexQuotaCollector.exe"
```

取消UAC不执行安装。首次安装仍需输入配对码，“一键安装”不绕过设备授权。双击提权、输入与安装结果由实际电脑验收，代码检查不等同真实UAC流程验证。

## 12. 立即采集结果

满队列恢复：可信上报队列达到72条时，采集器先完成本轮官方账号与额度归属核验，再尝试补传至多一条历史。服务器明确确认后才移除该事件、腾出位置并可靠入队本轮报告；网络或鉴权失败保留所有历史并停止本轮，不删除旧数据强行腾空间。历史响应不用于修改周期或服务器地址。只读模式和身份核验失败不触发补传；缺少可验证历史时仍保留队列并报错。普通未满队列继续先上报本轮报告，再补传一条历史。

- 已送达：采集器明确返回当前报告sent_report=true。
- 已排队：采集已经产生额度，但上报未送达；HTTP 401需检查服务端是否已停用/合并该设备身份，其他状态检查地址、网络与服务。保留原配置、令牌和队列，不自动重新配对。
- 已有采集运行中：锁保护避免重复运行，等待正在运行的一轮完成。
- 失败：显示固定脱敏错误码；程序和任务可能已经安装完成，勿删除配置来重试。可反馈report.log最后几行（不要提供令牌文件）。

本轮只通过任务与进程替身做代码检查，没有对真实设备执行安装、上报或UAC。实际安装由用户验收。

## RPC 协议隔离测试

`build-tests.ps1` 同时生成 `CodexQuotaPrototype.exe` 协议测试驱动；它不是第二套正式采集器，不进入分发包。

```powershell
python .\client-compiled\tests\test-rpc.py --exe "$build\CodexQuotaPrototype.exe"
python .\client-compiled\tests\test-backend-contract.py --exe "$build\CodexQuotaPrototype.exe" --node "<真实 Node.exe 路径>"
```

测试使用合成 RPC、回环 HTTP/HTTPS 和临时数据库；后端契约测试仅启动自己的临时服务。最新源码在完成本次构建与测试前不能引用历史结果作为通过证明。
## 统一入口模式选择

完整解压后双击 `Install.cmd`，同一用户管理员授权后显示 `1. 单轮（默认） / 2. 常驻`。回车选择单轮；无效输入重新询问。新设备沿用配对流程，但先创建禁用的准备任务，再应用选定模式，不在选择常驻前先执行一次 `--run`。

已有设备切换模式必须输入 `YES` 明确确认，其他输入取消且不修改程序、配置或任务。已有禁用状态保持，已有暂停状态不被清除；存在常驻暂停标记时拒绝转单轮，以免周期任务绕过暂停。正在运行并持有生命周期锁时拒绝覆盖程序，应先按授权安全停止。

常驻转单轮使用 `resident.schedule.json` 的内部实际周期，缺失时才兼容已有实际字段或五分钟；不使用期望周期。统一入口仅对新设备或原本已启用且未暂停的任务请求启动，计划任务受理不等于额度送达。`Install-Client.ps1` 的直接历史入口行为仍保留；新增 `-PrepareOnly` 仅供统一入口准备新设备，不启用或采集。

分发依赖包含 `Install.cmd`、`Start-Install.ps1`、`Install-Mode.Core.ps1`、`Install-Client.ps1`、`Install-ResidentMode.ps1` 与 `bin/CodexQuotaCollector.exe`；入口也兼容根目录 EXE。OTA 升级器和支持安装脚本仍按 OTA 文档白名单附带。
