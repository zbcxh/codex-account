<#
.SYNOPSIS
仅抽取安装器任务启用函数，以内存任务替身检查升级行为；不导入或调用真实计划任务模块。
.PARAMETER InstallerPath
待检查的安装脚本路径。
.OUTPUTS
纯代码测试结果，不安装、不配对、不操作真实任务。
#>
param([string]$InstallerPath)
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')
$json=[Web.Script.Serialization.JavaScriptSerializer]::new()
$PSModuleAutoLoadingPreference='None'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($InstallerPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw '安装器存在语法错误'}
$fn=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-UpgradedQuotaTask'},$true)
if(-not $fn){throw '缺少升级后启用任务并触发的实现'}
foreach($name in @('Invoke-InstalledCollectorOnce','Start-UpgradedQuotaTask')){
 $definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 if(-not $definition){throw ('缺少实现: '+$name)}
 . ([scriptblock]::Create($definition.Extent.Text))
}
$script:enabled=$false;$script:refuse=$false;$script:wrongAction=$false;$script:events=[Collections.Generic.List[string]]::new()
# 模拟任务读回、启用和触发；禁止模块自动加载，确保不会触及本机计划任务。
function Get-ScheduledTask {
 <#
 .SYNOPSIS
 读取合成任务。
 .PARAMETER TaskName
 合成任务名。
 .PARAMETER TaskPath
 合成任务路径。
 .PARAMETER ErrorAction
 测试替身接受的参数，不调用系统模块。
 .OUTPUTS
 内存测试对象或无输出，不操作真实任务。
 #>
 param($TaskName,$TaskPath,$ErrorAction)
 $command=if($script:wrongAction){'C:\unexpected.exe'}else{'C:\fixture\CodexQuotaCollector.exe'}
 return [pscustomobject]@{Settings=[pscustomobject]@{Enabled=$script:enabled};Actions=@([pscustomobject]@{Execute=$command;Arguments='--run'})}
}
function Enable-ScheduledTask {
 <#
 .SYNOPSIS
 模拟启用。
 .PARAMETER TaskName
 合成任务名。
 .PARAMETER TaskPath
 合成任务路径。
 .PARAMETER ErrorAction
 测试替身接受的参数，不调用系统模块。
 .OUTPUTS
 内存测试对象或无输出，不操作真实任务。
 #>
 param($TaskName,$TaskPath,$ErrorAction)
 $script:events.Add('enable');if(-not $script:refuse){$script:enabled=$true}
}
# 仅替换原生进程边界，不运行EXE，也不调用计划任务启动接口。
$script:processExit=0;$script:processOutput='{"ok":true,"sent_report":true}'
function Invoke-InstalledCollectorProcess {
 <#
 .SYNOPSIS
 返回合成采集器结果，不启动进程。
 .PARAMETER ExecutablePath
 合成程序路径。
 .OUTPUTS
 合成退出码和JSON输出。
 #>
 param([string]$ExecutablePath)
 $script:events.Add('collect')
 return [pscustomobject]@{ExitCode=$script:processExit;Output=$script:processOutput}
}
$result=Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'
if(($script:events -join ',') -ne 'enable,collect' -or $result.Status -ne 'reported'){throw '禁用任务没有先启用再直接采集'}
$script:events.Clear();$result=Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'
if(($script:events -join ',') -ne 'collect'){throw '已启用任务应仅直接采集一次'}
$script:events.Clear();$script:enabled=$false;$script:refuse=$true;$caught=$false
try{Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'|Out-Null}catch{$caught=$true}
if(-not $caught -or $script:events.Contains('collect')){throw '启用失败不应运行采集器'}
$script:events.Clear();$script:refuse=$false;$script:enabled=$true;$script:wrongAction=$true;$caught=$false
try{Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'|Out-Null}catch{$caught=$true}
if(-not $caught -or $script:events.Contains('collect')){throw '动作不符不应运行采集器'}
$script:wrongAction=$false;$script:processOutput='{"ok":false,"queued":true,"http_status":503}'
$result=Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'
if($result.Status -ne 'queued' -or $result.HttpStatus -ne 503){throw '排队不能误报送达'}
$script:processOutput='{"ok":true,"skipped":"collector_busy"}'
$result=Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'
if($result.Status -ne 'busy'){throw '并发跳过不能误报送达'}
$script:processOutput='{"ok":false,"error":"fixture_failure"}';$script:processExit=1;$caught=$false
try{Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'|Out-Null}catch{$caught=$true}
if(-not $caught){throw '采集失败不应显示成功'}
$script:processOutput='not-json';$caught=$false
try{Start-UpgradedQuotaTask 'fixture' '\' 'C:\fixture\CodexQuotaCollector.exe'|Out-Null}catch{$caught=$true}
if(-not $caught){throw '无法识别结果时不应显示成功'}
# 再覆盖安装收尾入口，防止只测试辅助函数却漏掉新设备分支。
$cleanup=$ast.Find({param($node)$node -is [Management.Automation.Language.TryStatementAst] -and $node.Finally -and $node.Finally.Extent.Text.Contains('$held.Dispose()')},$true)
if(-not $cleanup){throw '无法确认安装锁释放边界'}
$tail=[IO.File]::ReadAllText($InstallerPath).Substring($cleanup.Extent.EndOffset)
function Start-UpgradedQuotaTask {
 <#
 .SYNOPSIS
 记录收尾入口调用，不启用真实任务或启动进程。
 .PARAMETER TaskName
 合成任务名。
 .PARAMETER TaskPath
 合成路径。
 .PARAMETER ExpectedExecutable
 合成程序路径。
 .OUTPUTS
 合成已上报状态。
 #>
 param($TaskName,$TaskPath,$ExpectedExecutable)
 $script:tailCalls++;return [pscustomobject]@{Status='reported'}
}
function Write-Host {
 <#
 .SYNOPSIS
 抑制合成收尾的用户输出。
 .PARAMETER Object
 测试文案。
 .OUTPUTS
 无。
 #>
 param($Object)
}
function Write-Output {
 <#
 .SYNOPSIS
 抑制合成收尾的用户输出。
 .PARAMETER InputObject
 测试文案。
 .OUTPUTS
 无。
 #>
 param($InputObject)
}
foreach($paired in @($false,$true)){
 $owned=if($paired){[pscustomobject]@{Name='fixture'}}else{$null};$folder='\';$taskName='fixture';$target='C:\fixture\CodexQuotaCollector.exe';$backup='fixture-backup';$script:tailCalls=0
 . ([scriptblock]::Create($tail))
 if($script:tailCalls -ne 1){throw '新旧设备都必须在安装锁释放后采集一次'}
}
[Console]::WriteLine('installer_immediate_mock_tests_passed_10')
