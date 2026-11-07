# Vue 面板同源部署

项目只维护 `web/` 的 Vue 源码，旧 `server/public` 已移除。正式构建必须关闭 `VITE_DEMO`，默认输出 `web/dist/`。

服务端存在 `server/web-current.json` 时，按其中单段 `version` 选择 `server/web-releases/<版本>/`；不存在时使用 `web/dist/`。缺少入口文件报 `panel_index_missing`，不会回退旧面板。版本名拒绝路径穿越，选择器及部署产物不进 Git。

当前本机只保留正在选择的 Vue 版本。此次源码清理没有切换选择器或重启服务。日后部署按 [LOCAL-DEPLOY.md](LOCAL-DEPLOY.md) 执行，版本选择在启动时读取。

Vue 静态外壳允许加载；业务 API 继续受 IP 读取闸门控制，读取解锁不授予管理权限。管理口令仅驻留内存。HTML 不使用长期缓存，带哈希资源长期缓存。开发代理不能作为生产鉴权边界。

历史源码和旧部署说明通过 Git 查看；若需历史版本，先在独立目录恢复源码、重新构建和验证，再按授权切换。不恢复历史数据库、凭据或旧 bootstrap。
