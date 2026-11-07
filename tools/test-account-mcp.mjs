import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAccountMcp,hasUsableQuota} from '../server/account-mcp.mjs';
import {requestSource} from '../server/proxy-source.mjs';

test('推荐仅接受全部窗口已知且未耗尽的额度',()=>{
 assert.equal(hasUsableQuota([{used_percent:0,balance:'0'},{used_percent:99}]),true);
 assert.equal(hasUsableQuota([{used_percent:20},{used_percent:100}]),false);
 assert.equal(hasUsableQuota([{used_percent:100,resets_at:1}]),false);
 assert.equal(hasUsableQuota([{used_percent:null,balance:'100',has_credits:1}]),false);
 assert.equal(hasUsableQuota([{used_percent:20},{used_percent:null}]),false);
 assert.equal(hasUsableQuota([{used_percent:20,hit_limit:'rate_limit'}]),true);
 assert.equal(hasUsableQuota([]),false);
});

/** 功能：调用真实MCP处理器并替换HTTP边界；参数：请求正文、请求头及独立合成口令；返回值：响应与查询次数，不访问业务库。 */
async function call(body,headers={},token='synthetic-independent-token-123456789'){
 let status,payload,queries=0;
 const req={method:'POST',headers:{authorization:'Bearer synthetic-independent-token-123456789',...headers}};
 const res={setHeader(){},writeHead(code){status=code;return this;},end(){}};
 await handleAccountMcp(req,res,token,account=>{queries++;return {status:'ok',devices:['合成设备'],online_device_count:1,checked_at:1000};},async()=>typeof body==='string'?body:JSON.stringify(body),(response,code,data)=>{status=code;payload=data;});
 return {status,payload,queries};
}
test('MCP独立口令、Origin和未配置状态均在查询前拒绝',async()=>{
 const body={jsonrpc:'2.0',id:1,method:'tools/list'};
 assert.equal((await call(body,{},'')).status,404);
 assert.equal((await call(body,{authorization:'Bearer wrong'})).status,401);
 assert.equal((await call(body,{origin:'https://example.invalid'})).status,403);
 assert.equal((await call(body,{'mcp-protocol-version':'unsupported'})).status,400);
 assert.equal((await call('{')).payload.error.code,-32700);
});
test('MCP只开放固定只读工具，通知不查询，非法工具不分派',async()=>{
 const listed=await call({jsonrpc:'2.0',id:1,method:'tools/list'});
 assert.equal(listed.payload.result.tools.length,4);
  const body={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_codex_account_status',arguments:{account:'synthetic-account'}}};
 const result=await call(body);assert.equal(result.queries,1);assert.equal(JSON.parse(result.payload.result.content[0].text).online_device_count,1);
 const invalid=await call({...body,params:{...body.params,name:'delete_account'}});assert.equal(invalid.queries,0);assert.equal(invalid.payload.error.code,-32602);
 const notify=await call({jsonrpc:'2.0',method:'notifications/initialized'});assert.equal(notify.status,202);assert.equal(notify.queries,0);
});
test('代理默认忽略头，显式模式只允许本机重写的单个非回环地址',()=>{
 /** 功能：构造合成代理请求；参数：TCP对端和声明来源；返回值：请求替身。 */
 const request=(peer,ip)=>({socket:{remoteAddress:peer},headers:{'x-quota-client-ip':ip}});
 assert.equal(requestSource(request('198.51.100.1','127.0.0.1')),'198.51.100.1');
 assert.equal(requestSource(request('127.0.0.1','203.0.113.1'),true),'203.0.113.1');
 assert.equal(requestSource(request('198.51.100.1','203.0.113.1'),true),null);
 for(const ip of ['127.0.0.1','::1','203.0.113.1, 127.0.0.1',undefined])assert.equal(requestSource(request('127.0.0.1',ip),true),null);
});
