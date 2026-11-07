# 低配常驻采集器（候选）

2026-10-29：仅完成源码和合成隔离验证，未运行真实官方采集、安装、启用任务或部署。

## 入口与资源口径

最新 `CodexQuotaCollector.exe` 同时支持原 `--run`、只读查询 `--dry-run` 和显式 `--resident`，只有一份正式采集器。常驻复用自己创建的官方 stdio 实例，不能附着桌面已有进程；每轮仍验证前后账号及额度所属账号，不缓存身份结论。

外层匿名 Windows Job 包含控制进程和全部后代：默认 CPU 硬限额5%，本机 `--cpu-percent 1..10` 可调；启动私有提交预算300MiB、稳定预算200MiB。内层 Job 只负责会话回收，不操作桌面版或按名称查杀。挂起创建、继承句柄白名单、确认预算成员和绑定会话 Job 后才恢复执行。要求支持嵌套 Job 和 CPU 控制的 Windows；绑定、限制或读回失败就停止。

预算指私有提交量，另统计工作集；共享页形成的工作集不是同一口径，不通过清空工作集伪装低内存。CLR进入预算绑定之前的短暂启动阶段仍需目标机器实测。下调限制后重查实际提交，避免已有分配超过稳定预算。

初始化限时120秒，初始化后最多30秒收敛到稳定预算；每轮查询总时限60秒，管道写入也计入。stdout持续有界排空、请求编号不复用、无关通知不排队；stderr仅固定缓冲排空，不缓存官方完整日志。每秒检查一次实际资源状态，空闲等待事件，不轮询历史文件。

## 周期、失败与暂停

内部实际周期持久化在私有设备目录的 `resident.schedule.json`，不能使用旧任务重复触发器冒充。服务端下发新周期后，先持久化、切换和读回内部定时器，再沿用原配置确认协议。首次转换从旧任务真实周期初始化；后续常驻升级保留独立周期。原配置、client_id、DPAPI令牌、地址、可靠队列和迁移证明规则沿用原核心，历史补传响应不应用配置。

连续失败按5、15、30分钟退避，第三次失败先写入 `resident.paused.json`，最终退避结束后退出。必须健康度过一个完整正常周期才清零失败计数，一次短暂成功不能掩盖重启风暴。整树退出或后台线程清理无法确认时立即持久暂停，不再创建会话。

只有显式 `--resident --resume` 清除暂停标记；正常任务不得永久带 `--resume`。先查看脱敏原因、核实预算和环境，再决定恢复，不删除配置重配账号。

## 显式安装转换

`client-compiled/Install-ResidentMode.ps1` 只转换已配对设备，默认只预览。新设备身份仍由原安装入口建立，默认双击入口不隐式切换常驻。

```powershell
# 以下只供日后获准安装使用，本次未对真实设备执行。
powershell.exe -NoProfile -File .\client-compiled\Install-ResidentMode.ps1 -ExecutablePath "$build\CodexQuotaCollector.exe"
# -Apply 才替换程序和任务，仍保留原禁用状态；-Start 另行明确启用并请求启动。
```

常驻任务改为同一用户登录触发、无重复周期、无限执行期，移除原两分钟限制，不设置自动失败重启。因此用户尚未登录时不会通过该登录触发器运行。启动请求不等于成功上报，须另行验收。

运行中的生命周期锁无法取得时，安装立即拒绝，不强行停止进程或覆盖程序。原程序和task.xml备份在私有目录 `installation-backups/<唯一目录>/`，不改原config或token，不复制数据库、历史或队列。中途失败保留错误和备份，不盲目覆盖可能并发变化的任务。回退需获准停止并核验自有任务、确认锁已释放，核对当前归属后恢复备份程序与task.xml，不恢复旧配置或令牌。本次未执行安装或回退。

已有常驻设备升级使用常驻转换入口；普通安装器会拒绝不匹配的常驻动作，不自动降级。需要打包时仅额外加入此转换脚本及说明，将全部 `Resident*.cs` 纳入源码摘要，不包含任何测试EXE或设备状态文件。

## 隔离验证

```powershell
powershell.exe -NoProfile -File .\client-compiled\build-tests.ps1 -OutputDirectory "$build"
python .\client-compiled\tests\test-resident.py --build "$build"
powershell.exe -NoProfile -File .\tools\test-resident-installer.ps1 -BuildDirectory "$build"
# 每个资源场景使用独立进程，避免作业约束污染下一场景。
& "$build\ResidentTests.exe" guard
& "$build\ResidentTests.exe" cpu
& "$build\ResidentTests.exe" steady-memory
& "$build\ResidentTests.exe" startup-memory
& "$build\ResidentTests.exe" cannot-settle
```

覆盖一次初始化多轮查询、唯一请求编号、通知/错误流、身份变更、超时、异常退出、启动及稳定分配失败、不能收敛、整树回收、控制进程被强制结束、独立进程保持、生命周期锁、周期确认、重启恢复、退避暂停与清理未知。

### 实测限制与计数差异

合成忙负载短窗曾观察约整机2.7%、3.8%和5.2%，受调度和测量边界影响，不表示每一瞬间精确等于5%。合成正常多轮控制进程在会话退出后约24至32MiB，不代表官方会话稳定内存。

拒绝分配压力测试中，稳定期内核硬限制读回为200MiB，目标间隔1ms的私有提交采样曾观察最大约190至192MiB，但Windows历史Job峰值计数约204至208MiB。调度可能使实际采样间隔更长，其他轮次的样本最大值也可能更低。两个指标不一致的原因尚未完全证实，原始值分别保留；没有把历史计数降低、裁剪或冒充当前实际私有内存。采样最大值也不能证明所有瞬间绝不超限，硬限制配置本身不能替代真实验收。

官方版本能否在预算内正常初始化、E5目标机CPU及卡顿改善、多个20分钟周期、长时间内存增长，以及CLR进入限制前的启动峰值均未实测；需要后续单独授权。当前交付是有保护的候选，不声称目标机已经达标。

Windows边界依据：[CPU硬限额](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)、[提交量限制](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)、[进程绑定前内存操作的边界](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。
## 统一安装入口

双击 `Install.cmd` 可选择“1. 单轮（默认） / 2. 常驻”，回车默认单轮。选择常驻的新设备不会先执行单轮采集；已有设备切换需输入 `YES`，禁用状态保持。暂停设备不能转单轮绕过暂停，也不会自动清除暂停标记。直接 `Install-ResidentMode.ps1` 入口保留默认只预览和常驻行为，新增显式 `-Mode Single` 用于已确认的反向转换。
