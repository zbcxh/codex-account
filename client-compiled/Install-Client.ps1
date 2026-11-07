<#
.SYNOPSIS
直接配对并安装编译采集器；新旧设备均启用任务并直接采集上报一次，之后按周期运行。
.PARAMETER Server
新设备的 HTTP/HTTPS 服务地址；已配对设备默认沿用现有地址。
.PARAMETER Label
新设备显示名称；已有设备保持原值。
.PARAMETER ExecutablePath
包内编译采集器路径；未指定时在脚本体定位同目录bin，兼容空脚本根目录。
.PARAMETER PrepareOnly
供统一模式入口先完成新设备配对与程序准备；任务保持禁用，不立即采集。
.OUTPUTS
安装程序路径及私有备份位置，不输出配对码或设备令牌。
#>
[CmdletBinding()]
param([string]$Server,[string]$Label,[string]$ExecutablePath,[switch]$PrepareOnly)
$ErrorActionPreference='Stop'
# 部分启动环境在参数默认值求值时尚无脚本根目录；在脚本体解析，并且只回退到脚本文件路径。
if([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $installerDirectory=$PSScriptRoot
    if([string]::IsNullOrWhiteSpace($installerDirectory)) {
        $installerFile=$PSCommandPath
        if([string]::IsNullOrWhiteSpace($installerFile)){$installerFile=$MyInvocation.MyCommand.Path}
        if([string]::IsNullOrWhiteSpace($installerFile)){throw '无法定位安装脚本目录，请保存并使用 -File 运行，或显式指定 -ExecutablePath。'}
        $installerDirectory=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($installerFile))
    }
    $ExecutablePath=[IO.Path]::Combine($installerDirectory,'bin','CodexQuotaCollector.exe')
}

$admin=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){throw '请以管理员身份运行；不会自动提权。'}
$ExecutablePath=[IO.Path]::GetFullPath($ExecutablePath)
if(-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)){throw '缺少包内编译程序。'}
[void][Reflection.Assembly]::LoadFrom($ExecutablePath)
Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName System.Security
$root=Join-Path $env:LOCALAPPDATA 'CodexQuota'
$json=New-Object Web.Script.Serialization.JavaScriptSerializer

