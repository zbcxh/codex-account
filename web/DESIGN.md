---
version: alpha
name: NEXUS Quota Bridge
description: 科幻舰桥风格的个人设备额度监控Vue前端
colors:
  primary: "#4bd7ee"
  background: "#040c14"
  surface: "#081a27"
  text: "#def2f8"
  muted: "#85a8b7"
  border: "#23434f"
  success: "#53e3ac"
  warning: "#ffba75"
  danger: "#ff728b"
typography:
  display:
    fontFamily: 'Bahnschrift, Segoe UI, Microsoft YaHei, sans-serif'
  body:
    fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif'
  data:
    fontFamily: 'Consolas, SFMono-Regular, monospace'
rounded:
  DEFAULT: "3px"
  control: "2px"
spacing:
  page: "29px"
  panel: "20px"
components:
  panel:
    rounded: "3px"
  button:
    rounded: "2px"
---

# NEXUS 设计规范

## Overview

产品前端，非营销页。用户关注账号剩余额度、设备归属与上报健康。
中文内容及zh-CN界面；目标场景为Windows桌面浏览器和窄屏查看，没有日本市场需求。
方向来自用户明确要求：可视化大屏、科技感、可切换主题、低配电脑优先。
记忆点为舰桥HUD：静态坐标网格、面板角标、设备拓扑与等宽遥测读数；警告和管理表单保持克制。
反参考：持续全屏扫描、粒子背景、模糊玻璃、多重旋转、将装饰数字当作真实统计。

## Colors

运行时CSS为唯一可执行来源（Model B），本文件镜像其已接受值。
`src/style.css` 的 `[data-visual="scifi"]` 将background/surface/text/muted/border映射到 --bg/--panel/--text/--muted/--line。
--cyan是操作强调色，src/theme.ts根据模式与强调色切换；语义成功/警告/危险颜色不因主题而改变含义。
src/style.css拥有浅色和舰桥主题及全局滚动条；不可在业务页面独立复制主题值。

## Typography

标题使用本机Bahnschrift加中文回退；正文保留Segoe UI和微软雅黑，不下载字体。
遥测使用Consolas等宽数字；英文小标签仅作辅助，主要操作均提供中文名称。

## Layout

保留86px侧栏、69px顶栏；页面内距29px。760px以下64px侧栏、单列内容。
大屏的趋势与设备拓扑为视觉主区域；管理页采用原生语义表格。
页面保持文档自然滚动，表格仅横向溢出，不固定共享页面高度。

## Elevation & Depth

以层级底色和1px边界建立深度。光效限于角标、中心拓扑和选中状态。
无背景模糊，无新增长期动画，无全屏渲染循环。

## Shapes

舰桥面板3px圆角、控件2px圆角，以角标表达切角感，不裁剪焦点轮廓。
圆形只用于状态点和拓扑；状态同时有文字。

## Components

共享Button、Input、Dialog、Drawer、Toast仍由Element Plus组件和src/style.css拥有，科幻主题只适配视觉。
悬停、键盘焦点、按下、禁用必须可区分。表单采用应用校验、novalidate、关联标签和首错焦点。
主题选择和日期时间使用Element Plus Select/DatePicker，统一简体中文本地化。
全局滚动条由scifi.css提供标准属性、WebKit回退和forced-colors支持。
动效仅复用已有SVG流线与轻微脉冲，支持手动暂停和系统减少动态偏好。

## Do's and Don'ts

- 保留账号与设备的不同口径；未知数据不能显示为零或100%。
- 所有模拟内容必须标明演示，不接入实际权限、口令或设备令牌。
- 不以新主题改动任何真实配置或主项目代码。
- 不宣称静态审计通过就等于生产可用、无障碍全合规或后端验证通过。

## Vue前端适配

默认浅色，仅支持light/scifi；不提供标准深色和跟随系统。框架Vue3/Vite/TypeScript，Element Plus为控件与层级唯一拥有者，Pinia拥有数据刷新与内存授权。ECharts使用SVG渲染，非历史数据不绘制历史曲线。表格默认10行本地分页，后端当前返回完整集合；API支持分页前不伪造服务端分页。配对码明文和bootstrap不写localStorage，仅主题可持久化。
