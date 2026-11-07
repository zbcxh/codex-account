<#
.SYNOPSIS
抽取服务停止函数，用合成任务和进程验证归属保护，不调用真实任务或进程操作。
.PARAMETER ScriptPath
待验证的服务控制脚本路径。
.OUTPUTS
隔离断言通过数量；失败时抛出异常。
#>
param([string]$ScriptPath=(Join-Path $PSScriptRoot 'codex-quota-server.ps1'))
$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ScriptPath,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw '服务脚本语法错误'}
# 仅加载函数定义；脚本顶层的真实配置读取和动作分派不会执行。
foreach($name in @('Test-QuotaServerProcess','Stop-QuotaServer')){
 $fn=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 if($fn){. ([scriptblock]::Create($fn.Extent.Text))}
}
$entry='C:\fixture project\server\server.mjs';$self='C:\fixture project\tools\codex-quota-server.ps1';$serverDir='C:\fixture project\server';$TaskName='FixtureQuotaServer'
$script:nodePath='C:\fixture runtime\node.exe';$script:mode='owned';$script:stopped=0;$script:taskStopped=0;$script:cimReads=0;$script:checks=0
function Read-ServerConfig {
 <# .SYNOPSIS 返回合成配置。 .OUTPUTS 不含真实凭据的对象。 #>
 return [pscustomobject]@{Node=$script:nodePath;Port=18787}
}
function Get-Listener {
 <# .SYNOPSIS 返回合成监听者。 .PARAMETER Port 合成端口。 .OUTPUTS 合成 PID 或空。 #>
 param($Port)
 if($script:mode -ne 'absent'){return [pscustomobject]@{OwningProcess=4242}}
}
function Get-ScheduledTask {
 <# .SYNOPSIS 返回合成任务。 .PARAMETER TaskName 任务名。 .PARAMETER ErrorAction 兼容参数。 .OUTPUTS 合成任务或空。 #>
 param($TaskName,$ErrorAction)
 if($script:mode -in @('absent','no-task')){return}
 $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$self+'" -Action run'
 if($script:mode -eq 'foreign-task'){$arguments='-File "C:\other.ps1"'}
 $shell=if($script:mode -eq 'foreign-task-exe'){'C:\other\powershell.exe'}else{'powershell.exe'}
 return [pscustomobject]@{Actions=@([pscustomobject]@{Execute=$shell;Arguments=$arguments;WorkingDirectory=$serverDir})}
}
function Stop-ScheduledTask {
 <# .SYNOPSIS 记录合成任务停止。 .PARAMETER TaskName 任务名。 .PARAMETER ErrorAction 兼容参数。 .OUTPUTS 无。 #>
 param($TaskName,$ErrorAction)
 $script:taskStopped++
}
function Get-CimInstance {
 <# .SYNOPSIS 返回合成进程身份。 .PARAMETER ClassName 类名。 .PARAMETER Filter PID 筛选。 .PARAMETER ErrorAction 兼容参数。 .OUTPUTS 合成进程。 #>
 param($ClassName,$Filter,$ErrorAction)
 $script:cimReads++
 $exe=$script:nodePath;$command='"'+$exe+'" --no-warnings "'+$entry+'" --port 18787';$created=[datetime]'2026-01-01T00:00:00Z'
 if($script:mode -eq 'foreign-entry'){$command='"'+$exe+'" C:\other\server.mjs --reference "'+$entry+'"'}
 if($script:mode -eq 'foreign-exe'){$exe='C:\other\node.exe'}
 if($script:mode -eq 'prefix-entry'){$command='"'+$exe+'" --no-warnings "'+$entry+'.other"'}
 if($script:mode -eq 'missing-command'){$command=$null}
 if($script:mode -eq 'unknown'){return}
 if($script:mode -eq 'reused' -and $script:cimReads -gt 1){$created=$created.AddSeconds(1)}
 return [pscustomobject]@{ProcessId=4242;Name='node.exe';ExecutablePath=$exe;CommandLine=$command;CreationDate=$created}
}
function Get-Process {
 <# .SYNOPSIS 返回合成进程对象。 .PARAMETER Id PID。 .PARAMETER ErrorAction 兼容参数。 .OUTPUTS 合成进程。 #>
 param($Id,$ErrorAction)
 return [pscustomobject]@{Id=4242;ProcessName='node';StartTime=[datetime]'2026-01-01T00:00:00Z'}
}
function Stop-Process {
 <# .SYNOPSIS 只记录终止请求。 .PARAMETER Id PID。 .PARAMETER InputObject 进程对象。 .PARAMETER Force 兼容开关。 .OUTPUTS 无。 #>
 param($Id,$InputObject,[switch]$Force)
 $script:stopped++
}
function Write-Host {
 <# .SYNOPSIS 丢弃被测函数的界面输出。 .PARAMETER Object 合成提示。 .OUTPUTS 无，不加载系统模块。 #>
 param($Object)
}
foreach($scenario in @('foreign-entry','foreign-exe','unknown','foreign-task','foreign-task-exe','prefix-entry','missing-command','reused','owned','no-task','absent')){
 $script:mode=$scenario;$script:stopped=0;$script:taskStopped=0;$script:cimReads=0
 try{Stop-QuotaServer}catch{if($scenario -in @('owned','no-task','absent')){throw}}
 $expected=if($scenario -in @('owned','no-task')){1}else{0}
 if($script:stopped -ne $expected){throw ('进程保护失败：'+$scenario)}
 if($scenario -in @('foreign-entry','foreign-exe','unknown','foreign-task','foreign-task-exe','prefix-entry','missing-command') -and $script:taskStopped -ne 0){throw ('归属不明时不应停止任务：'+$scenario)}
 $script:checks++
}
[Console]::WriteLine('隔离停止保护通过：'+$script:checks)
