<#
  重启验证取证（临时任务，PowerShell 5.1，零依赖）

  回答一个问题：**这台机器重启后、没有人登录，服务器起来了没、客户端还在上报没、IP 还是不是那个 IP。**
  不登录就没人在场看，所以它每 5 分钟把实况追加进 %LOCALAPPDATA%\CodexQuota\logs\bootcheck.log，
  等你登录回来读这个文件就行。

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\codex-quota-bootcheck.ps1 -Action install
    :: 然后重启，什么都不点，等 10~15 分钟，再登录回来
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\codex-quota-bootcheck.ps1 -Action show
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\codex-quota-bootcheck.ps1 -Action uninstall   :: 用完必须删
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall', 'run', 'show')]
    [string]$Action = 'run',
    [int]$IntervalMinutes = 5,
    [int]$Hours = 6
)

$ErrorActionPreference = 'Stop'

$dir        = Join-Path $env:LOCALAPPDATA 'CodexQuota'
$binDir     = Join-Path $dir 'bin'
$logDir     = Join-Path $dir 'logs'
$log        = Join-Path $logDir 'bootcheck.log'
$taskName   = 'CodexQuotaBootCheck'
$installed  = Join-Path $binDir 'codex-quota-bootcheck.ps1'
$serverTask = 'CodexQuotaServer'
$clientTask = 'CodexQuotaMonitor'
$port       = 8787

function Test-IsAdmin {
    (New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent())
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Evidence {
    $out = New-Object System.Collections.Generic.List[string]
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    $upMin = [int]((Get-Date) - $boot).TotalMinutes
    $out.Add(('[{0}] ===== 开机后第 {1} 分钟（本次采集 {2}） =====' -f `
        (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $upMin, (Get-Date -Format 'HH:mm:ss')))

    # 有人登录没有：explorer 只存在于交互桌面会话，LogonUI 只在登录界面/锁屏时存在。
    # 这两个比 Win32_ComputerSystem.NumberOfLoggedOnUsers 可靠（后者在无登录时仍会报数）。
    $explorer = @(Get-Process explorer -ErrorAction SilentlyContinue)
    $logonui  = @(Get-Process LogonUI -ErrorAction SilentlyContinue)
    $out.Add(('  登录状态   = explorer {0} 个 · LogonUI {1} 个（期望 0 与 >0：停在登录界面、无人登录）' -f `
        $explorer.Count, $logonui.Count))

    # 服务器：端口在不在、属主进程跑在哪个会话
    $listen = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listen.Count -eq 0) {
        $out.Add("  服务器      = 端口 $port 没在监听  ← 开机自启失败")
    } else {
        foreach ($l in $listen) {
            $procId = $l.OwningProcess
            $sess = try { (Get-Process -Id $procId).SessionId } catch { '?' }
            $name = try { (Get-Process -Id $procId).ProcessName } catch { '?' }
            $out.Add(('  服务器      = {0}:{1} 由 PID {2}（{3}）监听，会话号 {4}{5}' -f `
                $l.LocalAddress, $port, $procId, $name, $sess, $(if ($sess -eq 0) { '（无头，符合预期）' } else { ' ← 不是会话 0' })))
        }
    }

    # 两个计划任务：这次开机后各跑过没有、返回码
    foreach ($t in @($serverTask, $clientTask)) {
        $info = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if (-not $info) { $out.Add("  任务 $t     = 不存在"); continue }
        $ci = $info | Get-ScheduledTaskInfo
        $lag = if ($ci.LastRunTime) { [int]((Get-Date) - $ci.LastRunTime).TotalMinutes } else { -1 }
        # 267009(0x41301) = 任务此刻正在运行，对常驻的服务器任务是正常值，别当成失败。
        $note = switch ([int]$ci.LastTaskResult) { 0 { '(成功)' } 267009 { '(仍在运行，常驻任务正常)' } 1 { '(脚本返回 1，看 report.log)' } default { '' } }
        $out.Add(('  任务 {0} = {1} · 登录方式 {2} · 上次 {3}（{4} 分钟前）· 返回 {5}{6} · 漏跑 {7} · 下次 {8}' -f `
            $t, $info.State, $info.Principal.LogonType, $ci.LastRunTime, $lag, $ci.LastTaskResult, $note, $ci.NumberOfMissedRuns, $ci.NextRunTime))
    }

    # IP 还是不是那个：路由器绑定生效的话，这里必须仍是 192.168.18.8
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '192.168.*' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)($($_.InterfaceAlias))" })
    $out.Add('  内网地址    = ' + $(if ($ips.Count) { $ips -join ' ' } else { '一个都没有 ← 网卡没起来' }))

    # 以"已配对机器的视角"读一次面板：目的地址用内网 IP，来源就是这台自己的内网 IP，
    # 走的是读取闸门放行那条路，能顺带确认闸门没把服务器自己挡在门外。
    $lan = ($ips | Where-Object { $_ -like '192.168.18.*' } | Select-Object -First 1)
    if ($lan) {
        $lanIp = ($lan -split '/')[0]
        $stateFile = Join-Path $env:TEMP 'cq-bootcheck-state.json'
        # try 块的"最后一个表达式"就是返回值，所以别在块里把结果赋回同名变量（会拿到旧的空值）。
        $readable = try {
            $http = ((& curl.exe -s -m 8 -o $stateFile -w '%{http_code}' "http://${lanIp}:${port}/api/state") -join '')
            $j = $null
            if (Test-Path -LiteralPath $stateFile) {
                $j = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            }
            $m = if ($j -and $j.machines) { @($j.machines).Count } else { 0 }
            $a = if ($j -and $j.accounts) { @($j.accounts).Count } else { 0 }
            "HTTP $http · 机器 $m 台 · 账号 $a 个"
        } catch { "读取失败：$($_.Exception.Message)" }
        $out.Add("  面板可读性  = $readable")
    } else {
        $out.Add('  面板可读性  = 跳过（没有 192.168.x 地址）')
    }

    # 客户端有没有真的在报：直接看它自己的日志尾两行
    $cl = Join-Path $logDir 'report.log'
    if (Test-Path -LiteralPath $cl) {
        $tail = Get-Content -LiteralPath $cl -Tail 2 -Encoding UTF8
        foreach ($line in $tail) { $out.Add("    report.log: $line") }
    } else {
        $out.Add('    report.log: 还没有这个文件')
    }
    return $out
}

