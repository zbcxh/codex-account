# 服务端统一上报周期

默认值为 5 分钟，允许设置 1～1440 的整数分钟。面板“设置 → 客户端上报周期（服务端）”可修改默认值，或为每台设备设置覆盖值；单台留空恢复继承。浏览器页面刷新频率与客户端上报周期是独立设置。

客户端下一次成功上报时收到配置，没有广播连接或额外常驻服务。仅在目标周期与实际任务不同时修改自己的单一重复触发器，下一轮从新周期之后开始；保留任务动作、S4U 身份和优先级 9，官方额度查询仍为短时 BelowNormal 子进程。

## 应用和确认

服务端将“目标周期”和“设备实际周期”分别保存。客户端读取实际任务周期随新额度上报；下发后先修改触发器、读回校验，再原子保存本机应用版本并发送确认。确认请求不产生额度快照，也不刷新设备在线心跳。失败保留真实周期，面板显示待应用或应用失败，下次成功上报重试。网络故障导致确认尚未送达时，服务端继续显示最近已知状态，后续上报会携带最新实际值。

在线判定为：最近成功额度上报距现在不超过该设备已报告/确认的实际周期 + 120秒采集及网络宽限。实际5分钟周期超过7分钟才离线，实际10分钟周期超过12分钟才离线，周期本身不改变。账号在用状态、设备监控及账号删除/设备合并的在线保护共用阈值。默认值或覆盖值刚保存时不会提前改变阈值。旧客户端未提供实际周期时仍暂按原来的 5 分钟兼容，面板明确显示“尚未确认”，必须升级后才能自动应用配置。

配置版本在默认或任意设备覆盖发生实际变化时递增；保存相同值不递增。所有设备可能收到新版本，但目标周期未变时只确认版本，不重写触发器。额度队列重放也返回当前配置，但客户端只对本轮新额度响应应用配置，不对历史补传响应再次改任务。

## 接口

- `POST /api/reporting-config`：管理员 `x-quota-bootstrap` 鉴权；请求 `{ "interval_minutes": 10 }` 修改默认值。
- `POST /api/machine/<id>/reporting-config`：相同管理员鉴权；整数设置单台覆盖，`null` 恢复继承。
- `POST /api/report`：沿用设备配对令牌，可选 `reporting_status: { "version": 2, "interval_minutes": 5 }` 报告实际周期。成功及幂等重放响应均含 `reporting_config: { "version": 3, "interval_minutes": 10, "applied_version": 2, "applied_interval_minutes": 5 }`。
- `POST /api/client/reporting-ack`：仅设备配对令牌鉴权，确认作用于令牌所属设备；请求 `{ "version": 3, "interval_minutes": 10 }`。应用失败可带 `error: "schedule_update_failed"`，此时分钟数必须是读回的真实值。过期版本返回 409，非法数值返回 400。
- `/api/state` 增加全局 `reporting_config`；设备增加 `online_window_sec`（实际周期+宽限）、`online_grace_sec`、`reporting_interval_sec` 和 `reporting`，其中包含默认、覆盖、目标、实际、`actual_known`、版本、待应用及错误码。不返回设备令牌或登录凭据。

客户端仅接受有界整数，不接受服务端下发脚本、可执行路径或任务名。安装器保存本机任务名；客户端修改前核验动作必须属于自己的采集任务；当前入口为 `%LOCALAPPDATA%\CodexQuota\bin\CodexQuotaCollector.exe --run`，兼容旧任务的校验以 `WindowsQuotaTaskStore` 实现为准。

## 数据与验证

仅新增 `reporting_policy` 和 `machine_reporting` 表，不重建设备、额度快照或账号映射；本机配置原子合并，保留设备 ID、配对信息和未知字段。旧客户端继续正常上报但不会应用配置。

隔离检查：`python tools/test-reporting-config.py --node <真实 node.exe>`；客户端通过 `client-compiled/build-tests.ps1` 和 `client-compiled/test-client.py` 验证任务适配及配置确认。测试使用临时数据库与内存合成任务，不修改实际计划任务。
