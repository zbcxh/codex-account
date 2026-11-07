import test from 'node:test';import assert from 'node:assert/strict';import {onlineWindowSeconds,isReportOnline} from '../server/online-status.mjs';
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {ReportingConfig} from '../server/reporting-config.mjs';
test('5分钟周期加2分钟采集宽限，不因正常延迟反复离线',()=>{assert.equal(onlineWindowSeconds(5),420);for(const age of [0,299,300,301,359,400,420])assert.equal(isReportOnline(1000,1000+age,5),true);assert.equal(isReportOnline(1000,1421,5),false);});
test('按实际已确认周期，而非固定五分钟判断',()=>{assert.equal(onlineWindowSeconds(10),720);assert.equal(isReportOnline(1000,1720,10),true);assert.equal(isReportOnline(1000,1721,10),false);assert.equal(onlineWindowSeconds(1),180);});
test('没有上报、未来时间及无效时间不标在线',()=>{for(const time of [null,undefined,NaN,Infinity,1001])assert.equal(isReportOnline(time,1000,5),false);assert.equal(isReportOnline(1000,NaN,5),false);});
/** 功能：验证单台20分钟确认前后及默认周期变化的在线阈值；参数：无；返回值：测试完成，不访问正式数据库。 */
test('单台20分钟确认后使用22分钟阈值，未确认前保持实际周期，其他设备继续默认',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec(fs.readFileSync(new URL('../server/schema.sql',import.meta.url),'utf8'));
  db.exec("INSERT INTO machine(machine_id,client_id,token,label,created_at) VALUES(1,'fixture-a','synthetic-a','合成设备A',0),(2,'fixture-b','synthetic-b','合成设备B',0)");
  const reporting=new ReportingConfig(db);reporting.set(1,20);
  assert.equal(reporting.describe(1).pending,true);
  assert.equal(onlineWindowSeconds(reporting.describe(1).applied_interval_minutes),420);
  assert.equal(reporting.acknowledge(1,{version:reporting.policy().version,interval_minutes:20}),0);
  assert.equal(reporting.describe(1).pending,false);
  assert.equal(onlineWindowSeconds(reporting.describe(1).applied_interval_minutes),1320);
  assert.equal(onlineWindowSeconds(reporting.describe(2).applied_interval_minutes),420);
  assert.equal(isReportOnline(1000,2320,reporting.describe(1).applied_interval_minutes),true);
  assert.equal(isReportOnline(1000,2321,reporting.describe(1).applied_interval_minutes),false);
  // 修改默认值只形成新的待确认版本，不能把设备已应用的20分钟伪装成默认周期。
  reporting.set(null,6);
  assert.equal(reporting.describe(1).desired_interval_minutes,20);
  assert.equal(onlineWindowSeconds(reporting.describe(1).applied_interval_minutes),1320);
 }finally{db.close();}
});
