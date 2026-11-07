import {validInterval} from './reporting-config.mjs';
export const REPORT_GRACE_SECONDS=120;
/** 功能：根据已确认上报周期计算离线阈值，为采集及网络延迟留两分钟；参数：actualMinutes；返回值：秒数，旧设备未知周期按五分钟。 */
export function onlineWindowSeconds(actualMinutes){return (validInterval(actualMinutes)?actualMinutes:5)*60+REPORT_GRACE_SECONDS;}
/** 功能：按最后成功上报判断在线，拒绝未来和非有限时间；参数：lastOk、now、actualMinutes；返回值：布尔值。 */
export function isReportOnline(lastOk,now,actualMinutes){return typeof lastOk==='number'&&Number.isFinite(lastOk)&&typeof now==='number'&&Number.isFinite(now)&&now>=lastOk&&now-lastOk<=onlineWindowSeconds(actualMinutes);}
