import type {Machine,OtaCapability,OtaRelease,OtaJob,OtaCreateResponse} from './types';

/** 功能：说明设备是否可选，离线不等于禁止排队；参数：当前设备、能力、目标发布、任务和Unix秒；返回值：空字符串表示可选，否则返回原因，最终以服务端复核为准。 */
export function otaEligibility(machine:Pick<Machine,'machine_id'|'client_id'>,cap:OtaCapability|undefined,release:OtaRelease|undefined,jobs:OtaJob[],now:number):string{
 if(!cap)return '不支持 OTA，需先手动安装支持版及可信根';
 if(cap.client_id!==machine.client_id)return '设备身份已变化，请重新读取能力';
 if(!release)return '请先选择可信发布版本';
 if(release.platform!=='win-x64')return '目标平台不支持';
 if(!Number.isFinite(release.expires_at)||release.expires_at<=now)return '发布已过期';
 if(!cap.key_id||release.key_id!==cap.key_id)return '本机信任根与发布不匹配';
 if(!Number.isSafeInteger(cap.seq)||!Number.isSafeInteger(release.release_seq)||release.release_seq<=cap.seq)return '发布序号必须高于设备最高接受序号';
 // 活跃任务必须先核实终态，避免用重复点击绕过已有升级或结果不确定的任务。
 if(jobs.some(job=>job.machine_id===machine.machine_id&&!['installed','failed','rolled_back'].includes(job.state)))return '已有进行中的升级任务，请先核实状态';
 return '';
}

/** 功能：区分本地安装检查与真实正常上报；参数：任务及设备当前在线状态；返回值：中文阶段，不凭在线状态推断升级成功送达。 */
export function otaStatus(job:Pick<OtaJob,'state'>,isOnline:boolean):string{
 if(job.state==='pending')return isOnline?'等待客户端领取':'等待连接';
 const labels:Record<string,string>={downloaded:'已下载',verified:'已验签',waiting_exit:'等待采集器安全退出',replaced:'已替换，等待本地检查',checking:'正在执行本地检查',installed:'已安装／本地检查通过，等待正常上报',failed:'升级失败',rolled_back:'已回滚'};
 return labels[job.state]||`未知阶段（${job.state}）`;
}

/** 功能：将安全错误码解释为可操作原因；参数：服务端安全错误码；返回值：中文原因与未知错误码，不回显请求或凭据。 */
export function otaError(code:string):string{
 const errors:Record<string,string>={ota_not_eligible:'设备能力、信任根、版本序号或发布有效期不满足要求，请重新读取',ota_busy:'已有进行中的升级任务，请核实列表',unknown_machine:'设备已不存在，请刷新设备列表',bad_ota_request:'任务参数无效，请重新选择设备和版本',bad_ota_ack:'客户端阶段确认无效',stale_ota_ack:'客户端确认已过期',resume_unconfirmed:'本地安装检查已通过，但恢复运行请求未确认；请核实本机任务状态，不代表已恢复采集或送达'};
 return errors[code]||`升级未完成：${code}`;
}

/** 功能：发送一次管理员明确确认的任务创建请求；参数：已有内存鉴权请求器、设备编号和人工选定发布序号；返回值：逐设备服务端结果，失败直接抛出且不自动重试。 */
export function createOtaJobs(send:(path:string,body:unknown)=>Promise<OtaCreateResponse>,machineIds:number[],releaseSeq:number):Promise<OtaCreateResponse>{
 return send('/api/ota/jobs',{machine_ids:machineIds,release_seq:releaseSeq});
}
