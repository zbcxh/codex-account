<#
.SYNOPSIS
只验证模式选择与纯XML转换，不访问任务调度器、配置或真实采集。
.PARAMETER BuildDirectory
本次隔离构建目录。
.OUTPUTS
隔离断言数量。
#>
param([Parameter(Mandatory=$true)][string]$BuildDirectory)
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadFrom((Join-Path $BuildDirectory 'CodexQuotaCollector.exe'))
. (Join-Path $PSScriptRoot '..\Install-Mode.Core.ps1')
$count=0
foreach($value in @('','1',' 1 ')) {if((Resolve-InstallMode $value) -ne 'Single'){throw '默认单轮错误'};$count++}
if((Resolve-InstallMode '2') -ne 'Resident'){throw '常驻选择错误'};$count++
foreach($value in @('0','3','resident','1;exit')){$rejected=$false;try{Resolve-InstallMode $value|Out-Null}catch{$rejected=$true};if(-not $rejected){throw '无效模式被接受'};$count++}
$root='C:\fixture'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$xml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><TimeTrigger><StartBoundary>2030-01-01T00:00:00</StartBoundary><Repetition><Interval>PT20M</Interval></Repetition></TimeTrigger></Triggers><Principals><Principal id="Author"><UserId>'+$sid+'</UserId><LogonType>S4U</LogonType></Principal></Principals><Settings><Enabled>false</Enabled></Settings><Actions Context="Author"><Exec><Command>C:\fixture\bin\CodexQuotaCollector.exe</Command><Arguments>--run</Arguments></Exec></Actions></Task>'
$resident=[ResidentTaskDefinition]::ConvertToResident($root,$xml)
# Windows导出的登录触发器可能使用用户名而非SID；仅同一Windows身份应通过，其他及无法解析的用户必须拒绝。
$named=[WindowsQuotaTaskStore]::Parse($resident)
$triggerUser=$named.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Triggers']/*[local-name()='LogonTrigger']/*[local-name()='UserId']")
$triggerUser.InnerText=[Security.Principal.WindowsIdentity]::GetCurrent().Name
[ResidentTaskDefinition]::Validate($root,$named.OuterXml);$count++
foreach($other in @('NT AUTHORITY\SYSTEM','quota-nonexistent-user-73a94c')){
    $triggerUser.InnerText=$other;$rejected=$false
    try{[ResidentTaskDefinition]::Validate($root,$named.OuterXml)}catch{$rejected=$true}
    if(-not $rejected){throw '其他或未知触发器用户被接受'};$count++
}
$single=[ResidentTaskDefinition]::ConvertToSingle($root,$resident,20)
if([WindowsQuotaTaskStore]::Validate($root,$single) -ne 20){throw '单轮实际周期未保持'};$count++
if(([WindowsQuotaTaskStore]::Parse($single)).SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']").InnerText -ne 'false'){throw '禁用状态改变'};$count++
foreach($bad in @($resident.Replace('C:\fixture\bin\CodexQuotaCollector.exe','C:\other.exe'),$resident.Replace($sid,'S-1-5-21-123'))){$rejected=$false;try{[ResidentTaskDefinition]::ConvertToSingle($root,$bad,20)|Out-Null}catch{$rejected=$true};if(-not $rejected){throw '未知归属未拒绝'};$count++}
Write-Output ('安装模式隔离断言='+$count)

# 直接执行正式编排函数，只把写入与交互边界替换为内存事件；取消必须早于所有写入。
$script:events=[Collections.Generic.List[string]]::new()
$prepare={$script:events.Add('prepare-disabled-no-run')}
$apply={param($mode,$start)$script:events.Add('apply-'+$mode+'-start-'+$start)}
foreach($target in @('Single','Resident')){
    $script:events.Clear();$result=Invoke-InstallModeFlow -Mode $target -Paired $false -PreviousMode '' -WasEnabled $false -Paused $false -ConfirmSwitch {throw '新设备不应确认切换'} -Prepare $prepare -Apply $apply
    if($result -ne 'Applied' -or $script:events[0] -ne 'prepare-disabled-no-run' -or $script:events[1] -ne ('apply-'+$target+'-start-True')){throw '首次模式准备或启动错误'};$count++
}
foreach($target in @('Single','Resident')){
    $old=if($target -eq 'Single'){'Resident'}else{'Single'}
    $script:events.Clear();$result=Invoke-InstallModeFlow -Mode $target -Paired $true -PreviousMode $old -WasEnabled $false -Paused $false -ConfirmSwitch {$false} -Prepare $prepare -Apply $apply
    if($result -ne 'Cancelled' -or $script:events.Count){throw '取消仍有写入'};$count++
    $script:events.Clear();$result=Invoke-InstallModeFlow -Mode $target -Paired $true -PreviousMode $old -WasEnabled $false -Paused $false -ConfirmSwitch {$true} -Prepare $prepare -Apply $apply
    if($script:events.Count -ne 1 -or $script:events[0] -ne ('apply-'+$target+'-start-False')){throw '已禁用任务被准备或启动'};$count++
    $script:events.Clear()
    if($target -eq 'Single'){$rejected=$false;try{Invoke-InstallModeFlow -Mode $target -Paired $true -PreviousMode $old -WasEnabled $true -Paused $true -ConfirmSwitch {$true} -Prepare $prepare -Apply $apply|Out-Null}catch{$rejected=$true};if(-not $rejected -or $script:events.Count){throw '暂停转换单轮未拒绝'}}
    else{Invoke-InstallModeFlow -Mode $target -Paired $true -PreviousMode $old -WasEnabled $true -Paused $true -ConfirmSwitch {$true} -Prepare $prepare -Apply $apply|Out-Null;if($script:events[0] -ne ('apply-'+$target+'-start-False')){throw '暂停设备被启动'}};$count++
}
Write-Output ('模式编排累计隔离断言='+$count)
