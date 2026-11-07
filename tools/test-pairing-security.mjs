// 本脚本仅在用户批准验证后执行；所有数据库、凭据和设备均为临时合成值。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PairingSecurity } from '../server/pairing-security.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quota-pairing-fixture-'));
const database=path.join(directory,'fixture.sqlite3');
let db;
let checks=0;
/** 功能：断言明确的业务错误；参数：operation 为操作，code 为预期错误码；返回值：无。 */
function rejects(operation,code) {
  assert.throws(operation,error => error.publicCode===code);
  checks++;
}
/** 功能：注册合成设备并保留旧令牌；参数：clientId 为合成身份；返回值：注册回调。 */
function register(clientId) {
  return existing => {
    db.prepare('INSERT OR IGNORE INTO machine(client_id,token) VALUES(?,?)').run(clientId,existing?.token || crypto.randomBytes(24).toString('hex'));
    return db.prepare('SELECT * FROM machine WHERE client_id=?').get(clientId);
  };
}
try {
  db=new DatabaseSync(database);
  db.exec('CREATE TABLE machine(machine_id INTEGER PRIMARY KEY,client_id TEXT UNIQUE NOT NULL,token TEXT NOT NULL)');
  const admin='synthetic-initial-bootstrap';
  let security=new PairingSecurity(db,admin);
  assert(security.verifyAdmin(admin)); checks++;
  rejects(() => security.changeAdmin('wrong','synthetic-new-bootstrap','synthetic-new-bootstrap'),'bad_bootstrap');
  rejects(() => security.changeAdmin(admin,'short','short'),'bad_new_bootstrap');
  security.changeAdmin(admin,'synthetic-new-bootstrap','synthetic-new-bootstrap');
  assert(!security.verifyAdmin(admin) && security.verifyAdmin('synthetic-new-bootstrap')); checks++;
  db.close();
  db=new DatabaseSync(database);
  security=new PairingSecurity(db,admin);
  assert(!security.verifyAdmin(admin) && security.verifyAdmin('synthetic-new-bootstrap')); checks++;
  const single=security.createCode({name:'单次合成',kind:'single'});
  const device=security.redeem(single.code,'device-a',null,register('device-a'));
  const retry=security.redeem(single.code,'device-a',null,register('device-a'));
  assert.equal(retry.token,device.token); checks++;
  rejects(() => security.redeem(single.code,'device-b',null,register('device-b')),'pairing_code_used');
  const now=Math.floor(Date.now()/1000);
  const timed=security.createCode({name:'限时合成',kind:'timed',starts_at:now-1,expires_at:now+600});
  security.redeem(timed.code,'device-b',null,register('device-b'));
  security.redeem(timed.code,'device-c',null,register('device-c'));
  assert.equal(security.listCodes().find(x=>x.id===timed.id).uses,2); checks++;
  const permanent=security.createCode({name:'永久合成',kind:'permanent'});
  rejects(() => security.redeem(permanent.code,'device-a',null,register('device-a')),'existing_device_requires_token');
  const same=security.redeem(permanent.code,'device-a',device.token,register('device-a'));
  assert.equal(same.token,device.token); checks++;
  const before=db.prepare('SELECT * FROM machine ORDER BY machine_id').all();
  const failed=security.createCode({name:'事务合成',kind:'single'});
  assert.throws(() => security.redeem(failed.code,'device-failed',null,() => {
    db.prepare('INSERT INTO machine(client_id,token) VALUES(?,?)').run('device-failed','synthetic-token');
    throw new Error('synthetic_interruption');
  }));
  assert.deepEqual(db.prepare('SELECT * FROM machine ORDER BY machine_id').all(),before);
  assert.equal(security.listCodes().find(x=>x.id===failed.id).uses,0); checks++;
  const scheduled=security.createCode({name:'预约合成',kind:'timed',starts_at:now+600,expires_at:now+1200});
  rejects(() => security.redeem(scheduled.code,'device-d',null,register('device-d')),'pairing_code_unavailable');
  db.prepare('UPDATE pairing_code SET expires_at=? WHERE id=?').run(now-1,timed.id);
  rejects(() => security.redeem(timed.code,'device-d',null,register('device-d')),'pairing_code_unavailable');
  security.revokeCode(permanent.id);
  rejects(() => security.redeem(permanent.code,'device-e',null,register('device-e')),'pairing_code_unavailable');
  assert.equal(db.prepare('SELECT token FROM machine WHERE client_id=?').get('device-a').token,device.token); checks++;
  db.prepare('UPDATE pairing_claim SET claimed_at=? WHERE code_id=?').run(now-601,single.id);
  rejects(() => security.redeem(single.code,'device-a',null,register('device-a')),'pairing_code_used');
  const listed=JSON.stringify(security.listCodes());
  assert(!listed.includes(single.code) && !listed.includes('digest')); checks++;
  const saved=db.prepare('SELECT * FROM admin_authorization').get();
  assert(!JSON.stringify(saved).includes('synthetic-new-bootstrap')); checks++;
  rejects(() => security.createCode({name:'错误合成',kind:'timed',starts_at:now,expires_at:now}),'bad_pairing_time');
  rejects(() => security.createCode({name:'错误合成',kind:'permanent',expires_at:now+60}),'bad_pairing_time');
  console.log(JSON.stringify({ok:true,checks,isolated_database:true,synthetic_credentials_only:true}));
} finally {
  if(db?.isOpen) db.close();
  // 只删除本脚本通过 mkdtemp 创建的独立目录，不计算任何产品数据路径。
  fs.rmSync(directory,{recursive:true,force:true});
}
