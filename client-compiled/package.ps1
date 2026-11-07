<#
.SYNOPSIS
隔离构建、校验并交付客户端ZIP，保留历史包；不安装、不启动采集器、不操作服务或计划任务。
.PARAMETER Version
发布版本，默认1.0.0。
.PARAMETER BuildId
唯一构建编号，默认UTC编译时间；同名发布禁止覆盖。
.OUTPUTS
包含ZIP路径、SHA-256、版本及构建编号的JSON交付结果。
#>
param(
    [ValidatePattern('^\d{1,4}\.\d{1,4}\.\d{1,4}$')][string]$Version='1.0.0',
    [ValidatePattern('^[0-9A-Za-z][0-9A-Za-z._-]{0,95}$')][string]$BuildId=([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
)
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$release=Join-Path $repository 'releases'
$work=Join-Path $env:TEMP ('quota-package-'+[Guid]::NewGuid().ToString('N'))
$archiveName='codex-quota-client-'+$Version+'-'+$BuildId+'.zip'
$target=Join-Path $release $archiveName
$scripts=@('Install.cmd','Start-Install.ps1','Install-Mode.Core.ps1','Install-Client.ps1','Install-ResidentMode.ps1','Install-OtaSupport.ps1','Install-OtaSupport.Core.ps1','README.txt')
$sources=@('QuotaPrototype.cs','QuotaClient.cs','ResidentProcess.cs','ResidentSession.cs','ResidentCollector.cs','ResidentTaskDefinition.cs','OtaCore.cs','OtaClient.cs','OtaTransaction.cs','build.ps1','package.ps1')+$scripts
$lock=$null;$pending=$null;$pendingDigest=$null
try {
    if((Test-Path -LiteralPath $release) -and ((Get-Item -LiteralPath $release).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'releases不能是目录链接。'}
    [void][IO.Directory]::CreateDirectory($release)
    # 所有发布在同一文件锁下串行，避免两个构建互相清理对方刚交付的安装包。
    $lock=New-Object IO.FileStream((Join-Path $release '.client-package.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    if((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath ($target+'.sha256.txt'))){throw '同版本构建的发布文件已存在，不覆盖。'}
    $revision=(& git -C $repository rev-parse HEAD).Trim()
    if($LASTEXITCODE -ne 0 -or -not $revision){throw '无法记录源码提交。'}
    $changes=@(& git -C $repository status --porcelain --untracked-files=normal)
    if($LASTEXITCODE -ne 0){throw '无法核对源码未提交状态。'}
    $sourceHashes=[ordered]@{}
    # 明确列出编译输入和分发脚本；不读取本机配置，也不把测试驱动作为分发输入。
    foreach($name in $sources){$sourceHashes[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
    $build=Join-Path $work 'build';$stage=Join-Path $work 'stage'
    [void][IO.Directory]::CreateDirectory((Join-Path $stage 'bin'))
    $shell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1') -OutputDirectory $build -Version $Version -BuildId $BuildId | Out-Host
    if($LASTEXITCODE -ne 0){throw '构建失败，保留原安装包。'}
    $files=@()
    foreach($name in $scripts){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stage;$files+=$name}
    foreach($name in @('CodexQuotaCollector.exe','CodexQuotaUpdater.exe')){
        $exe=Join-Path $build $name
        $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
        if($info.FileVersion -ne ($Version+'.0') -or $info.ProductVersion -ne ($Version+'+'+$BuildId)){throw '程序版本或构建编号不一致。'}
        Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'bin');$files+=('bin/'+$name)
    }
    $manifest=[ordered]@{version=$Version;build=$BuildId;collector_sha256=(Get-FileHash -LiteralPath (Join-Path $build 'CodexQuotaCollector.exe') -Algorithm SHA256).Hash.ToLowerInvariant();source_commit=$revision;source_dirty=($changes.Count -gt 0);source_hashes=$sourceHashes;validation='build-identity-whitelist-sha256';files=@()}
    foreach($name in $files){$manifest.files+=@{path=$name;sha256=(Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash.ToLowerInvariant()}}
    [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'),($manifest|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive=Join-Path $work $archiveName
    $outputZip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
    try{
        # 显式使用正斜线条目，避免.NET Framework目录压缩生成反斜线路径而与清单不一致。
        foreach($name in ($files+@('manifest.json'))){
            $entry=$outputZip.CreateEntry($name,[IO.Compression.CompressionLevel]::Optimal)
            $inputFile=[IO.File]::OpenRead((Join-Path $stage $name));$outputFile=$entry.Open()
            try{$inputFile.CopyTo($outputFile)}finally{$inputFile.Dispose();$outputFile.Dispose()}
        }
    }finally{$outputZip.Dispose()}
    $zip=[IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $allowed=$files+@('manifest.json')
        if($zip.Entries.Count -ne $allowed.Count){throw 'ZIP条目数量不符。'}
        # 对每个条目核对路径和内容摘要，拒绝额外配置、遗漏依赖或归档损坏。
        foreach($entry in $zip.Entries){
            if($allowed -cnotcontains $entry.FullName){throw 'ZIP包含非白名单条目。'}
            $stream=$entry.Open();$sha=[Security.Cryptography.SHA256]::Create()
            try{$digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}
            $expected=(Get-FileHash -LiteralPath (Join-Path $stage $entry.FullName) -Algorithm SHA256).Hash.ToLowerInvariant()
            if($digest -ne $expected){throw 'ZIP条目摘要不符。'}
        }
    }finally{$zip.Dispose()}
    # 源码在编译期间改变时拒绝发布，避免清单绑定到另一份输入。
    foreach($name in $sources){if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sourceHashes[$name]){throw '构建期间源码已改变，保留原安装包。'}}
    $currentRevision=(& git -C $repository rev-parse HEAD).Trim()
    if($LASTEXITCODE -ne 0 -or $currentRevision -ne $revision){throw '构建期间源码提交已改变。'}
    $digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $pending=Join-Path $release ('.package-'+[Guid]::NewGuid().ToString('N')+'.tmp')
    $pendingDigest=$pending+'.sha256.txt'
    Copy-Item -LiteralPath $archive -Destination $pending
    if((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest){throw '交付复制摘要不符。'}
    [IO.File]::WriteAllText($pendingDigest,($digest+'  '+$archiveName+[Environment]::NewLine),[Text.Encoding]::ASCII)
    # 同卷改名不覆盖已有文件；保留全部历史ZIP及摘要，不自动删除任何旧发布。
    [IO.File]::Move($pending,$target)
    try{[IO.File]::Move($pendingDigest,$target+'.sha256.txt')}catch{Remove-Item -LiteralPath $target;throw}
    [ordered]@{archive=$target;sha256=$digest;version=$Version;build=$BuildId;source_dirty=$manifest.source_dirty}|ConvertTo-Json -Compress
}finally{
    # 失败只移除本次唯一暂存文件，正式旧包在成功交付前始终保留。
    foreach($temporaryFile in @($pending,$pendingDigest)){if($temporaryFile -and (Test-Path -LiteralPath $temporaryFile)){Remove-Item -LiteralPath $temporaryFile}}
    if($lock){$lock.Dispose();try{Remove-Item -LiteralPath (Join-Path $release '.client-package.lock') -ErrorAction Stop}catch{}}
    $absolute=[IO.Path]::GetFullPath($work);$temporaryRoot=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\'
    if((Test-Path -LiteralPath $absolute) -and $absolute.StartsWith($temporaryRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($absolute).StartsWith('quota-package-')){Remove-Item -LiteralPath $absolute -Recurse -Force}
}
