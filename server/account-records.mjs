import crypto from 'node:crypto';
/** 功能：创建账号管理安全错误；参数：错误码与HTTP状态；返回值：异常。 */
function rejected(code,status=400){return Object.assign(new Error(code),{publicCode:code,status});}
/** 功能：独立读取账号历史并提供事务删除；参数：数据库、设备在线窗口函数、时钟；返回值：管理实例。 */
export class AccountRecords{
 /** 功能：初始化删除时间屏障，不改设备授权；参数：db、onlineWindow(id)、clock；返回值：实例。 */
 constructor(db,onlineWindow,clock=()=>Math.floor(Date.now()/1000)){
  this.db=db;this.onlineWindow=onlineWindow;this.clock=clock;this.pending=new Map();
  db.exec('CREATE TABLE IF NOT EXISTS account_deleted(account_id TEXT PRIMARY KEY,deleted_before INTEGER NOT NULL)');
 }
 /** 功能：判断报告是否晚于显式删除屏障；参数：账号ID和采集时间；返回值：是否允许接收。 */
 accepts(accountId,collectedAt){const r=this.db.prepare('SELECT deleted_before FROM account_deleted WHERE account_id=?').get(accountId);return !r||collectedAt>r.deleted_before;}
 /** 功能：读取各可见已知账号的最新有效完整报告；参数：无；返回值：账号ID和窗口原始行，包含仅有映射的账号。 */
 heads(){
  const ids=this.db.prepare(`SELECT account_id FROM (SELECT account_id FROM quota_snapshot WHERE account_id IS NOT NULL AND account_id<>'' UNION SELECT account_id FROM account_alias)
   WHERE account_id NOT IN(SELECT account_id FROM account_hidden) ORDER BY account_id`).all();
  const latest=this.db.prepare('SELECT report_id FROM quota_snapshot WHERE account_id=? AND collected_at<=? ORDER BY collected_at DESC,reported_at DESC,id DESC LIMIT 1');
  const rows=this.db.prepare("SELECT * FROM quota_snapshot WHERE report_id=? ORDER BY CASE WHEN window_kind='primary' THEN 0 ELSE 1 END,id");
  return ids.map(item=>{const report=latest.get(item.account_id,this.clock()+300);return {...item,rows:report?rows.all(report.report_id):[]};});
 }
 /** 功能：读取账号曾使用的设备关系，不以电脑名称推导身份；参数：无；返回值：账号ID与设备ID关系。 */
 members(){return this.db.prepare("SELECT DISTINCT account_id,machine_id FROM quota_snapshot WHERE account_id IS NOT NULL AND account_id<>''").all();}
 /** 功能：阻止删除仍由设备在线使用的账号，未来异常心跳也保守拦截；参数：账号ID；返回值：无或抛错。 */
 assertUnused(accountId){
  const now=this.clock();
  const machines=this.db.prepare(`SELECT DISTINCT m.machine_id,m.last_ok_at FROM machine m JOIN quota_snapshot q ON q.report_id=m.last_report_id WHERE q.account_id=?`).all(accountId);
  for(const m of machines)if(m.last_ok_at!==null&&(m.last_ok_at>now||now-m.last_ok_at<=this.onlineWindow(m.machine_id)))throw rejected('account_in_use',409);
 }
 /** 功能：读取删除范围指纹，不包含设备令牌；参数：账号ID；返回值：范围和统计。 */
 scope(accountId){
  const reports=this.db.prepare('SELECT report_id,COUNT(*) n,MIN(id) first_id,MAX(id) last_id FROM quota_snapshot WHERE account_id=? GROUP BY report_id ORDER BY report_id').all(accountId);
  const alias=this.db.prepare('SELECT * FROM account_alias WHERE account_id=?').get(accountId)??null;
  const hidden=this.db.prepare('SELECT * FROM account_hidden WHERE account_id=?').get(accountId)??null;
  if(!reports.length&&!alias&&!hidden)throw rejected('unknown_account',404);
  // 数据若出现跨账号混合报告，拒绝删除，避免拆窗口或误删其他账号。
  const mixed=this.db.prepare(`SELECT 1 FROM quota_snapshot WHERE report_id IN(SELECT report_id FROM quota_snapshot WHERE account_id=?) GROUP BY report_id HAVING COUNT(DISTINCT COALESCE(account_id,''))>1 LIMIT 1`).get(accountId);
  if(mixed)throw rejected('mixed_account_report',409);
  return {reports,alias,hidden};
 }
 /** 功能：生成五分钟一次性删除预览；参数：账号ID；返回值：统计及凭证，不写业务数据。 */
 preview(accountId){
  this.assertUnused(accountId);const scope=this.scope(accountId),now=this.clock(),token=crypto.randomBytes(32).toString('hex');
  for(const [key,value] of this.pending)if(value.expires<=now)this.pending.delete(key);
  if(this.pending.size>=32)this.pending.delete(this.pending.keys().next().value);
  this.pending.set(token,{accountId,expires:now+300,fingerprint:JSON.stringify(scope)});
  return {account_id:accountId,display_name:scope.alias?.display_name??null,hidden:Boolean(scope.hidden),has_alias:Boolean(scope.alias),
   report_count:scope.reports.length,snapshot_rows:scope.reports.reduce((n,r)=>n+r.n,0),
   device_count:this.db.prepare('SELECT COUNT(DISTINCT machine_id) n FROM quota_snapshot WHERE account_id=?').get(accountId).n,delete_token:token,expires_at:now+300};
 }
 /** 功能：事务删除账号历史、映射、隐藏标记并清空失效引用；参数：账号ID、一次性凭证、重复输入的账号ID；返回值：删除数量，设备与令牌不变。 */
 remove(accountId,token,confirmation){
  if(confirmation!==accountId||typeof token!=='string')throw rejected('bad_account_confirmation');
  const preview=this.pending.get(token);this.pending.delete(token);
  if(!preview||preview.accountId!==accountId||preview.expires<=this.clock())throw rejected('stale_account_preview',409);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.assertUnused(accountId);const scope=this.scope(accountId);
   if(JSON.stringify(scope)!==preview.fingerprint)throw rejected('stale_account_preview',409);
   // 清空引用后必须保持未知，不能挑选历史里另一个旧账号冒充当前身份。
   this.db.prepare('UPDATE machine SET last_report_id=NULL,last_session_mtime=NULL WHERE last_report_id IN(SELECT report_id FROM quota_snapshot WHERE account_id=?)').run(accountId);
   const removed=this.db.prepare('DELETE FROM quota_snapshot WHERE account_id=?').run(accountId);
   this.db.prepare('DELETE FROM account_alias WHERE account_id=?').run(accountId);
   this.db.prepare('DELETE FROM account_hidden WHERE account_id=?').run(accountId);
   this.db.prepare('INSERT INTO account_deleted(account_id,deleted_before) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET deleted_before=MAX(deleted_before,excluded.deleted_before)').run(accountId,this.clock());
   this.db.exec('COMMIT');return {deleted_reports:scope.reports.length,deleted_rows:Number(removed.changes)};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
