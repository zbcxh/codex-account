<#
.SYNOPSIS
双击入口的管理员提权与交互引导，不重配已有设备。
.PARAMETER Elevated
标记已请求过提权，避免循环请求。
.PARAMETER ExpectedUserSid
原启动用户SID，仅用于拒绝跨Windows用户安装，不含凭据。
.OUTPUTS
交互安装结果及退出码；不输出配对码或设备令牌。
#>
[CmdletBinding()]
param([switch]$Elevated,[string]$ExpectedUserSid)
$ErrorActionPreference='Stop'
function New-ElevatedInstallArguments {
    <#
    .SYNOPSIS
    构造固定的脚本文件提权参数，不把路径或SID当作PowerShell表达式执行。
    .PARAMETER ScriptPath
    本启动器的绝对文件路径。
    .PARAMETER UserSid
    原Windows用户SID。
    .OUTPUTS
    供系统powershell.exe使用的参数字符串。
    #>
    param([string]$ScriptPath,[string]$UserSid)
    # 文件路径始终加双引号；SID只接受系统格式，拒绝向命令行注入额外参数。
    if([string]::IsNullOrWhiteSpace($ScriptPath) -or $ScriptPath.Contains('"') -or $UserSid -notmatch '^S-\d+(?:-\d+)+$'){throw '安装启动参数不合法。'}
    $full=[IO.Path]::GetFullPath($ScriptPath)
    return '-NoProfile -ExecutionPolicy Bypass -File "'+$full+'" -Elevated -ExpectedUserSid '+$UserSid
}
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $sid=$identity.User.Value
    $admin=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $scriptFile=$PSCommandPath
    if([string]::IsNullOrWhiteSpace($scriptFile)){$scriptFile=$MyInvocation.MyCommand.Path}
    if([string]::IsNullOrWhiteSpace($scriptFile)){throw '无法定位启动器，请先解压整个安装包，再双击Install.cmd。'}
    if(-not $admin) {
        if($Elevated){throw '尚未取得管理员权限，请使用同一Windows用户的管理员授权。'}
        $systemShell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments=New-ElevatedInstallArguments -ScriptPath $scriptFile -UserSid $sid
        # 用户明确要求双击提权；保留可见窗口用于配对码隐藏输入与安装结果确认。
        $child=Start-Process -FilePath $systemShell -Verb RunAs -ArgumentList $arguments -WindowStyle Normal -Wait -PassThru
        exit $child.ExitCode
    }
    if($ExpectedUserSid -and $ExpectedUserSid -ne $sid){throw '提权后Windows用户发生变化，已停止。请使用登录Codex的同一用户，避免把凭据安装到另一个用户。'}
    $installer=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($scriptFile))) 'Install-Client.ps1'
    if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw '缺少Install-Client.ps1，请完整解压测试包。'}
    $packageDirectory=Split-Path -Parent $installer
    . (Join-Path $packageDirectory 'Install-Mode.Core.ps1')
    $modeInstaller=Join-Path $packageDirectory 'Install-ResidentMode.ps1'
    $candidate=Join-Path $packageDirectory 'bin\CodexQuotaCollector.exe'
    if(-not (Test-Path -LiteralPath $candidate -PathType Leaf)){$candidate=Join-Path $packageDirectory 'CodexQuotaCollector.exe'}
    if(-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or -not (Test-Path -LiteralPath $modeInstaller -PathType Leaf)){throw '缺少模式安装依赖，请完整解压安装包。'}
    [void][Reflection.Assembly]::LoadFrom($candidate)
    Write-Host '请选择运行模式：1. 单轮模式（默认，每次采集后退出）；2. 常驻模式（复用官方进程）。'
    $mode=$null
    # 输入错误时只重新询问，不执行安装或静默回退。
    while(-not $mode){try{$mode=Resolve-InstallMode (Read-Host '输入1或2，直接回车选择单轮')}catch{Write-Host $_.Exception.Message -ForegroundColor Yellow}}
    $root=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexQuota'))
    $paired=(Test-Path -LiteralPath (Join-Path $root 'token.bin')) -or (Test-Path -LiteralPath (Join-Path $root 'token.lm.bin'))
    $options=@{}
    $previousMode=$null;$wasEnabled=$false
    if($paired){
        [QuotaClient]::CheckPrivate($root)
        $existing=[QuotaClient]::Read((Join-Path $root 'config.json'),$false)
        $name=if($existing.ContainsKey('task_name')){[string]$existing['task_name']}else{'CodexQuotaMonitor'}
        $tasks=@(Get-ScheduledTask -TaskName $name -ErrorAction Stop)
        if($tasks.Count -ne 1){throw '已有任务归属不唯一，停止。'}
        $xml=Export-ScheduledTask -TaskName $tasks[0].TaskName -TaskPath $tasks[0].TaskPath -ErrorAction Stop
        $doc=[WindowsQuotaTaskStore]::Parse($xml)
        $arg=$doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']/*[local-name()='Arguments']")
        if($arg -and $arg.InnerText -eq '--resident'){[ResidentTaskDefinition]::Validate($root,$xml);$previousMode='Resident'}else{[void][WindowsQuotaTaskStore]::Validate($root,$xml);$previousMode='Single'}
        $enabled=$doc.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']")
        $wasEnabled=-not $enabled -or $enabled.InnerText -ne 'false'
    }
    if(-not $paired) {
        Write-Host '首次安装：请输入服务器地址、设备名称，随后在隐藏输入处填写页面生成的配对码。'
        $options.Server=(Read-Host '服务器HTTP/HTTPS地址').Trim()
        if([string]::IsNullOrWhiteSpace($options.Server)){throw '服务器地址不能为空。'}
        $label=(Read-Host '设备显示名称（回车使用电脑名称）').Trim()
        if($label){$options.Label=$label}
    } else {Write-Host '检测到已有配对，将沿用原client_id、服务地址和设备令牌，不重新配对。'}
    $paused=Test-Path -LiteralPath (Join-Path $root 'resident.paused.json')
    $outcome=Invoke-InstallModeFlow -Mode $mode -Paired $paired -PreviousMode $previousMode -WasEnabled $wasEnabled -Paused $paused -ConfirmSwitch {
        param($old,$next)
        Write-Host ('当前模式 '+$old+'，目标模式 '+$next+'。切换保留设备身份、实际周期及禁用/暂停状态。')
        return (Read-Host '确认切换请输入 YES，其他输入取消') -ceq 'YES'
    } -Prepare {& $installer @options -ExecutablePath $candidate -PrepareOnly;if(-not $?){throw '新设备准备失败。'}} -Apply {
        param($selectedMode,$start)
        $expected=if($paired){$xml}else{$null}
        & $modeInstaller -ExecutablePath $candidate -Mode $selectedMode -Apply -Start:$start -ExpectedTaskXml $expected
        if(-not $?){throw '模式应用失败，请保留配置和凭据。'}
    }
    if($outcome -eq 'Cancelled'){Write-Host '已取消，未修改程序、配置或任务。'}else{Write-Host ('安装模式 '+$mode+' 已应用；原禁用或暂停设备保持停止。任务请求启动不等于额度送达，请查看面板核实。')}
    Write-Host '关闭本窗口后可删除ZIP和解压目录。'
    [void](Read-Host '按Enter关闭窗口')
    exit 0
} catch {
    Write-Host ('安装未完成：'+$_.Exception.Message) -ForegroundColor Red
    Write-Host '取消UAC不会执行安装。不要删除已有CodexQuota配置或凭据来重试。'
    [void](Read-Host '按Enter关闭窗口')
    exit 1
}
