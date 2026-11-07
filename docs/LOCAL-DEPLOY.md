# Windows 本机部署指南

适用已有服务的日常更新。代码目录：`D:\zhoubc\projects\tools\codex-accounts`。不安装客户端，不清空数据库，不操作真实删除或设备合并。

日常流程：**备份 → 构建 → 暂停自动清理 → 切换版本并重启 → 恢复清理设置**。前面的耗时还包含功能开发与回归；日常部署不必全部重做。本机最近前端构建约7～10秒，启动脚本端口检查上限20秒，首次安装依赖另计。

## 一、目录和入口

| 项目 | 位置 |
|---|---|
| Vue 前端 | `web/src` |
| Node 后端 | `server/server.mjs` 及同目录模块，已测 Node 22.23.3 |
| 发布的前端 | `server/web-releases/<版本>/` |
| 当前版本选择器 | `server/web-current.json`，只含版本目录名 |
| 服务任务 | `CodexQuotaServer` |
| 启停脚本 | `tools/codex-quota-server.ps1` |
| 配置 | `server/server.config.json`，含口令，不要输出或提交 |
| 数据库 | `server/data/quota.sqlite3`，部署不要删除 |
| 日志 | `server/data/server.log`、`server.err.log` |
| 客户端测试包 | 项目根目录 `releases/`，与网页部署无关 |

旧面板与本机历史版本已移除。当前部署保留所选 Vue 版本；无选择器时从 `web/dist/` 提供 Vue，缺少构建产物则明确报错。选择器在启动时读取，切换后必须重启。不要把 Vite 开发服务器当正式服务。

服务控制脚本停止前会核对计划任务动作、配置中的 Node 可执行路径及本项目实际入口；停止任务后再次核对监听者、进程创建时间和入口，防止端口被其他项目占用或 PID 被复用时误杀。信息缺失、任务被替换或归属变化会报错，不打印完整命令行，也不强制终止未知进程。仅做隔离验证可运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-server-stop.ps1`，该测试使用任务与进程替身，不操作真实服务。

## 二、准备与备份

以管理员打开 **PowerShell 7**，后面的代码段在同一窗口按顺序执行。不要直接使用 PowerShell 5.1 执行整份指南；启停服务时单独调用系统 powershell.exe。

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'D:\zhoubc\projects\tools\codex-accounts'
Set-Location -LiteralPath $repo
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$version = 'manual-' + $stamp
$release = Join-Path $repo ('server\web-releases\' + $version)
$backup = Join-Path 'D:\zhoubc\tools\backups' ('manual-deploy-' + $stamp)
$selector = Join-Path $repo 'server\web-current.json'
$cfg = Get-Content 'server\server.config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$node = [string]$cfg.node
$port = if ($cfg.port) { [int]$cfg.port } else { 8787 }
if (-not (Test-Path -LiteralPath $node)) { throw '配置中的Node路径不存在' }
& $node --version
git status --short
```

有未提交内容时先确认发布范围，不自动 `git pull`、`reset --hard` 或覆盖工作区。**后端更新源码前备份旧程序**；源码已经修改时，下面保存的是当前工作区，并不等于上一成功部署版本。

```powershell
New-Item -ItemType Directory -Path $backup | Out-Null
# 备份含凭据，只允许当前用户、SYSTEM和Administrators访问。
$acl = Get-Acl -LiteralPath $backup
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
        'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $backup -AclObject $acl
New-Item -ItemType Directory -Path (Join-Path $backup 'server') | Out-Null
Get-ChildItem -LiteralPath 'server' -File | Where-Object {
    $_.Extension -in '.mjs', '.sql' -or $_.Name -in 'server.config.json', 'web-current.json'
} | Copy-Item -Destination (Join-Path $backup 'server')
Copy-Item -LiteralPath 'web\src' -Destination (Join-Path $backup 'web-src') -Recurse
Copy-Item -LiteralPath 'tools\codex-quota-server.ps1' -Destination $backup
Export-ScheduledTask -TaskName CodexQuotaServer |
    Set-Content (Join-Path $backup 'CodexQuotaServer.xml') -Encoding utf8
```

不复制 `server/data`、日志、队列或历史额度。数据库里的设备令牌、管理员摘要和策略单独导出到私有备份：

