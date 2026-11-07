import test from 'node:test';
import assert from 'node:assert/strict';
import {externalTarget} from '../src/external-links.ts';
// 只验证地址策略，不打开外部网站、不触发真实额度采集。
test('旧面板已知禁止嵌入站点及其子域走新标签页',()=>{
 assert.equal(externalTarget('https://codex-reset.com/zh','http://localhost:8787').mode,'window');
 assert.equal(externalTarget('https://www.codex-reset.com/zh','http://localhost:8787').mode,'window');
});
test('普通HTTPS外链使用内容页签且保留路径与片段',()=>{
 assert.deepEqual(externalTarget('https://example.com/path#part','http://localhost:8787'),{mode:'tab',url:'https://example.com/path#part'});
 assert.equal(externalTarget('https://codex-reset.com.example.com','http://localhost:8787').mode,'tab');
});
test('HTTPS面板不在iframe加载明文混合内容',()=>{assert.equal(externalTarget('http://example.com','https://quota.example.com').mode,'window');});
test('内部路由、非法地址、非网页协议和凭据地址不作为外链页签',()=>{
 for(const value of ['/#/settings','javascript:void(0)','mailto:user@example.com','https://u:p@example.com','http://['])assert.equal(externalTarget(value,'http://localhost:8787').mode,'ignore');
});
