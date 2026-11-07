# Vue前端 UX Contract

## Product context

来源：用户已确认的同级UI原型；服务端数据规则见../docs/PAIRING.md、../server/server.mjs和../server/reporting-config.mjs。业务证据不授权真实管理写入。
zh-CN界面；本机时区显示Unix时间，倒计时采用服务端基准加performance.now。无日本市场特定需求。
只实现前端，不修改数据库、采集器、服务配置或旧面板。权限以服务端校验为准，页面授权状态只是交互提示。

## Visual contract

DESIGN.md镜像src/style.css的token。src/theme.ts仅支持浅色与科幻，默认浅色。Element Plus为选择、日期、表单、弹层、提示的单一拥有者。

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Element Plus ElSelect | DESIGN.md | authored | 主题选择与键盘 |
| Date | Element Plus ElDatePicker | 本契约 | authored datetime | 中文面板、时间边界 |
| Form | ManageDialog / AdminGate / ElForm | 本契约 | create/edit/confirm | 必填、失败、重试 |
| Scrollbar | src/style.css全局基线 | DESIGN.md | light/scifi/forced-colors | 审计与浏览器 |
| Toast | Element Plus ElMessage | 本契约 | success/warning/info | 不显示凭据 |
| CRUD | api.ts / ManageDialog | ../docs/PAIRING.md | 等待服务端确认 | 合成演示与领域测试 |

## Data and permissions

账号额度采用服务端分组，不相加；设备使用服务端归属，来源不是app_server时不称已核验身份。未知额度、历史、版本及性能保留未知，不补模拟值。
设备在线按实际周期和最近成功上报计算，不以期望周期替代实际周期。离线显示最近使用设备。
管理口令仅在内存；403清除授权，保留安全草稿；生成的码只展示当次，默认掩码，可复制，不放URL/日志/存储。
读取失败保留上次快照并显示异常；管理写入不自动重试，超时结果不确定时先核实列表。

## Dataset navigation

设备搜索与状态存入hash路由query，本地即时过滤，输入法组合期间不提交；搜索有明确清除。账号风险和隐藏筛选也在路由。每页10条本地分页，过滤时重置，结果减少夹紧页码。
映射/配对码分页为当前视图状态；后端无分页参数，不能称服务端分页。无批量选择或删除。

## Flows and resilience

管理操作共用ManageDialog；busy防重复，确认后关闭并更新拥有列表；失败保留输入和错误。配对码生成采用当次秘密展示变体；刷新失败不误报生成失败。
撤销、隐藏、删除映射显示对象与后果。关闭已修改表单询问放弃；取消保留草稿。ElForm接管标签、novalidate校验与错误。
后台15秒刷新，页面隐藏暂停，请求15秒超时，读取合并，卸载取消。没有离线写入、凭据跨标签页同步。

## Integration boundaries

VITE_DEMO=true仅启用合成演示，不发网络；正式默认false，真实请求走同源/api。开发代理默认127.0.0.1:8787，可通过VITE_API_TARGET配置，仅供本机开发，不作生产认证边界。
无历史/性能接口，不显示推测曲线或CPU/内存。生产发布仍需授权部署并验证反向代理来源、HTTPS、读取闸门及旧设备上报。本任务不执行真实配对、撤销、口令修改或采集。

## 2026-10-28 读取与状态一致性修正（待验证）

- not_paired 单独展示读取解锁入口；/api/unlock 仅显式提交口令，使用后清空，不建立管理授权。
- 解锁后重新读取快照，读取失败不误报完全成功；代理来源认证边界仍由部署方案解决，本轮未改代理或后端。
- 设备抽屉只保存设备ID，详情来自最新快照，设备消失时关闭；非app_server来源标为历史观察账号。
- 总览、账号卡和映射在用数量共用设备实际周期与单调时间，断网时保留额度快照但在线数量会按时过期。
- 配对码按已知有效时间更新展示状态，撤销和使用次数仍以服务端快照为准；列表减少时夹紧页码。
- 源码已备份；本轮未构建、测试或部署，未替换旧面板。

必要验证：类型检查及构建；合成读取403/错误口令/成功解锁/解锁后网络失败；管理权限不随读取解锁获得；详情打开期间账号/名称/周期更新及设备消失；不同实际周期边界、断网跨阈值时各页在线数量一致；配对码开始/结束时间与页码；敏感输入不写存储或日志。