```powershell
@'
import {DatabaseSync} from "node:sqlite";import fs from "node:fs";import path from "node:path";
const [repo,folder]=process.argv.slice(2);const db=new DatabaseSync(path.join(repo,"server/data/quota.sqlite3"),{readOnly:true});const saved={};
// 只备份设备授权和管理配置，不导出额度窗口。
for(const name of ["machine","admin_authorization","pairing_code","pairing_claim","account_alias","account_hidden","account_deleted","machine_merged","reporting_policy","machine_reporting","server_migration_policy","machine_server_migration","history_cleanup_policy"]){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))continue;
  saved[name]=db.prepare(name==="machine"?"SELECT machine_id,client_id,token,label,hostname,created_at FROM machine":`SELECT * FROM ${name}`).all();
}
fs.writeFileSync(path.join(folder,"credentials-and-policy.json"),JSON.stringify(saved,null,2));db.close();console.log("凭据及策略备份完成，未备份额度历史");
'@ | Set-Content (Join-Path $backup 'backup-security.mjs') -Encoding utf8
& $node --no-warnings (Join-Path $backup 'backup-security.mjs') $repo $backup
if ($LASTEXITCODE -ne 0) { throw '凭据备份失败，停止部署' }
```

## 三、构建前端

已有依赖时不重新安装。只有首次准备或 `package-lock.json` 变更时，才先进入 `web` 执行 `npm.cmd ci`。使用现有 Node，不自动升级依赖。

```powershell
& $node 'web\node_modules\vue-tsc\bin\vue-tsc.js' --noEmit -p 'web\tsconfig.json'
if ($LASTEXITCODE -ne 0) { throw '类型检查失败，停止部署' }
& $node --check 'server\server.mjs'
if ($LASTEXITCODE -ne 0) { throw '后端语法检查失败，停止部署' }
$previousDemo = $env:VITE_DEMO
$env:VITE_DEMO = 'false'
Push-Location -LiteralPath 'web'
try {
    & $node 'node_modules\vite\bin\vite.js' build --outDir $release
    if ($LASTEXITCODE -ne 0) { throw '生产构建失败，停止部署' }
} finally {
    Pop-Location
    if ($null -eq $previousDemo) { Remove-Item Env:VITE_DEMO -ErrorAction SilentlyContinue }
    else { $env:VITE_DEMO = $previousDemo }
}
if (-not (Test-Path -LiteralPath (Join-Path $release 'index.html'))) { throw '缺少构建入口' }
```

直接构建到尚未启用的新版本目录，失败不覆盖当前 Vue 面板。必须显式 `VITE_DEMO=false`，避免发布演示数据。

## 四、临时暂停自动清理

**服务启动也会触发自动清理。** 即使只更新字体，也先保存原策略并暂时关闭；保留期限和版本不变，服务启动后恢复。以下适用于已有历史清理策略表的当前版本，缺表则停止，不要删除或重建数据库。

```powershell
@'
import {DatabaseSync} from "node:sqlite";import fs from "node:fs";import path from "node:path";
const [repo,folder]=process.argv.slice(2);const db=new DatabaseSync(path.join(repo,"server/data/quota.sqlite3"));db.exec("PRAGMA busy_timeout=5000;BEGIN IMMEDIATE");
try{const p=db.prepare("SELECT * FROM history_cleanup_policy WHERE id=1").get();if(!p)throw new Error("缺少清理策略");fs.writeFileSync(path.join(folder,"original-cleanup-policy.json"),JSON.stringify(p));db.prepare("UPDATE history_cleanup_policy SET automatic_enabled=0 WHERE id=1").run();db.exec("COMMIT");console.log("自动清理已暂停");}catch(e){db.exec("ROLLBACK");throw e;}finally{db.close();}
'@ | Set-Content (Join-Path $backup 'pause-cleanup.mjs') -Encoding utf8
& $node --no-warnings (Join-Path $backup 'pause-cleanup.mjs') $repo $backup
if ($LASTEXITCODE -ne 0) { throw '暂停失败，停止部署' }
```

## 五、切换面板并重启

```powershell
# 先确认端口确实属于本项目；不打印完整启动参数。
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
    if ($process.Name -ne 'node.exe' -or $process.CommandLine -notlike ('*' + $repo + '\server\server.mjs*')) {
        throw '端口不属于本项目，停止，不终止其他程序'
    }
}
$stage = $selector + '.new'
[IO.File]::WriteAllText($stage, (@{version=$version} | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[IO.File]::Move($stage, $selector, $true)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\tools\codex-quota-server.ps1' -Action restart
if ($LASTEXITCODE -ne 0) { throw '重启命令失败' }
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) { throw '服务未监听，先检查日志，暂不恢复自动清理' }
$process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
if ($process.Name -ne 'node.exe' -or $process.CommandLine -notlike ('*' + $repo + '\server\server.mjs*')) {
    throw '监听进程不符合预期，暂不恢复清理'
}
Get-ScheduledTask -TaskName CodexQuotaServer | Select-Object TaskName, State
Get-Content -LiteralPath 'server\web-current.json'
```

