<#
Codex 额度监控服务器的启停与开机自启控制脚本（PowerShell 5.1，无依赖）。

  -Action install   注册/更新计划任务 CodexQuotaServer：开机即启动、不登录也启动、后台无窗口
  -Action start     拉起服务器（任务不存在时先注册），等到端口能连上才返回
  -Action stop      停掉任务和监听端口的 node
  -Action restart   stop + start
  -Action status    看配置、任务状态、端口、日志位置
  -Action run       任务的执行入口，前台占住任务进程并写日志；不要手工长期用它
  -Action uninstall 删除计划任务（不删数据、不删防火墙规则）

口令与端口放在 server\server.config.json，不进任务计划的参数，也不进文档。
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'start', 'stop', 'restart', 'status', 'run', 'uninstall')]
    [string]$Action = 'status',
    [string]$TaskName = 'CodexQuotaServer'
)

$ErrorActionPreference = 'Stop'

$root       = Split-Path -Parent $PSScriptRoot
$serverDir  = Join-Path $root 'server'
$entry      = Join-Path $serverDir 'server.mjs'
$configPath = Join-Path $serverDir 'server.config.json'
$dataDir    = Join-Path $serverDir 'data'
$log        = Join-Path $dataDir 'server.log'
$errLog     = Join-Path $dataDir 'server.err.log'
$self       = Join-Path $PSScriptRoot 'codex-quota-server.ps1'
$taskDesc   = 'Codex 额度监控服务器（开机自启、后台无窗口）'

function Read-ServerConfig {
    if (-not (Test-Path $configPath)) { throw "找不到配置文件：$configPath" }
    if (-not (Test-Path $entry)) { throw "找不到服务器入口：$entry" }
    $c = Get-Content -Raw -Path $configPath | ConvertFrom-Json
    if (-not $c.bootstrap) { throw "$configPath 里没有 bootstrap，客户端无法配对。" }
    $node = [string]$c.node
    if (-not $node) {
        $g = Get-Command node -ErrorAction SilentlyContinue
        if ($g) { $node = $g.Source }
    }
    if (-not $node -or -not (Test-Path $node)) {
        throw "node.exe 路径无效（配置里的 node 字段为空或不存在），PATH 里也找不到 node。请在 $configPath 的 node 字段填绝对路径。"
    }
    $port = 8787
    if ($c.port) { $port = [int]$c.port }
    [pscustomobject]@{
        Node      = $node
        Port      = $port
        Bootstrap = [string]$c.bootstrap
        Allow     = [string]$c.allow
        ReadGate  = [string]$c.read_gate
    }
}

function Get-Listener([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
        IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-BootTask {
    if (-not (Test-Admin)) { throw '注册/修改计划任务需要管理员权限，请在管理员窗口里再跑一次。' }
    $null = Read-ServerConfig
    $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -Action run" `
        -WorkingDirectory $serverDir
    # AtStartup + S4U：开机就起、不依赖有人登录，会话 0 里跑，天然没有窗口。
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Set-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
        Write-Host "已更新计划任务 $TaskName（开机自启 / 免登录 / 后台）"
    } else {
        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings `
            -Principal $principal -Description $taskDesc | Out-Null
        Write-Host "已注册计划任务 $TaskName（开机自启 / 免登录 / 后台）"
    }
}

function Invoke-Run {
    $cfg = Read-ServerConfig
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    # 每次启动开一份新日志，上一份留成 .old，避免日志无限增长
    foreach ($f in @($log, $errLog)) {
        if (Test-Path $f) { Move-Item -Path $f -Destination "$f.old" -Force }
    }
    $argList = @('--no-warnings', $entry, '--port', $cfg.Port, '--bootstrap', $cfg.Bootstrap)
    if ($cfg.Allow) { $argList += @('--allow', $cfg.Allow) }
    if ($cfg.ReadGate) { $argList += @('--read-gate', $cfg.ReadGate) }
    $proc = Start-Process -FilePath $cfg.Node -ArgumentList $argList -WorkingDirectory $serverDir `
        -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $errLog
    Write-Host "node 已拉起（PID $($proc.Id)），日志：$log"
    Wait-Process -Id $proc.Id
    $code = try { $proc.ExitCode } catch { $null }
    "exit=$code at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Add-Content -Path $errLog
}

function Start-QuotaServer {
    $cfg = Read-ServerConfig
    $existing = Get-Listener $cfg.Port
    if ($existing) {
        Write-Host "端口 $($cfg.Port) 已在监听（PID $($existing.OwningProcess)），服务器本来就活着，不用重复启动。"
        Write-Host "要看面板：http://localhost:$($cfg.Port)"
        return
    }
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Install-BootTask }
    Start-ScheduledTask -TaskName $TaskName
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Get-Listener $cfg.Port) {
            Write-Host "启动成功，面板 http://localhost:$($cfg.Port) （日志：$log）"
            return
        }
    }
    Write-Warning "20 秒内端口 $($cfg.Port) 没起来。看日志：$log 和 $errLog"
    Get-Content $errLog -Tail 10 -ErrorAction SilentlyContinue
}

