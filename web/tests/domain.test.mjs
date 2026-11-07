import {test} from 'node:test';
import assert from 'node:assert/strict';
import {remaining,online,risk,accountName} from '../src/domain.ts';
const item={account_id:'account-identity',display_name:null,windows:[],hit_limit:null};
test('缺失或空读数保留未知，不显示100%剩余',()=>{assert.equal(remaining(item),null);assert.equal(remaining({...item,windows:[{kind:'primary',used_percent:null}]}),null);assert.equal(remaining({...item,windows:[{kind:'primary',used_percent:NaN}]}),null);});
test('额度以账号窗口为准且限制显示边界',()=>{assert.equal(remaining({...item,windows:[{kind:'primary',used_percent:18}]}),82);assert.equal(remaining({...item,windows:[{kind:'primary',used_percent:120}]}),0);});
test('在线阈值使用实际周期，不使用固定5分钟',()=>{const m={last_ok_at:100,online_window_sec:600};assert.equal(online(m,700),true);assert.equal(online(m,701),false);assert.equal(online({...m,last_ok_at:null},700),false);assert.equal(online(m,99),false);});
test('风险考虑任意窗口与触顶',()=>{assert.equal(risk({...item,windows:[{used_percent:12},{used_percent:85}]}),true);assert.equal(risk({...item,hit_limit:'weekly'}),true);assert.equal(risk(item),false);});
test('无映射以账号ID显示，不以设备名替代',()=>{assert.equal(accountName({...item,display_name:'账号A'}),'账号A');assert.equal(accountName({account_id:null}),'账号未知');assert.match(accountName(item),/^account-/);});
