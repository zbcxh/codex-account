import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Ota,verifyManifest} from '../server/ota.mjs';

const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const now=1800000000;
test('整数词法与C#一致，拒绝小数及指数形式',()=>{for(const literal of ['1.0','1e0','-0']){const manifest=release().manifest.replace('"protocol":1','"protocol":'+literal);const signature=crypto.sign('RSA-SHA256',Buffer.from(manifest),privateKey).toString('base64');assert.throws(()=>verifyManifest({manifest,signature},publicKey,now));}});
/** 功能：创建临时签名发布；参数：覆盖字段；返回值：清单信封及合成程序。 */
function release(extra={}){const bytes=Buffer.from('synthetic executable');const manifest=JSON.stringify({protocol:1,release_seq:2,version:'2.0.0',platform:'win-x64',min_updater:1,filename:'CodexQuotaCollector.exe',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,issued_at:now-10,expires_at:now+1000,key_id:'fixture',...extra});return {manifest,signature:crypto.sign('RSA-SHA256',Buffer.from(manifest),privateKey).toString('base64'),bytes};}
test('可信清单与篡改、过期、平台及大小门禁',()=>{const good=release();assert.equal(verifyManifest(good,publicKey,now).release_seq,2);for(const extra of [{expires_at:now},{platform:'linux'},{size:20971521},{release_seq:0}])assert.throws(()=>verifyManifest(release(extra),publicKey,now));assert.throws(()=>verifyManifest({...good,manifest:good.manifest+' '},publicKey,now));});
test('重复字段与错误类型拒绝',()=>{const good=release();good.manifest=good.manifest.replace('"protocol":1','"protocol":1,"protocol":1');good.signature=crypto.sign('RSA-SHA256',Buffer.from(good.manifest),privateKey).toString('base64');assert.throws(()=>verifyManifest(good,publicKey,now));assert.throws(()=>verifyManifest(release({size:'20'}),publicKey,now));});
test('设备能力、归属、幂等与降级隔离',()=>{const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>now);const r=release();ota.publish(r,publicKey);assert.throws(()=>ota.create(1,'device-one',2));ota.capability(1,'device-one',{protocol:1,release_seq:1,key_id:'fixture'});const job=ota.create(1,'device-one',2);assert.equal(ota.create(1,'device-one',2).job_id,job.job_id);assert.equal(ota.claim(2,'other'),null);assert.equal(ota.claim(1,'device-one').job_id,job.job_id);assert.throws(()=>ota.ack(2,'other',job.job_id,'installed'));ota.ack(1,'device-one',job.job_id,'installed');ota.ack(1,'device-one',job.job_id,'installed');assert.throws(()=>ota.ack(1,'device-one',job.job_id,'downloaded'));assert.equal(ota.claim(1,'device-one'),null);assert.throws(()=>ota.create(1,'device-one',2));db.close();});
/** 功能：验证过期待执行任务不阻塞新发布；参数：无；返回值：无。 */
test('未执行的过期任务释放设备槽位',()=>{
  let time=now;const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>time);
  ota.publish(release({expires_at:now+1}),publicKey);ota.capability(1,'one',{protocol:1,release_seq:1,key_id:'fixture'});
  const old=ota.create(1,'one',2);time+=2;assert.equal(ota.claim(1,'one'),null);
  ota.publish(release({release_seq:3}),publicKey);assert.equal(ota.create(1,'one',3).seq,3);
  assert.equal(ota.list().jobs.find(job=>job.job_id===old.job_id).error,'manifest_expired');db.close();
});
/** 功能：验证下载的设备、任务终态及密钥归属；参数：无；返回值：无。 */
test('下载必须绑定活动任务与当前设备信任根',()=>{
  const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>now);ota.publish(release(),publicKey);
  ota.capability(1,'one',{protocol:1,release_seq:1,key_id:'fixture'});const job=ota.create(1,'one',2);
  assert.throws(()=>ota.download(2,'other',job.job_id));assert.equal(ota.download(1,'one',job.job_id).seq,2);
  assert.throws(()=>ota.capability(1,'one',{protocol:1,release_seq:1,key_id:'changed'}));
  assert.throws(()=>ota.capability(1,'other',{protocol:1,release_seq:1,key_id:'fixture'}));
  assert.equal(ota.list().capabilities[0].key_id,'fixture');
  ota.ack(1,'one',job.job_id,'failed','download_failed');assert.throws(()=>ota.download(1,'one',job.job_id));db.close();
});
/** 功能：验证发布重试与序号冲突；参数：无；返回值：无。 */
test('发布序号单调且原样重试幂等，冲突拒绝',()=>{
  const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>now);const envelope=release();
  ota.publish(envelope,publicKey);assert.equal(ota.publish(envelope,publicKey).release_seq,2);
  assert.throws(()=>ota.publish(release({release_seq:1}),publicKey));assert.throws(()=>ota.publish(release({version:'9.0.0'}),publicKey));db.close();
});
/** 功能：验证最高序号与终态重放不能被失败清除；参数：无；返回值：无。 */
test('验签接受后失败保留最高序号，早期失败允许管理员明确重试',()=>{
  const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>now);ota.publish(release(),publicKey);
  ota.capability(1,'one',{protocol:1,release_seq:1,key_id:'fixture'});const first=ota.create(1,'one',2);
  ota.ack(1,'one',first.job_id,'failed','download_failed');const second=ota.create(1,'one',2);assert.notEqual(second.job_id,first.job_id);
  ota.ack(1,'one',second.job_id,'verified');assert.equal(ota.create(1,'one',2).job_id,second.job_id);
  ota.capability(1,'one',{protocol:1,release_seq:0,key_id:'fixture'});assert.equal(ota.list().capabilities[0].seq,2);
  ota.ack(1,'one',second.job_id,'failed','health_failed');
  ota.ack(1,'one',second.job_id,'failed','different_error');assert.equal(ota.list().jobs.find(job=>job.job_id===second.job_id).error,'health_failed');
  assert.throws(()=>ota.create(1,'one',2));assert.throws(()=>ota.ack(1,'one',second.job_id,'installed'));db.close();
});
/** 功能：验证严格签名编码、预期密钥以及转义重复字段；参数：无；返回值：无。 */
test('严格签名编码和显式密钥身份门禁',()=>{
  const good=release();assert.throws(()=>verifyManifest({...good,signature:good.signature+'!!'},publicKey,now));
  assert.throws(()=>verifyManifest(good,publicKey,now,'other'));
  const escaped={...good,manifest:good.manifest.replace('"protocol":1','"protocol":1,"\\u0070rotocol":1')};
  escaped.signature=crypto.sign('RSA-SHA256',Buffer.from(escaped.manifest),privateKey).toString('base64');
  assert.throws(()=>verifyManifest(escaped,publicKey,now));
});
/** 功能：验证报告更高已安装序号会终结被取代任务；参数：无；返回值：无。 */
test('设备已升级到更高序号时旧任务不得继续下载',()=>{
  const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>now);ota.publish(release(),publicKey);
  ota.capability(1,'one',{protocol:1,release_seq:1,key_id:'fixture'});const job=ota.create(1,'one',2);
  ota.capability(1,'one',{protocol:1,release_seq:3,key_id:'fixture'});
  assert.equal(ota.claim(1,'one'),null);assert.throws(()=>ota.download(1,'one',job.job_id));
  assert.throws(()=>ota.create(1,'one',2));assert.equal(ota.list().jobs[0].error,'release_superseded');db.close();
});
/** 功能：验证边界拒绝错误密钥、清单结构与产物字节；参数：无；返回值：无。 */
test('清单与产物异常不产生发布或任务记录',()=>{
  const db=new DatabaseSync(':memory:');const ota=new Ota(db,()=>now);
  const wrongKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey;
  assert.throws(()=>ota.publish(release(),wrongKey));assert.throws(()=>ota.publish({...release(),bytes:Buffer.from('bad')},publicKey));
  // 全部异常信封仍使用临时合法签名，以验证解析门禁而非仅命中验签失败。
  for(const manifest of [release().manifest.slice(0,-1),release({unknown:1}).manifest,release({sha256:{nested:1}}).manifest]){
    const signature=crypto.sign('RSA-SHA256',Buffer.from(manifest),privateKey).toString('base64');assert.throws(()=>ota.publish({manifest,signature},publicKey));
  }
  assert.equal(ota.list().releases.length,0);db.close();
});
