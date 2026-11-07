import test from 'node:test';import assert from 'node:assert/strict';import {fontPercent,fontSizes} from '../src/font-size.ts';
test('字号提供100至150的六个固定档位',()=>{assert.deepEqual(fontSizes,[100,110,120,130,140,150]);for(const value of fontSizes)assert.equal(fontPercent(String(value)),value);});
test('无效偏好回退120，不能注入CSS或越界缩放',()=>{for(const value of [null,undefined,'','90','151','125','NaN','120; color:red',true])assert.equal(fontPercent(value),120);});
