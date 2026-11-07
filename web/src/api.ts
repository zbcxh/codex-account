import type {Alias,PairCode,Snapshot} from './types';
export class ApiError extends Error {
  /** 功能：创建可安全展示的请求异常；参数：状态、错误码；返回值：错误实例。 */
  constructor(public status:number,public code:string){super(messages[code]|| (status===403?'无权执行此操作，请重新授权':status===404?'服务端尚未提供此功能':'请求失败，请稍后重试'));}
}
const messages:Record<string,string>={binding_https_required:'浏览器绑定需要HTTPS，请打开云端HTTPS地址',bad_binding_name:'浏览器名称须为1至80字',unknown_binding:'绑定不存在，请重新读取',bad_wecom_webhook:'请输入有效的企业微信群机器人 Webhook 地址',bad_merge_devices:'请选择两个不同的有效设备',device_already_merged:'设备已合并停用，请刷新列表',merge_source_online:'旧设备仍在线，不能合并，请先停止旧采集器',merge_report_conflict:'设备报告键存在冲突，已阻止合并，请先核查',bad_merge_confirmation:'请输入正确的源编号->目标编号确认方向',stale_merge_preview:'合并预览过期或设备状态已变化，请重新预览',account_in_use:'该账号仍有设备在线使用，不能删除',stale_account_preview:'删除预览已失效或记录发生变化，请重新预览',bad_account_confirmation:'请输入完整账号ID确认',unknown_account:'账号记录不存在，请刷新',mixed_account_report:'发现跨账号混合报告，已阻止删除，请先核查数据',bad_cleanup_policy:'保留天数须为1至3650整数，请检查设置',stale_cleanup_preview:'预览已失效或数据发生变化，请重新预览',bad_cleanup_confirmation:'清理确认内容不正确',cleanup_count_mismatch:'数据发生变化，清理已回滚，请重新预览',bad_server_url:'服务器地址无效，请使用不含凭据和参数的 HTTP/HTTPS 地址',unknown_machine:'设备不存在，请重新加载',bad_bootstrap:'管理员口令不正确，请重新授权',not_paired:'当前来源尚未获得面板读取权限',bad_key:'读取解锁口令不正确',bad_new_bootstrap:'新口令至少16位、最多256字节，且两次输入一致',bootstrap_unchanged:'新口令不能与当前口令相同',bad_pairing_time:'有效时间不正确，请重新选择',bad_pairing_name:'请填写配对码名称',network:'连接失败，请检查服务地址',timeout:'请求超时，结果可能未确认，请先刷新核实',invalid_response:'服务器返回了无法识别的数据，请检查代理地址',stale_config:'配置已变化，请刷新后重新操作'};
let bootstrap='';
/** 功能：仅在内存设置管理凭据；参数：value；返回值：无，不写存储。 */
export function setCredential(value:string){bootstrap=value;}
/** 功能：向同源API请求，不自动重试管理写入；参数：路径、请求方法/正文/取消信号/临时授权；返回值：类型化响应。 */
export async function request<T>(path:string,options:{method?:string;body?:unknown;signal?:AbortSignal;credential?:string}={}):Promise<T>{
  if(import.meta.env.VITE_DEMO==='true'){const {demoRequest}=await import('./demo');return demoRequest<T>(path,options);}
  const control=new AbortController();let timedOut=false;
  const cancel=()=>control.abort();options.signal?.addEventListener('abort',cancel,{once:true});
  if(options.signal?.aborted)control.abort();
  const timeout=setTimeout(()=>{timedOut=true;control.abort();},15000);
  const method=options.method||'GET';const headers:Record<string,string>={accept:'application/json'};
  if(options.body!==undefined)headers['content-type']='application/json';
  if(method!=='GET'&&(options.credential??bootstrap))headers['x-quota-bootstrap']=options.credential??bootstrap;
  try{
    const response=await fetch(path,{method,headers,body:options.body===undefined?undefined:JSON.stringify(options.body),signal:control.signal,cache:'no-store',redirect:'error'});
    const data=await response.json().catch(()=>{throw new ApiError(response.status,'invalid_response');});
    if(!response.ok){if(data.error==='bad_bootstrap'){bootstrap='';window.dispatchEvent(new Event('quota-authorization-expired'));}throw new ApiError(response.status,data.error||'request_failed');}
    return data as T;
  }catch(error){if(error instanceof ApiError)throw error;if(timedOut)throw new ApiError(0,'timeout');if(control.signal.aborted)throw new DOMException('Aborted','AbortError');throw new ApiError(0,'network');}
  finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',cancel);}
}
export const api={
  /** 功能：显式解锁当前来源的读取权限，不建立管理授权；参数：key为当前管理员口令；返回值：解锁期限。 */
  unlock:(key:string)=>request<{ok:boolean;expires_in_sec:number}>('/api/unlock',{method:'POST',body:{key},credential:''}),
  /** 功能：读取主快照；参数：取消信号；返回值：服务端快照。 */
  state:(signal?:AbortSignal)=>request<Snapshot>('/api/state',{signal}),
  /** 功能：读取显示映射；参数：是否含隐藏项；返回值：账号列表。 */
  aliases:(hidden=false)=>request<{accounts:Alias[]}>('/api/accounts'+(hidden?'?include_hidden=1':'')),
  /** 功能：读取配对码元数据并可验证临时授权；参数：可选口令；返回值：安全元数据。 */
  codes:(credential?:string)=>request<{codes:PairCode[]}>('/api/pairing-codes/list',{method:'POST',body:{},credential}),
  /** 功能：执行显式管理操作；参数：路径、正文、方法；返回值：确认响应，不自动重试。 */
  mutate:<T=Record<string,unknown>>(path:string,body:unknown,method='POST')=>request<T>(path,{method,body}),
};
