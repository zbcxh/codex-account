import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BrowserBindings, bindingCookie, browserToken,handleBrowserBindings} from '../server/browser-bindings.mjs';
import {PairingSecurity} from '../server/pairing-security.mjs';

test('同一初始管理口令重建服务保留浏览器绑定，改变口令立即失效',()=>{
 const db=new DatabaseSync(':memory:'),machine={client_id:'synthetic',label:'测试',last_ok_at:1000,applied_interval_minutes:5};
 let security=new PairingSecurity(db,'synthetic-initial-admin');
 const bindings=new BrowserBindings(db,()=>machine,()=>1000,()=>security.generation());
 const issued=bindings.bind(1,'测试浏览器');
 security=new PairingSecurity(db,'synthetic-initial-admin');
 assert.equal(bindings.status(issued.token).online,true);
 security=new PairingSecurity(db,'different-initial-admin');
 assert.equal(bindings.status(issued.token).bound,false);
 db.close();
});

/** 功能：创建合成设备及可控时钟；参数：无；返回值：测试服务、设备状态与数据库。 */
function fixture(){
 const db=new DatabaseSync(':memory:');let now=1000;
 const machine={machine_id:1,client_id:'synthetic',label:'合成设备',last_ok_at:1000,applied_interval_minutes:5,merged:false};
 const service=new BrowserBindings(db,id=>id===1?machine:null,()=>now);
 return {db,machine,service,tick:value=>{now=value;}};
}
test('凭证只保存摘要，列表不泄露凭证，关联设备在线才放行',()=>{
 const f=fixture(),issued=f.service.bind(1,'合成浏览器');
 assert.notEqual(f.db.prepare('SELECT token_digest FROM browser_read_binding').get().token_digest,issued.token);
 assert.equal(JSON.stringify(f.service.list()).includes(issued.token),false);
 assert.equal(f.service.status(issued.token).online,true);
 f.tick(1421);assert.equal(f.service.status(issued.token).online,false);
 f.machine.last_ok_at=1421;assert.equal(f.service.status(issued.token).online,true);
 f.db.close();
});
test('过期、撤销、设备合并和身份变化均不再授予读取',()=>{
 const f=fixture();let issued=f.service.bind(1,'测试');
 f.service.revoke(issued.binding.id);assert.equal(f.service.status(issued.token).bound,false);
 issued=f.service.bind(1,'测试');f.machine.merged=true;assert.equal(f.service.status(issued.token).bound,false);
 f.machine.merged=false;f.machine.client_id='different';assert.equal(f.service.status(issued.token).bound,false);
 f.machine.client_id='synthetic';f.tick(1000+30*86400);assert.equal(f.service.status(issued.token).bound,false);
 f.db.close();
});
test('错误凭证、重复Cookie、未知设备及空名称失败关闭',()=>{
 const f=fixture();assert.equal(f.service.status('invalid').bound,false);
 assert.throws(()=>f.service.bind(99,'测试'),/unknown_machine/);
 assert.throws(()=>f.service.bind(1,''),/bad_binding_name/);
 assert.equal(browserToken('__Host-quota_browser=a; __Host-quota_browser=b'),null);
 assert.equal(browserToken('unrelated=x'),null);f.db.close();
});
test('Cookie仅用于安全读取，口令轮换可撤销全部绑定',()=>{
 const f=fixture(),issued=f.service.bind(1,'测试');
 const cookie=bindingCookie(issued.token);
 for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(cookie.includes(flag));
 assert.equal(browserToken(cookie),issued.token);
 f.service.revokeAll();assert.equal(f.service.status(issued.token).bound,false);f.db.close();
});
test('浏览器凭证不能替代管理员授权，轮换期间创建绑定失败关闭',async()=>{
 const f=fixture(),issued=f.service.bind(1,'测试');let response,valid=true;
 const req={method:'POST',headers:{cookie:bindingCookie(issued.token)}};
 const res={setHeader(){}};
 const context={bindings:f.service,security:{verifyAdmin:key=>valid&&key==='synthetic-admin'},devices:()=>[],readBody:async()=>{valid=false;return '{"machine_id":1,"name":"测试"}';},send:(_res,status,body)=>{response={status,body};},secure:true};
 await handleBrowserBindings(req,res,'/api/browser-bindings/list',context);
 assert.equal(response.status,403);
 req.headers['x-quota-bootstrap']='synthetic-admin';
 await handleBrowserBindings(req,res,'/api/browser-bindings/bind',context);
 assert.equal(response.status,403);assert.equal(f.service.list().length,1);f.db.close();
});
test('非HTTPS不能创建绑定，响应不回显明文凭证',async()=>{
 const f=fixture();let response;const headers={};
 const req={method:'POST',headers:{'x-quota-bootstrap':'synthetic-admin'}};
 const res={setHeader:(key,value)=>{headers[key]=value;}};
 const context={bindings:f.service,security:{verifyAdmin:key=>key==='synthetic-admin'},devices:()=>[],readBody:async()=>'{"machine_id":1,"name":"测试"}',send:(_res,status,body)=>{response={status,body};},secure:false};
 await handleBrowserBindings(req,res,'/api/browser-bindings/bind',context);assert.equal(response.status,400);assert.equal(f.service.list().length,0);
 context.secure=true;await handleBrowserBindings(req,res,'/api/browser-bindings/bind',context);
 assert.equal(response.status,200);assert.ok(headers['Set-Cookie']);assert.equal(JSON.stringify(response.body).includes(browserToken(headers['Set-Cookie'])),false);f.db.close();
});