switch ($Action) {
    'run' {
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        $lines = Get-Evidence
        foreach ($l in $lines) { Write-Host $l }
        $lines | Add-Content -LiteralPath $log -Encoding UTF8
        exit 0
    }
    'show' {
        if (-not (Test-Path -LiteralPath $log)) { Write-Warning "还没有取证文件：$log"; exit 1 }
        Get-Content -LiteralPath $log -Encoding UTF8
        exit 0
    }
    'install' {
        if (-not (Test-IsAdmin)) { throw "注册无头取证任务需要管理员权限。" }
        if (-not (Test-Path -LiteralPath $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        Copy-Item -LiteralPath $PSCommandPath -Destination $installed -Force

        # 变量名不能叫 $action：PowerShell 大小写不敏感，它会把 ValidateSet 参数 $Action 覆盖成
        # MSFT_TaskExecAction，下一次循环/校验就报"不是有效值"。
        $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installed`" -Action run"
        # 开机触发 + 立即先跑一次，之后每 $IntervalMinutes 分钟一次，只录 $Hours 小时。
        $startAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        $triggers = @(
            (New-ScheduledTaskTrigger -AtStartup),
            (New-ScheduledTaskTrigger -Once -At $startAt `
                -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
                -RepetitionDuration (New-TimeSpan -Hours $Hours))
        )
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
            -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Set-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $triggers -Settings $settings -Principal $principal | Out-Null
        } else {
            Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $triggers -Settings $settings -Principal $principal `
                -Description 'Codex 额度监控重启验证取证：开机后无登录状态下每 5 分钟记录一次服务器/客户端实况' | Out-Null
        }
        Write-Host "取证任务已注册：$taskName（开机触发 + 每 $IntervalMinutes 分钟，录 $Hours 小时）"
        Write-Host "证据文件：$log"
        Write-Host "现在可以去重启这台机器了；重启后【不要登录】，等 10~15 分钟再回来登录，然后跑 -Action show。"
        exit 0
    }
    'uninstall' {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "已删除取证任务 $taskName"
        } else { Write-Host "没有取证任务 $taskName" }
        if (Test-Path -LiteralPath $installed) { Remove-Item -LiteralPath $installed -Force; Write-Host "已删副本 $installed" }
        Write-Host "证据文件保留在 $log（要留档就自己拷走，不要了就手动删）"
        exit 0
    }
}
