import crypto from 'node:crypto';

const fields=['protocol','release_seq','version','platform','min_updater','filename','sha256','size','issued_at','expires_at','key_id'];
const stages=['pending','downloaded','verified','waiting_exit','replaced','checking','installed'];
const terminal=['installed','failed','rolled_back'];
/** 功能：按 JSON 词法读取平面清单，拒绝转义后的重复键；参数：已验签的文本；返回值：唯一字段对象。 */
function parseManifest(text){
  let value;
  try{value=JSON.parse(text);}catch{throw Error('bad_manifest');}
  if(!value||Array.isArray(value)||typeof value!=='object')throw Error('bad_manifest');
  // 整个字符串一次匹配，避免把字符串内容中的冒号或转义引号误识别为字段。
  const token=/\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}:,])/y;
  const tokens=[];let position=0;
  while(position<text.length){
    if(/^[\x20\t\r\n]*$/.test(text.slice(position)))break;
    token.lastIndex=position;const match=token.exec(text);
    if(!match)throw Error('bad_manifest');tokens.push(match[1]);position=token.lastIndex;
  }
  // 限定平面字段且逐项计数，避免 JSON.parse 静默覆盖重复属性；转义键同样被解码核对。
  const keys=[];
  if(tokens.shift()!=='{'||tokens.pop()!=='}')throw Error('bad_manifest');
  // 只接受键、冒号、标量、逗号的固定序列；任何嵌套或额外字段均失败关闭。
  for(let index=0;index<tokens.length;index+=4){
    if(!tokens[index]?.startsWith('"')||tokens[index+1]!==':'||!tokens[index+2]||['{','}',':',','].includes(tokens[index+2])||(index+3<tokens.length&&tokens[index+3]!==','))throw Error('bad_manifest');
    // 与C#客户端使用同一整数词法，避免服务端接受客户端永远无法解析的签名版本。
    if(!tokens[index+2].startsWith('"')&&!/^(0|[1-9][0-9]*)$/.test(tokens[index+2]))throw Error('bad_manifest');
    keys.push(JSON.parse(tokens[index]));
  }
  if(tokens.length!==fields.length*4-1||keys.length!==fields.length||new Set(keys).size!==fields.length||fields.some(name=>!Object.hasOwn(value,name))||Object.keys(value).length!==fields.length)throw Error('bad_manifest');
  return value;
}
/** 功能：验签并严格解析平面发布清单；参数：原始信封、公钥、Unix秒与可选固定密钥ID；返回值：已验证清单，异常时拒绝。 */
export function verifyManifest(envelope,key,now=Math.floor(Date.now()/1000),expectedKeyId=null){
  if(typeof envelope?.manifest!=='string'||Buffer.byteLength(envelope.manifest)>4096||typeof envelope.signature!=='string')throw Error('bad_manifest');
  // RSA-3072 签名固定为384字节，标准 Base64 恰为512字符；拒绝宽松解码吞掉的杂字符。
  if(!/^[A-Za-z0-9+/]{512}$/.test(envelope.signature)||!Number.isSafeInteger(now))throw Error('bad_signature');
  const publicKey=crypto.createPublicKey(key.type==='public'?key.export({type:'spki',format:'pem'}):key);
  if(publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails.modulusLength!==3072||!crypto.verify('RSA-SHA256',Buffer.from(envelope.manifest),{key:publicKey,padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(envelope.signature,'base64')))throw Error('bad_signature');
  const value=parseManifest(envelope.manifest);
  for(const name of ['protocol','release_seq','min_updater','size','issued_at','expires_at'])if(!Number.isSafeInteger(value[name]))throw Error('bad_manifest');
  if(value.protocol!==1||value.release_seq<1||value.min_updater!==1||value.size<1||value.size>20*1024*1024||value.platform!=='win-x64'||value.filename!=='CodexQuotaCollector.exe'||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||typeof value.version!=='string'||!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version)||typeof value.key_id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value.key_id)||value.issued_at>now+120||value.issued_at<0||value.expires_at<=now||value.expires_at<=value.issued_at)throw Error('bad_manifest');
  if(expectedKeyId!==null&&value.key_id!==expectedKeyId)throw Error('bad_key_id');
  return value;
}

