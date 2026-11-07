# 管理授权与设备配对

实现状态：隔离安全模块20项、临时HTTP接口13项和页面交互验证通过。页面由用户提交合成新口令后，旧口令403、新口令200，临时服务重启后保持。正式部署另行记录。

## 权限分离

- bootstrap 只用于管理操作和读取解锁，不再作为设备配对口令。
- 设置页可验证当前 bootstrap 后修改，新值至少16位、最多256字节、两次一致且首尾无空格；旧口令立即失效。
- 初始口令仍由现有启动配置提供。页面更改后，以 SQLite 新增 admin_authorization 表内的加盐 scrypt 摘要为准；启动参数中的旧值不能覆盖它。
- 不在页面、接口响应或日志中回显管理员口令，不改写启动配置中的其他字段。当前浏览器更新会话授权；其他页面下一次写入需新口令。
- 修改后清除旧口令的 IP 解锁记录，并保留本次修改来源的读取权限。
- 需要异步读取请求体的管理操作，在读取完成后、业务写入前再次校验当前口令；等待期间轮换后旧口令返回403，不继续执行删除、合并、策略、名称或迁移设置，也不消费预览。无异步等待的操作在同一执行段内校验后完成。

## 三种配对码

- 单次：默认10分钟有效，可指定结束时间；成功接入一台后失效。
- 限时：指定开始、结束时间，时间段内允许多台设备接入。
- 永久：不自动到期，直到管理员撤销。
- 服务端按 UTC 秒判断边界：开始时间包含，结束时间不包含；页面按浏览器本地时区输入和展示。
- 名称、时间、摘要和使用状态持久化到新增 pairing_code / pairing_claim 表；明文仅生成当次返回，不支持重新查询。
- 撤销或到期只影响后续配对，不影响已发设备令牌及上报。
- 单次核销和设备注册同一 SQLite 事务提交。相同配对码、相同 client_id 在首次成功后10分钟内可取回原响应，仍受配对码到期和撤销限制。
- 已有设备不能凭另一张配对码和 client_id 取回原令牌；超出安全重试窗口的重配需提供原设备令牌。现有客户端安装入口不携带该证明，遇到409应保留原配置，不自动删除身份或生成替代设备。

## 客户端兼容

不替换采集器，不修改现有 client_id、DPAPI 文件或设备令牌。
新设备沿用原安装入口，在原 bootstrap 输入位置填页面生成的配对码。新分发配置中 bootstrap 应留空，避免旧固定口令自动填入。
现有 /api/report 与 /api/client/reporting-ack 的设备令牌鉴权及响应协议不变。

## 新接口

所有管理接口均 POST，并通过 x-quota-bootstrap 校验当前管理员授权；配对码不能调用这些接口。

| 接口 | 请求字段 | 返回 |
|---|---|---|
| /api/admin/bootstrap | new_bootstrap, confirm_bootstrap | ok，不返回口令 |
| /api/pairing-codes | name, kind, 可选 starts_at/expires_at | id, code（仅此一次）, kind, starts_at, expires_at |
| /api/pairing-codes/list | 空对象 | codes（无明文或摘要）, server_now |
| /api/pairing-codes/:id/revoke | 空对象 | ok |

/api/pair 沿用 x-quota-bootstrap 请求头传配对码，body 仍为 client_id/hostname/label；成功返回原格式 machine_id/token/label。
已有设备证明可通过 x-quota-token 提交；错误码包含 bad_pairing_code、pairing_code_unavailable、pairing_code_used、existing_device_requires_token。

## 备份与待验证

本次只备份程序、当前配置和设备凭据，不备份历史额度、队列或日志。运行数据库尚未改动，新表将在批准后启动候选服务时初始化。
必要验证应只使用隔离目录、合成口令/设备和临时数据库；无真实账号额度查询。
需覆盖：旧管理口令失效与重启持久化、配对码权限隔离、单次与同设备重试、限时边界、永久/撤销、多设备、事务回滚、旧令牌正常上报及页面生成/复制/撤销/修改交互。
初始化专项及采集器性能测试继续延后。

2026-10-28 验证证据（仅本机隔离记录）：
- D:/zhoubc/tools/pairing-validation/c0695e954ee3464aae80195fd1d81e71/REPORT.md
- D:/zhoubc/tools/pairing-browser-submit/555909c21cfc4e33a59ef40364d742a6/REPORT.md
