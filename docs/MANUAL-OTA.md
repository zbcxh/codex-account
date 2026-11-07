# 管理员手动 OTA

本功能只升级本项目 Windows x64 采集器 EXE。管理员选择设备和可信发布版本后创建任务，设备在下一次正常成功上报后领取。没有安装信任根和独立升级器的旧设备显示不支持。离线、禁用及暂停设备不会因面板操作被启用。

## 首次可信安装

支持版采集器需要手动安装一次。常驻转换仍使用 `Install-ResidentMode.ps1`，默认预览；`-Apply` 保留禁用状态，`-Start` 是单独的启用授权。

OTA 支持安装使用 `client-compiled/Install-OtaSupport.ps1 -CollectorPath <支持版EXE> -UpdaterPath <独立升级器EXE> -TrustFile <人工核验公钥JSON>`，默认预览；`-Apply` 才安装。公钥 JSON 包含 `key_id`、RSAParameters 的 Base64 `modulus`、`exponent`；固定 RSA-3072。安装入口不接收私钥，不覆盖既有信任根或未知任务，也不启动任务。

本次开发和隔离验证只使用临时测试密钥。分发包不含测试信任根或正式私钥；未配置可信公钥时，程序不宣称已可执行正式 OTA。正式信任根、可信首次安装和真实发布需单独完成。

## 离线签发与服务端配置

离线私钥保存在仓库及服务端运行目录之外。辅助工具只生成本机发布资产，不上传、不修改运行配置：

```powershell
node tools/build-ota-release.mjs --exe <采集器EXE> --private-key <仓库外私钥PEM> --seq <递增正整数> --version <主.次.补丁> --key-id <固定ID> --expires-at <Unix秒> --out <全新输出目录>
```

输出 `release.json`（原始清单及签名）与 `<sha256>.exe`。仅将程序复制到服务端显式配置的固定产物目录；公钥 PEM、固定 key_id 及目录通过 `--ota-public-key`、`--ota-key-id`、`--ota-artifacts` 启动参数设置。没有这些参数时拒绝登记发布。修改运行配置、启动或重启服务属于部署，本次不执行。

管理员向 `POST /api/ota/releases` 提交 `release.json` 信封，服务端验签并核验磁盘摘要、大小后登记。`POST /api/ota/list` 返回可信发布、设备能力及任务；`POST /api/ota/jobs` 接收 `machine_ids`（最多100个唯一正整数）与 `release_seq`，返回逐设备 `job` 或 `error`。上述接口使用现有内存管理口令，写入等待正文后重新鉴权，不自动重试。

## 设备协议

- 当前上报成功后，支持设备使用令牌调用 `POST /api/client/ota/poll`，正文为 `capability:{protocol:1,release_seq,key_id}`；返回 `job` 或 `null`。历史补传及重放响应不触发升级。
- `job` 包含身份、唯一 `job_id`、目标 `seq`、原始 UTF-8 `manifest`、Base64 `signature` 和固定同源 `download_path`。
- `GET /api/client/ota/download/<job_id>` 必须持有该任务设备令牌，拒绝其他设备、终态及过期任务。程序最大20MiB，流式校验，禁止重定向和任意路径。
- `POST /api/client/ota/ack` 接收 `job_id`、`state` 和可选安全错误码。状态单调，允许确认丢失后的前跳，终态同值重试幂等；`verified` 及之后保留最高接受序号。

清单所有时间为 Unix 秒；字段固定为 `protocol, release_seq, version, platform, min_updater, filename, sha256, size, issued_at, expires_at, key_id`。签名覆盖原始清单字节；拒绝重复字段、未知字段、错误类型、过期、错误平台、降级及未知信任根。

## 替换与恢复

独立升级器由固定同用户任务启动，在常驻资源 Job 外运行。下载与验签后，通过私有停止标记等待采集器释放生命周期锁，最长5分钟，不按名称强杀进程。替换前核验任务、程序及上一版本摘要。`File.Replace` 与阶段日志共同决定断电恢复或唯一上一版本回滚；第三方冲突保留证据并停止。

新程序只读健康检查不配对、不上报、不重建身份。恢复启动只依据升级前运行状态，保持任务禁用及暂停标记；新采集器等待已核验升级器退出后才启动官方进程。配置、令牌、client_id、服务地址、周期及队列均不随升级替换。

“已安装/本地检查通过”不等于真实额度送达。网络、官方版本资源及吴工电脑运行效果仍需后续真实验收。

首次 OTA 支持安装若在复制或任务注册后失败，会保留已写入资产并拒绝普通重试覆盖。应由项目所有者核对固定升级器摘要、同用户任务定义和公钥，按错误证据修复；不要删除设备配置或令牌强制重装。升级后恢复任务采用至多一次请求，断电或任务调度失败时可能仍保持停止；查看管理任务状态和本机计划任务，确认归属后再人工恢复。任何“本地检查通过”均不表示任务已经运行或额度已经送达。

## 隔离验证入口

```powershell
node --test tools/test-ota.mjs tools/test-ota-routes.mjs tools/test-ota-release.mjs tools/test-admin-rotation.mjs
python tools/test-ota-http.py --help
powershell.exe -NoProfile -ExecutionPolicy Bypass -File client-compiled/build-tests.ps1 -OutputDirectory <独立临时目录>
# 在构建目录运行 OtaTests.exe；仅临时密钥、合成程序、回环服务与任务替身。
```