function Invoke-InstalledCollectorProcess {
    <#
    .SYNOPSIS
    在当前同一Windows用户下直接执行已安装采集器一次，捕获有限业务结果供上层判断。
    .PARAMETER ExecutablePath
    已核验的本机编译采集器路径。
    .OUTPUTS
    原生进程退出码和输出；不主动查询或打印凭据。
    #>
    param([string]$ExecutablePath)
    $previousPreference=$ErrorActionPreference
    try {
        # 捕获原生错误流，避免PS5.1先把非零退出当作终止错误而丢掉采集器脱敏JSON。
        $ErrorActionPreference='Continue'
        $output=@(& $ExecutablePath --run 2>&1)
        $code=$LASTEXITCODE
    } finally {$ErrorActionPreference=$previousPreference}
    return [pscustomobject]@{ExitCode=$code;Output=(($output|ForEach-Object {$_.ToString()}) -join [Environment]::NewLine)}
}
function Invoke-InstalledCollectorOnce {
    <#
    .SYNOPSIS
    区分实际送达、排队、并发运行和失败，不把计划任务受理当作上报成功。
    .PARAMETER ExecutablePath
    已核验的本机采集器路径。
    .OUTPUTS
    Status及可选HttpStatus；无法确认结果或采集失败时抛出脱敏错误。
    #>
    param([string]$ExecutablePath)
    $process=Invoke-InstalledCollectorProcess -ExecutablePath $ExecutablePath
    try {
        if([string]::IsNullOrWhiteSpace($process.Output) -or $process.Output.Length -gt 65536){throw 'invalid_result'}
        $result=$json.DeserializeObject($process.Output)
        if($result -isnot [Collections.IDictionary]){throw 'invalid_result'}
    } catch {throw '程序和任务已安装，但无法识别立即采集结果；请保留配置和凭据，反馈运行日志。'}
    if($process.ExitCode -eq 0 -and $result['ok'] -eq $true -and $result['sent_report'] -eq $true){return [pscustomobject]@{Status='reported'}}
    if($process.ExitCode -eq 0 -and $result['ok'] -eq $true -and $result['skipped'] -eq 'collector_busy'){return [pscustomobject]@{Status='busy'}}
    if($result['queued'] -eq $true){
        $status=if($result['http_status'] -is [int] -and $result['http_status'] -ge 0 -and $result['http_status'] -le 599){$result['http_status']}else{0}
        return [pscustomobject]@{Status='queued';HttpStatus=$status}
    }
    $code=if($result['error'] -is [string] -and $result['error'] -match '^[a-z_]{1,64}$'){$result['error']}else{'collector_failed'}
    throw ('程序和任务已安装，但立即采集失败：'+$code+'；请保留原配置和凭据。')
}
function Start-UpgradedQuotaTask {
    <#
    .SYNOPSIS
    确认新旧设备任务仍指向本机编译采集器，启用后直接采集一次。
    .PARAMETER TaskName
    已验证归属的采集任务名称。
    .PARAMETER TaskPath
    已验证归属的任务文件夹。
    .PARAMETER ExpectedExecutable
    本机安装后的编译采集器绝对路径。
    .OUTPUTS
    采集结果状态；失败或排队不会误报已送达。
    #>
    param([string]$TaskName,[string]$TaskPath,[string]$ExpectedExecutable)
    $task=Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    # 启用前后都核对动作，避免并发改动后意外启用或运行其他程序。
    if(@($task.Actions).Count -ne 1 -or -not [string]::Equals([string]$task.Actions[0].Execute,$ExpectedExecutable,[StringComparison]::OrdinalIgnoreCase) -or ([string]$task.Actions[0].Arguments).Trim() -ne '--run'){throw '任务动作已改变，停止启用和触发。'}
    if(-not $task.Settings.Enabled){Enable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop|Out-Null}
    $readback=Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
    if(-not $readback.Settings.Enabled){throw '任务启用后读回仍为禁用状态，未触发采集。'}
    if(@($readback.Actions).Count -ne 1 -or -not [string]::Equals([string]$readback.Actions[0].Execute,$ExpectedExecutable,[StringComparison]::OrdinalIgnoreCase) -or ([string]$readback.Actions[0].Arguments).Trim() -ne '--run'){throw '任务动作并发改变，未触发采集。'}
    return Invoke-InstalledCollectorOnce -ExecutablePath $ExpectedExecutable
}
function Set-InstallPrivateDirectory {
    <#
    .SYNOPSIS
    创建只允许当前用户、SYSTEM和管理员访问的目录。
    .PARAMETER Path
    本机监控或私有备份目录。
    .OUTPUTS
    无。
    #>
    param([string]$Path)
    if((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw '拒绝链接目录。'}
    [void][IO.Directory]::CreateDirectory($Path)
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
        $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Write-InstallToken {
    <#
    .SYNOPSIS
    持久化新设备的加密令牌，不覆盖已有令牌。
    .PARAMETER Name
    监控目录内的固定令牌文件名。
    .PARAMETER Bytes
    已由DPAPI加密的字节。
    .OUTPUTS
    无。
    #>
    param([string]$Name,[byte[]]$Bytes)
    $target=Join-Path $root $Name
    if(Test-Path -LiteralPath $target){throw '已有令牌文件，停止覆盖。'}
    $temporary=Join-Path $root ([Guid]::NewGuid().ToString('N')+'.tmp')
    try {
        $stream=New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
        [IO.File]::Move($temporary,$target)
    } finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary}}
}
# 先检查已有私有目录，避免安装动作悄悄修复或覆盖异常权限及链接。
if(Test-Path -LiteralPath $root){[QuotaClient]::CheckPrivate($root)}else{Set-InstallPrivateDirectory $root}
$configPath=Join-Path $root 'config.json'
$cfg=[QuotaClient]::Read($configPath,$true)
$taskName=if($cfg.ContainsKey('task_name')){[string]$cfg['task_name']}else{'CodexQuotaMonitor'}
if(-not $taskName -or $taskName.Contains('\')){throw '本机任务名异常，停止安装。'}
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$store=New-Object WindowsQuotaTaskStore
$owned=if($task){$store.Read($root,$cfg)}else{$null}
$held=New-Object IO.FileStream((Join-Path $root '.collector.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$backup=Join-Path $env:LOCALAPPDATA ('CodexQuotaInstallBackups\'+[Guid]::NewGuid().ToString('N'))
try {
    Set-InstallPrivateDirectory $backup
    # 只备份当前程序、配置、凭据和任务，不复制历史额度、缓存、队列或日志。
    foreach($name in @('config.json','token.bin','token.lm.bin','bin\CodexQuotaCollector.exe')) {
        $path=Join-Path $root $name
        if(Test-Path -LiteralPath $path){Copy-Item -LiteralPath $path -Destination (Join-Path $backup ([IO.Path]::GetFileName($name)))}
    }
    if($owned){[IO.File]::WriteAllText((Join-Path $backup 'task.xml'),$owned.Xml)}
    $paired=(Test-Path -LiteralPath (Join-Path $root 'token.bin')) -or (Test-Path -LiteralPath (Join-Path $root 'token.lm.bin'))
    if($paired) {
        [void][QuotaClient]::Token($root)
        if(-not $cfg.ContainsKey('client_id') -or -not $cfg.ContainsKey('server_url')){throw '现有配对配置不完整，停止，不自动重新配对。'}
        if($Server -and $Server.TrimEnd('/') -ne ([string]$cfg['server_url']).TrimEnd('/')){throw '已有配对不允许通过安装器修改服务地址。'}
    } else {
        if(-not $Server -and $cfg.ContainsKey('server_url')){$Server=[string]$cfg['server_url']}
        if(-not $Server){$Server=(Read-Host '服务器 HTTP/HTTPS 地址').Trim()}
        $endpoint=[QuotaPrototype]::Endpoint($Server)
        $pairUri=$endpoint.AbsoluteUri.Substring(0,$endpoint.AbsoluteUri.Length-6)+'pair'
        if(-not $cfg.ContainsKey('client_id')){$cfg['client_id']=[Guid]::NewGuid().ToString()}
        if(-not $Label){$Label=$env:COMPUTERNAME}
        $cfg['server_url']=$Server.TrimEnd('/');$cfg['label']=$Label;$cfg['hostname']=$env:COMPUTERNAME;$cfg['task_name']=$taskName
        # 配对前保存本机新UUID；响应丢失后仍可用同码同身份安全重试。
        [QuotaClient]::Atomic($root,$configPath,$json.Serialize($cfg))
        $secure=Read-Host '网页生成的设备配对码（不是 bootstrap 管理口令）' -AsSecureString
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
        try {$pairCode=[Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer)}
        $request=[Net.HttpWebRequest]::Create($pairUri)
        $request.Method='POST';$request.ContentType='application/json; charset=utf-8';$request.AllowAutoRedirect=$false
        $request.Timeout=20000;$request.ReadWriteTimeout=20000
        [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
        $request.Headers['x-quota-bootstrap']=$pairCode
        $bytes=[Text.Encoding]::UTF8.GetBytes($json.Serialize(@{client_id=$cfg['client_id'];hostname=$cfg['hostname'];label=$cfg['label']}))
        $request.ContentLength=$bytes.Length
        $stream=$request.GetRequestStream();try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
        $response=$request.GetResponse()
        try {
            $reader=New-Object IO.StreamReader($response.GetResponseStream(),[Text.Encoding]::UTF8)
            try {$chars=New-Object char[] 65537;$count=0;while($count -lt $chars.Length -and ($got=$reader.Read($chars,$count,$chars.Length-$count)) -gt 0){$count+=$got};if($count -gt 65536){throw '配对响应过大。'};$reply=$json.DeserializeObject((-join $chars[0..($count-1)]))}finally{$reader.Dispose()}
            if([int]$response.StatusCode -ne 200 -or -not $reply['token'] -or [string]$reply['token'] -notmatch '^[a-f0-9]{48}$'){throw '配对响应无效，停止。'}
        }finally{$response.Dispose();$pairCode=$null}
        $plain=[Text.Encoding]::UTF8.GetBytes([string]$reply['token'])
        Write-InstallToken 'token.bin' ([Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
        Write-InstallToken 'token.lm.bin' ([Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))
        [Array]::Clear($plain,0,$plain.Length);$reply=$null
    }
    $bin=Join-Path $root 'bin';[void][IO.Directory]::CreateDirectory($bin)
    $target=Join-Path $bin 'CodexQuotaCollector.exe'
    $temporary=Join-Path $bin ([Guid]::NewGuid().ToString('N')+'.tmp')
    Copy-Item -LiteralPath $ExecutablePath -Destination $temporary
    if(Test-Path -LiteralPath $target){[IO.File]::Replace($temporary,$target,[NullString]::Value)}else{[IO.File]::Move($temporary,$target)}
    $action=New-ScheduledTaskAction -Execute $target -Argument '--run'
    if($owned) {
        $current=$store.Read($root,$cfg)
        if($current.Xml -cne $owned.Xml){throw '任务并发改变，停止更新动作。'}
        $folder=$owned.Path.Substring(0,$owned.Path.LastIndexOf('\')+1)
        Set-ScheduledTask -TaskName $owned.Name -TaskPath $folder -Action $action -ErrorAction Stop|Out-Null
    } else {
        $trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
        $settings=New-ScheduledTaskSettingsSet -Priority 9 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -Hidden -Disable:$PrepareOnly
        $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType S4U -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Codex 编译额度采集器'|Out-Null
    }
    # 已配对设备升级不重写配置，保留原字段和字节；新设备持久化任务名称。
    if(-not $paired){$cfg['task_name']=$taskName;[QuotaClient]::Atomic($root,$configPath,$json.Serialize($cfg))}
}finally{$held.Dispose()}
if($PrepareOnly){Write-Output '程序及配对已准备，未启用任务或执行采集；继续由统一入口应用所选模式。';return}
# 必须先释放安装锁；新旧设备均直接采集一次，不再只提交无法确认执行结果的任务请求。
$resumePath=if($owned){$folder}else{'\'}
Write-Host '程序与任务已安装，正在立即采集并尝试上报，请稍候…'
$initialReport=Start-UpgradedQuotaTask -TaskName $taskName -TaskPath $resumePath -ExpectedExecutable $target
if($initialReport.Status -eq 'reported'){Write-Output ('安装完成；立即采集已送达服务器。私有备份：'+$backup)}
elseif($initialReport.Status -eq 'queued'){Write-Warning ('安装完成；本次额度已排队，尚未送达服务器，HTTP状态：'+$initialReport.HttpStatus+'。请检查地址、网络及服务端设备授权；不要删除配置重新配对。')}
else{Write-Output ('安装完成；已有采集正在运行，本次未重复执行。请稍后核对面板。私有备份：'+$backup)}
