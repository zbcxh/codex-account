import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {withAccountDeviceReportTimes} from '../server/account-device-times.mjs';

test('账号设备联合时间隔离，多窗口合并，迟到补报取最后接收时间，未知保持空值',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec('CREATE TABLE quota_snapshot(account_id TEXT,machine_id INTEGER,collected_at INTEGER,reported_at INTEGER)');
  const insert=db.prepare('INSERT INTO quota_snapshot VALUES(?,?,?,?)');
  insert.run('A',1,100,110);insert.run('A',1,50,220);insert.run('A',1,50,220);
  insert.run('A',2,1,1);insert.run('B',1,999,999);insert.run(null,1,1000,1000);
  const input=[{account_id:'A',machines:[{machine_id:1,last_ok_at:999},{machine_id:2},{machine_id:3}]},{account_id:'B',machines:[{machine_id:1}]},{account_id:null,machines:[{machine_id:1}]}];
  const output=withAccountDeviceReportTimes(db,input);
  assert.deepEqual(output[0].machines.map(m=>m.last_reported_at),[220,1,null]);
  assert.equal(output[1].machines[0].last_reported_at,999);
  assert.equal(output[2].machines[0].last_reported_at,null);
  assert.equal(output[0].machines[0].last_ok_at,999);
  assert.equal(input[0].machines[0].last_reported_at,undefined);
 } finally {db.close();}
});
