<#
.SYNOPSIS
只在随机临时私有根执行 OTA 首次安装核心，调度服务全部由内存替身代替。
.PARAMETER BuildDirectory
本轮独立构建目录。
.OUTPUTS
隔离断言计数。
#>
param([Parameter(Mandatory=$true)][string]$BuildDirectory)
$ErrorActionPreference='Stop'
$BuildDirectory=[IO.Path]::GetFullPath($BuildDirectory)
[void][Reflection.Assembly]::LoadFrom((Join-Path $BuildDirectory 'CodexQuotaCollector.exe'))
. (Join-Path $PSScriptRoot '..\Install-OtaSupport.Core.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('ota-installer-test-'+[Guid]::NewGuid().ToString('N'))
$count=0
try {
    foreach($scenario in @('preview','apply','conflict','locked','changed','register_failure')) {
        $root=Join-Path $temporary $scenario
        [void][QuotaClient]::PrivateDirectory($root,$root)
        [void][QuotaClient]::PrivateDirectory($root,(Join-Path $root 'bin'))
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $collector=[Security.SecurityElement]::Escape([OtaCore]::PathIn($root,'bin/CodexQuotaCollector.exe'))
        $xml='<Task><Principals><Principal id="Author"><UserId>'+$sid+'</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Settings><Enabled>false</Enabled></Settings><Actions Context="Author"><Exec><Command>'+$collector+'</Command><Arguments>--run</Arguments></Exec></Actions></Task>'
        $tasks=@{FixtureCollector=$xml}
        $calls=@{reads=0;registers=0}
        foreach($name in @('config.json','token.bin','resident.paused.json','resident.schedule.json')){[IO.File]::WriteAllText((Join-Path $root $name),('synthetic '+$name))}
        if($scenario -eq 'conflict'){$tasks['FixtureCollector-OTA']='unknown existing task'}
        $read={param($taskName) $calls.reads++;if($scenario -eq 'changed' -and $calls.reads -gt 1 -and $taskName -eq 'FixtureCollector'){return $tasks[$taskName].Replace('--run','--resident')};return $tasks[$taskName]}.GetNewClosure()
        $exists={param($taskName) return $tasks.ContainsKey($taskName)}.GetNewClosure()
        $register={param($taskName,$definition) $calls.registers++;if($scenario -eq 'register_failure'){throw 'synthetic_registration_failure'};$tasks[$taskName]=$definition}.GetNewClosure()
        $held=$null
        if($scenario -eq 'locked'){$held=New-Object IO.FileStream((Join-Path $root '.collector.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
        $failed=$false
        try {Invoke-OtaSupportInstall -Root $root -UpdaterPath (Join-Path $BuildDirectory 'CodexQuotaUpdater.exe') -Trust @{key_id='temporary_test';modulus='synthetic';exponent='AQAB'} -TaskName 'FixtureCollector' -ReadTask $read -TaskExists $exists -RegisterTask $register -Apply:($scenario -ne 'preview')|Out-Null} catch {$failed=$true} finally {if($held){$held.Dispose()}}
        if($failed -ne ($scenario -in @('conflict','locked','changed','register_failure'))){throw ('隔离安装结果不符：'+$scenario)};$count++
        if($tasks['FixtureCollector'] -cne $xml){throw '原禁用任务被修改。'};$count++
        foreach($name in @('config.json','token.bin','resident.paused.json','resident.schedule.json')){if([IO.File]::ReadAllText((Join-Path $root $name)) -cne ('synthetic '+$name)){throw '身份或暂停状态被修改。'};$count++}
        if($scenario -eq 'apply'){
            [OtaTasks]::Validate($root,$tasks['FixtureCollector-OTA'],$true)
            if($calls.registers -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $root 'ota.trust.json'))){throw '未形成唯一固定任务和信任根。'};$count++
        } elseif(Test-Path -LiteralPath (Join-Path $root 'ota.trust.json')){throw '未完成安装写入信任根。'}else{$count++}
        if($scenario -eq 'preview' -and (Test-Path -LiteralPath (Join-Path $root 'bin/CodexQuotaUpdater.exe'))){throw '预览写入升级器。'}
    }
    Write-Output ('OTA installer isolated assertions='+$count)
} finally {
    # 删除前核对随机测试根仍位于系统临时目录，绝不枚举真实安装目录。
    $full=[IO.Path]::GetFullPath($temporary)
    $prefix=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -notlike 'ota-installer-test-*'){throw '临时清理路径拒绝。'}
    if(Test-Path -LiteralPath $full){Remove-Item -LiteralPath $full -Recurse -Force}
}