选择器应为本次版本。端口监听表示已完成启动时清理检查，此时才可以恢复自动开关。服务脚本最多等20秒，不保证超时后退出码一定失败，所以不能省略监听检查。

## 六、恢复自动清理原值

```powershell
@'
import {DatabaseSync} from "node:sqlite";import fs from "node:fs";import path from "node:path";
const [repo,folder]=process.argv.slice(2);const original=JSON.parse(fs.readFileSync(path.join(folder,"original-cleanup-policy.json"),"utf8"));const db=new DatabaseSync(path.join(repo,"server/data/quota.sqlite3"));db.exec("PRAGMA busy_timeout=5000;BEGIN IMMEDIATE");
try{const p=db.prepare("SELECT * FROM history_cleanup_policy WHERE id=1").get();
// 如果维护期间其他管理员修改过策略，不能覆盖其设置。
if(p.version!==original.version||p.retention_days!==original.retention_days||p.automatic_enabled!==0)throw new Error("策略已变化，请人工核对");db.prepare("UPDATE history_cleanup_policy SET automatic_enabled=? WHERE id=1").run(original.automatic_enabled);db.exec("COMMIT");console.log("自动清理已恢复原设置");}catch(e){db.exec("ROLLBACK");throw e;}finally{db.close();}
'@ | Set-Content (Join-Path $backup 'restore-cleanup.mjs') -Encoding utf8
& $node --no-warnings (Join-Path $backup 'restore-cleanup.mjs') $repo $backup
if ($LASTEXITCODE -ne 0) { throw '恢复失败，保留原策略文件人工核对' }
```

原来开启则恢复开启，原来关闭则恢复关闭；恢复后定时清理仍按原策略运行。不要在服务启动前提前恢复开启，也不要遗忘恢复。

## 七、你来验收

打开 `http://192.168.18.8:8787`，先 **Ctrl+F5**。不需要重新安装采集器或重新配对。

- 顶部出现字号选择，默认120%，刷新保留本浏览器偏好。
- 系统设置有历史额度清理和迁移上报服务器。先预览，避免误删真实历史。
- 账号映射区分删除映射和删除账号记录。
- 设备监控打开离线旧记录详情，有合并旧设备入口。先确认目标身份。
- 允许嵌入的普通外链在内容页签打开，可切换和关闭。`codex-reset.com` 等已知禁止嵌入站点仍走浏览器新页，属于当前设计，不是部署失败。
- 上报是否正常以设备成功上报时间和实际周期为准；服务监听不等于功能已验收。

排错仅查看日志，不打印配置或完整进程参数：

```powershell
Get-Content -LiteralPath 'server\data\server.err.log' -Tail 30
Get-Content -LiteralPath 'server\data\server.log' -Tail 20
```

## 八、回退与常见问题

| 情况 | 处理 |
|---|---|
| 构建失败 | 不切选择器，当前面板不变；修正后构建新目录 |
| 只回退前端 | 恢复备份里的 `server/web-current.json`，暂停自动清理，再重启并恢复原策略。原本无选择器则移走本次选择器，使用旧public |
| 后端启动失败 | 保持清理暂停，恢复上一成功部署的后端及配套模块，再启动；不能盲目覆盖未提交改动 |
| 清理恢复失败 | 保留 `original-cleanup-policy.json`，核对是否有人同时修改策略，不强制覆盖 |
| 页面仍旧 | 检查选择器、版本目录index.html、正确服务是否重启，再Ctrl+F5；不重装采集器 |

不要恢复整库或设备令牌，不要回退到会无条件删除旧历史的早期清理器。指南不删除旧版本目录，也不清理真实历史；旧目录清理另行处理。

## 可选代码检查

源码改变清理、删除、合并逻辑时，运行对应合成库测试。纯文档修改无需运行。不启动临时服务、不读取真实额度、不操作浏览器。

```powershell
& $node --no-warnings --test 'tools/test-history-cleanup.mjs' 'tools/test-account-records.mjs' 'tools/test-device-merge.mjs'
& $node --experimental-strip-types --test 'web/tests/*.test.mjs'
```

客户端EXE、测试包及其他电脑安装见 [CLIENT-BUILD-INSTALL.md](CLIENT-BUILD-INSTALL.md)。网页部署不用编译EXE，后续测试包输出项目 `releases/`，不含本机配置、数据或凭据。

## 历史版本清理后的回退边界

仓库只保留当前 Vue 源码和当前选择的本机部署版本，不保留旧面板或历史安装包。本文的回退步骤仅适用于本次部署事先备份且仍存在的版本目录；不能将选择器指向已清理目录。更早版本需从 Git 检出到独立目录并重新构建、验证，再按授权部署。数据库、凭据和用户配置不能随源码回退。