/** 功能：维护可信发布、设备能力及定向任务；参数：SQLite连接和时钟；返回值：领域实例。 */
export class Ota{
  /** 功能：初始化独立持久表；参数：连接与Unix秒时钟；返回值：实例。 */
  constructor(db,clock=()=>Math.floor(Date.now()/1000)){
    this.db=db;this.clock=clock;
    db.exec(`CREATE TABLE IF NOT EXISTS ota_release(seq INTEGER PRIMARY KEY,key_id TEXT NOT NULL,envelope TEXT NOT NULL,manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ota_capability(machine_id INTEGER PRIMARY KEY,client_id TEXT NOT NULL,seq INTEGER NOT NULL,key_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ota_job(job_id TEXT PRIMARY KEY,machine_id INTEGER NOT NULL,client_id TEXT NOT NULL,seq INTEGER NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS ota_one_active ON ota_job(machine_id) WHERE state NOT IN ('installed','failed','rolled_back');`);
  }
  /** 功能：登记已验签发布；参数：信封、固定公钥与可选固定密钥ID，信封可带合成产物字节；返回值：清单。 */
  publish(envelope,key,expectedKeyId=null){
    const manifest=verifyManifest(envelope,key,this.clock(),expectedKeyId);
    if(envelope.bytes!==undefined&&(!Buffer.isBuffer(envelope.bytes)||envelope.bytes.length!==manifest.size||crypto.createHash('sha256').update(envelope.bytes).digest('hex')!==manifest.sha256))throw Error('bad_artifact');
    const encoded=JSON.stringify({manifest:envelope.manifest,signature:envelope.signature});
    const existing=this.db.prepare('SELECT envelope FROM ota_release WHERE seq=?').get(manifest.release_seq);
    if(existing){if(existing.envelope!==encoded)throw Error('release_conflict');return manifest;}
    const highest=this.db.prepare('SELECT MAX(seq) AS seq FROM ota_release').get().seq;
    if(highest!==null&&manifest.release_seq<=highest)throw Error('release_seq_not_increasing');
    this.db.prepare('INSERT INTO ota_release VALUES(?,?,?,?)').run(manifest.release_seq,manifest.key_id,encoded,JSON.stringify(manifest));return manifest;
  }
  /** 功能：记录当前设备可信能力，不降低已接受序号；参数：设备ID、身份、能力；返回值：无。 */
  capability(id,client,cap){
    if(!Number.isSafeInteger(id)||id<1||typeof client!=='string'||!client||cap?.protocol!==1||!Number.isSafeInteger(cap.release_seq)||cap.release_seq<0||typeof cap.key_id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(cap.key_id))throw Error('bad_ota_capability');
    const existing=this.db.prepare('SELECT * FROM ota_capability WHERE machine_id=?').get(id);
    // V1不接受设备报告静默轮换信任根或身份；轮换须走后续可信安装协议。
    if(existing&&(existing.client_id!==client||existing.key_id!==cap.key_id))throw Error('ota_capability_conflict');
    this.db.prepare('INSERT INTO ota_capability VALUES(?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(id,client,cap.release_seq,cap.key_id);
    // 更高序号表示已通过其他可信安装完成更新，旧目标不能再领取或占据活动槽位。
    this.db.prepare("UPDATE ota_job SET state='failed',error='release_superseded',updated_at=? WHERE machine_id=? AND client_id=? AND seq<? AND state NOT IN ('installed','failed','rolled_back')").run(this.clock(),id,client,cap.release_seq);
  }
  /** 功能：终结尚未验签且已过期的任务以释放活动槽位；参数：设备ID；返回值：无。 */
  expire(id){
    const jobs=this.db.prepare("SELECT job_id,seq FROM ota_job WHERE machine_id=? AND state IN ('pending','downloaded')").all(id);
    // 已验签后可能正在本机恢复，不能仅凭发布过期解除其互斥或抹掉恢复证据。
    for(const job of jobs){const release=this.db.prepare('SELECT manifest FROM ota_release WHERE seq=?').get(job.seq);if(!release||JSON.parse(release.manifest).expires_at<=this.clock())this.db.prepare("UPDATE ota_job SET state='failed',error='manifest_expired',updated_at=? WHERE job_id=?").run(this.clock(),job.job_id);}
  }
  /** 功能：创建单设备幂等升级任务；参数：设备ID、身份、目标序号；返回值：任务。 */
  create(id,client,seq){
    if(!Number.isSafeInteger(seq)||seq<1)throw Error('ota_not_eligible');
    this.expire(id);
    const cap=this.db.prepare('SELECT * FROM ota_capability WHERE machine_id=? AND client_id=?').get(id,client);
    const release=this.db.prepare('SELECT * FROM ota_release WHERE seq=?').get(seq);
    if(!cap||!release||cap.key_id!==release.key_id)throw Error('ota_not_eligible');
    const old=this.db.prepare("SELECT * FROM ota_job WHERE machine_id=? AND state NOT IN ('installed','failed','rolled_back')").get(id);
    // 幂等查询先于最高序号检查：verified确认会提升序号，但相同活动任务仍须可重复创建查询。
    if(old){if(old.seq!==seq||old.client_id!==client)throw Error('ota_busy');return old;}
    if(seq<=cap.seq||JSON.parse(release.manifest).expires_at<=this.clock())throw Error('ota_not_eligible');
    const job={job_id:crypto.randomUUID(),machine_id:id,client_id:client,seq,state:'pending',error:null,updated_at:this.clock()};this.db.prepare('INSERT INTO ota_job VALUES(?,?,?,?,?,?,?)').run(...Object.values(job));return job;
  }
  /** 功能：领取本设备当前任务，终态不重放；参数：设备ID和身份；返回值：任务信封或null。 */
  claim(id,client){
    this.expire(id);
    const job=this.db.prepare("SELECT j.* FROM ota_job j JOIN ota_capability c ON c.machine_id=j.machine_id AND c.client_id=j.client_id JOIN ota_release r ON r.seq=j.seq AND r.key_id=c.key_id WHERE j.machine_id=? AND j.client_id=? AND j.state NOT IN ('installed','failed','rolled_back')").get(id,client);
    if(!job)return null;const r=this.db.prepare('SELECT envelope,manifest FROM ota_release WHERE seq=?').get(job.seq);
    if(JSON.parse(r.manifest).expires_at<=this.clock())return null;
    return {...job,...JSON.parse(r.envelope),download_path:'/api/client/ota/download/'+job.job_id};
  }
  /** 功能：授权下载本设备活动任务的固定产物；参数：已鉴权设备、身份与任务ID；返回值：任务和原始签名信封，文件读取由接口层按摘要进行。 */
  download(id,client,jobId){
    const task=this.claim(id,client);
    if(!task||task.job_id!==jobId)throw Error('ota_download_not_allowed');return task;
  }
  /** 功能：单调确认本设备任务，保留最高接受序号；参数：设备、身份、任务ID、阶段和安全错误码；返回值：无。 */
  ack(id,client,jobId,state,error=null){
    if((!stages.includes(state)&&!terminal.includes(state))||(error!==null&&(typeof error!=='string'||!/^[a-z_]{1,64}$/.test(error))))throw Error('bad_ota_ack');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // 在同一写事务内重新核对归属、信任根与前态，避免多个服务连接覆盖终态。
      const job=this.db.prepare('SELECT j.* FROM ota_job j JOIN ota_capability c ON c.machine_id=j.machine_id AND c.client_id=j.client_id JOIN ota_release r ON r.seq=j.seq AND r.key_id=c.key_id WHERE j.job_id=? AND j.machine_id=? AND j.client_id=?').get(jobId,id,client);
      if(!job)throw Error('bad_ota_ack');
      if(job.state!==state){
        if(terminal.includes(job.state)||(!terminal.includes(state)&&stages.indexOf(state)<stages.indexOf(job.state)))throw Error('stale_ota_ack');
        this.db.prepare('UPDATE ota_job SET state=?,error=?,updated_at=? WHERE job_id=?').run(state,error,this.clock(),jobId);
        if(stages.indexOf(state)>=stages.indexOf('verified')||state==='rolled_back')this.db.prepare('UPDATE ota_capability SET seq=MAX(seq,?) WHERE machine_id=? AND client_id=?').run(job.seq,id,client);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  /** 功能：读取管理员可见发布与任务；参数：无；返回值：安全元数据。 */
  list(){return {releases:this.db.prepare('SELECT manifest FROM ota_release ORDER BY seq DESC').all().map(row=>JSON.parse(row.manifest)),jobs:this.db.prepare('SELECT * FROM ota_job ORDER BY updated_at DESC LIMIT 200').all(),capabilities:this.db.prepare('SELECT * FROM ota_capability').all()};}
}
