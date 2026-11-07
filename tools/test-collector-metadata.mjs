import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

test('采集器元数据：旧库升级、正常上报、补传隔离和旧客户端兼容',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'quota-collector-meta-')),serverDir=path.join(temp,'server');
 fs.mkdirSync(serverDir);fs.mkdirSync(path.join(temp,'web/dist'),{recursive:true});
 const source=new URL('../server/',import.meta.url);
 // 只使用源码和合成空库，不读取正式配置、账号或设备令牌。
 for(const name of fs.readdirSync(source))if(name.endsWith('.mjs')||name==='schema.sql')fs.copyFileSync(new URL(name,source),path.join(serverDir,name));
 fs.writeFileSync(path.join(temp,'web/dist/index.html'),'<div></div>');
 const dbPath=path.join(temp,'test.sqlite3'),db=new DatabaseSync(dbPath),now=Math.floor(Date.now()/1000);
 // 去掉新增列，证明已有数据库可在启动时无损升级。
 db.exec(fs.readFileSync(new URL('schema.sql',source),'utf8').replace(/^.*collector_(version|build|sha256).*\r?\n/gm,''));
 db.prepare('INSERT INTO machine(client_id,token,label,created_at) VALUES(?,?,?,?)').run('synthetic','synthetic-token','测试',now);db.close();
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const child=spawn(process.execPath,['--no-warnings',path.join(serverDir,'server.mjs'),'--host','127.0.0.1','--port',String(port),'--db',dbPath,'--bootstrap','synthetic-admin'],{stdio:'ignore'});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 /** 功能：访问隔离服务；参数：路径及可选合成正文；返回值：HTTP响应。 */
 const request=(route,body)=>fetch(`http://127.0.0.1:${port}${route}`,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-quota-token':'synthetic-token'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
 /** 功能：构造有效额度报告；参数：采集秒时间和可选元数据；返回值：合成报告。 */
 const report=(time,extra={})=>({collected_at:time,source:'app_server',account_id:'11111111-1111-4111-8111-111111111111',primary:{used_percent:20,window_minutes:300},...extra});
 /** 功能：读取设备快照；参数：无；返回值：合成设备读模型。 */
 const machine=async()=>(await (await request('/api/state')).json()).machines[0];
 try{
  let ready=false;
  // 限时等待本测试进程就绪，不触碰本机正式服务。
  for(let i=0;i<100;i++){try{if((await request('/api/state')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready);
  assert.equal((await machine()).collector_version,null);
  const metadata={collector_version:'1.0.0',collector_build:'20261105T010203Z',collector_sha256:'a'.repeat(64)};
  assert.equal((await request('/api/report',report(now,{...metadata,event_id:'1'.repeat(64)}))).status,200);
  assert.equal((await (await request('/api/report',report(now,{...metadata,collector_version:'9.9.9',event_id:'1'.repeat(64)}))).json()).replay,true);
  const current=await machine();for(const key of Object.keys(metadata))assert.equal(current[key],metadata[key]);
  assert.equal((await request('/api/report',report(now-60,{...metadata,collector_version:'0.9.0'}))).status,200);
  assert.equal((await machine()).collector_version,'1.0.0');
  const stored=new DatabaseSync(dbPath);assert.equal(stored.prepare('SELECT collector_version FROM quota_snapshot ORDER BY id DESC LIMIT 1').get().collector_version,'0.9.0');stored.close();
  assert.equal((await request('/api/report',report(now+1))).status,200);
  assert.equal((await machine()).collector_version,null);
  assert.equal((await request('/api/report',report(now+2,{collector_sha256:'invalid'}))).status,400);
 }finally{child.kill();await exited;fs.rmSync(temp,{recursive:true,force:true});}
});
