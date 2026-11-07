<#
.SYNOPSIS
以合成私有目录及任务命令替身运行常驻转换入口，绝不访问真实任务或设备配置。
.PARAMETER BuildDirectory
包含候选 EXE 和合成状态驱动的隔离构建目录。
.OUTPUTS
断言结果；不执行真实安装或采集。
#>
param([Parameter(Mandatory=$true)][string]$BuildDirectory)
$ErrorActionPreference='Stop'
Import-Module Microsoft.PowerShell.Management,Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference='None'
$originalLocal=$env:LOCALAPPDATA
$fixture=Join-Path $env:TEMP ('resident-install-fixture-'+[Guid]::NewGuid().ToString('N'))
$env:LOCALAPPDATA=$fixture
$root=[IO.Path]::GetFullPath((Join-Path $fixture 'CodexQuota'))
$candidate=Join-Path $BuildDirectory 'CodexQuotaCollector.exe'
$driver=Join-Path $BuildDirectory 'QuotaClientTestDriver.exe'
$global:ResidentInstallFixtureCalls=[Collections.Generic.List[string]]::new()
# 禁止计划任务模块自动加载，并在父作用域遮蔽所有可能触及真实任务的命令。
function Get-ScheduledTask {
    <# .SYNOPSIS 返回合成任务。 .PARAMETER TaskName 合成名称。 .OUTPUTS 合成快照。 #>
    param($TaskName)
    return [pscustomobject]@{TaskName=$TaskName;TaskPath='\'}
}
function Export-ScheduledTask {
    <# .SYNOPSIS 返回内存定义。 .PARAMETER TaskName 合成名称。 .PARAMETER TaskPath 合成路径。 .OUTPUTS XML。 #>
    param($TaskName,$TaskPath)
    if($global:ModeInstallPauseRace){$global:ModeInstallPauseRace=$false;[IO.File]::WriteAllText((Join-Path $root 'resident.paused.json'),'{"reason":"fixture_race"}',[Text.UTF8Encoding]::new($false))}
    if($global:ModeInstallRace){$global:ModeInstallExports++;if($global:ModeInstallExports -eq 4){$global:ResidentInstallFixtureXml=$global:ResidentInstallFixtureXml.Replace('<Enabled>true</Enabled><ExecutionTimeLimit>','<Enabled>false</Enabled><ExecutionTimeLimit>')}}
    return $global:ResidentInstallFixtureXml
}
function Register-ScheduledTask {
    <# .SYNOPSIS 在内存注册替身。 .PARAMETER TaskName 名称。 .PARAMETER TaskPath 路径。 .PARAMETER Xml 定义。 .PARAMETER Force 兼容开关。 .OUTPUTS 无。 #>
    param($TaskName,$TaskPath,$Xml,[switch]$Force)
    $global:ResidentInstallFixtureXml=$Xml;$global:ResidentInstallFixtureCalls.Add('register')
}
function Enable-ScheduledTask {
    <# .SYNOPSIS 记录启用替身。 .PARAMETER TaskName 名称。 .PARAMETER TaskPath 路径。 .OUTPUTS 无。 #>
    param($TaskName,$TaskPath)
    $global:ResidentInstallFixtureCalls.Add('enable')
}
function Start-ScheduledTask {
    <# .SYNOPSIS 记录启动替身。 .PARAMETER TaskName 名称。 .PARAMETER TaskPath 路径。 .OUTPUTS 无。 #>
    param($TaskName,$TaskPath)
    $global:ResidentInstallFixtureCalls.Add('start')
}
try {
    & $driver seed $root|Out-Null
    if($LASTEXITCODE -ne 0){throw '合成状态创建失败。'}
    $bin=Join-Path $root 'bin';[void][IO.Directory]::CreateDirectory($bin)
    Copy-Item -LiteralPath $candidate -Destination (Join-Path $bin 'CodexQuotaCollector.exe')
    [IO.File]::WriteAllText((Join-Path $root 'config.json'),' {"client_id":"fixture-client","server_url":"http://fixture.invalid","task_name":"FixtureTask","reporting_interval_minutes":20,"unknown":"keep"} ',[Text.UTF8Encoding]::new($false))
    $configBefore=(Get-FileHash -LiteralPath (Join-Path $root 'config.json')).Hash
    $tokenBefore=(Get-FileHash -LiteralPath (Join-Path $root 'token.bin')).Hash
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $exe=[Security.SecurityElement]::Escape((Join-Path $bin 'CodexQuotaCollector.exe'))
    $global:ResidentInstallFixtureXml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><TimeTrigger><StartBoundary>2030-01-01T00:00:00</StartBoundary><Repetition><Interval>PT20M</Interval></Repetition></TimeTrigger></Triggers><Principals><Principal id="Author"><UserId>'+$sid+'</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><Enabled>false</Enabled><ExecutionTimeLimit>PT2M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings><Actions Context="Author"><Exec><Command>'+$exe+'</Command><Arguments>--run</Arguments></Exec></Actions></Task>'
    $installer=Join-Path $PSScriptRoot '..\client-compiled\Install-ResidentMode.ps1'
    & $installer -ExecutablePath $candidate|Out-Null
    if($global:ResidentInstallFixtureCalls.Count -ne 0 -or (Test-Path -LiteralPath (Join-Path $root 'installation-backups'))){throw '预览发生写入。'}
    $held=[IO.File]::Open((Join-Path $root '.collector.lock'),'OpenOrCreate','ReadWrite','None')
    try {
        $refused=$false;try{& $installer -ExecutablePath $candidate -Apply|Out-Null}catch{$refused=$true}
        if(-not $refused -or $global:ResidentInstallFixtureCalls.Count -ne 0){throw '运行中程序未拒绝覆盖。'}
    }finally{$held.Dispose()}
    & $installer -ExecutablePath $candidate -Apply|Out-Null
    if(($global:ResidentInstallFixtureCalls -join ',') -ne 'register' -or $global:ResidentInstallFixtureXml -notmatch '<Enabled>false</Enabled>' -or $global:ResidentInstallFixtureXml -match 'Repetition' -or $global:ResidentInstallFixtureXml -notmatch 'PT0S'){throw '常驻任务设置或禁用状态改变。'}
    if((Get-FileHash -LiteralPath (Join-Path $root 'config.json')).Hash -ne $configBefore -or (Get-FileHash -LiteralPath (Join-Path $root 'token.bin')).Hash -ne $tokenBefore){throw '已有配置或令牌被改写。'}
    & $installer -ExecutablePath $candidate -Apply -Start|Out-Null
    if(($global:ResidentInstallFixtureCalls -join ',') -ne 'register,register,enable,start'){throw '显式启动替身调用不正确。'}
    # 反向转换必须用常驻内部实际周期，不能用配置旧字段20分钟或期望值。
    [IO.File]::WriteAllText((Join-Path $root 'resident.schedule.json'),'{"interval_minutes":30}',[Text.UTF8Encoding]::new($false))
    $beforeSingle=$global:ResidentInstallFixtureCalls.Count
    & $installer -ExecutablePath $candidate -Mode Single -Apply|Out-Null
    if($global:ResidentInstallFixtureCalls.Count -ne $beforeSingle+1 -or [WindowsQuotaTaskStore]::Validate($root,$global:ResidentInstallFixtureXml) -ne 30 -or $global:ResidentInstallFixtureXml -notmatch '<Enabled>false</Enabled>'){throw '反向转换未保持实际周期或禁用状态。'}
    if((Get-FileHash -LiteralPath (Join-Path $root 'config.json')).Hash -ne $configBefore -or (Get-FileHash -LiteralPath (Join-Path $root 'token.bin')).Hash -ne $tokenBefore){throw '单轮转换修改了身份或配置。'}
    & $installer -ExecutablePath $candidate -Mode Resident -Apply|Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'resident.paused.json'),'{"reason":"fixture"}',[Text.UTF8Encoding]::new($false))
    $pauseXml=$global:ResidentInstallFixtureXml;$pauseCalls=$global:ResidentInstallFixtureCalls.Count;$rejected=$false
    try{& $installer -ExecutablePath $candidate -Mode Single -Apply|Out-Null}catch{$rejected=$true}
    if(-not $rejected -or $global:ResidentInstallFixtureXml -cne $pauseXml -or $global:ResidentInstallFixtureCalls.Count -ne $pauseCalls -or -not (Test-Path -LiteralPath (Join-Path $root 'resident.paused.json'))){throw '常驻暂停被单轮转换绕过。'}
    # 确认前冻结快照必须绑定实际写入；不同XML在任何写入前拒绝。
    $raceCalls=$global:ResidentInstallFixtureCalls.Count;$rejected=$false
    try{& $installer -ExecutablePath $candidate -Mode Resident -Apply -ExpectedTaskXml ($global:ResidentInstallFixtureXml+' ')|Out-Null}catch{$rejected=$true}
    if(-not $rejected -or $global:ResidentInstallFixtureCalls.Count -ne $raceCalls){throw '确认期间任务漂移仍写入。'}
    [IO.File]::Delete((Join-Path $root 'resident.paused.json'))
    $global:ResidentInstallFixtureXml=$global:ResidentInstallFixtureXml.Replace('<Enabled>false</Enabled><ExecutionTimeLimit>','<Enabled>true</Enabled><ExecutionTimeLimit>')
    $snapshot=$global:ResidentInstallFixtureXml;$global:ModeInstallRace=$true;$global:ModeInstallExports=0;$raceCalls=$global:ResidentInstallFixtureCalls.Count;$rejected=$false
    try{& $installer -ExecutablePath $candidate -Mode Resident -Apply -Start -ExpectedTaskXml $snapshot|Out-Null}catch{$rejected=$true}finally{$global:ModeInstallRace=$false}
    if(-not $rejected -or $global:ResidentInstallFixtureCalls.Count -ne $raceCalls+1 -or $global:ResidentInstallFixtureCalls[$raceCalls] -ne 'register' -or $global:ResidentInstallFixtureXml -notmatch '<Enabled>false</Enabled><ExecutionTimeLimit>'){throw '启用前并发禁用未被保留。'}
    [Console]::WriteLine('PASS 常驻安装替身：预览、生命周期锁、无重复触发、无限执行期、禁用保持、配置令牌保持、显式启动')
    [Console]::WriteLine('PASS 双向模式替身：内部实际周期、反向禁用身份保持、暂停禁止绕过')
    [Console]::WriteLine('PASS 模式并发替身：确认前任务漂移零写入、启用前并发禁用不恢复')
    # 模拟常驻在首次只读任务快照期间写暂停后退出；安装器持锁后的第二道检查必须拒绝。
    $global:ModeInstallPauseRace=$true;$raceCalls=$global:ResidentInstallFixtureCalls.Count;$raceXml=$global:ResidentInstallFixtureXml
    $raceHash=(Get-FileHash -LiteralPath (Join-Path $root 'bin\CodexQuotaCollector.exe')).Hash;$rejected=$false
    try{& $installer -ExecutablePath $candidate -Mode Single -Apply|Out-Null}catch{$rejected=$true}
    if(-not $rejected -or $global:ResidentInstallFixtureCalls.Count -ne $raceCalls -or $global:ResidentInstallFixtureXml -cne $raceXml -or (Get-FileHash -LiteralPath (Join-Path $root 'bin\CodexQuotaCollector.exe')).Hash -ne $raceHash){throw '取锁前新增暂停被单轮绕过。'}
    [Console]::WriteLine('PASS 模式暂停竞态：预检后新增暂停在持锁后拒绝，程序任务不变')
}finally{
    $env:LOCALAPPDATA=$originalLocal
    # 仅保留本次合成证据目录，不用递归删除掩盖测试失败。
    [Console]::WriteLine('隔离证据：'+$fixture)
}
