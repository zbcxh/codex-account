<#
.SYNOPSIS
为已有编译采集器安装固定 OTA 升级任务及人工指定的可信公钥；默认仅预览。
.PARAMETER CollectorPath
已验证的支持 OTA 的采集器，用于加载安全原语，不自动替换采集器。
.PARAMETER UpdaterPath
本次构建的独立升级器。
.PARAMETER TrustFile
人工核验的正式公钥 JSON（key_id、modulus、exponent），不得使用测试根。
.PARAMETER Apply
明确安装升级器及固定任务；不启动任务或启用采集器。
.OUTPUTS
脱敏预览或安装结果。
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CollectorPath,[Parameter(Mandatory=$true)][string]$UpdaterPath,[Parameter(Mandatory=$true)][string]$TrustFile,[switch]$Apply)
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::LoadFrom([IO.Path]::GetFullPath($CollectorPath))
$root=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'CodexQuota')).TrimEnd('\')
[QuotaClient]::Fence($root,$root)|Out-Null
[QuotaClient]::CheckPrivate($root)
[QuotaClient]::CheckPrivate((Join-Path $root 'bin'))
$config=[QuotaClient]::Read((Join-Path $root 'config.json'),$false)
$trust=[QuotaClient]::Read([IO.Path]::GetFullPath($TrustFile),$false)
if([string]$trust['key_id'] -notmatch '^[a-zA-Z0-9_-]{1,64}$' -or $trust.ContainsKey('test_only')){throw '信任根标识无效或标记为测试根。'}
$rsa=New-Object Security.Cryptography.RSACryptoServiceProvider
try {
    $parameters=New-Object Security.Cryptography.RSAParameters
    $parameters.Modulus=[Convert]::FromBase64String([string]$trust['modulus'])
    $parameters.Exponent=[Convert]::FromBase64String([string]$trust['exponent'])
    $rsa.ImportParameters($parameters)
    if($rsa.KeySize -ne 3072){throw '必须使用 RSA-3072 公钥。'}
} finally {$rsa.PersistKeyInCsp=$false;$rsa.Dispose()}
$name=if($config.ContainsKey('task_name')){[string]$config['task_name']}else{'CodexQuotaMonitor'}
[void][OtaTasks]::Access($name,$root,$false,$false)
$otaName=$name+'-OTA'
$destination=[OtaCore]::PathIn($root,'bin/CodexQuotaUpdater.exe')
if(-not $Apply){Write-Output '预览：固定同用户最小权限 OTA 任务，保留采集器状态；不安装、不启动。';return}
# 首次安装不得覆盖已有信任根或未知任务，换钥必须独立人工审查。
if(Test-Path -LiteralPath (Join-Path $root 'ota.trust.json')){throw '已有信任根，禁止普通安装入口覆盖。'}
if(Test-Path -LiteralPath $destination){throw '已有升级器，禁止覆盖未知版本。'}
if(Get-ScheduledTask -TaskName $otaName -ErrorAction SilentlyContinue){throw '已有同名任务，停止安装。'}
. (Join-Path $PSScriptRoot 'Install-OtaSupport.Core.ps1')
Invoke-OtaSupportInstall -Root $root -UpdaterPath $UpdaterPath -Trust $trust -TaskName $name -Apply `
    -ReadTask { param($taskName) [OtaTasks]::Access($taskName,$root,($taskName -eq $otaName),$false) } `
    -TaskExists { param($taskName) [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) } `
    -RegisterTask { param($taskName,$xml) Register-ScheduledTask -TaskName $taskName -Xml $xml -ErrorAction Stop|Out-Null }