function Test-QuotaServerProcess {
    <#
    .SYNOPSIS
    以可执行文件路径和实际入口参数核验监听进程，不按进程名或任意参数子串猜测归属。
    .PARAMETER Process
    Win32_Process 查询返回的进程身份。
    .PARAMETER NodePath
    本项目配置的 Node 绝对路径。
    .PARAMETER EntryPath
    本项目服务器入口绝对路径。
    .OUTPUTS
    身份信息完整且符合当前服务启动方式时返回真，否则返回假。
    #>
    param($Process,[string]$NodePath,[string]$EntryPath)
    if(-not $Process -or -not $Process.ExecutablePath -or -not $Process.CommandLine -or -not $Process.CreationDate){return $false}
    try {
        if(-not [string]::Equals([IO.Path]::GetFullPath([string]$Process.ExecutablePath),[IO.Path]::GetFullPath($NodePath),[StringComparison]::OrdinalIgnoreCase)){return $false}
        # 入口必须是 Node 选项之后的脚本参数，不能只是其他项目命令行中的备注或附带参数。
        $escapedEntry=[regex]::Escape([IO.Path]::GetFullPath($EntryPath))
        $pattern='^(?:"[^"]+"|\S+)\s+(?:--no-warnings\s+)?(?:"'+$escapedEntry+'"|'+$escapedEntry+')(?:\s|$)'
        return [regex]::IsMatch([string]$Process.CommandLine,$pattern,([Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::CultureInvariant))
    } catch {return $false}
}

function Stop-QuotaServer {
    <#
    .SYNOPSIS
    停止已确认属于本项目的任务及残留监听进程；归属未知或 PID 被复用时拒绝终止。
    .OUTPUTS
    脱敏停止结果；无参数，拒绝时抛出错误且不终止未知进程。
    #>
    $cfg = Read-ServerConfig
    $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if($task){
        $expectedArguments='-NoProfile -ExecutionPolicy Bypass -File "'+$self+'" -Action run'
        $action=@($task.Actions)
        $systemShell=[IO.Path]::Combine($env:WINDIR,'System32\WindowsPowerShell\v1.0\powershell.exe')
        # 同名计划任务可能已被其他程序替换，先核对动作再停止，不能先产生副作用。
        if($action.Count -ne 1 -or ([string]$action[0].Execute -ine 'powershell.exe' -and [string]$action[0].Execute -ine $systemShell) -or
            [string]$action[0].Arguments -ine $expectedArguments -or [string]$action[0].WorkingDirectory -ine $serverDir){throw '服务任务动作不属于本项目，未停止任务或进程。'}
    }
    $before=Get-Listener $cfg.Port
    $identity=$null
    if($before){
        $identity=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$before.OwningProcess) -ErrorAction SilentlyContinue
        if(-not (Test-QuotaServerProcess -Process $identity -NodePath $cfg.Node -EntryPath $entry)){throw '监听进程归属无法确认，未停止任务或进程。'}
    }
    if($task){Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop}
    $l = Get-Listener $cfg.Port
    if (-not $l) { Write-Host "端口 $($cfg.Port) 上没有在监听的进程，已经停了。"; return }
    $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    $current=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$l.OwningProcess) -ErrorAction SilentlyContinue
    # 两种进程查询接口的时间精度可能不同，跨来源比较允许不足 1 秒的误差。
    $sameStartTime = $p -and $current -and $current.CreationDate -and
        [Math]::Abs(($p.StartTime.ToUniversalTime() - $current.CreationDate.ToUniversalTime()).TotalSeconds) -lt 1
    # 停止任务与重新查询之间 PID 可能变化或复用；再次核对创建时间和入口，未知状态一律不杀。
    if ($identity -and $p -and $l.OwningProcess -eq $before.OwningProcess -and
        (Test-QuotaServerProcess -Process $current -NodePath $cfg.Node -EntryPath $entry) -and
        $current.CreationDate -eq $identity.CreationDate -and $sameStartTime) {
        Stop-Process -InputObject $p -Force
        Write-Host "已停止残留的 node（PID $($p.Id)）——任务计划杀掉父进程时子进程偶尔会活下来。"
    } else {
        throw '监听进程已变化或无法确认归属，未终止该进程。'
    }
}

function Show-Status {
    $cfg = Read-ServerConfig
    $masked = if ($cfg.Bootstrap.Length -gt 6) { $cfg.Bootstrap.Substring(0, 4) + ('*' * ($cfg.Bootstrap.Length - 6)) + $cfg.Bootstrap.Substring($cfg.Bootstrap.Length - 2) } else { '****' }
    Write-Host "配置  端口 $($cfg.Port) · 口令 $masked · node $($cfg.Node)"
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        $info = $t | Get-ScheduledTaskInfo
        $trigger = ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
        Write-Host "任务  $TaskName · 状态 $($t.State) · 触发器 $trigger · 登录方式 $($t.Principal.LogonType)"
        Write-Host "      上次运行 $($info.LastRunTime) · 返回 $($info.LastTaskResult) · 下次运行 $($info.NextRunTime)"
    } else {
        Write-Host "任务  未注册（跑 -Action install 注册开机自启）"
    }
    $l = Get-Listener $cfg.Port
    if ($l) { Write-Host "端口  $($cfg.Port) 正在监听（PID $($l.OwningProcess)）· 面板 http://localhost:$($cfg.Port)" }
    else { Write-Host "端口  $($cfg.Port) 没在监听，面板不可用" }
    Write-Host "日志  $log / $errLog"
}

function Uninstall-BootTask {
    if (-not (Test-Admin)) { throw '删除计划任务需要管理员权限。' }
    Stop-QuotaServer
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已删除计划任务 $TaskName（数据文件和防火墙规则没动）。"
}

switch ($Action) {
    'install'   { Install-BootTask }
    'run'       { Invoke-Run }
    'start'     { Start-QuotaServer }
    'stop'      { Stop-QuotaServer }
    'restart'   { Stop-QuotaServer; Start-Sleep -Seconds 1; Start-QuotaServer }
    'status'    { Show-Status }
    'uninstall' { Uninstall-BootTask }
}
