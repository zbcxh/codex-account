<#
.SYNOPSIS
仅构建编译客户端，不安装、不启动、不修改既有状态；执行构建前需取得本轮验证授权。
.PARAMETER OutputDirectory
构建输出目录，默认是源码目录下的 bin。
.PARAMETER Version
采集器发布版本，默认1.0.0，写入程序集及正常报告。
.PARAMETER BuildId
构建编号，默认UTC编译时间；不使用运行时间替代构建标识。
.OUTPUTS
生成的可执行文件路径。
#>
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'), [string]$Version = '1.0.0', [string]$BuildId = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')))
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d{1,4}\.\d{1,4}\.\d{1,4}$' -or $BuildId -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]{0,95}$') { throw '版本或构建编号格式无效。' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\') + '\'
foreach ($protected in @((Join-Path $env:LOCALAPPDATA 'CodexQuota'), (Join-Path $env:USERPROFILE '.codex'), (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex'))) {
    $protectedRoot = [IO.Path]::GetFullPath($protected).TrimEnd('\') + '\'
    if ($outputRoot.StartsWith($protectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '构建输出不能覆盖正式程序、配置或凭据目录。' }
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '未找到系统 C# 编译器，不会自动安装。' }
[void][IO.Directory]::CreateDirectory($outputRoot)
$output = Join-Path $outputRoot 'CodexQuotaCollector.exe'
$metadata = Join-Path $outputRoot 'CollectorAssemblyInfo.cs'
# 仅向隔离构建目录生成程序集属性，两种可执行入口使用相同构建身份。
[IO.File]::WriteAllText($metadata, ('using System.Reflection;' + "`n" + '[assembly: AssemblyVersion("' + $Version + '.0")]' + "`n" + '[assembly: AssemblyFileVersion("' + $Version + '.0")]' + "`n" + '[assembly: AssemblyInformationalVersion("' + $Version + '+' + $BuildId + '")]'), [Text.Encoding]::UTF8)
& $compiler /nologo /codepage:65001 /optimize+ /platform:x64 /target:exe /main:QuotaClient /reference:System.Web.Extensions.dll /reference:System.Security.dll /reference:System.Xml.dll ('/out:' + $output) $metadata (Join-Path $PSScriptRoot 'QuotaPrototype.cs') (Join-Path $PSScriptRoot 'QuotaClient.cs') (Join-Path $PSScriptRoot 'ResidentProcess.cs') (Join-Path $PSScriptRoot 'ResidentSession.cs') (Join-Path $PSScriptRoot 'ResidentCollector.cs') (Join-Path $PSScriptRoot 'ResidentTaskDefinition.cs') (Join-Path $PSScriptRoot 'OtaCore.cs') (Join-Path $PSScriptRoot 'OtaClient.cs') (Join-Path $PSScriptRoot 'OtaTransaction.cs')
if ($LASTEXITCODE -ne 0) { throw '客户端构建失败。' }
Write-Output $output
# 升级器独立链接全部共用原语，替换采集器时不加载正在替换的程序集。
$updater = Join-Path $outputRoot 'CodexQuotaUpdater.exe'
$sources = @('QuotaPrototype.cs','QuotaClient.cs','ResidentProcess.cs','ResidentSession.cs','ResidentCollector.cs','ResidentTaskDefinition.cs','OtaCore.cs','OtaClient.cs','OtaTransaction.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
& $compiler /nologo /codepage:65001 /optimize+ /platform:x64 /target:exe /main:OtaUpdater /reference:System.Web.Extensions.dll /reference:System.Security.dll /reference:System.Xml.dll ('/out:' + $updater) $metadata $sources
if ($LASTEXITCODE -ne 0) { throw '升级器构建失败。' }
Write-Output $updater
