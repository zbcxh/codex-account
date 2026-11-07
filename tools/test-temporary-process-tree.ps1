<#
.SYNOPSIS
编译并运行临时进程树的合成回归，不访问真实账号、配置、任务或服务器。
.OUTPUTS
隔离证据目录及测试结果；失败时抛出异常，保留证据。
#>
param()
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$evidence=Join-Path $env:TEMP ('quota-tree-tests-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($evidence)
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe=Join-Path $evidence 'TemporaryTreeTests.exe'
& $compiler /nologo /codepage:65001 /platform:x64 /target:exe /main:TemporaryTreeTests /reference:System.Web.Extensions.dll /reference:System.Security.dll ('/out:'+$exe) (Join-Path $PSScriptRoot 'TemporaryTreeTests.cs') (Join-Path $root 'client-compiled\QuotaPrototype.cs')
if ($LASTEXITCODE -ne 0) { throw '合成进程测试编译失败。' }
& $exe | Tee-Object -FilePath (Join-Path $evidence 'results.txt')
if ($LASTEXITCODE -ne 0) { throw '合成进程测试失败。' }
Write-Output ('隔离证据目录：'+$evidence)
