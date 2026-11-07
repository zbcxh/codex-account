import type {Account,Alias,Machine,PairCode,Snapshot,OtaJob,OtaCapability,OtaRelease} from './types';
import {otaEligibility} from './ota';
const now=Math.floor(Date.now()/1000);const aliases:Alias[]=[{account_id:'11111111-1111-4111-8111-111111111111',display_name:'Alpha Workspace',owner:'演示负责人A',note:null},{account_id:'22222222-2222-4222-8222-222222222222',display_name:'Beta Workspace',owner:'演示负责人B',note:null},{account_id:'33333333-3333-4333-8333-333333333333',display_name:'Gamma Workspace',owner:'演示负责人C',note:null}];
const machines:Machine[]=Array.from({length:6},(_v,index)=>{const a=aliases[[0,1,1,0,2,2][index]]!;const active=[0,1,2,4].includes(index);return {machine_id:index+1,client_id:'demo-device-'+(index+1),label:['主力工作站','开发笔记本','设计工作站','便携笔记本','测试工作站','备用工作站'][index],hostname:'DEMO-NODE-'+(index+1),account_id:a.account_id,display_name:a.display_name,owner:a.owner,account_known:true,plan_type:'pro',windows:[{kind:'primary',label:'周(7天)',minutes:10080,used_percent:[34,18,18,34,86,86][index],resets_at:now+86400*(index===4?1:5)}],last_ok_at:now-(active?60:3600),collected_at:now-90,age_sec:active?60:3600,stale:active?'green':'grey',online_window_sec:300,has_report:true,balance:index===0?'12860.50':null,has_credits:index===0,unlimited:false,cli_version:'演示版本',source:'app_server',skew_sec:0,reporting:{applied_interval_minutes:5,desired_interval_minutes:5,override_interval_minutes:null,pending:false}};});
let codes:PairCode[]=[{id:1,name:'研发组 · 合成邀请',kind:'timed',status:'active',starts_at:now-600,expires_at:now+86400,uses:2,last_used_at:now-90,revoked_at:null}];let authorized=false,admin='demo-admin-only',defaultMinutes=5;
const otaReleases:OtaRelease[]=[{release_seq:3,version:'1.2.3',platform:'win-x64',key_id:'demo-metadata-only',expires_at:now+86400}];
const otaCapabilities:OtaCapability[]=[1,4].map(id=>({machine_id:id,client_id:`demo-device-${id}`,seq:2,key_id:'demo-metadata-only'}));
const otaJobs:OtaJob[]=[];
/** 功能：从合成设备生成账号级最新快照；参数：无；返回值：演示快照。 */
function snapshot():Snapshot{const accounts:Account[]=aliases.filter(a=>!a.hidden).map(a=>{const members=machines.filter(m=>m.account_id===a.account_id);const latest=members[0];return {...latest,account_id:a.account_id,display_name:a.display_name,owner:a.owner,windows:latest?.windows||[],plan_type:latest?.plan_type??null,collected_at:latest?.collected_at??null,balance:latest?.balance??null,has_credits:latest?.has_credits??null,unlimited:latest?.unlimited??null,key:a.account_id,active_machine_count:members.filter(m=>m.stale==='green').length,in_use:members.some(m=>m.stale==='green'),machines:members.map(m=>({machine_id:m.machine_id,label:m.label,stale:m.stale,age_sec:m.age_sec}))};});return {server_now:Math.floor(Date.now()/1000),machines,accounts,aliases:aliases.filter(a=>!a.hidden),reporting_config:{default_interval_minutes:defaultMinutes,version:1}};}
/** 功能：模拟独立演示接口，不发出网络或持久化业务数据；参数：路径与请求选项；返回值：合成响应。 */
export async function demoRequest<T>(path:string,options:{method?:string;body?:unknown;credential?:string}):Promise<T>{
 await new Promise(resolve=>setTimeout(resolve,150));const body=(options.body||{}) as Record<string,unknown>;
 if(path==='/api/unlock'){if(body.key!==admin)throw new Error('演示读取解锁口令不正确');return {ok:true,expires_in_sec:28800} as T;}
 if(path==='/api/state')return structuredClone(snapshot()) as T;
 if(path.startsWith('/api/accounts'))return structuredClone({accounts:aliases.filter(a=>path.includes('include_hidden=1')||!a.hidden).map(a=>({...a,active_machine_count:machines.filter(m=>m.account_id===a.account_id&&m.stale==='green').length,last_reported_at:now-60,plan_type:'pro'}))}) as T;
 if(path==='/api/pairing-codes/list'&&options.credential){if(options.credential!==admin)throw new Error('演示口令不正确，请使用 demo-admin-only');authorized=true;}
 if(!authorized)throw new Error('请使用演示口令 demo-admin-only 授权，不要输入真实口令');
 if(path==='/api/ota/list')return structuredClone({ok:true,releases:otaReleases,jobs:otaJobs,capabilities:otaCapabilities}) as T;
 if(path==='/api/ota/jobs'){
  const release=otaReleases.find(item=>item.release_seq===body.release_seq);
  // 演示只创建内存任务，复用选择约束模拟逐设备结果，绝不执行下载、安装或真实上报。
  const results=(Array.isArray(body.machine_ids)?body.machine_ids:[]).map(id=>{
   const machine=machines.find(item=>item.machine_id===id);
   if(!machine||otaEligibility(machine,otaCapabilities.find(item=>item.machine_id===id),release,otaJobs,Date.now()/1000))return {machine_id:id,error:'ota_not_eligible'};
   const job:OtaJob={job_id:`demo-${crypto.randomUUID()}`,machine_id:id,client_id:machine.client_id,seq:release!.release_seq,state:'pending',error:null,updated_at:Math.floor(Date.now()/1000)};
   otaJobs.unshift(job);return {machine_id:id,job};
  });
  return structuredClone({ok:true,results}) as T;
 }
 if(path==='/api/pairing-codes/list')return structuredClone({codes}) as T;
 if(path==='/api/pairing-codes'){const code:PairCode={id:Date.now(),name:String(body.name),kind:body.kind as PairCode['kind'],starts_at:Number(body.starts_at||now),expires_at:body.kind==='permanent'?null:Number(body.expires_at),status:'active',uses:0,last_used_at:null,revoked_at:null};codes.unshift(code);return {ok:true,...code,code:'DEMO-'+crypto.randomUUID()} as T;}
 const revoke=path.match(/^\/api\/pairing-codes\/(\d+)\/revoke$/);if(revoke){const code=codes.find(c=>c.id===Number(revoke[1]));if(code){code.revoked_at=Math.floor(Date.now()/1000);code.status='revoked';}return {ok:true} as T;}
 if(path==='/api/admin/bootstrap'){if(options.credential!==admin)throw new Error('当前演示口令不正确');admin=String(body.new_bootstrap);return {ok:true} as T;}
 if(path==='/api/reporting-config'){defaultMinutes=Number(body.interval_minutes);return {ok:true} as T;}
 const device=path.match(/^\/api\/machine\/(\d+)\/(label|reporting-config)$/);if(device){const m=machines.find(m=>m.machine_id===Number(device[1]));if(m){if(device[2]==='label')m.label=String(body.label);else {m.reporting.override_interval_minutes=body.interval_minutes as number|null;m.reporting.desired_interval_minutes=Number(body.interval_minutes??defaultMinutes);m.reporting.pending=true;}}return {ok:true} as T;}
 const match=path.match(/^\/api\/account\/([^/]+)\/(alias|hidden)$/);if(match){const id=decodeURIComponent(match[1]);let a=aliases.find(a=>a.account_id===id);if(!a){a={account_id:id,display_name:null,owner:null,note:null};aliases.push(a);}if(match[2]==='hidden')a.hidden=options.method!=='DELETE';else if(options.method==='DELETE'){a.display_name=null;a.owner=null;a.note=null;}else Object.assign(a,body);for(const m of machines.filter(m=>m.account_id===id)){m.display_name=a.display_name;m.owner=a.owner;}return {ok:true} as T;}
 throw new Error('演示模式未提供此操作');
}
