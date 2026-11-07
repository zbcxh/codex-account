import crypto from 'node:crypto';
/** 功能：生成设备合并安全错误；参数：错误码、HTTP状态；返回值：异常。 */
function rejected(code,status=409){return Object.assign(new Error(code),{publicCode:code,status});}
/** 功能：管理员显式合并离线旧设备，保留目标身份及全部历史；参数：数据库、在线窗口函数和时钟；返回值：管理实例。 */
export class DeviceMerge{
 /** 功能：建立旧身份停用审计表；参数：db、onlineWindow(id)、clock；返回值：实例。 */
 constructor(db,onlineWindow,clock=()=>Math.floor(Date.now()/1000)){this.db=db;this.onlineWindow=onlineWindow;this.clock=clock;this.pending=new Map();db.exec('CREATE TABLE IF NOT EXISTS machine_merged(source_id INTEGER PRIMARY KEY REFERENCES machine(machine_id),target_id INTEGER NOT NULL REFERENCES machine(machine_id),merged_at INTEGER NOT NULL)');}
 /** 功能：检查设备是否已被合并停用；参数：设备编号；返回值：布尔值。 */
 isMerged(id){return Boolean(this.db.prepare('SELECT 1 FROM machine_merged WHERE source_id=?').get(id));}
 /** 功能：校验双方状态并读取合并范围；参数：sourceId、targetId；返回值：双方记录与历史统计，不直接对外返回。 */
 scope(sourceId,targetId){
  if(!Number.isSafeInteger(sourceId)||!Number.isSafeInteger(targetId)||sourceId<1||targetId<1||sourceId===targetId)throw rejected('bad_merge_devices',400);
  const source=this.db.prepare('SELECT * FROM machine WHERE machine_id=?').get(sourceId),target=this.db.prepare('SELECT * FROM machine WHERE machine_id=?').get(targetId);
  if(!source||!target)throw rejected('unknown_machine',404);
  if(this.isMerged(sourceId)||this.isMerged(targetId))throw rejected('device_already_merged');
  if(source.last_ok_at!==null&&(source.last_ok_at>this.clock()||this.clock()-source.last_ok_at<=this.onlineWindow(sourceId)))throw rejected('merge_source_online');
  const rows=this.db.prepare('SELECT report_id,COUNT(*) n,MIN(id) first_id,MAX(id) last_id FROM quota_snapshot WHERE machine_id=? GROUP BY report_id ORDER BY report_id').all(sourceId);
  // 合并不猜测重复窗口，跨设备共用报告键的数据异常必须人工核查。
  if(this.db.prepare('SELECT 1 FROM quota_snapshot WHERE machine_id<>? AND report_id IN(SELECT report_id FROM quota_snapshot WHERE machine_id=?) LIMIT 1').get(sourceId,sourceId))throw rejected('merge_report_conflict');
  return {source,target,rows};
 }
 /** 功能：创建五分钟一次性预览，不暴露令牌；参数：源与目标编号；返回值：身份摘要、影响数和凭证。 */
 preview(sourceId,targetId){
  const scope=this.scope(sourceId,targetId),now=this.clock(),token=crypto.randomBytes(32).toString('hex');
  for(const [key,p] of this.pending)if(p.expires<=now)this.pending.delete(key);
  if(this.pending.size>=32)this.pending.delete(this.pending.keys().next().value);
  this.pending.set(token,{sourceId,targetId,expires:now+300,fingerprint:crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex')});
  const safe=m=>({machine_id:m.machine_id,client_id:m.client_id,label:m.label,hostname:m.hostname,last_ok_at:m.last_ok_at});
  return {source:safe(scope.source),target:safe(scope.target),report_count:scope.rows.length,snapshot_rows:scope.rows.reduce((n,r)=>n+r.n,0),hostname_differs:scope.source.hostname!==scope.target.hostname,merge_token:token,expires_at:now+300};
 }
 /** 功能：事务迁移历史并停用源身份，不改变目标凭据/当前报告/周期；参数：双方编号、凭证、源编号->目标编号确认文本；返回值：迁移数量。 */
 execute(sourceId,targetId,token,confirmation){
  if(typeof token!=='string'||confirmation!==`${sourceId}->${targetId}`)throw rejected('bad_merge_confirmation',400);
  const preview=this.pending.get(token);this.pending.delete(token);
  if(!preview||preview.sourceId!==sourceId||preview.targetId!==targetId||preview.expires<=this.clock())throw rejected('stale_merge_preview');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const scope=this.scope(sourceId,targetId);
   if(crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex')!==preview.fingerprint)throw rejected('stale_merge_preview');
   const moved=this.db.prepare('UPDATE quota_snapshot SET machine_id=? WHERE machine_id=?').run(targetId,sourceId);
   this.db.prepare('INSERT INTO machine_merged(source_id,target_id,merged_at) VALUES(?,?,?)').run(sourceId,targetId,this.clock());
   this.db.prepare('UPDATE machine SET last_report_id=NULL,last_session_mtime=NULL,last_ok_at=NULL WHERE machine_id=?').run(sourceId);
   // 目标当前报告绝不能被旧历史替换；合并到无读数设备时仍保持身份未知。
   this.db.exec('COMMIT');return {moved_reports:scope.rows.length,moved_rows:Number(moved.changes),source_id:sourceId,target_id:targetId};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
