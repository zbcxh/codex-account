import test from 'node:test';
import assert from 'node:assert/strict';
import {accountReportTime, sortRecentAccountDevices} from '../src/domain.ts';

test('历史设备显示本地月日时分，未知时间不伪装为当前时间',()=>{
 const timestamp=new Date(2026,9,28,18,32,45).getTime()/1000;
 assert.equal(accountReportTime(timestamp),'10月28日 18:32');
 for(const value of [null,undefined,NaN,Infinity])assert.equal(accountReportTime(value),'未知');
});

test('最近设备按账号最后上报时间降序，未知排最后且不改变原数组',()=>{
 const devices=[{machine_id:1,last_reported_at:null},{machine_id:2,last_reported_at:100},{machine_id:3,last_reported_at:300},{machine_id:4},{machine_id:5,last_reported_at:200},{machine_id:6,last_reported_at:NaN}];
 assert.deepEqual(sortRecentAccountDevices(devices).map(m=>m.machine_id),[3,5,2,1,4,6]);
 assert.deepEqual(devices.map(m=>m.machine_id),[1,2,3,4,5,6]);
});
