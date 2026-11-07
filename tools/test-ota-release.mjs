import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {signRelease} from './build-ota-release.mjs';
import {verifyManifest} from '../server/ota.mjs';
test('离线签发绑定程序原始摘要与大小且不泄漏私钥',()=>{const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:3072});const result=signRelease(Buffer.from('fixture'),privateKey,{release_seq:3,version:'1.2.3',key_id:'fixture',issued_at:100,expires_at:200});const m=verifyManifest(result,publicKey,150,'fixture');assert.equal(m.size,7);assert.equal(m.release_seq,3);assert.equal(Object.keys(result).sort().join(','),'manifest,signature');assert.throws(()=>signRelease(Buffer.alloc(0),privateKey,{release_seq:3,version:'1.2.3',key_id:'fixture',issued_at:100,expires_at:200}));});
