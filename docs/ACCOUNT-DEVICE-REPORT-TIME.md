# 历史设备最后上报时间

账号额度卡片的历史设备以灰色显示“最后上报 月日 时分”，悬停显示含年份和秒的完整本地时间。

`GET /api/state` 的 `accounts[].machines[].last_reported_at` 是 Unix 秒或 null，按账号 ID 与设备 ID 聚合 `MAX(reported_at)`，只表示服务器最后收到该设备此账号额度的时间。它不是该设备其他账号的心跳，不表示最后实际使用 Codex 的时间。

多窗口合并显示一个时间；历史清理后取现存报告，不新增历史存储。旧接口缺失字段时显示未知，不用当前时间或设备心跳代替。

读取逻辑在独立的 `server/account-device-times.mjs`，不依赖尚未提交的账号删除、设备合并或卡片布局改版。

代码检查：`node --test tools/test-account-device-times.mjs`，`node --experimental-strip-types --test web/tests/account-report-time.test.mjs`，以及 Vue 类型检查。测试只用内存数据库和固定时间，不操作正式数据或浏览器。
