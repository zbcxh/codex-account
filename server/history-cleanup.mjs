import crypto from 'node:crypto';

/** 功能：校验保留期限；参数：days 为天数；返回值：是否合法的1至3650整数。 */
export function validRetention(days) {return Number.isInteger(days) && days >= 1 && days <= 3650;}
/** 功能：构造不含数据内容的清理错误；参数：code、status；返回值：安全异常。 */
function rejected(code,status=400){return Object.assign(new Error(code),{publicCode:code,status});}

// 窗口行先排名再保护整份报告，避免主/次窗口被拆开；异常未来时间额外保留有效回退报告。
const candidatesSql=`WITH ranked AS (
 SELECT report_id,account_id,collected_at,
 ROW_NUMBER() OVER(PARTITION BY machine_id ORDER BY collected_at DESC,reported_at DESC,id DESC) AS device_rank,
 ROW_NUMBER() OVER(PARTITION BY account_id ORDER BY collected_at DESC,reported_at DESC,id DESC) AS account_rank,
 ROW_NUMBER() OVER(PARTITION BY machine_id ORDER BY CASE WHEN collected_at<=:usable THEN 0 ELSE 1 END,collected_at DESC,reported_at DESC,id DESC) AS usable_device_rank,
 ROW_NUMBER() OVER(PARTITION BY account_id ORDER BY CASE WHEN collected_at<=:usable THEN 0 ELSE 1 END,collected_at DESC,reported_at DESC,id DESC) AS usable_account_rank
 FROM quota_snapshot
), protected AS (
 SELECT last_report_id AS report_id FROM machine WHERE last_report_id IS NOT NULL
 UNION SELECT report_id FROM ranked WHERE device_rank=1 OR (account_id IS NOT NULL AND account_id<>'' AND account_rank=1)
 OR (collected_at<=:usable AND (usable_device_rank=1 OR (account_id IS NOT NULL AND account_id<>'' AND usable_account_rank=1)))
), reports AS (
 SELECT report_id,COUNT(*) AS row_count,MIN(id) AS min_id,MAX(id) AS max_id,MIN(reported_at) AS oldest_at,MAX(reported_at) AS newest_at,
 MIN(machine_id) AS machine_id,MIN(account_id) AS account_id
 FROM quota_snapshot GROUP BY report_id
), candidates AS (
 SELECT * FROM reports WHERE newest_at<:cutoff AND report_id NOT IN (SELECT report_id FROM protected)
)`;

