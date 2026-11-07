<#
.SYNOPSIS
无副作用核对正式候选采集器的程序集版本、构建编号和自身文件摘要，不运行采集或读取设备配置。
.PARAMETER ExecutablePath
本次隔离构建的采集器路径。
.PARAMETER Version
预期的发布版本。
.OUTPUTS
脱敏构建身份；不匹配时抛出错误。
#>
param([Parameter(Mandatory=$true)][string]$ExecutablePath,[string]$Version='1.0.0')
$ErrorActionPreference='Stop'
$exe=(Resolve-Path -LiteralPath $ExecutablePath).Path
$assembly=[Reflection.Assembly]::LoadFile($exe)
$actual=$assembly.GetType('QuotaClient').GetMethod('DescribeCollector').Invoke($null,@())
$digest=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
if($actual['collector_sha256'] -cne $digest -or $actual['collector_version'] -cne $Version -or $actual['collector_build'] -notmatch '^\d{8}T\d{9}Z$'){throw '采集器构建身份核验失败。'}
# 返回副本必须隔离调用方修改，不能污染同进程后续正常报告。
$build=$actual['collector_build'];$actual['collector_build']='changed'
$again=$assembly.GetType('QuotaClient').GetMethod('DescribeCollector').Invoke($null,@())
if($again['collector_build'] -cne $build){throw '采集器元数据被调用方修改。'}
$again|ConvertTo-Json -Compress
