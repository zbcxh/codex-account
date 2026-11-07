<#
.SYNOPSIS
为已配对设备显式切换最新编译采集器到常驻模式；默认只预览，不配对、不改令牌或周期。
.PARAMETER ExecutablePath
本轮已验证的候选 EXE 路径。
.PARAMETER Apply
明确执行程序替换和同用户任务定义转换；不自动启用或启动任务。
.PARAMETER Start
与 Apply 同时指定，表示另行明确启用并请求启动任务；启动不等于额度送达。
.PARAMETER Mode
显式选择Resident或Single；保留原脚本默认常驻行为，统一入口另以单轮为默认。
.PARAMETER ExpectedTaskXml
统一入口确认前冻结的完整任务定义；不一致时拒绝写入，避免确认期间禁用状态漂移。
.OUTPUTS
预览或私有程序与任务备份位置，不输出配置或凭据。
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ExecutablePath,[switch]$Apply,[switch]$Start,[ValidateSet('Single','Resident')][string]$Mode='Resident',[string]$ExpectedTaskXml)
$ErrorActionPreference='Stop'
if($Start -and -not $Apply){throw '-Start 必须同时指定 -Apply。'}
$ExecutablePath=[IO.Path]::GetFullPath($ExecutablePath)
if(-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)){throw '缺少已经验证的候选程序。'}
[void][Reflection.Assembly]::LoadFrom($ExecutablePath)
$root=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexQuota')).TrimEnd('\')
[QuotaClient]::Fence($root,$root)|Out-Null
[QuotaClient]::CheckPrivate($root)
$cfg=[QuotaClient]::Read((Join-Path $root 'config.json'),$false)
if(-not $cfg.ContainsKey('client_id') -or -not $cfg.ContainsKey('server_url')){throw '只支持已有配对设备；本入口不创建身份。'}
if($Mode -eq 'Single' -and (Test-Path -LiteralPath (Join-Path $root 'resident.paused.json'))){throw '存在常驻暂停标记，禁止切换单轮绕过暂停；请先人工核验并显式恢复。'}
$taskName=if($cfg.ContainsKey('task_name')){[string]$cfg['task_name']}else{'CodexQuotaMonitor'}
if(-not $taskName -or $taskName.Contains('\')){throw '任务名不合法。'}
$tasks=@(Get-ScheduledTask -TaskName $taskName -ErrorAction Stop)
if($tasks.Count -ne 1){throw '任务归属不唯一，停止。'}
$task=$tasks[0]
$before=Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
if($ExpectedTaskXml -and $before -cne $ExpectedTaskXml){throw '确认期间任务发生变化，未修改程序或任务；请重新选择。'}
# 转换前从已核验周期任务读取真实周期；后续常驻升级沿用独立内部定时器状态。
$beforeDocument=[WindowsQuotaTaskStore]::Parse($before)
$beforeArgument=$beforeDocument.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Arguments']")
$wasResident=$beforeArgument -and $beforeArgument.InnerText -eq '--resident'
$schedule=[QuotaClient]::Fence($root,(Join-Path $root 'resident.schedule.json'))
$initialMinutes=if($wasResident){
    [ResidentTaskDefinition]::Validate($root,$before)
    # 常驻内部持久周期才是真实值；缺失时才沿用既有兼容字段，不能使用期望配置。
    if(Test-Path -LiteralPath $schedule){$actual=[QuotaClient]::Read($schedule,$false);[int][QuotaClient]::Integer($actual['interval_minutes'],1,1440)}
    elseif($cfg.ContainsKey('reporting_interval_minutes')){[int][QuotaClient]::Integer($cfg['reporting_interval_minutes'],1,1440)}else{5}
}else{[WindowsQuotaTaskStore]::Validate($root,$before)}
$after=if($Mode -eq 'Resident'){[ResidentTaskDefinition]::ConvertToResident($root,$before)}else{[ResidentTaskDefinition]::ConvertToSingle($root,$before,$initialMinutes)}
if(-not $Apply){Write-Output ('预览：保留设备身份、实际周期和禁用状态，目标模式 '+$Mode+'；本次未写入。');return}
$admin=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){throw '应用任务变更需要同一 Windows 用户的管理员终端。'}
$held=New-Object IO.FileStream(([QuotaClient]::Fence($root,(Join-Path $root '.collector.lock'))),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    # 生命周期锁必须在复制前取得；常驻程序未停止时拒绝覆盖，不强制停止其他进程。
    # 常驻进程可能在预检后写入暂停并退出；持锁后必须重检，防止切换单轮绕过新暂停。
    if($Mode -eq 'Single' -and (Test-Path -LiteralPath (Join-Path $root 'resident.paused.json'))){throw '取锁前设备进入暂停，禁止切换单轮；未替换程序或任务。'}
    [void][QuotaClient]::Token($root)
    $current=Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
    if($current -cne $before){throw '任务并发改变，未替换程序或任务。'}
    $backups=[QuotaClient]::PrivateDirectory($root,(Join-Path $root 'installation-backups'))
    $backup=[QuotaClient]::PrivateDirectory($root,(Join-Path $backups ([Guid]::NewGuid().ToString('N'))))
    [IO.File]::WriteAllText((Join-Path $backup 'task.xml'),$before,[Text.UTF8Encoding]::new($false))
    $target=[QuotaClient]::Fence($root,(Join-Path $root 'bin\CodexQuotaCollector.exe'))
    if(-not (Test-Path -LiteralPath $target -PathType Leaf)){throw '已有设备程序缺失，停止。'}
    Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'CodexQuotaCollector.exe')
    $schedule=[QuotaClient]::Fence($root,(Join-Path $root 'resident.schedule.json'))
    if($Mode -eq 'Resident' -and (-not $wasResident -or -not (Test-Path -LiteralPath $schedule))){
        $serializer=New-Object Web.Script.Serialization.JavaScriptSerializer
        [QuotaClient]::Atomic($root,$schedule,$serializer.Serialize(@{interval_minutes=$initialMinutes}))
    }
    $temporary=[QuotaClient]::Fence($root,(Join-Path $root ('bin\'+[Guid]::NewGuid().ToString('N')+'.tmp')))
    try {
        Copy-Item -LiteralPath $ExecutablePath -Destination $temporary
        if((Get-FileHash -LiteralPath $temporary).Hash -ne (Get-FileHash -LiteralPath $ExecutablePath).Hash){throw '程序复制摘要不一致。'}
        [IO.File]::Replace($temporary,$target,[NullString]::Value)
        Register-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Xml $after -Force -ErrorAction Stop|Out-Null
        $readback=Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
        if($Mode -eq 'Resident'){[ResidentTaskDefinition]::Validate($root,$readback)}else{[void][WindowsQuotaTaskStore]::Validate($root,$readback)}
        $appliedXml=$readback
    } catch {
        throw ('常驻切换未完成；请保留程序与任务备份 '+$backup+'。未自动覆盖可能并发变化的任务。错误：'+$_.Exception.Message)
    } finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary}}
} finally {$held.Dispose()}
if($Start){
    # 仅显式 Start 才启用；再次检查实际动作，避免将并发替换的任务拉起。
    $readback=Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
    if($readback -cne $appliedXml){throw '应用后任务并发改变，未启用或启动；请重新核实。'}
    if($Mode -eq 'Resident'){[ResidentTaskDefinition]::Validate($root,$readback)}else{[void][WindowsQuotaTaskStore]::Validate($root,$readback)}
    if(Test-Path -LiteralPath (Join-Path $root 'resident.paused.json')){throw '设备有暂停标记，本次不启用或启动；请另行核验并显式恢复。'}
    Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop|Out-Null
    Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
    Write-Output ('已请求启动 '+$Mode+' 任务；是否送达须另行核验，不自动清除暂停标记。')
}
Write-Output ('模式 '+$Mode+' 已应用，原任务是否禁用由转换前定义保持。私有程序与任务备份：'+$backup)
