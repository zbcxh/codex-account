import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyManifest} from '../server/ota.mjs';

/** 功能：使用外部离线私钥签发单程序清单；参数：程序字节、私钥、序号版本密钥ID及Unix秒有效期；返回值：不含私钥的原始清单和签名。 */
export function signRelease(bytes,privateKey,metadata){
  if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>20*1024*1024)throw Error('bad_artifact_size');
  const key=typeof privateKey==='string'||Buffer.isBuffer(privateKey)?crypto.createPrivateKey(privateKey):privateKey;
  if(key.type!=='private'||key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength!==3072)throw Error('bad_signing_key');
  const manifest=JSON.stringify({protocol:1,release_seq:metadata.release_seq,version:metadata.version,platform:'win-x64',min_updater:1,filename:'CodexQuotaCollector.exe',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,issued_at:metadata.issued_at,expires_at:metadata.expires_at,key_id:metadata.key_id});
  const envelope={manifest,signature:crypto.sign('RSA-SHA256',Buffer.from(manifest),{key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')};
  verifyManifest(envelope,crypto.createPublicKey(key),metadata.issued_at,metadata.key_id);return envelope;
}
/** 功能：按显式路径生成离线发布资产，不联网或发布；参数：命令行键值选项；返回值：输出目录，异常时退出失败。 */
function main(args){
  const options={};for(let index=0;index<args.length;index+=2){if(!['--exe','--private-key','--seq','--version','--key-id','--expires-at','--out'].includes(args[index])||!args[index+1]||Object.hasOwn(options,args[index]))throw Error('bad_options');options[args[index]]=args[index+1];}
  if(Object.keys(options).length!==7)throw Error('required_options_missing');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),privatePath=path.resolve(options['--private-key']);
  if(privatePath===root||privatePath.startsWith(root+path.sep))throw Error('signing_key_must_be_outside_repository');
  const output=path.resolve(options['--out']);if(fs.existsSync(output))throw Error('output_must_be_new');
  const bytes=fs.readFileSync(options['--exe']),issued_at=Math.floor(Date.now()/1000);
  const envelope=signRelease(bytes,fs.readFileSync(privatePath),{release_seq:Number(options['--seq']),version:options['--version'],key_id:options['--key-id'],issued_at,expires_at:Number(options['--expires-at'])});
  const manifest=JSON.parse(envelope.manifest);fs.mkdirSync(output,{recursive:false});
  fs.writeFileSync(path.join(output,manifest.sha256+'.exe'),bytes,{flag:'wx'});fs.writeFileSync(path.join(output,'release.json'),JSON.stringify(envelope,null,2),{flag:'wx'});
  console.log(output);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main(process.argv.slice(2));}catch{console.error('OTA离线签发失败，请核对选项、外部密钥、版本和有效期。');process.exitCode=1;}}
