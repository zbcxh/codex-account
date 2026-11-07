<#
.SYNOPSIS
在合成仓库中验证统一打包及成功失败均保留历史包，不访问正式服务或设备配置。
.OUTPUTS
通过的检查项数量。
#>
$ErrorActionPreference='Stop'
$repository=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path $env:TEMP ('quota-package-test-'+[Guid]::NewGuid().ToString('N'))
$client=Join-Path $fixture 'client-compiled'
[void][IO.Directory]::CreateDirectory($client)
$shell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
try {
    # 仅复制源码和安装依赖到隔离仓库，不复制配置、数据库、Git配置或凭据。
    foreach($file in Get-ChildItem (Join-Path $repository 'client-compiled') -File){if($file.Extension -in '.cs','.ps1','.cmd' -or $file.Name -eq 'README.txt'){Copy-Item -LiteralPath $file.FullName -Destination $client}}
    & git -C $fixture init --quiet
    if($LASTEXITCODE -ne 0){throw '合成仓库初始化失败'}
    & git -C $fixture -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm fixture
    if($LASTEXITCODE -ne 0){throw '合成仓库基线失败'}
    $release=Join-Path $fixture 'releases';[void][IO.Directory]::CreateDirectory($release)
    $old=Join-Path $release 'codex-quota-client-old.zip'
    [IO.File]::WriteAllText($old,'synthetic-old')
    [IO.File]::WriteAllText($old+'.sha256.txt','synthetic-old-digest')
    [IO.File]::WriteAllText((Join-Path $release 'keep.txt'),'unrelated')
    # 新包构建失败前不能清理旧包，包括其摘要和无关文件。
    # 5.1会将预期失败的子进程stderr提升为错误记录；此处只按退出码及旧包保留断言判断，随后恢复严格错误处理。
    $ErrorActionPreference='Continue'
    try{& $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $client 'package.ps1') -Version invalid *> (Join-Path $fixture 'failure.txt')}finally{$ErrorActionPreference='Stop'}
    if($LASTEXITCODE -eq 0 -or [IO.File]::ReadAllText($old) -ne 'synthetic-old'){throw '失败没有保留旧包'}
    $buildId='20990101T010203000Z'
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $client 'package.ps1') -BuildId $buildId *> (Join-Path $fixture 'success.txt')
    if($LASTEXITCODE -ne 0){throw ('打包失败：'+[IO.File]::ReadAllText((Join-Path $fixture 'success.txt')))}
    $archive=Join-Path $release ('codex-quota-client-1.0.0-'+$buildId+'.zip')
    if(-not (Test-Path -LiteralPath $archive) -or [IO.File]::ReadAllText($old) -ne 'synthetic-old' -or [IO.File]::ReadAllText($old+'.sha256.txt') -ne 'synthetic-old-digest'){throw '成功后没有保留历史包及摘要'}
    if([IO.File]::ReadAllText((Join-Path $release 'keep.txt')) -ne 'unrelated'){throw '误删无关文件'}
    $digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if(([IO.File]::ReadAllText($archive+'.sha256.txt') -split '\s+')[0] -ne $digest){throw '分发摘要不符'}
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip=[IO.Compression.ZipFile]::OpenRead($archive)
    try{
        $entries=@($zip.Entries|ForEach-Object {$_.FullName})
        if($entries.Count -ne 11 -or $entries -notcontains 'Install-Mode.Core.ps1' -or $entries -notcontains 'Install-OtaSupport.Core.ps1' -or @($entries|Where-Object {$_ -match '(config|token|TestDriver|\.cs$)'}).Count){throw '白名单或依赖不符'}
        $reader=[IO.StreamReader]::new($zip.GetEntry('manifest.json').Open())
        try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
        if($manifest.build -ne $buildId -or -not $manifest.source_dirty -or -not $manifest.source_hashes){throw '缺少真实构建或源码身份'}
    }finally{$zip.Dispose()}
    # 同编号不能覆盖既有包，必须在再次构建和清理前拒绝。
    $ErrorActionPreference='Continue'
    try{& $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $client 'package.ps1') -BuildId $buildId *> (Join-Path $fixture 'collision.txt')}finally{$ErrorActionPreference='Stop'}
    if($LASTEXITCODE -eq 0 -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest){throw '同名包被覆盖'}
    Write-Output '统一打包隔离检查=7项通过'
}finally{
    # 只清理本次生成的合成仓库；先核对绝对路径和固定前缀，不递归操作正式仓库。
    $absolute=[IO.Path]::GetFullPath($fixture)
    $temporary=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\'
    if($absolute.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($absolute).StartsWith('quota-package-test-')){Remove-Item -LiteralPath $absolute -Recurse -Force}
}
