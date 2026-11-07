<#
.SYNOPSIS
统一验证获准后构建候选程序和隔离测试驱动；本脚本不会自行申请授权或部署程序。
.PARAMETER OutputDirectory
仅用于隔离候选和测试驱动的输出目录。
.OUTPUTS
候选与测试驱动路径；不运行测试。
#>
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'))
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build.ps1') -OutputDirectory $OutputDirectory
$candidate = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'CodexQuotaCollector.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$driver = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'QuotaClientTestDriver.exe'
& $compiler /nologo /codepage:65001 /optimize+ /platform:x64 /target:exe /main:QuotaClientTestDriver /reference:System.Web.Extensions.dll /reference:System.Security.dll /reference:System.Xml.dll ('/reference:' + $candidate) ('/out:' + $driver) (Join-Path $PSScriptRoot 'TestDriver.cs')
if ($LASTEXITCODE -ne 0) { throw '隔离驱动构建失败。' }
Write-Output $driver

# 协议测试复用正式共享源码，仅生成隔离测试驱动，不安装或上报。
$rpc = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) "CodexQuotaPrototype.exe"
& $compiler /nologo /codepage:65001 /optimize+ /platform:x64 /target:exe /reference:System.Web.Extensions.dll ("/out:" + $rpc) (Join-Path $PSScriptRoot "QuotaPrototype.cs")
if ($LASTEXITCODE -ne 0) { throw "RPC 测试驱动构建失败。" }
Write-Output $rpc

# 常驻资源测试直接复用正式源码，仅入口与替身属于测试程序集。
$resident = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'ResidentTests.exe'
$sources = @('tests\ResidentTests.cs', 'QuotaClient.cs', 'QuotaPrototype.cs', 'ResidentProcess.cs', 'ResidentSession.cs', 'ResidentCollector.cs', 'ResidentTaskDefinition.cs', 'OtaCore.cs', 'OtaClient.cs', 'OtaTransaction.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
& $compiler /nologo /codepage:65001 /optimize+ /platform:x64 /target:exe /main:ResidentTests /reference:System.Web.Extensions.dll /reference:System.Security.dll /reference:System.Xml.dll ('/out:' + $resident) $sources
if ($LASTEXITCODE -ne 0) { throw '常驻隔离驱动构建失败。' }
Write-Output $resident

# OTA 测试只使用进程内临时密钥和系统临时目录，不连接正式服务或任务。
$ota = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'OtaTests.exe'
& $compiler /nologo /codepage:65001 /optimize+ /platform:x64 /target:exe /reference:System.Web.Extensions.dll ('/reference:' + $candidate) ('/out:' + $ota) (Join-Path $PSScriptRoot 'tests\OtaTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'OTA 隔离驱动构建失败。' }
Write-Output $ota
