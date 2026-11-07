<#
.SYNOPSIS
OTA 首次安装的受限核心；系统任务边界可注入替身，正式入口固定绑定本机调度服务。
#>
function Invoke-OtaSupportInstall {
    <#
    .SYNOPSIS
    在已有私有根内安装唯一升级器、固定任务及公钥，不启动或修改采集任务。
    .PARAMETER Root
    已配对设备私有根。
    .PARAMETER UpdaterPath
    人工核验的升级器源路径。
    .PARAMETER Trust
    人工核验的固定公钥。
    .PARAMETER TaskName
    已有采集任务名。
    .PARAMETER ReadTask
    读取任务 XML 的受限边界。
    .PARAMETER TaskExists
    判断任务存在的受限边界。
    .PARAMETER RegisterTask
    仅注册指定固定 XML 的受限边界。
    .PARAMETER Apply
    是否明确应用；默认只预览。
    .OUTPUTS
    脱敏安装结果。
    #>
    param([string]$Root,[string]$UpdaterPath,$Trust,[string]$TaskName,[scriptblock]$ReadTask,[scriptblock]$TaskExists,[scriptblock]$RegisterTask,[switch]$Apply)
    [QuotaClient]::CheckPrivate($Root)
    [QuotaClient]::CheckPrivate((Join-Path $Root 'bin'))
    $before=& $ReadTask $TaskName
    [OtaTasks]::Validate($Root,$before,$false)
    if(-not $Apply){return '预览：固定同用户最小权限升级任务；未写入。'}
    $otaName=$TaskName+'-OTA'
    $target=[OtaCore]::PathIn($Root,'bin/CodexQuotaUpdater.exe')
    $trustPath=[OtaCore]::PathIn($Root,'ota.trust.json')
    if((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $trustPath) -or (& $TaskExists $otaName)){throw '已有升级资产，停止以免覆盖。'}
    $held=New-Object IO.FileStream(([OtaCore]::PathIn($Root,'.collector.lock')),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        # 持锁后重读任务，避免预览与应用之间覆盖并发修改。
        if((& $ReadTask $TaskName) -cne $before){throw '采集任务并发改变，停止安装。'}
        [void][QuotaClient]::PrivateDirectory($Root,(Join-Path $Root 'ota'))
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $escaped=[Security.SecurityElement]::Escape($target)
        $xml='<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>'+ $sid +'</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>'+ $sid +'</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Enabled>true</Enabled><Priority>9</Priority></Settings><Actions Context="Author"><Exec><Command>'+ $escaped +'</Command><Arguments>--apply</Arguments></Exec></Actions></Task>'
        [OtaTasks]::Validate($Root,$xml,$true)
        [IO.File]::Copy([IO.Path]::GetFullPath($UpdaterPath),$target,$false)
        if((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $UpdaterPath).Hash){throw '升级器复制摘要不符。'}
        & $RegisterTask $otaName $xml
        $readback=& $ReadTask $otaName
        [OtaTasks]::Validate($Root,$readback,$true)
        if((& $ReadTask $TaskName) -cne $before){throw '采集任务并发改变；保留安装证据供人工核验。'}
        [QuotaClient]::Atomic($Root,$trustPath,[OtaCore]::Json.Serialize($Trust))
    } finally {$held.Dispose()}
    return 'OTA 支持已安装；未启动任务或修改采集器启用状态。'
}
