# 浏览器设备读取凭证

在“系统设置 → 浏览器设备绑定”或读取解锁提示中打开绑定窗口，用当前管理口令读取设备与绑定，确认当前浏览器所在设备后绑定。临时口令仅驻留内存，关闭窗口清除，不建立管理授权。管理接口继续使用原管理员鉴权。

绑定有效期30天，服务端生成256位随机凭证，通过 `__Host-quota_browser` Cookie保存，属性为 `HttpOnly; Secure; SameSite=Strict; Path=/`，不设Domain，不放入URL或浏览器存储。数据库独立表`browser_read_binding`只存凭证摘要、关联设备身份、口令代际和管理元数据。Cookie不会出现在接口JSON响应。

仅关联设备实际在线时，该凭证才授予面板读取权限。在线按最近成功上报、已确认实际周期和120秒宽限判断；无效或未来时间不标在线，周期未知兼容5分钟。出口IP变化不影响凭证。设备离线时凭证暂停放行，在线恢复；设备删除、合并、身份改变、凭证撤销、到期或管理口令轮换均使凭证失效。口令代际立即校验，撤销元数据写入失败也不恢复旧凭证权限。

保留原来的来源IP自动读取和8小时手动读取解锁作为独立方式。绑定凭证不撤销这些既有授权，也不能代替管理口令、配对码或采集器设备令牌。管理员选择设备是人工确认的关联，并非电脑硬件证明。不同浏览器、配置文件、清除Cookie后需分别绑定。

绑定创建必须通过HTTPS；本机HTTP服务保留现有行为，不签发绑定Cookie。云端使用`--host 127.0.0.1 --trust-loopback-proxy`，仅信任本机Nginx覆盖的`X-Quota-Client-IP`和HTTPS声明。Nginx必须覆盖客户端同名头，只从官方Cloudflare网段解析真实来源，不可将后端端口公开。

## 接口

时间字段均为Unix秒。以下管理接口位于读取闸门之前，但始终要求`X-Quota-Bootstrap`，等待正文后重新校验；不能使用Cookie管理绑定。

| 方法和路径 | 输入 | 输出 |
| --- | --- | --- |
| GET /api/browser-bindings/status | Cookie，可缺省 | `bound, online`；有效绑定另含`id,machine_id,label,expires_at`，不暴露其他绑定 |
| POST /api/browser-bindings/list | `{}`，管理员授权 | `devices[{machine_id,label,online}],bindings[{id,machine_id,name,created_at,expires_at,revoked_at}],current` |
| POST /api/browser-bindings/bind | `{machine_id:整数,name:1至80字名称}`，管理员授权及HTTPS | 安全Cookie与`ok`及当前绑定状态；当前浏览器旧有效绑定同时撤销 |
| POST /api/browser-bindings/revoke | `{binding_id:整数}`，管理员授权 | `{ok:true}`；撤销本浏览器时清Cookie |

未知、已合并设备返回`unknown_machine`；名称非法返回`bad_binding_name`；未知绑定返回`unknown_binding`；HTTP创建返回`binding_https_required`；无效或轮换后的管理口令返回403 `bad_bootstrap`。未知、伪造、重复Cookie、撤销或过期凭证不授予读取权限。管理写入不自动重试，未知结果先重新读取列表核实。

最简验证：绑定授权与安全Cookie、伪造/过期/撤销、在线与离线、身份或合并变化、口令轮换、Cookie不能管理写入；类型检查和生产构建。页面由用户验收。

初始口令使用数据库持久化的随机盐，授权代际同时绑定盐与口令摘要的不可逆派生；未更换口令时服务重启不使绑定失效，更换初始配置口令或页面轮换仍会失效。页面轮换后的持久口令继续优先，不复活旧配置口令。旧版本按进程随机代际签发的绑定在升级本修复时需重新绑定；本修复不自动修改运行环境。
