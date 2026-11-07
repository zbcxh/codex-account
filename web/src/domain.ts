import type { Machine, QuotaEntity, QuotaWindow } from './types';
/** 功能：读取有限数值，保留未知；参数：value为原值；返回值：数值或null。 */
export function finite(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)?value:null;}
/** 功能：按实际周期和服务端时间计算在线；参数：设备、服务端秒；返回值：布尔值。 */
export function online(machine:Machine,now:number):boolean{return machine.last_ok_at!==null&&now>=machine.last_ok_at&&now-machine.last_ok_at<=machine.online_window_sec;}
/** 功能：读取主窗口，不把未知当零；参数：item；返回值：窗口或undefined。 */
export function primary(item:QuotaEntity):QuotaWindow|undefined{return item.windows.find(w=>w.kind==='primary')??item.windows[0];}
/** 功能：读取剩余比例；参数：item；返回值：0至100或null。 */
export function remaining(item:QuotaEntity):number|null{const used=finite(primary(item)?.used_percent);return used===null?null:Math.max(0,100-used);}
/** 功能：风险同时考虑所有窗口与触顶；参数：item；返回值：布尔值。 */
export function risk(item:QuotaEntity):boolean{return Boolean(item.hit_limit)||item.windows.some(w=>(finite(w.used_percent)??-1)>=80);}
/** 功能：格式化本地日期时间；参数：秒级Unix时间；返回值：中文本地时间。 */
export function date(value:number|null|undefined):string{return value==null?'—':new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium',hour12:false}).format(value*1000);}
/** 功能：格式化经过时间；参数：秒数；返回值：中文时长。 */
export function duration(seconds:number|null):string{if(seconds===null)return '未知';if(seconds<=0)return '已到期';const n=Math.floor(seconds);if(n>=86400)return `${Math.floor(n/86400)}天 ${Math.floor(n%86400/3600)}小时`;if(n>=3600)return `${Math.floor(n/3600)}小时 ${Math.floor(n%3600/60)}分钟`;return `${Math.floor(n/60)}分 ${n%60}秒`;}
/** 功能：显示账号名称，禁止以设备名称替代账号归属；参数：实体；返回值：映射或账号ID。 */
export function accountName(item:Pick<QuotaEntity,'display_name'|'account_id'>):string{return item.display_name|| (item.account_id?`${item.account_id.slice(0,8)}…${item.account_id.slice(-4)}`:'账号未知');}
/** 功能：格式化历史设备最后上报的本地月日时分；参数：秒级Unix时间，可缺省；返回值：简短时间或未知。 */
export function accountReportTime(value:number|null|undefined):string{
 if(finite(value)===null)return '未知';
 const time=new Date(value!*1000);
 if(!Number.isFinite(time.getTime()))return '未知';
 return `${time.getMonth()+1}月${time.getDate()}日 ${String(time.getHours()).padStart(2,'0')}:${String(time.getMinutes()).padStart(2,'0')}`;
}
/** 功能：按账号与设备最后上报时间降序排列历史设备；参数：含可选Unix秒时间的设备数组；返回值：新数组，未知时间在末尾。 */
export function sortRecentAccountDevices<T extends {last_reported_at?:number|null}>(devices:T[]):T[]{
 // 未知时间不伪造为零或当前时间；同一时间保留原顺序。
 return [...devices].sort((a,b)=>{const x=finite(a.last_reported_at),y=finite(b.last_reported_at);return x===null?(y===null?0:1):y===null?-1:y-x;});
}
