# 页面迁移上报服务器

控制台设置 → 迁移上报服务器 → 管理授权 → 读取迁移配置。选择默认或单台设备，填写 HTTP/HTTPS 基础地址并保存。单台留空继承默认；默认留空取消尚未执行的迁移，不能撤回已经保存到客户端的地址。

设备下次向旧服务成功上报后接收设置。首先向目标发送不带令牌的随机挑战，核对以原设备令牌计算的 HMAC；再发送令牌验证接口并比对 client_id。校验全部成功后才原子合并本机 config.json 的 server_url。失败保留原地址，并向旧服务确认错误状态；不自动重定向、不接受无效证书、不允许 HTTPS 降级到 HTTP。

目标必须运行支持迁移协议的服务，且已安全迁移现有设备库。此功能不创建新设备、不重新配对、不改变 client_id 或设备令牌、不搬运数据库。全新空库会校验失败。

旧服务器应保持在线直到各设备确认迁移，未上线设备无法接收设置。已迁移设备由新服务器管理；回迁须在新服务器设置目标。旧采集器会忽略新增响应字段，需要更新采集器才能迁移。

管理接口（bootstrap 授权）：POST /api/server-migration/list 读取状态；POST /api/server-migration 请求 {machine_id: null或设备整数ID, server_url: 地址或null}。设备接口：POST /api/client/migration-proof 接收 client_id/nonce，返回 HMAC；POST /api/client/migration-validate 需要原设备令牌并比对 client_id；POST /api/client/migration-ack 需要原设备令牌，接收 version/server_url/可选错误码。设备校验和确认不改变在线心跳或额度。

配置存储在新增 server_migration_policy 和 machine_server_migration 表，不修改已有账号/额度/设备授权结构。回退时从已验证备份恢复对应采集器程序、Vue 部署版本和服务端程序；保留新增表不影响旧版运行，不回退历史数据库。客户端地址已改变时须使用备份或在当前服务执行回迁。