/** 功能：安全清理历史额度，仅修改快照和独立保留策略；参数：db、初始期限、可注入单调推进的测试时钟；返回值：管理实例。 */
export class HistoryCleanup {
 /** 功能：初始化策略，首次默认暂停自动清理；参数：db、initialDays、clock；返回值：实例。 */
 constructor(db,initialDays=90,clock=()=>Math.floor(Date.now()/1000)){
  this.db=db;this.clock=clock;this.pending=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS history_cleanup_policy(id INTEGER PRIMARY KEY CHECK(id=1),retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),automatic_enabled INTEGER NOT NULL DEFAULT 0 CHECK(automatic_enabled IN (0,1)),version INTEGER NOT NULL DEFAULT 1)`);
  db.prepare('INSERT OR IGNORE INTO history_cleanup_policy(id,retention_days) VALUES(1,?)').run(validRetention(initialDays)?initialDays:90);
 }
 /** 功能：读取持久策略；参数：无；返回值：期限、自动开关和版本。 */
 policy(){const p=this.db.prepare('SELECT retention_days,automatic_enabled,version FROM history_cleanup_policy WHERE id=1').get();return {...p,automatic_enabled:Boolean(p.automatic_enabled)};}
 /** 功能：保存管理员策略并使旧预览失效；参数：body 含期限、自动开关及所读版本；返回值：最新策略。 */
 save(body){
  if(!validRetention(body.retention_days)||typeof body.automatic_enabled!=='boolean'||!Number.isSafeInteger(body.version))throw rejected('bad_cleanup_policy');
  const result=this.db.prepare('UPDATE history_cleanup_policy SET retention_days=?,automatic_enabled=?,version=version+1 WHERE id=1 AND version=?').run(body.retention_days,Number(body.automatic_enabled),body.version);
  if(!result.changes)throw rejected('stale_cleanup_preview',409);
  this.pending.clear();return this.policy();
 }
 /** 功能：计算受保护报告之外的有限删除批次；参数：cutoff 为固定截止点，now 为保护快照基准；返回值：批次和计数，不写快照。 */
 plan(cutoff,now){
  const args={usable:now+300,cutoff};
  const totals=this.db.prepare(candidatesSql+'SELECT COUNT(*) AS eligible_reports,COALESCE(SUM(row_count),0) AS eligible_rows FROM candidates').get(args);
  const reports=this.db.prepare(candidatesSql+'SELECT * FROM candidates ORDER BY newest_at,report_id LIMIT 200').all(args);
  const protectedCount=this.db.prepare(candidatesSql+'SELECT COUNT(DISTINCT report_id) AS n FROM protected').get(args).n;
  return {...totals,reports,protected_reports:protectedCount};
 }
 /** 功能：生成五分钟一次性只读预览；参数：days 为本次保留天数；返回值：安全计数、固定截止点和内存凭证。 */
 preview(days){
  if(!validRetention(days))throw rejected('bad_cleanup_policy');
  const now=this.clock(),cutoff=now-days*86400,plan=this.plan(cutoff,now),token=crypto.randomBytes(32).toString('hex');
  // 丢弃过期/最旧预览，管理员重复刷新不会无限占用服务内存。
  for(const [key,value] of this.pending)if(value.expires_at<=now)this.pending.delete(key);
  if(this.pending.size>=32)this.pending.delete(this.pending.keys().next().value);
  this.pending.set(token,{days,cutoff,expires_at:now+300,version:this.policy().version,fingerprint:JSON.stringify(plan.reports)});
  return {preview_token:token,expires_at:now+300,retention_days:days,cutoff_at:cutoff,eligible_reports:plan.eligible_reports,eligible_rows:plan.eligible_rows,
   protected_reports:plan.protected_reports,batch_reports:plan.reports.length,batch_rows:plan.reports.reduce((n,r)=>n+r.row_count,0),
   affected_devices:new Set(plan.reports.map(r=>r.machine_id)).size,affected_accounts:new Set(plan.reports.map(r=>r.account_id).filter(Boolean)).size,
   oldest_at:plan.reports.length?Math.min(...plan.reports.map(r=>r.oldest_at)):null,newest_at:plan.reports.length?Math.max(...plan.reports.map(r=>r.newest_at)):null};
 }
 /** 功能：确认后事务删除已预览的整报告，状态变化拒绝执行；参数：token、confirmation 固定确认文本；返回值：实际删除计数，不执行VACUUM。 */
 execute(token,confirmation){
  if(typeof token!=='string'||confirmation!=='删除历史额度')throw rejected('bad_cleanup_confirmation');
  const preview=this.pending.get(token);this.pending.delete(token);
  if(!preview||preview.expires_at<=this.clock())throw rejected('stale_cleanup_preview',409);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(preview.version!==this.policy().version)throw rejected('stale_cleanup_preview',409);
   const plan=this.plan(preview.cutoff,this.clock());
   if(JSON.stringify(plan.reports)!==preview.fingerprint)throw rejected('stale_cleanup_preview',409);
   const remove=this.db.prepare('DELETE FROM quota_snapshot WHERE report_id=?');let deleted=0;
   // 单次最多200报告；每份报告所有窗口同事务删除，失败则整批回滚。
   for(const report of plan.reports)deleted+=Number(remove.run(report.report_id).changes);
   if(deleted!==plan.reports.reduce((n,r)=>n+r.row_count,0))throw rejected('cleanup_count_mismatch',409);
   this.db.exec('COMMIT');
   return {deleted_reports:plan.reports.length,deleted_rows:deleted,remaining_reports:plan.eligible_reports-plan.reports.length};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 /** 功能：自动清理复用同一保护和事务，未明确启用时不执行删除；参数：无；返回值：跳过标记或实际计数。 */
 automatic(){const p=this.policy();if(!p.automatic_enabled)return {skipped:true};const preview=this.preview(p.retention_days);return this.execute(preview.preview_token,'删除历史额度');}
}
