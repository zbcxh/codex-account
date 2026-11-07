import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {requestSource} from '../server/proxy-source.mjs';

const source=fs.readFileSync(new URL('../server/server.mjs',import.meta.url),'utf8');
/** 功能：抽取真实顶层处理器供隔离执行；参数：函数名；返回值：原始函数源码，不启动服务。 */
function definition(name){
 const start=source.indexOf(`async function ${name}(`);
 assert.ok(start>=0,`缺少处理器 ${name}`);
 return source.slice(start,source.indexOf('\n}',start)+2);
}
const names=['handleSecurity','handleReportingConfig','handleDeviceMerge','handleAccountDelete','handleAlias','handleAccountHidden','handleHistoryCleanup','handleOta'];
const routeStart=source.indexOf('const server = http.createServer(async (req, res) => {');
const routeSource=source.slice(routeStart,source.indexOf('\n});',routeStart)+4);
const operations=[
 ['/api/history-cleanup/save',{retention_days:90,automatic_enabled:false,version:1}],
 ['/api/history-cleanup/execute',{preview_token:'synthetic-preview',confirmation:'删除历史额度'}],
 ['/api/machine/1/merge',{target_id:2,merge_token:'synthetic-preview',confirmation:'1->2'}],
 ['/api/account/account-fixture/delete',{delete_token:'synthetic-preview',confirmation:'account-fixture'}],
 ['/api/reporting-config',{interval_minutes:10}],
 ['/api/machine/1/reporting-config',{interval_minutes:10}],
 ['/api/account/account-fixture/alias',{display_name:'合成映射'}],
 ['/api/machine/1/label',{label:'合成设备'}],
 ['/api/server-migration',{machine_id:null,server_url:'https://fixture.invalid'}],
 ['/api/pairing-codes',{name:'合成邀请',kind:'permanent'}],
 ['/api/ota/jobs',{machine_ids:[1],release_seq:2}],
];
/** 功能：以内存鉴权和写入替身运行真实路由；参数：是否轮换、初始口令、路径和正文；返回值：响应与写入计数。 */
async function exercise(rotate,key,path,body){
 let current='synthetic-old',writes=0,readStarted=false,release,response,route;
 /** 功能：记录合成写入；参数：忽略的业务参数；返回值：合成结果。 */
 const write=()=>{writes++;return {machines:[]};};
 const context={requestSource,CFG:{trustLoopbackProxy:false},URL,Buffer,Map,Set,Number,String,JSON,Date,ACCOUNT_ID_RE:/^[A-Za-z0-9._:-]{6,128}$/,READ_GATE:false,
  http:{createServer:handler=>{route=handler;}},ipAllowed:()=>true,nowSec:()=>1234,
  security:{hasAdmin:()=>true,verifyAdmin:value=>value===current,createCode:write},
  readBody:()=>{readStarted=true;return new Promise(resolve=>{release=resolve;});},
  send:(_res,status,payload)=>{response={status,payload};},
  cleanup:{save:write,execute:write},deviceMerge:{isMerged:()=>false,execute:write},accountRecords:{remove:write},
  reporting:{set:write},validInterval:value=>Number.isInteger(value)&&value>=1&&value<=1440,
  migration:{set:write},visibleMigration:value=>value,
  ota:{create:write},
  Q:{machineById:{get:()=>({machine_id:1})},aliasUp:{run:write},setLabel:{run:write}},
 };
 vm.runInNewContext(names.map(definition).join('\n')+'\n'+routeSource,context);
 const pending=route({method:'POST',url:path,headers:{'x-quota-bootstrap':key},socket:{remoteAddress:'127.0.0.1'}},{});
 // 精确停在真实处理器等待正文的位置，再模拟另一个请求完成口令轮换，避免依赖定时等待。
 if(readStarted){if(rotate)current='synthetic-new';release(JSON.stringify(body));}
 await pending;
 return {response,writes,readStarted};
}
// 同时覆盖轮换拒绝、原本无权和正常授权，防止以禁用全部管理写入掩盖问题。
for(const [path,body] of operations){
 test(`等待正文期间轮换后拒绝旧口令：${path}`,async()=>{
  const r=await exercise(true,'synthetic-old',path,body);assert.equal(r.readStarted,true);assert.equal(r.response.status,403);assert.equal(r.response.payload.error,'bad_bootstrap');assert.equal(r.writes,0);
 });
 test(`正确口令仍可操作：${path}`,async()=>{
  const r=await exercise(false,'synthetic-old',path,body);assert.equal(r.response.status,200);assert.equal(r.writes,1);
 });
 test(`无效口令在读取正文前拒绝：${path}`,async()=>{
  const r=await exercise(false,'synthetic-invalid',path,body);assert.equal(r.response.status,403);assert.equal(r.writes,0);assert.equal(r.readStarted,false);
 });
}
