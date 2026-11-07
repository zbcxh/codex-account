import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {HistoryCleanup} from '../server/history-cleanup.mjs';

/** 功能：创建仅在内存中的合成额度库；参数：无；返回值：清理器与数据库，不访问正式服务。 */
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../server/schema.sql',import.meta.url),'utf8'));
 db.exec("INSERT INTO machine(machine_id,client_id,token,label,created_at,last_report_id) VALUES(1,'test-1','synthetic-token','设备1',0,'b'),(2,'test-2','synthetic-token-2','设备2',0,'c');INSERT INTO account_alias VALUES('A','账号A',NULL,NULL,0)");
 const insert=db.prepare("INSERT INTO quota_snapshot(machine_id,report_id,source,window_kind,collected_at,reported_at,account_id) VALUES(?,?,'app_server',?,?,?,?)");
 // 所有记录均早于保留截止点；x/a 可删，b/c 分别被账号或设备保护。
 for(const [id,report,account,time] of [[1,'x','A',1],[1,'a','A',2],[1,'b','B',3],[2,'c','A',4]])for(const kind of ['primary','secondary'])insert.run(id,report,kind,time,time,account);
 let now=200*86400;const cleanup=new HistoryCleanup(db,90,()=>now);
 return {db,cleanup,setNow:value=>{now=value;},insert};
}
test('预览不改快照，完整保护账号/设备报告且自动默认关闭',()=>{const {db,cleanup}=fixture();const p=cleanup.preview(90);assert.equal(p.eligible_reports,2);assert.equal(p.batch_rows,4);assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_snapshot').get().n,8);assert.equal(cleanup.policy().automatic_enabled,false);assert.equal(cleanup.automatic().skipped,true);db.close();});
test('确认只删除整报告并保留映射身份与令牌',()=>{const {db,cleanup}=fixture();const before=db.prepare('SELECT * FROM machine').all();const p=cleanup.preview(90);const result=cleanup.execute(p.preview_token,'删除历史额度');assert.equal(result.deleted_rows,4);assert.deepEqual(db.prepare('SELECT DISTINCT report_id FROM quota_snapshot ORDER BY report_id').all().map(x=>x.report_id),['b','c']);assert.deepEqual(db.prepare('SELECT * FROM machine').all(),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM account_alias').get().n,1);assert.throws(()=>cleanup.execute(p.preview_token,'删除历史额度'));db.close();});
test('账号独立最新报告即使不再被设备引用也被保护',()=>{const {db,cleanup,insert}=fixture();insert.run(1,'old-account','primary',5,5,'C');const p=cleanup.preview(90);cleanup.execute(p.preview_token,'删除历史额度');assert.equal(db.prepare("SELECT COUNT(*) n FROM quota_snapshot WHERE report_id='old-account'").get().n,1);db.close();});
test('错误确认与过期凭证不执行删除',()=>{const {db,cleanup,setNow}=fixture();let p=cleanup.preview(90);assert.throws(()=>cleanup.execute(p.preview_token,'yes'));p=cleanup.preview(90);setNow(200*86400+301);assert.throws(()=>cleanup.execute(p.preview_token,'删除历史额度'));assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_snapshot').get().n,8);db.close();});
test('预览后新上报改变保护集合时拒绝删除',()=>{const {db,cleanup,insert}=fixture();const p=cleanup.preview(90);insert.run(2,'new','primary',6,6,'A');db.prepare("UPDATE machine SET last_report_id='new' WHERE machine_id=2").run();assert.throws(()=>cleanup.execute(p.preview_token,'删除历史额度'));assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_snapshot').get().n,9);db.close();});
test('保留未来异常报告和当前可用报告',()=>{const {db,cleanup,insert}=fixture();insert.run(1,'future','primary',300*86400,1,'B');const p=cleanup.preview(90);cleanup.execute(p.preview_token,'删除历史额度');assert.equal(db.prepare("SELECT COUNT(*) n FROM quota_snapshot WHERE report_id IN ('b','future')").get().n,3);db.close();});
test('同报告中存在保留期内窗口时整报告保留',()=>{const {db,cleanup,insert}=fixture();insert.run(1,'x','other',1,199*86400,'A');const p=cleanup.preview(90);assert.equal(p.eligible_reports,1);assert.equal(p.batch_rows,2);db.close();});
test('策略校验和版本变更使旧预览失效',()=>{const {db,cleanup}=fixture();const p=cleanup.preview(90);assert.throws(()=>cleanup.save({retention_days:'30',automatic_enabled:false,version:1}));assert.throws(()=>cleanup.preview(0));cleanup.save({retention_days:30,automatic_enabled:false,version:1});assert.throws(()=>cleanup.execute(p.preview_token,'删除历史额度'));assert.equal(cleanup.policy().retention_days,30);db.close();});
test('单次最多200报告且自动与手动同保护规则',()=>{const {db,cleanup,insert}=fixture();for(let i=0;i<205;i++)insert.run(1,'batch-'+i,'primary',0,0,'A');const p=cleanup.preview(90);assert.equal(p.batch_reports,200);assert.equal(p.eligible_reports,207);cleanup.save({retention_days:90,automatic_enabled:true,version:1});const result=cleanup.automatic();assert.equal(result.deleted_reports,200);assert.equal(db.prepare("SELECT COUNT(*) n FROM quota_snapshot WHERE report_id IN ('b','c')").get().n,4);db.close();});
test('事务删除失败时回滚完整报告',()=>{const {db,cleanup}=fixture();db.exec("CREATE TRIGGER deny_delete BEFORE DELETE ON quota_snapshot WHEN OLD.window_kind='secondary' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");const p=cleanup.preview(90);assert.throws(()=>cleanup.execute(p.preview_token,'删除历史额度'));assert.equal(db.prepare('SELECT COUNT(*) n FROM quota_snapshot').get().n,8);db.close();});
