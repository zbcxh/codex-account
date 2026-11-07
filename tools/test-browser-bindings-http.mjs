import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

test('隔离真实路由：浏览器跨出口读取、离线暂停、管理隔离、撤销和口令轮换',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'quota-browser-http-')),serverDir=path.join(temp,'server');
 fs.mkdirSync(path.join(temp,'web/dist'),{recursive:true});fs.mkdirSync(serverDir);
 const repositoryServer=new URL('../server/',import.meta.url);
 // 只复制程序与结构，不读取正式配置、数据库、通知地址或任何真实设备。
 for(const name of fs.readdirSync(repositoryServer))if(name.endsWith('.mjs')||name==='schema.sql')fs.copyFileSync(new URL(name,repositoryServer),path.join(serverDir,name));
 fs.writeFileSync(path.join(temp,'web/dist/index.html'),'<div id="app"></div>');
 const dbPath=path.join(temp,'synthetic.sqlite3'),db=new DatabaseSync(dbPath),now=Math.floor(Date.now()/1000);
 db.exec(fs.readFileSync(new URL('schema.sql',repositoryServer),'utf8'));
 db.prepare('INSERT INTO machine(machine_id,client_id,token,label,created_at,last_ok_at,last_ip) VALUES(1,?,?,?,?,?,?)').run('synthetic-client','synthetic-device-token','合成设备',now,now,'198.51.100.1');db.close();
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const secret=crypto.randomBytes(24).toString('hex');
 const child=spawn(process.execPath,['--no-warnings',path.join(serverDir,'server.mjs'),'--host','127.0.0.1','--port',String(port),'--trust-loopback-proxy','--db',dbPath,'--bootstrap',secret],{stdio:'ignore'});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 /** 功能：请求隔离服务，模拟受信任本机代理重写来源；参数：路由、可选正文、Cookie、口令与代理HTTPS标记；返回值：HTTP响应。 */
 const request=(route,body,cookie,credential,secure=true,ip='203.0.113.8')=>fetch(`http://127.0.0.1:${port}`+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-quota-client-ip':ip,...(secure?{'x-forwarded-proto':'https'}:{}),...(cookie?{cookie}:{}),...(credential?{'x-quota-bootstrap':credential}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 try{
  let ready=false;
  // 只等待本测试子进程就绪，最多5秒，避免无限等待掩盖启动失败。
  for(let attempt=0;attempt<100;attempt++){try{if((await request('/api/state')).status===403){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,'隔离服务未就绪');
  assert.equal((await request('/api/browser-bindings/bind',{machine_id:1,name:'测试'},null,secret,false)).status,400);
  const binding=await request('/api/browser-bindings/bind',{machine_id:1,name:'测试'},null,secret);
  assert.equal(binding.status,200);const cookie=binding.headers.get('set-cookie').split(';')[0],id=(await binding.json()).id;
  assert.equal((await request('/api/state',undefined,cookie)).status,200);
  assert.equal((await request('/api/state',undefined,cookie,undefined,true,'203.0.113.9')).status,200);
  assert.equal((await request('/api/reporting-config',{interval_minutes:10},cookie)).status,403);
  const update=new DatabaseSync(dbPath);update.prepare('UPDATE machine SET last_ok_at=? WHERE machine_id=1').run(now-10000);
  assert.equal((await request('/api/state',undefined,cookie)).status,403);
  update.prepare('UPDATE machine SET last_ok_at=? WHERE machine_id=1').run(now);update.close();
  assert.equal((await request('/api/state',undefined,cookie)).status,200);
  assert.equal((await request('/api/browser-bindings/revoke',{binding_id:id},cookie,secret)).status,200);
  assert.equal((await request('/api/state',undefined,cookie)).status,403);
  const second=await request('/api/browser-bindings/bind',{machine_id:1,name:'第二次'},null,secret),secondCookie=second.headers.get('set-cookie').split(';')[0];
  const next=crypto.randomBytes(24).toString('hex');
  assert.equal((await request('/api/admin/bootstrap',{new_bootstrap:next,confirm_bootstrap:next},secondCookie,secret)).status,200);
  assert.equal((await request('/api/state',undefined,secondCookie,undefined,true,'203.0.113.10')).status,403);
  assert.equal((await (await request('/api/browser-bindings/status',undefined,secondCookie)).json()).bound,false);
 }finally{child.kill();await exited;}
});
