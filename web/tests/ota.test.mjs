import {test} from 'node:test';
import assert from 'node:assert/strict';
import {otaEligibility,otaStatus,otaError,createOtaJobs} from '../src/ota.ts';

const machine={machine_id:7,client_id:'synthetic-client',last_ok_at:1,online_window_sec:300};
const cap={machine_id:7,client_id:'synthetic-client',seq:2,key_id:'test-only'};
const release={release_seq:3,version:'1.2.3',platform:'win-x64',key_id:'test-only',expires_at:5000};

test('旧设备、身份不符或未知可信根不能创建升级任务',()=>{
 assert.match(otaEligibility(machine,undefined,release,[],1000),/不支持/);
 assert.match(otaEligibility(machine,{...cap,client_id:'different'},release,[],1000),/身份/);
 assert.match(otaEligibility(machine,cap,{...release,key_id:'other'},[],1000),/信任根/);
});
test('过期、平台错误和序号倒退拒绝；离线设备允许等待正常连接',()=>{
 assert.match(otaEligibility(machine,cap,{...release,expires_at:1000},[],1000),/过期/);
 assert.match(otaEligibility(machine,cap,{...release,platform:'other'},[],1000),/平台/);
 assert.match(otaEligibility(machine,cap,{...release,release_seq:2},[],1000),/序号/);
 assert.equal(otaEligibility(machine,cap,release,[],1000),'');
 assert.equal(otaStatus({state:'pending'},false),'等待连接');
 assert.equal(otaStatus({state:'pending'},true),'等待客户端领取');
});
test('活跃任务阻止重复选择；终态不会阻止新任务',()=>{
 const job={machine_id:7,client_id:'synthetic-client',state:'checking'};
 assert.match(otaEligibility(machine,cap,release,[job],1000),/进行中/);
 assert.equal(otaEligibility(machine,cap,release,[{...job,state:'failed'}],1000),'');
 assert.equal(otaStatus({state:'installed'},false),'已安装／本地检查通过，等待正常上报');
 assert.equal(otaStatus({state:'new-state'},true),'未知阶段（new-state）');
});
test('任务创建仅发送一次，结果不确定不自动重试',async()=>{
 const calls=[];
 const send=async(path,body)=>{calls.push({path,body});throw new Error('timeout');};
 await assert.rejects(createOtaJobs(send,[7],3),/timeout/);
 assert.deepEqual(calls,[{path:'/api/ota/jobs',body:{machine_ids:[7],release_seq:3}}]);
});
test('逐设备结果保留服务端事实，未知错误码明确展示而不误报成功',async()=>{
 const result={ok:true,results:[{machine_id:7,error:'ota_busy'}]};
 assert.equal(await createOtaJobs(async()=>result,[7],3),result);
 assert.match(otaError('ota_busy'),/进行中/);
 assert.match(otaError('new_error'),/new_error/);
});
