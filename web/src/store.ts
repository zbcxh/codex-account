import {computed,ref} from 'vue';
import {defineStore} from 'pinia';
import {api,ApiError,setCredential} from './api';
import {online} from './domain';
import type {Action,PairCode,Snapshot} from './types';
/** 功能：管理真实状态快照、刷新和服务器时间；参数：无；返回值：Pinia状态。 */
export const useData=defineStore('data',()=>{
 const snapshot=ref<Snapshot|null>(null),loading=ref(false),error=ref(''),readLocked=ref(false),fetchedAt=ref<number|null>(null),tick=ref(performance.now());let origin=performance.now();let pending:Promise<void>|null=null;let controller:AbortController|null=null;
 const now=computed(()=>snapshot.value?snapshot.value.server_now+Math.max(0,tick.value-origin)/1000:Date.now()/1000);
 const active=computed(()=>snapshot.value?.machines.filter(m=>online(m,now.value))||[]);
 // 账号与设备共用同一单调时间和实际周期，旧快照不会让账号在线数量永久停留。
 const accounts=computed(()=>snapshot.value?.accounts.map(account=>{
  const members=account.machines.map(member=>({...member,stale:active.value.some(machine=>machine.machine_id===member.machine_id&&machine.account_id===account.account_id)?'green':'grey'}));
  const count=members.filter(member=>member.stale==='green').length;
  return {...account,machines:members,in_use:count>0,active_machine_count:count};
 })||[]);
 /** 功能：合并重复刷新，失败保留最后快照并区分读取闸门；参数：无；返回值：异步完成。 */
 function refresh():Promise<void>{if(pending)return pending;loading.value=true;controller=new AbortController();pending=(async()=>{try{const data=await api.state(controller!.signal);if(!Array.isArray(data.accounts)||!Array.isArray(data.machines))throw new Error('快照格式不兼容');snapshot.value=data;origin=performance.now();tick.value=origin;fetchedAt.value=Date.now();error.value='';readLocked.value=false;}catch(e){if(e instanceof DOMException&&e.name==='AbortError')return;readLocked.value=e instanceof ApiError&&e.code==='not_paired';error.value=e instanceof Error?e.message:'读取失败';}finally{loading.value=false;pending=null;}})();return pending;}
 /** 功能：取消离开应用时的请求；参数：无；返回值：无。 */
 function dispose(){controller?.abort();}
 return {snapshot,loading,error,readLocked,fetchedAt,now,active,accounts,refresh,dispose,tick};
});
/** 功能：管理只驻留内存的管理授权与操作弹层；参数：无；返回值：Pinia状态。 */
export const useUI=defineStore('ui',()=>{
 const authorized=ref(false),authOpen=ref(false),action=ref<Action|null>(null),codes=ref<PairCode[]>([]),codesLoaded=ref(false);
 /** 功能：设置或清除内存授权；参数：value为管理口令；返回值：无。 */
 function credential(value:string){setCredential(value);authorized.value=Boolean(value);if(!value){codes.value=[];codesLoaded.value=false;}}
 /** 功能：打开操作，没有管理授权时只询问授权；参数：next为操作；返回值：无。 */
 function open(next:Action){if(!authorized.value){authOpen.value=true;return;}action.value=next;}
 return {authorized,authOpen,action,codes,codesLoaded,credential,open};
});
