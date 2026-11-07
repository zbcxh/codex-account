import crypto from 'node:crypto';
import {isReportOnline} from './online-status.mjs';

const COOKIE='__Host-quota_browser';
const LIFETIME=30*86400;
/** 功能：读取唯一浏览器凭证，拒绝重复或畸形 Cookie；参数：Cookie 请求头；返回值：凭证或 null。 */
export function browserToken(header){
 if(typeof header!=='string'||header.length>8192)return null;
 const values=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(COOKIE+'='));
 if(values.length!==1)return null;
 const token=values[0].slice(COOKIE.length+1);
 // 固定格式限制凭证长度，不把任意 Cookie 内容带入日志或数据库查询。
 return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
}
/** 功能：构造仅 HTTPS、不可被脚本读取的绑定 Cookie；参数：凭证或 null 清除；返回值：Set-Cookie 字符串。 */
export function bindingCookie(token){return `${COOKIE}=${token??''}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token?LIFETIME:0}`;}
/** 功能：将随机凭证转为持久摘要；参数：凭证；返回值：SHA-256 摘要。 */
function digest(token){return crypto.createHash('sha256').update(token).digest('hex');}

/** 功能：维护独立的浏览器读取授权，不授予任何管理权限；参数：数据库、设备查询函数和 Unix 秒时钟；返回值：管理实例。 */
export class BrowserBindings{
 /** 功能：初始化独立表；参数：db、machine查询、Unix秒clock和当前管理口令代际generation；返回值：实例。 */
 constructor(db,machine,clock=()=>Math.floor(Date.now()/1000),generation=()=>''){
  this.db=db;this.machine=machine;this.clock=clock;this.generation=generation;
  db.exec(`CREATE TABLE IF NOT EXISTS browser_read_binding(id INTEGER PRIMARY KEY AUTOINCREMENT,machine_id INTEGER NOT NULL,client_id TEXT NOT NULL,name TEXT NOT NULL,token_digest TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,admin_generation TEXT NOT NULL)`);
 }
 /** 功能：生成新浏览器读取凭证；参数：设备整数 ID、浏览器名称；返回值：安全元数据与仅供设置 Cookie 的明文凭证。 */
 bind(id,name){
  const machine=Number.isSafeInteger(id)?this.machine(id):null;
  if(!machine||machine.merged)throw new Error('unknown_machine');
  if(typeof name!=='string'||!name.trim()||name.trim().length>80)throw new Error('bad_binding_name');
  const token=crypto.randomBytes(32).toString('base64url'),now=this.clock();
  const result=this.db.prepare('INSERT INTO browser_read_binding(machine_id,client_id,name,token_digest,created_at,expires_at,admin_generation) VALUES(?,?,?,?,?,?,?)').run(id,machine.client_id,name.trim(),digest(token),now,now+LIFETIME,this.generation());
  return {token,binding:this.list().find(row=>row.id===Number(result.lastInsertRowid))};
 }
 /** 功能：读取不含凭证和摘要的绑定列表；参数：无；返回值：元数据数组，时间单位 Unix 秒。 */
 list(){return this.db.prepare('SELECT id,machine_id,name,created_at,expires_at,revoked_at FROM browser_read_binding ORDER BY id DESC').all();}
 /** 功能：解析凭证并实时核对设备身份和在线状态；参数：明文凭证或 null；返回值：当前浏览器安全状态。 */
 status(token){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return {bound:false,online:false};
  const row=this.db.prepare('SELECT * FROM browser_read_binding WHERE token_digest=?').get(digest(token)),now=this.clock();
  // 即使撤销列表写入暂时失败，口令代际变化也会立即让旧凭证失效。
  if(!row||row.admin_generation!==this.generation()||row.revoked_at!==null||row.created_at>now||row.expires_at<=now)return {bound:false,online:false};
  const machine=this.machine(row.machine_id);
  // 合并、删除或身份替换不能继承原浏览器权限；离线状态只暂停凭证的自动放行。
  if(!machine||machine.merged||machine.client_id!==row.client_id)return {bound:false,online:false};
  return {bound:true,online:isReportOnline(machine.last_ok_at,now,machine.applied_interval_minutes),id:row.id,machine_id:row.machine_id,label:machine.label,expires_at:row.expires_at};
 }
 /** 功能：撤销单个绑定；参数：绑定整数 ID；返回值：无，未知 ID 抛错。 */
 revoke(id){if(!Number.isSafeInteger(id)||!this.db.prepare('SELECT 1 FROM browser_read_binding WHERE id=?').get(id))throw new Error('unknown_binding');this.db.prepare('UPDATE browser_read_binding SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.clock(),id);}
 /** 功能：管理口令轮换时撤销所有绑定；参数：无；返回值：无。 */
 revokeAll(){this.db.prepare('UPDATE browser_read_binding SET revoked_at=? WHERE revoked_at IS NULL').run(this.clock());}
}

/** 功能：处理浏览器绑定接口，读取凭证绝不代替管理员授权；参数：请求、响应、路由和已绑定服务上下文；返回值：异步 HTTP 响应。 */
export async function handleBrowserBindings(req,res,pathname,{bindings,security,devices,readBody,send,secure}){
 res.setHeader('Cache-Control','no-store');
 const token=browserToken(req.headers.cookie);
 if(req.method==='GET'&&pathname==='/api/browser-bindings/status')return send(res,200,bindings.status(token));
 if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
 const credential=req.headers['x-quota-bootstrap'];
 if(!security.verifyAdmin(credential))return send(res,403,{error:'bad_bootstrap'});
 try{
  const raw=await readBody(req,res,4096);
  // 异步等待正文后重新鉴权，防止轮换前的旧口令继续创建或撤销绑定。
  if(!security.verifyAdmin(credential))return send(res,403,{error:'bad_bootstrap'});
  const body=JSON.parse(raw||'{}');
  if(pathname==='/api/browser-bindings/list')return send(res,200,{devices:devices(),bindings:bindings.list(),current:bindings.status(token)});
  if(pathname==='/api/browser-bindings/bind'){
   if(!secure)return send(res,400,{error:'binding_https_required'});
   const issued=bindings.bind(body?.machine_id,body?.name);
   // 新绑定替换当前浏览器旧凭证，避免形成无法管理的遗留授权。
   const current=bindings.status(token);if(current.bound)bindings.revoke(current.id);
   res.setHeader('Set-Cookie',bindingCookie(issued.token));
   return send(res,200,{ok:true,...bindings.status(issued.token)});
  }
  if(pathname==='/api/browser-bindings/revoke'){
   const current=bindings.status(token);bindings.revoke(body?.binding_id);
   if(current.id===body.binding_id)res.setHeader('Set-Cookie',bindingCookie(null));
   return send(res,200,{ok:true});
  }
  return send(res,404,{error:'not_found'});
 }catch(error){
  if(['unknown_machine','bad_binding_name','unknown_binding'].includes(error.message))return send(res,400,{error:error.message});
  if(error instanceof SyntaxError)return send(res,400,{error:'bad_json'});
  if(error.code===413)return send(res,413,{error:'body_too_large'});
  throw error;
 }
}
