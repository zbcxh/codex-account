# 账号状态与设备只读 MCP

`/api/mcp` 提供 `get_codex_account_status`、`list_codex_accounts_with_credit`、`recommend_codex_login_account` 和 `list_unoccupied_codex_accounts` 四个只读工具。单账号查询要求 `account` 为完整账号 ID 或精确别名，重名时要求完整 ID。隐藏或不存在的账号返回相同的未找到状态。

列表工具接受可选 `status`（normal、unknown、restricted）、`online_count`、`offline_count`，数量为非负整数精确匹配，多个条件取交集。兼容旧调用中的 `account` 参数，列表查询忽略该参数。设备数依据设备当前账号归属及实际周期在线规则统计，合并停用设备排除，非在线设备计入离线数。推荐先按正常、未知、受限排序，再按在线设备数升序，最多返回十项。时间字段使用 Unix 秒，未知额度保留 null。

管理员可通过 `GET/POST /api/account-status/:accountId` 读取或维护状态，POST 正文为 `{status:"normal"}` 等三个枚举值之一，均要求管理口令。历史账号默认为 unknown，采集上报不修改管理员状态。`GET /api/accounts` 的 `account_status` 供账号映射页维护与状态页签筛选使用。

推荐及有额度列表仅接受最新完整报告中全部窗口 `used_percent` 为有限数值且处于 `[0,100)` 的账号。任一窗口比例未知或耗尽均排除，重置时间经过不能替代新读数。`balance`、`has_credits` 不参与推荐资格判断。列表结果增加 `windows[].used_percent` 和 `windows[].remaining_percent`，剩余比例为 100 减使用比例，未知返回 null。未占用列表只判断占用情况，可包含比例未知或耗尽的账号。

由服务启动环境变量 `CODEX_ACCOUNTS_MCP_TOKEN` 配置独立口令，至少32字符；未配置时返回404。调用须提供对应 `Authorization: Bearer`，不能使用浏览器Cookie或管理口令替代。不要把真实值写入源码、文档或Git。默认来源网络限制仍有效；公网代理部署遵循浏览器绑定文档的可信本机代理边界。

只接受 POST 单个 JSON-RPC 请求，支持 initialize、ping、tools/list 和指定 tools/call，通知返回202。带 Origin 的请求拒绝，错误口令401；不提供管理工具，不向其他路由分派调用。协议支持版本以源码版本列表为准；本次检查验证本地处理器契约，不代表外部MCP客户端兼容性验收。
