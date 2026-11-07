import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/server.mjs',import.meta.url),'utf8');
/** 功能：抽取真实OTA处理器并使用内存替身；参数：路径、口令轮换标志；返回值：响应和写入次数。 */
async function exercise(path,rotate=false){let secret='old',writes=0,release,response;const start=source.indexOf('async function handleOta(');assert.ok(start>=0);const handler=source.slice(start,source.indexOf('\n}',start)+2);const context={JSON,Number,Array,Set,security:{verifyAdmin:key=>key===secret},readBody:()=>new Promise(resolve=>{release=resolve;}),send:(_,status,body)=>{response={status,body};},ota:{list:()=>({releases:[],jobs:[]}),create:()=>{writes++;return {job_id:'fixture'};}},Q:{machineById:{get:id=>({machine_id:id,client_id:'fixture'})}},deviceMerge:{isMerged:()=>false}};vm.runInNewContext(handler+';this.handler=handleOta;',context);const pending=context.handler({headers:{'x-quota-bootstrap':'old'}},{},path);if(release){if(rotate)secret='new';release(JSON.stringify({machine_ids:[1],release_seq:2}));}await pending;return {response,writes};}
test('OTA管理写入等待正文后重新鉴权',async()=>{const r=await exercise('/api/ota/jobs',true);assert.equal(r.response.status,403);assert.equal(r.writes,0);});
test('OTA管理员定向创建任务',async()=>{const r=await exercise('/api/ota/jobs');assert.equal(r.response.status,200);assert.equal(r.writes,1);});
test('OTA管理员读取状态不写任务',async()=>{const r=await exercise('/api/ota/list');assert.equal(r.response.status,200);assert.equal(r.writes,0);});
