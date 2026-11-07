# Codex Accounts · Vue前端

Vue3 + Vite + TypeScript + Element Plus + Pinia + Vue Router + ECharts SVG。
按同级原型改造；默认浅色，仅保留浅色/科幻舰桥。

## 开发

Node22.12以上。首次npm ci；随后npm run dev。
默认http://127.0.0.1:5173，/api代理到127.0.0.1:8787。
其他服务器仅在本目录.env.local配置VITE_API_TARGET=https://your-server.example，不放口令。
独立演示：当前终端设置VITE_DEMO=true后运行npm run dev；仅合成数据，无真实请求。演示管理口令demo-admin-only，勿输入真实口令。正式构建前清除此变量。
开发代理仅供本机调试，不暴露公网，不作为生产安全边界。

## 验证与构建

npm run typecheck
npm test
npm run build

产物仅在本目录dist，无选择器时由后端直接提供。hash路由可由静态服务提供。
正式部署时将dist交给静态服务器，让同源/api指向现有后端；生产来源IP/HTTPS/读取闸门须另行核实。当前未改变旧服务静态目录或重启服务。

## 范围

6页：实时总览、账号额度、设备及详情、映射与隐藏、三种配对码、周期与bootstrap设置。
管理操作需要授权，口令只驻留内存，页面打开不自动管理写入。
不切换账号、不替换采集器、不修改现有client_id、设备令牌、配置或历史。
没有历史/性能接口就不展示模拟曲线、CPU或内存数字。未知额度不等于剩余100%。
视觉见DESIGN.md；行为和部署边界见UX-CONTRACT.md；仅维护当前 Vue 面板。

## 同源正式部署

见 ../docs/VUE-PANEL.md。必要隔离验证已完成；通过server/web-current.json选择独立构建版本，缺少选择器时使用web/dist；历史版本从Git恢复并重新构建。不能把Vite开发代理当作生产认证边界。
