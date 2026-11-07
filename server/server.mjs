import http from 'node:http';
import {requestSource} from './proxy-source.mjs';
import {BrowserBindings,browserToken,handleBrowserBindings} from './browser-bindings.mjs';
import { handleAccountMcp, hasUsableQuota } from './account-mcp.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ReportingConfig, validInterval } from './reporting-config.mjs';
import { PairingSecurity } from './pairing-security.mjs';
import { ServerMigration, migrationProof } from './server-migration.mjs';
import { HistoryCleanup } from './history-cleanup.mjs';
import { withAccountDeviceReportTimes } from './account-device-times.mjs';
import { AccountRecords } from './account-records.mjs';
import { DeviceMerge } from './device-merge.mjs';
import { Ota, verifyManifest } from './ota.mjs';
import {onlineWindowSeconds,isReportOnline,REPORT_GRACE_SECONDS} from './online-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 功能：解析服务启动参数，不从请求接收OTA信任根；参数：命令行数组，--host为监听地址，--trust-loopback-proxy仅信任本机代理；返回值：启动配置。 */
function parseArgs(argv) {
  const out = { host:'0.0.0.0', trustLoopbackProxy:false, port: 8787, allow: null, bootstrap: null, readGate: 'paired', db: path.join(HERE, 'data', 'quota.sqlite3'), retentionDays: 90 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--host') out.host = String(next());
    else if (a === '--trust-loopback-proxy') out.trustLoopbackProxy = true;
    else if (a === '--port') out.port = Number(next());
    else if (a === '--allow') out.allow = String(next());
    else if (a === '--bootstrap') out.bootstrap = next();
    else if (a === '--read-gate') out.readGate = String(next());
    else if (a === '--db') out.db = next();
    else if (a === '--retention-days') out.retentionDays = Number(next());
    else if (a === '--ota-public-key') out.otaPublicKey = next();
    else if (a === '--ota-key-id') out.otaKeyId = next();
    else if (a === '--ota-artifacts') out.otaArtifacts = next();
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node --no-warnings server.mjs [--port 8787] [--allow 192.168.1.0/24,...] [--bootstrap SECRET] [--read-gate paired|lan] [--db path]
Codex 额度监控服务器：接收客户端上报并提供面板。
--read-gate paired（默认）只有已接入的机器能读面板；lan 则内网段内任意来源都能读。`);
      process.exit(0);
    }
  }
  return out;
}

const CFG = parseArgs(process.argv.slice(2));
let wecomWebhook = readWecomWebhook();
const accountMcpToken = process.env.CODEX_ACCOUNTS_MCP_TOKEN;

/** 功能：读取并校验本机企微推送地址；参数：无；返回值：有效 URL 或 null。 */
function readWecomWebhook() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(HERE, 'server.config.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!config.wecomWebhook) return null;
    const url = parseWecomWebhook(config.wecomWebhook);
    if (url) return url;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
  }
  console.warn('企微提醒配置无效，已停用。');
  return null;
}

/** 功能：验证企微群推送地址；参数：value 为待验证字符串；返回值：有效 URL 或 null。 */
function parseWecomWebhook(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const url = URL.parse(value.trim());
  // 限定企微群推送入口，避免将设备信息发送到其他主机。
  if (url?.origin === 'https://qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send'
      && !url.username && !url.password && !url.hash && url.searchParams.get('key')) return url;
  return null;
}

/** 功能：记录触发并向企微发送提醒；参数：content 为文本，kind 为提醒类型，deviceName 为触发设备显示名或 null；返回值：发送结果 Promise，记录时间为 Unix 秒。 */
async function sendWecomAlert(content, kind, deviceName = null) {
  const target = wecomWebhook;
  if (!target) return false;
  const id = recordWecomDelivery.run(kind, nowSec(), deviceName).lastInsertRowid;
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    const success = response.ok && result.errcode === 0;
    finishWecomDelivery.run(nowSec(), success ? 'sent' : 'failed',
      response.ok ? (Number.isInteger(result.errcode) ? String(result.errcode) : 'invalid_response') : 'http_' + response.status, id);
    return success;
  } catch {
    finishWecomDelivery.run(nowSec(), 'failed', 'network_or_response_error', id);
    console.warn('企微提醒发送失败。');
    return false;
  }
}

// 默认只放行回环与 RFC1918 内网段；--allow 显式给出时以其为准。
const DEFAULT_NETWORKS = [['127.0.0.0', 8], ['10.0.0.0', 8], ['192.168.0.0', 16], ['172.16.0.0', 12]]
  .map(([ip, bits]) => toNetwork(ip, bits));
const ALLOWED = CFG.allow
  ? String(CFG.allow).split(',').map((s) => s.trim()).filter(Boolean).map(toNetworkFromCidr)
  : DEFAULT_NETWORKS;

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function toNetwork(ip, bits) {
  const value = ipToInt(ip);
  if (value === null) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { value: (value & mask) >>> 0, mask, cidr: `${ip}/${bits}` };
}

function toNetworkFromCidr(cidr) {
  const [ip, bits] = String(cidr).split('/');
  return toNetwork(ip, bits === undefined ? 32 : Number(bits));
}

function ipAllowed(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '');
  if (clean === '::1') return true;
  const value = ipToInt(clean);
  if (value === null) return false;
  return ALLOWED.some((n) => n && ((value & n.mask) >>> 0) === n.value);
}

function sameSecret(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

fs.mkdirSync(path.dirname(CFG.db), { recursive: true });
const db = new DatabaseSync(CFG.db);
// 同步数据库等待必须有界，避免外部读连接占锁时长时间阻塞整个 HTTP 事件循环。
db.exec('PRAGMA busy_timeout=1000');
db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
// 老库保留原记录，新增字段初始未知，不能把最近上报时间冒充上线时间。
for (const [table, column] of [['machine', 'online_since'], ['wecom_delivery', 'device_name'], ['quota_snapshot', 'collector_version'], ['quota_snapshot', 'collector_build'], ['quota_snapshot', 'collector_sha256']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((field) => field.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${column === 'online_since' ? 'INTEGER' : 'TEXT'}`);
  }
}
const storedWecomWebhook = db.prepare('SELECT webhook FROM wecom_notification WHERE id = 1').get();
// 缺行沿用文件配置，存在空值表示管理员已明确停用。
if (storedWecomWebhook) wecomWebhook = parseWecomWebhook(storedWecomWebhook.webhook);
const saveWecomWebhook = db.prepare(`INSERT INTO wecom_notification (id, webhook) VALUES (1, ?)
  ON CONFLICT(id) DO UPDATE SET webhook = excluded.webhook`);
const claimResetNotice = db.prepare('INSERT OR IGNORE INTO wecom_reset_notice (account_id, window_kind, resets_at) VALUES (?, ?, ?)');
// 仅记录类型、时间和安全结果码，避免凭据和消息正文进入诊断记录。
const recordWecomDelivery = db.prepare("INSERT INTO wecom_delivery (kind, triggered_at, device_name, status) VALUES (?, ?, ?, 'sending')");
const markOnlineSince = db.prepare('UPDATE machine SET online_since=? WHERE machine_id=?');
const finishWecomDelivery = db.prepare('UPDATE wecom_delivery SET finished_at=?, status=?, result_code=? WHERE id=?');
db.prepare("UPDATE wecom_delivery SET status='unknown', result_code='service_restarted' WHERE status='sending'").run();

/** 功能：管理员读取或更新企微配置；参数：req/res 为 HTTP 对象，save 为是否保存，保存正文 webhook 为地址或 null；返回值：配置状态及最近20条提醒的 Unix 秒时间、安全结果码。 */
async function handleWecomSettings(req, res, save) {
  const credential = req.headers['x-quota-bootstrap'];
  res.setHeader('Cache-Control', 'no-store');
  if (!security.verifyAdmin(credential)) return send(res, 403, { error: 'bad_bootstrap' });
  if (save) {
    const raw = await readBody(req, res, 4096);
    // 读正文期间口令可能轮换，写入前使用当前口令重新验证。
    if (!security.verifyAdmin(credential)) return send(res, 403, { error: 'bad_bootstrap' });
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad_json' }); }
    const url = parseWecomWebhook(body?.webhook);
    if (body?.webhook !== null && !url) return send(res, 400, { error: 'bad_wecom_webhook' });
    saveWecomWebhook.run(url?.href ?? null);
    wecomWebhook = url;
  }
  return send(res, 200, { configured: Boolean(wecomWebhook),
    deliveries: db.prepare('SELECT * FROM wecom_delivery ORDER BY id DESC LIMIT 20').all() });
}

/** 功能：管理员显式发送一条测试消息；参数：req/res 为 HTTP 对象；返回值：发送结果，失败不自动重试。 */
async function handleWecomTest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res, 403, { error: 'bad_bootstrap' });
  if (!wecomWebhook) return send(res, 409, { error: 'wecom_disabled' });
  return send(res, 200, { sent: await sendWecomAlert('【测试】codex-accounts 企业微信提醒连通性测试。', 'test') });
}
const reporting = new ReportingConfig(db);
const migration = new ServerMigration(db);
const cleanup = new HistoryCleanup(db, CFG.retentionDays);
const deviceMerge = new DeviceMerge(db, id => onlineWindowSeconds(reporting.describe(id).applied_interval_minutes));
const accountRecords = new AccountRecords(db, id => onlineWindowSeconds(reporting.describe(id).applied_interval_minutes));
const security = new PairingSecurity(db, CFG.bootstrap);
const ota = new Ota(db);
/** 功能：为浏览器凭证提供当前设备身份及实际在线参数；参数：设备ID；返回值：设备或null，不返回令牌。 */
function browserMachine(id) {
  const machine=db.prepare('SELECT machine_id,client_id,label,last_ok_at FROM machine WHERE machine_id=?').get(id);
  return machine?{...machine,merged:deviceMerge.isMerged(id),applied_interval_minutes:reporting.describe(id).applied_interval_minutes}:null;
}
const browserBindings=new BrowserBindings(db,browserMachine,()=>Math.floor(Date.now()/1000),()=>security.generation());
/** 功能：列出可绑定设备安全元数据；参数：无；返回值：设备ID、显示名和在线状态。 */
function browserDevices() {
  // 在线标准与额度面板保持一致，不能使用期望周期或普通心跳替代实际成功上报。
  return db.prepare('SELECT machine_id,label,last_ok_at FROM machine WHERE machine_id NOT IN (SELECT source_id FROM machine_merged)').all()
    .map(machine=>({machine_id:machine.machine_id,label:machine.label,online:isReportOnline(machine.last_ok_at,nowSec(),reporting.describe(machine.machine_id).applied_interval_minutes)}));
}
// 未显式提供可信公钥与产物目录时不开放发布；不从请求接受信任根。
const otaPublicKey = CFG.otaPublicKey ? fs.readFileSync(CFG.otaPublicKey, 'utf8') : null;
const otaArtifacts = CFG.otaArtifacts ? path.resolve(CFG.otaArtifacts) : null;
// 管理口令只在初始摘要计算时使用；后续校验统一经过安全存储。
CFG.bootstrap = null;

const Q = {
  machineByClient: db.prepare('SELECT * FROM machine WHERE client_id = ?'),
  machineByToken: db.prepare('SELECT * FROM machine WHERE token = ?'),
  machineById: db.prepare('SELECT * FROM machine WHERE machine_id = ?'),
  insertMachine: db.prepare(`INSERT INTO machine (client_id, token, label, hostname, created_at, last_ip)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET
      hostname = COALESCE(excluded.hostname, machine.hostname),
      label    = CASE WHEN excluded.label <> '' THEN excluded.label ELSE machine.label END,
      last_ip  = excluded.last_ip`),
  touchSeen: db.prepare(`UPDATE machine SET last_seen_at = ?, last_ok_at = ?, last_ip = ?,
      last_report_id = ?, last_session_mtime = ? WHERE machine_id = ?`),
  touchAttempt: db.prepare('UPDATE machine SET last_seen_at = ?, last_ip = ? WHERE machine_id = ?'),
  setLabel: db.prepare('UPDATE machine SET label = ? WHERE machine_id = ?'),
  rowsOfReport: db.prepare('SELECT * FROM quota_snapshot WHERE report_id = ?'),
  latestUsableReport: db.prepare('SELECT report_id FROM quota_snapshot WHERE machine_id = ? AND collected_at <= ? ORDER BY collected_at DESC, reported_at DESC, id DESC LIMIT 1'),
  latestReportOfMachine: db.prepare('SELECT last_report_id FROM machine WHERE machine_id = ?'),
  machines: db.prepare('SELECT * FROM machine ORDER BY label'),
  // 闸门用的"已接入来源 IP"：last_ip 是某台机器的最近来源，且这台机器 24 小时内有动静
  // （刚配对还没上报过的用 created_at 兜底，免得装完看不到面板）。
  readIps: db.prepare(`SELECT DISTINCT last_ip FROM machine
      WHERE machine_id NOT IN (SELECT source_id FROM machine_merged) AND last_ip IS NOT NULL AND last_ip <> '' AND COALESCE(last_seen_at, created_at) > ?`),
  aliases: db.prepare('SELECT * FROM account_alias ORDER BY display_name COLLATE NOCASE'),
  hiddenAccounts: db.prepare('SELECT account_id FROM account_hidden'),
  accountStatuses: db.prepare('SELECT account_id,status FROM account_status'),
  setAccountStatus: db.prepare('INSERT INTO account_status(account_id,status,updated_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at'),
  hideAccount: db.prepare('INSERT INTO account_hidden (account_id, hidden_at) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET hidden_at = excluded.hidden_at'),
  unhideAccount: db.prepare('DELETE FROM account_hidden WHERE account_id = ?'),
  accountExists: db.prepare(`SELECT 1 AS found FROM quota_snapshot WHERE account_id = ? LIMIT 1`),
  aliasUp: db.prepare(`INSERT INTO account_alias (account_id, display_name, owner, note, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
        display_name = excluded.display_name, owner = excluded.owner,
        note = excluded.note, updated_at = excluded.updated_at`),
  aliasDel: db.prepare('DELETE FROM account_alias WHERE account_id = ?'),
  acctIds: db.prepare(`SELECT account_id, COUNT(*) AS snap_rows, COUNT(DISTINCT machine_id) AS machine_count,
        MIN(reported_at) AS first_seen, MAX(reported_at) AS last_reported_at
      FROM quota_snapshot WHERE account_id IS NOT NULL AND account_id <> ''
      GROUP BY account_id ORDER BY last_reported_at DESC`),
  acctLatest: db.prepare(`SELECT plan_type, window_kind, window_minutes, used_percent, resets_at, balance, has_credits,
        unlimited, collected_at, cli_version, originator
      FROM quota_snapshot WHERE account_id = ? AND collected_at <= unixepoch() + 300
      ORDER BY collected_at DESC, reported_at DESC, CASE WHEN window_kind = 'primary' THEN 0 ELSE 1 END, id DESC LIMIT 1`),
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function signatureOf(rows) {
  const r = rows[0];
  if (!r) return null;
  const windows = rows
    .map((w) => `${w.window_kind}:${w.window_minutes}:${Math.round((w.used_percent ?? -1) * 10)}`)
    .sort()
    .join('|');
  return [r.account_id, r.plan_type, r.balance, r.has_credits, r.unlimited, r.hit_limit, r.source, windows].join('~');
}

function num(v, { min, max } = {}) {
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function windowRow(kind, w) {
  if (!w || typeof w !== 'object') return null;
  const used = num(w.used_percent, { min: 0, max: 1000 });
  const minutes = num(w.window_minutes, { min: 1 });
  if (used === null) return null;
  return {
    window_kind: kind,
    window_minutes: minutes === null ? null : Math.round(minutes),
    used_percent: used,
    resets_at: num(w.resets_at, { min: 0 }) === null ? null : Math.round(num(w.resets_at, { min: 0 })),
  };
}

const pairThrottle = new Map();
const PAIR_BUDGET_PER_MIN = 8;

/** 功能：只用配对码注册设备，事务保护单次核销及设备令牌；参数：req、res、body、remote 为请求、响应、设备字段和来源；返回值：配对响应。 */
function handlePair(req, res, body, remote) {
  const clientId = String(body.client_id ?? '').trim();
  if (!clientId || clientId.length > 128) return send(res, 400, { error: 'bad_client_id' });
  const previous=Q.machineByClient.get(clientId);
  if(previous&&deviceMerge.isMerged(previous.machine_id))return send(res,409,{error:'device_already_merged'});
  // 对所有配对尝试限流，包括无效码，避免永久码入口被无限猜测。
  const recent = (pairThrottle.get(remote) ?? []).filter(t => Date.now()-t < 60_000);
  if (recent.length >= PAIR_BUDGET_PER_MIN) return send(res,429,{ error:'pair_throttled',retry_after_sec:60 });
  recent.push(Date.now());
  pairThrottle.set(remote,recent);
  const hostname = body.hostname ? String(body.hostname).slice(0,120) : null;
  const label = body.label ? String(body.label).slice(0,120) : '';
  try {
    // 沿用客户端现有请求头，客户端无需替换，只需在原口令位置输入配对码。
    const machine = security.redeem(req.headers['x-quota-bootstrap'],clientId,req.headers['x-quota-token'],existing => {
      Q.insertMachine.run(clientId,existing ? existing.token : crypto.randomBytes(24).toString('hex'),label,hostname,nowSec(),remote);
      return Q.machineByClient.get(clientId);
    });
    return send(res,200,{ machine_id:machine.machine_id,token:machine.token,label:machine.label });
  } catch (error) {
    return send(res,error.status || 500,{ error:error.publicCode || 'pairing_failed' });
  }
}

/** 功能：管理页面修改授权及生成/列出/撤销配对码；参数：req、res、pathname 为请求、响应及路由；返回值：安全管理响应。 */
async function handleSecurity(req,res,pathname) {
  if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{ error:'bad_bootstrap' });
  try {
    const body = JSON.parse((await readBody(req,res,4096)) || '{}');
    // 读取请求体会让出事件循环，提交前重新校验，阻止旧口令在轮换后继续写入。
    if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{ error:'bad_bootstrap' });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res,400,{ error:'bad_security_request' });
    if (pathname === '/api/admin/bootstrap') {
      security.changeAdmin(req.headers['x-quota-bootstrap'],body.new_bootstrap,body.confirm_bootstrap);
      unlockedIps.clear();
      browserBindings.revokeAll();
      // 清除旧口令解锁，但保留本次成功更改者的读取权限，避免页面保存后立即被闸门拦住。
      const remote = requestSource(req,CFG.trustLoopbackProxy);
      unlockedIps.set(remote,Date.now()+UNLOCK_TTL_MS);
      return send(res,200,{ ok:true });
    }
    if (pathname === '/api/pairing-codes/list') return send(res,200,{ ok:true,codes:security.listCodes(),server_now:nowSec() });
    if (pathname === '/api/pairing-codes') return send(res,200,{ ok:true,...security.createCode(body) });
    const match = /^\/api\/pairing-codes\/(\d+)\/revoke$/.exec(pathname);
    if (!match) return send(res,404,{ error:'not_found' });
    security.revokeCode(Number(match[1]));
    return send(res,200,{ ok:true });
  } catch (error) {
    if (error?.code === 413) return;
    return send(res,error.status || (error instanceof SyntaxError ? 400 : 500),{ error:error.publicCode || (error instanceof SyntaxError ? 'bad_json' : 'security_operation_failed') });
  }
}

/**
 * 功能：事务保存额度与设备实际周期，并在成功响应中下发期望配置。
 * 参数：req/res 为 HTTP 对象，body 含额度、可选 reporting_status 及 collector_version/build/sha256（字符串或空值），machine 为已鉴权设备，remote 为来源。
 * 返回值：额度结果及 reporting_config；重放也返回当前配置，不重复写入历史。
 */
function handleReport(req, res, body, machine, remote) {
  // 元数据可缺省以兼容旧客户端；限制字符及长度，拒绝截断摘要造成错误的程序身份。
  for (const [field, pattern] of [['collector_version', /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/], ['collector_build', /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,95}$/], ['collector_sha256', /^[a-fA-F0-9]{64}$/]]) {
    if (body[field] != null && (typeof body[field] !== 'string' || !pattern.test(body[field]))) return send(res, 400, {error:'bad_collector_metadata'});
  }
  if (!reporting.validStatus(body.reporting_status)) return send(res, 400, { error: 'bad_reporting_status' });
  const primary = windowRow('primary', body.primary);
  if (!primary) return send(res, 400, { error: 'bad_primary_window' });

  const rows = [primary];
  const secondary = windowRow('secondary', body.secondary);
  if (secondary) rows.push(secondary);

  const collected = num(body.collected_at, { min: 0 });
  if (collected === null || collected > nowSec() + 300) return send(res, 400, { error: 'bad_collected_at' });
  const collectedAt = Math.round(collected);
  const reportedAt = nowSec();
  // 显式删除之前采集的旧队列按已处理返回，避免再次创建已删除账号；新鲜报告仍可重新出现。
  if (!accountRecords.accepts(body.account_id ? String(body.account_id).slice(0,128) : '', collectedAt)) {
    return send(res,200,{ok:true,ignored:'deleted_account_history',reporting_config:reporting.forClient(machine.machine_id),migration_config:migration.describe(machine.machine_id)});
  }
  const eventId = body.event_id;
  if (eventId !== undefined && (typeof eventId !== 'string' || !/^[a-f0-9]{64}$/.test(eventId))) return send(res, 400, { error: 'bad_event_id' });
  const reportId = eventId ? crypto.createHash('sha256').update(`${machine.machine_id}:${eventId}`).digest('hex') : crypto.randomBytes(12).toString('hex');
  if (eventId && Q.rowsOfReport.all(reportId).length) return send(res, 200, { ok: true, replay: true, report_id: reportId, server_now: reportedAt, reporting_config: reporting.forClient(machine.machine_id), migration_config: migration.describe(machine.machine_id) });

  const credits = body.credits && typeof body.credits === 'object' ? body.credits : {};
  const balance = credits.balance === undefined || credits.balance === null
    ? null
    : String(credits.balance).slice(0, 64);

  const prevReportId = machine.last_report_id;
  const prevSig = prevReportId ? signatureOf(Q.rowsOfReport.all(prevReportId)) : null;
  const base = {
    account_id: body.account_id ? String(body.account_id).slice(0, 128) : null,
    user_id: body.user_id ? String(body.user_id).slice(0, 128) : null,
    plan_type: body.plan_type ? String(body.plan_type).slice(0, 64) : null,
    cli_version: body.cli_version ? String(body.cli_version).slice(0, 64) : null,
    originator: body.originator ? String(body.originator).slice(0, 64) : null,
    balance,
    has_credits: credits.has_credits === undefined ? null : (credits.has_credits ? 1 : 0),
    unlimited: credits.unlimited === undefined ? null : (credits.unlimited ? 1 : 0),
    hit_limit: body.hit_limit ? String(body.hit_limit).slice(0, 64) : null,
    source: body.source ? String(body.source).slice(0, 32) : 'session_tail',
    source_seq: num(body.source_seq, { min: 0 }) === null ? null : Math.round(num(body.source_seq, { min: 0 })),
  };
  const mySig = signatureOf(rows.map((r) => ({ ...base, ...r })));
  const isDuplicate = prevSig !== null && prevSig === mySig ? 1 : 0;
  const before = describeMachine(machine, reportedAt);

  const insert = db.prepare(`INSERT INTO quota_snapshot (machine_id, report_id, source, window_kind,
      collected_at, reported_at, skew_sec, is_duplicate, account_id, user_id, plan_type, cli_version,
      originator, window_minutes, used_percent, resets_at, balance, has_credits, unlimited, hit_limit, source_seq,
      collector_version, collector_build, collector_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
  for (const r of rows) {
    insert.run(machine.machine_id, reportId, base.source, r.window_kind, collectedAt, reportedAt,
      collectedAt - reportedAt, isDuplicate, base.account_id, base.user_id, base.plan_type, base.cli_version,
      base.originator, r.window_minutes, r.used_percent, r.resets_at, base.balance, base.has_credits,
      base.unlimited, base.hit_limit, base.source_seq, body.collector_version ?? null, body.collector_build ?? null, body.collector_sha256?.toLowerCase() ?? null);
  }
  // 隐藏由管理员主动恢复，上报与迟到补传不能解除隐藏。

  const sessionMtime = num(body.last_session_mtime, { min: 0 });
  // Keep delayed reports in history, but never replace a newer machine observation.
  const previous = prevReportId ? Q.rowsOfReport.all(prevReportId)[0] : null;
  if (!previous || previous.collected_at > reportedAt + 300 || collectedAt >= previous.collected_at) {
    Q.touchSeen.run(reportedAt, reportedAt, remote, reportId, sessionMtime === null ? null : Math.round(sessionMtime),
      machine.machine_id);
    reporting.observe(machine.machine_id, body.reporting_status);
    // 仅离线转在线时更新本次上线时间，重复上报及延迟历史报告保留原值。
    if (before.stale !== 'green') markOnlineSince.run(reportedAt, machine.machine_id);
  }
  db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // 仅在本次上报使设备进入该账号的在线集合时计数，重复上报和历史补传不再次触发。
  if (wecomWebhook && base.account_id && (before.account_id !== base.account_id || before.stale !== 'green')
      && Q.latestReportOfMachine.get(machine.machine_id)?.last_report_id === reportId) {
    try {
      const machines = Q.machines.all()
        .filter((m) => !deviceMerge.isMerged(m.machine_id))
        .map((m) => describeMachine(m, reportedAt))
        .filter((m) => m.account_id === base.account_id && m.stale === 'green');
      if (machines.length >= 3 && machines.some((m) => m.machine_id === machine.machine_id)) {
        // 提醒沿用面板映射名，方便群成员对应账号；未映射时保留 ID 回退。
        const name = aliasMap().get(base.account_id)?.display_name || base.account_id.slice(-8);
        const deviceName = before.label;
        void sendWecomAlert(`Codex 账号 ${name} 的【${deviceName}】上线，当前有 ${machines.length} 台设备在线。`, 'devices', deviceName);
      }
    } catch {
      console.warn('企微设备提醒计算失败。');
    }
  }
  return send(res, 200, { ok: true, is_duplicate: isDuplicate === 1, report_id: reportId, server_now: reportedAt, reporting_config: reporting.forClient(machine.machine_id), migration_config: migration.describe(machine.machine_id) });
}

const STALE_GREY_SEC = 24 * 60 * 60;

/**
 * 功能：由管理员修改默认周期或单台覆盖，写操作需要原有 bootstrap 鉴权。
 * 参数：req/res 为 HTTP 对象，id 为设备编号或默认配置用的 null；请求体字段为 interval_minutes。
 * 返回值：最新配置或明确的校验错误；null 仅用于单台恢复继承。
 */
async function handleReportingConfig(req, res, id) {
  if (!security.hasAdmin() || !security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res, 403, { error: 'bad_bootstrap' });
  if (id !== null && (!Number.isSafeInteger(id) || !Q.machineById.get(id))) return send(res, 404, { error: 'unknown_machine' });
  let body;
  try { body = JSON.parse((await readBody(req, res, 4096)) || '{}'); }
  catch (error) { if (error?.code === 413) throw error; return send(res, 400, { error: 'bad_json' }); }
  // 等待正文时管理员可能已轮换口令，提交前重新校验当前授权。
  if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{error:'bad_bootstrap'});
  const minutes = body?.interval_minutes;
  if (!validInterval(minutes) && !(id !== null && minutes === null)) return send(res, 400, { error: 'bad_interval' });
  return send(res, 200, { ok: true, reporting_config: reporting.set(id, minutes) });
}

// ---------- 读取闸门 ----------
// 已接入 = 这个来源 IP 是某台机器的 last_ip，且这台机器 24 小时内还在上报（和面板"变灰"用同一把尺）。
// 不在集合里的来源只能看到一个不含任何数据的解锁页；输入 bootstrap 口令后，这个 IP 解锁 8 小时
// （只存内存，重启服务即失效）。回环 127.0.0.1/::1 永远放行：面板在本机开、tools\backup.mjs、自检都走回环。
// 上报与配对两个接口不受闸门影响，否则没接入的机器永远配不上对。
const READ_GATE = CFG.readGate !== 'lan';
const UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;
const unlockedIps = new Map();

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1';
}

function ipReadAllowed(ip) {
  const until = unlockedIps.get(ip);
  if (until !== undefined) {
    if (until > Date.now()) return true;
    unlockedIps.delete(ip);
  }
  return Q.readIps.all(nowSec() - STALE_GREY_SEC).some((r) => r.last_ip === ip);
}

function handleUnlock(raw, remote, res) {
  if (!security.hasAdmin()) return send(res, 503, { error: 'server_missing_bootstrap' });
  let key;
  try {
    key = String(JSON.parse(raw || '{}').key ?? '');
  } catch {
    return send(res, 400, { error: 'bad_json' });
  }
  if (!security.verifyAdmin(key)) return send(res, 403, { error: 'bad_key' });
  for (const [ip, until] of unlockedIps) if (until <= Date.now()) unlockedIps.delete(ip);
  unlockedIps.set(remote, Date.now() + UNLOCK_TTL_MS);
  return send(res, 200, { ok: true, ip: remote, expires_in_sec: Math.round(UNLOCK_TTL_MS / 1000) });
}

const DENY_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>这台机器还没接入 · Codex 额度监控</title>
<style>
body{font:15px/1.7 "Segoe UI",system-ui,sans-serif;background:#12161c;color:#dfe6ef;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#191f27;border:1px solid #262d38;border-radius:12px;padding:26px 30px;max-width:460px}
h1{font-size:18px;margin:0 0 10px}p{margin:0 0 14px;color:#98a4b3}
input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid #38414f;background:#12161c;color:#dfe6ef;font-size:14px}
button{margin-top:12px;padding:9px 16px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer}
.err{color:#f87171;font-size:13px;margin-top:10px;min-height:18px}
</style>
<div class="card">
  <h1>这台机器还没接入</h1>
  <p>面板只对<strong>已配对的机器</strong>开放。想让这台机器能看，先在那台机器上双击 <code>client\\client-start.bat</code> 完成配对；急用时也可以在这里输入服务器口令，本机会解锁 8 小时。</p>
  <input id="k" type="password" placeholder="服务器口令" autocomplete="off">
  <button id="b">解锁本机</button>
  <div class="err" id="e"></div>
</div>
<script>
const k = document.getElementById('k'), b = document.getElementById('b'), e = document.getElementById('e');
async function go() {
  e.textContent = '';
  const r = await fetch('/api/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k.value }) });
  if (r.ok) return location.reload();
  const j = await r.json().catch(() => ({}));
  e.textContent = j.error === 'bad_key' ? '口令不对' : (j.error || ('解锁失败 ' + r.status));
}
b.onclick = go;
k.onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
k.focus();
</script></html>`;

function denyRead(pathname, res, remote) {
  const isPage = pathname === '/' || pathname === '/index.html' || pathname.endsWith('.html');
  if (isPage) {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(DENY_HTML);
  }
  return send(res, 403, { error: 'not_paired', remote });
}

function windowLabel(minutes) {
  if (minutes === null || minutes === undefined) return '未知窗口';
  if (minutes % 1440 === 0) return `周(${minutes / 1440}天)`;
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

// 闲置机器不会再上报，实测锚点会一直停在已经过去的周期上，倒计时看着像卡死。
// 这里按窗口长度把锚点推到下一个未到周期，只为让"还剩多久"可读：原始实测值留在
// reset_anchor_at，并用 reset_estimated 标明是推算，下一次上报会把它纠正回来。
const RESET_ROLL_MAX_PERIODS = 12; // 太老的读数不值得推算，留给面板显示"重置点已过"
function rollReset(resetsAt, minutes, serverNow) {
  const at = Number.isFinite(Number(resetsAt)) ? Number(resetsAt) : null;
  const plain = { resets_at: at, reset_in_sec: at === null ? null : at - serverNow, reset_estimated: false, reset_anchor_at: at };
  if (at === null || at > serverNow) return plain;
  const period = Number(minutes) * 60;
  if (!Number.isFinite(period) || period <= 0) return plain;
  const n = Math.ceil((serverNow - at) / period);
  if (n <= 0 || n > RESET_ROLL_MAX_PERIODS) return plain;
  const rolled = at + n * period;
  return { resets_at: rolled, reset_in_sec: rolled - serverNow, reset_estimated: true, reset_anchor_at: at };
}

/**
 * 功能描述：将机器最新有效上报转换为面板状态，并按设备确认的实际周期加采集宽限标记在线状态。
 * 参数：machine 为机器数据库记录；serverNow 为服务端当前 Unix 秒数。
 * 返回值：包含最新账号、额度快照、最近上报时间、在线状态及对应报告的采集器版本、构建编号和SHA-256（未知为null）的机器对象。
 */
function describeMachine(machine, serverNow) {
  const reportingConfig = reporting.describe(machine.machine_id);
  const onlineWindowSec = onlineWindowSeconds(reportingConfig.applied_interval_minutes);
  let reportId = machine.last_report_id;
  let rows = reportId ? Q.rowsOfReport.all(reportId) : [];
  if (rows[0]?.collected_at > serverNow + 300) {
    reportId = Q.latestUsableReport.get(machine.machine_id, serverNow + 300)?.report_id ?? null;
    rows = reportId ? Q.rowsOfReport.all(reportId) : [];
  }
  const head = rows[0] ?? null;
  const lastOk = machine.last_ok_at;
  const ageSec = lastOk === null || lastOk === undefined ? null : serverNow - lastOk;
  const windows = rows.map((r) => ({
    kind: r.window_kind,
    minutes: r.window_minutes,
    label: windowLabel(r.window_minutes),
    used_percent: r.used_percent,
    ...rollReset(r.resets_at, r.window_minutes, serverNow),
  })).sort((a, b) => (a.kind === 'primary' ? -1 : 1) - (b.kind === 'primary' ? -1 : 1) || (b.minutes ?? 0) - (a.minutes ?? 0));

  return {
    machine_id: machine.machine_id,
    client_id: machine.client_id,
    label: machine.label || machine.hostname || `机器#${machine.machine_id}`,
    hostname: machine.hostname,
    // 这是服务端 TCP 连接看到的最近来源地址；VPN 或反向代理场景下不等于设备物理公网地址。
    last_ip: machine.last_ip ?? null,
    has_report: Boolean(head),
    account_id: head ? head.account_id : null,
    account_known: Boolean(head && head.account_id),
    plan_type: head ? head.plan_type : null,
    cli_version: head ? head.cli_version : null,
    collector_version: head?.collector_version ?? null,
    collector_build: head?.collector_build ?? null,
    collector_sha256: head?.collector_sha256 ?? null,
    originator: head ? head.originator : null,
    source: head ? head.source : null,
    collected_at: head ? head.collected_at : null,
    last_ok_at: lastOk ?? null,
    online_since: machine.online_since ?? null,
    age_sec: ageSec,
    stale: isReportOnline(lastOk,serverNow,reportingConfig.applied_interval_minutes) ? 'green' : 'grey',
    online_window_sec: onlineWindowSec,
    reporting_interval_sec: reportingConfig.applied_interval_minutes * 60,
    online_grace_sec: REPORT_GRACE_SECONDS,
    reporting: reportingConfig,
    skew_sec: head ? head.skew_sec : null,
    hit_limit: head ? head.hit_limit : null,
    balance: head ? head.balance : null,
    has_credits: head ? head.has_credits : null,
    unlimited: head ? head.unlimited : null,
    last_session_mtime: machine.last_session_mtime ?? null,
    report_id: reportId,
    windows,
  };
}

/**
 * 功能描述：按账号 ID 汇总机器额度，并统计该账号当前在线设备数。
 * 参数：machines 为已解析的机器状态数组；serverNow 为服务端当前 Unix 秒数。
 * 返回值：按账号分组的额度与设备状态数组。
 */
function buildGroups(machines, serverNow) {
  const buckets = new Map();
  for (const m of machines) {
    const key = m.account_known ? `acct:${m.account_id}` : `unknown:${m.machine_id}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }

  const groups = [];
  for (const [key, members] of buckets) {
    const withData = members.filter((m) => m.has_report);
    const onlineMembers = members.filter((m) => m.stale === 'green');
    // 组额度取组内最新鲜的一次读数：额度是账号级全局值，各机器只是不同时点的快照。
    const freshest = withData.slice().sort((a, b) => (b.collected_at ?? 0) - (a.collected_at ?? 0))[0] ?? null;
    const freshPeers = withData.filter((m) => Math.abs((m.collected_at ?? 0) - (freshest?.collected_at ?? 0)) <= 1800);
    const pcts = freshPeers.map((m) => m.windows[0]?.used_percent).filter((v) => typeof v === 'number');
    const spread = pcts.length > 1 ? Math.max(...pcts) - Math.min(...pcts) : 0;
    const resets = new Set(freshPeers.map((m) => m.windows[0]?.resets_at ?? null));

    groups.push({
      key,
      account_id: freshest ? freshest.account_id : null,
      account_known: Boolean(freshest && freshest.account_known),
      plan_type: freshest ? freshest.plan_type : null,
      in_use: onlineMembers.length > 0,
      active_machine_count: onlineMembers.length,
      shared: members.length > 1,
      machine_ids: members.map((m) => m.machine_id),
      machines: members.map((m) => ({ machine_id: m.machine_id, label: m.label, stale: m.stale, age_sec: m.age_sec })),
      windows: freshest ? freshest.windows : [],
      collected_at: freshest ? freshest.collected_at : null,
      last_ok_at: freshest ? freshest.last_ok_at : null,
      stale: freshest ? freshest.stale : 'grey',
      hit_limit: freshest ? freshest.hit_limit : null,
      balance: freshest ? freshest.balance : null,
      has_credits: freshest ? freshest.has_credits : null,
      unlimited: freshest ? freshest.unlimited : null,
      // 同账号且读数都新鲜却差得多：通常是时钟异常或根本不是同一账号。
      divergence: freshPeers.length > 1 && spread > 5,
      reset_mismatch: freshPeers.length > 1 && resets.size > 1,
    });
  }
  return groups.sort((a, b) => (a.account_id ?? 'zzz').localeCompare(b.account_id ?? 'zzz'));
}

/**
 * 功能：以账号历史为主生成完整卡片，设备切号不再使离线账号消失。
 * 参数：machines 为最新设备状态；serverNow 为服务端秒时间。
 * 返回值：可见账号卡片，额度取账号最新有效完整报告，关联当前及历史设备。
 */
function buildAccountGroups(machines, serverNow) {
  const relations=accountRecords.members();
  const warnings=new Map(buildGroups(machines.filter(m=>!m.account_hidden),serverNow).map(a=>[a.account_id,a]));
  return accountRecords.heads().map(({account_id,rows})=>{
    const head=rows[0]??null;
    const ids=new Set(relations.filter(r=>r.account_id===account_id).map(r=>r.machine_id));
    const members=machines.filter(m=>ids.has(m.machine_id)).map(m=>({machine_id:m.machine_id,label:m.label,
      stale:m.account_id===account_id&&m.stale==='green'?'green':'grey',age_sec:m.age_sec}));
    const count=members.filter(m=>m.stale==='green').length;
    return {key:`acct:${account_id}`,account_id,account_known:true,plan_type:head?.plan_type??null,source:head?.source??null,
      in_use:count>0,active_machine_count:count,shared:members.length>1,machine_ids:[...ids],machines:members,
      windows:rows.map(row=>({kind:row.window_kind,minutes:row.window_minutes,label:windowLabel(row.window_minutes),used_percent:row.used_percent,
        ...rollReset(row.resets_at,row.window_minutes,serverNow)})),collected_at:head?.collected_at??null,last_ok_at:head?.reported_at??null,
      stale:count?'green':'grey',hit_limit:head?.hit_limit??null,balance:head?.balance??null,has_credits:head?.has_credits??null,unlimited:head?.unlimited??null,
      divergence:warnings.get(account_id)?.divergence??false,reset_mismatch:warnings.get(account_id)?.reset_mismatch??false};
  });
}

function aliasMap() {
  const m = new Map();
  for (const a of Q.aliases.all()) m.set(a.account_id, a);
  return m;
}

/** 功能：按完整 ID 或唯一别名查询可见账号的在线设备；参数：query 为账号标识，mode 为工具名，filters 为状态及在线、离线精确数量筛选；返回值：查询状态、设备显示名及 Unix 秒时间。 */
function lookupAccountDevices(query, mode = 'get_codex_account_status', filters = {}) {
  const serverNow = nowSec();
  const statusMap = new Map(Q.accountStatuses.all().map((row) => [row.account_id, row.status]));
  const hidden = new Set(Q.hiddenAccounts.all().map((row) => row.account_id));
  const aliases = aliasMap();
  const ids = new Set([...Q.acctIds.all().map((row) => row.account_id), ...aliases.keys()]);
  // 完整 ID 优先，重名不猜测；隐藏账号和不存在的账号返回相同状态。
  const matches = ids.has(query) ? [query] : [...ids].filter((id) => aliases.get(id)?.display_name === query);
  const visible = matches.filter((id) => !hidden.has(id));
  if (mode !== 'get_codex_account_status') {
    const accountHeads = new Map(accountRecords.heads().map(({account_id,rows}) => [account_id, rows]));
    const usableAccounts = new Set(accountRecords.heads().filter(({rows}) => hasUsableQuota(rows)).map(({account_id}) => account_id));
    const rows = Q.acctIds.all().filter(row => !hidden.has(row.account_id)).map(row => {
      const latest = Q.acctLatest.get(row.account_id) ?? null;
      const machines = Q.machines.all().filter(machine => !deviceMerge.isMerged(machine.machine_id)).map(machine => describeMachine(machine, serverNow)).filter(machine => machine.account_id === row.account_id);
      return {account_id:row.account_id, windows:(accountHeads.get(row.account_id)??[]).map(window=>({used_percent:window.used_percent,remaining_percent:typeof window.used_percent === 'number' ? Math.max(0,100-window.used_percent) : null})), balance:latest?.balance??null, used_percent:accountHeads.get(row.account_id)?.[0]?.used_percent??null, resets_at:latest ? rollReset(latest.resets_at,latest.window_minutes,serverNow).resets_at : null, online_count:machines.filter(machine=>machine.stale==='green').length, offline_count:machines.filter(machine=>machine.stale!=='green').length, status:statusMap.get(row.account_id)??'unknown', display_name:aliases.get(row.account_id)?.display_name??null};
    }).filter(row => (mode === 'list_unoccupied_codex_accounts' || usableAccounts.has(row.account_id)) && (filters.status === undefined || row.status === filters.status) && (filters.online_count === undefined || row.online_count === filters.online_count) && (filters.offline_count === undefined || row.offline_count === filters.offline_count));
    const statusRank = {normal: 0, unknown: 1, restricted: 2};
    rows.sort((a,b)=>(statusRank[a.status]??1)-(statusRank[b.status]??1)||a.online_count-b.online_count||String(a.display_name??a.account_id).localeCompare(String(b.display_name??b.account_id)));
    const selected = mode==='list_unoccupied_codex_accounts' ? rows.filter(row=>row.online_count===0) : mode==='recommend_codex_login_account' ? rows.slice(0,10) : rows;
    return {status:'ok',accounts:selected,checked_at:serverNow};
  }
  if (visible.length !== 1) return { status: visible.length ? 'ambiguous_use_account_id' : 'not_found' };
  const accountId = visible[0];
  const devices = Q.machines.all()
    .filter((machine) => !deviceMerge.isMerged(machine.machine_id))
    .map((machine) => describeMachine(machine, serverNow))
    .filter((machine) => machine.account_id === accountId && machine.stale === 'green')
    .map((machine) => machine.label);
  const latest = Q.acctLatest.get(accountId) ?? null;
  const details = Q.machines.all().filter((machine) => !deviceMerge.isMerged(machine.machine_id)).map((machine) => describeMachine(machine, serverNow)).filter((machine) => machine.account_id === accountId).map((machine) => ({name:machine.label,hostname:machine.hostname,online:machine.stale==='green',last_ok_at:machine.last_ok_at}));
  return { status:'ok', account_id:accountId, account_status:statusMap.get(accountId)??'unknown', balance:latest?.balance??null, used_percent:latest?.used_percent??null, window_minutes:latest?.window_minutes??null, resets_at:latest ? rollReset(latest.resets_at,latest.window_minutes,serverNow).resets_at : null, reset_in_sec:latest ? rollReset(latest.resets_at,latest.window_minutes,serverNow).reset_in_sec : null, online_device_count:details.filter(device=>device.online).length, device_count:details.length, devices:details, checked_at:serverNow };
}

/** 功能：管理员读取或更新账号状态；参数：req、res及路径中的账号ID；返回值：状态对象或受控错误响应。 */
async function handleAccountStatus(req, res, pathname) {
  if (!security.hasAdmin() || !security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res, 403, { error: 'bad_bootstrap' });
  const accountId = decodeURIComponent(pathname.split('/')[3] ?? '');
  if (!ACCOUNT_ID_RE.test(accountId)) return send(res, 400, { error: 'bad_account_id' });
  if (!Q.accountExists.get(accountId) && !aliasMap().has(accountId)) return send(res, 404, { error: 'unknown_account' });
  if (req.method === 'GET') return send(res, 200, { account_id: accountId, status: Q.accountStatuses.all().find((row) => row.account_id === accountId)?.status ?? 'unknown' });
  const body = JSON.parse((await readBody(req, res, 4096)) || '{}');
  if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res, 403, { error: 'bad_bootstrap' });
  if (!['normal', 'restricted', 'unknown'].includes(body.status)) return send(res, 400, { error: 'bad_account_status' });
  Q.setAccountStatus.run(accountId, body.status, nowSec());
  return send(res, 200, { ok: true, account_id: accountId, status: body.status });
}

// 映射名只用于显示；没有映射时前端回落到截断 UUID。
function withDisplayName(list, aliases) {
  for (const item of list) {
    const a = item.account_id ? aliases.get(item.account_id) : null;
    item.display_name = a ? a.display_name : null;
    item.owner = a ? a.owner : null;
  }
  return list;
}

/**
 * 功能描述：生成面板主状态，并返回默认周期与每台设备的实际在线窗口。
 * 参数：req 为 HTTP 请求；res 为 HTTP 响应。
 * 返回值：写入账号分组、机器状态、映射及刷新时效的 HTTP JSON 响应，账号关联设备的 last_reported_at 为该账号最后上报秒时间。
 */
function handleState(req, res) {
  const serverNow = nowSec();
  const aliases = aliasMap();
  const hidden = new Set(Q.hiddenAccounts.all().map((r) => r.account_id));
  const machines = withDisplayName(Q.machines.all().filter(m=>!deviceMerge.isMerged(m.machine_id)).map((m) => describeMachine(m, serverNow)), aliases)
    .map((m) => hidden.has(m.account_id) ? {
      ...m, account_hidden: true, account_id: null, account_known: false, plan_type: null,
      balance: null, has_credits: null, unlimited: null, hit_limit: null, windows: [],
    } : m);
  const accounts = withAccountDeviceReportTimes(db, withDisplayName(buildAccountGroups(machines, serverNow), aliases));
  return send(res, 200, {
    server_now: serverNow,
    stale_green_sec: onlineWindowSeconds(reporting.policy().default_interval_minutes),
    reporting_config: reporting.policy(),
    stale_grey_sec: STALE_GREY_SEC,
    accounts,
    machines,
    aliases: [...aliases.values()].filter((a) => !hidden.has(a.account_id)),
  });
}

/**
 * 功能描述：返回历史账号映射，并依据最近成功上报计算在线设备数。
 * 参数：req 为 HTTP 请求；res 为 HTTP 响应；includeHidden 控制是否包含隐藏账号。
 * 返回值：写入账号映射与历史额度列表的 HTTP JSON 响应。
 */
function handleAccounts(req, res, includeHidden = false) {
  const serverNow = nowSec();
  const statusMap = new Map(Q.accountStatuses.all().map((row) => [row.account_id, row.status]));
  const aliases = aliasMap();
  const hidden = new Set(Q.hiddenAccounts.all().map((r) => r.account_id));
  const activeMachineCounts = new Map();
  for (const machine of Q.machines.all().filter(m=>!deviceMerge.isMerged(m.machine_id)).map((m) => describeMachine(m, serverNow))) {
    if (!machine.account_id || machine.stale !== 'green') continue;
    activeMachineCounts.set(machine.account_id, (activeMachineCounts.get(machine.account_id) ?? 0) + 1);
  }

  const out = Q.acctIds.all().map((r) => {
    const latest = Q.acctLatest.get(r.account_id) ?? null;
    const a = aliases.get(r.account_id);
    return {
      account_id: r.account_id,
      account_status: statusMap.get(r.account_id) ?? 'unknown',
      hidden: hidden.has(r.account_id),
      display_name: a ? a.display_name : null,
      owner: a ? a.owner : null,
      note: a ? a.note : null,
      plan_type: latest ? latest.plan_type : null,
      window_minutes: latest ? latest.window_minutes : null,
      window_label: latest ? windowLabel(latest.window_minutes) : null,
      used_percent: latest ? latest.used_percent : null,
      ...rollReset(latest ? latest.resets_at : null, latest ? latest.window_minutes : null, serverNow),
      balance: latest ? latest.balance : null,
      has_credits: latest ? latest.has_credits : null,
      unlimited: latest ? latest.unlimited : null,
      collected_at: latest ? latest.collected_at : null,
      cli_version: latest ? latest.cli_version : null,
      originator: latest ? latest.originator : null,
      machine_count: r.machine_count,
      active_machine_count: activeMachineCounts.get(r.account_id) ?? 0,
      snap_rows: r.snap_rows,
      first_seen: r.first_seen,
      last_reported_at: r.last_reported_at,
      in_use: (activeMachineCounts.get(r.account_id) ?? 0) > 0,
    };
  });

  // 手工建了映射但服务器还没收到过该账号的读数：也要出现在表里，否则像没生效。
  for (const [id, a] of aliases) {
    if (out.some((x) => x.account_id === id)) continue;
    out.push({
      account_id: id, display_name: a.display_name, owner: a.owner, note: a.note,
      account_status: statusMap.get(id) ?? 'unknown',
      hidden: hidden.has(id),
      plan_type: null, window_minutes: null, window_label: null, used_percent: null,
      resets_at: null, balance: null, has_credits: null, unlimited: null, collected_at: null,
      cli_version: null, originator: null, machine_count: 0, snap_rows: 0,
      active_machine_count: 0, first_seen: null, last_reported_at: null, in_use: false,
    });
  }

  out.sort((x, y) =>
    (x.in_use === y.in_use ? 0 : x.in_use ? -1 : 1) ||
    (y.last_reported_at ?? 0) - (x.last_reported_at ?? 0));
  return send(res, 200, { server_now: serverNow, accounts: includeHidden ? out : out.filter((a) => !a.hidden) });
}

/** 功能：从迁移设置中排除已停用的源设备；参数：迁移策略结果；返回值：有效设备列表。 */
function visibleMigration(value){return {...value,machines:value.machines.filter(m=>!deviceMerge.isMerged(m.machine_id))};}

/** 功能：管理员预览并确认合并离线旧设备；参数：请求含target_id、merge_token、confirmation；返回值：影响范围或实际迁移数，不返回令牌。 */
async function handleDeviceMerge(req,res,pathname){
 if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
 try{
  const body=JSON.parse((await readBody(req,res,4096))||'{}'),sourceId=Number(pathname.split('/')[3]);
  // 预览和执行均不能沿用等待正文前的过期授权。
  if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
  if(!body||typeof body!=='object'||Array.isArray(body))return send(res,400,{error:'bad_merge_devices'});
  if(pathname.endsWith('/merge-preview'))return send(res,200,{ok:true,...deviceMerge.preview(sourceId,body.target_id)});
  return send(res,200,{ok:true,...deviceMerge.execute(sourceId,body.target_id,body.merge_token,body.confirmation)});
 }catch(error){if(error instanceof SyntaxError)return send(res,400,{error:'bad_json'});if(error.publicCode)return send(res,error.status,{error:error.publicCode});throw error;}
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9._:-]{6,128}$/;

/** 功能：管理员预览和显式删除账号记录；参数：请求含delete_token和重复输入账号ID，pathname含账号ID；返回值：删除范围或结果，设备及令牌不变。 */
async function handleAccountDelete(req,res,pathname){
  if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
  const accountId=decodeURIComponent(pathname.split('/')[3]??'');
  if(!ACCOUNT_ID_RE.test(accountId))return send(res,400,{error:'bad_account_id'});
  try{
    if(pathname.endsWith('/delete-preview'))return send(res,200,{ok:true,...accountRecords.preview(accountId)});
    const body=JSON.parse((await readBody(req,res,4096))||'{}');
    // 删除前再次校验口令，避免等待正文期间轮换后仍消费预览并删除。
    if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
    if(!body || typeof body!=='object' || Array.isArray(body))return send(res,400,{error:'bad_account_confirmation'});
    return send(res,200,{ok:true,...accountRecords.remove(accountId,body.delete_token,body.confirmation)});
  }catch(error){
    if(error instanceof SyntaxError)return send(res,400,{error:'bad_json'});
    if(error.publicCode)return send(res,error.status,{error:error.publicCode});
    throw error;
  }
}


/** 功能：管理账号显示映射，正文读取后重新鉴权；参数：请求、响应、路径和方法；返回值：保存或删除结果及受控错误。 */
async function handleAlias(req, res, pathname, method) {
  if (!security.hasAdmin() || !security.verifyAdmin(req.headers['x-quota-bootstrap'])) {
    return send(res, 403, { error: 'bad_bootstrap' });
  }
  const accountId = decodeURIComponent(pathname.split('/')[3] ?? '');
  if (!ACCOUNT_ID_RE.test(accountId)) return send(res, 400, { error: 'bad_account_id' });

  if (method === 'DELETE') {
    const removed = Q.aliasDel.run(accountId);
    return removed.changes ? send(res, 200, { ok: true }) : send(res, 404, { error: 'unknown_alias' });
  }

  const body = JSON.parse((await readBody(req, res, 4096)) || '{}');
  // 读取异步正文会让出执行权，不能继续信任读取前的管理口令。
  if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{error:'bad_bootstrap'});
  const displayName = String(body.display_name ?? '').trim().slice(0, 120);
  if (!displayName) return send(res, 400, { error: 'bad_display_name' });
  const owner = body.owner ? String(body.owner).trim().slice(0, 60) : null;
  const note = body.note ? String(body.note).trim().slice(0, 200) : null;
  Q.aliasUp.run(accountId, displayName, owner, note, nowSec());
  return send(res, 200, { ok: true, account_id: accountId, display_name: displayName, owner, note });
}

async function handleAccountHidden(req, res, pathname, method) {
  if (!security.hasAdmin() || !security.verifyAdmin(req.headers['x-quota-bootstrap'])) {
    return send(res, 403, { error: 'bad_bootstrap' });
  }
  const accountId = decodeURIComponent(pathname.split('/')[3] ?? '');
  if (!ACCOUNT_ID_RE.test(accountId)) return send(res, 400, { error: 'bad_account_id' });
  if (!Q.accountExists.get(accountId) && !aliasMap().has(accountId)) return send(res, 404, { error: 'unknown_account' });
  if (method === 'POST') Q.hideAccount.run(accountId, nowSec());
  else Q.unhideAccount.run(accountId);
  return send(res, 200, { ok: true, account_id: accountId, hidden: method === 'POST' });
}

/** 功能：处理管理员OTA列表、可信发布和定向任务；参数：HTTP对象及路径，发布含原始清单和签名，任务含设备ID数组和序号；返回值：安全元数据或逐设备结果。 */
async function handleOta(req,res,pathname) {
  if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
  if(pathname==='/api/ota/list')return send(res,200,{ok:true,...ota.list()});
  const body=JSON.parse((await readBody(req,res,16384))||'{}');
  // 异步等待后再次核验当前口令，防止轮换期间旧请求继续创建任务。
  if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
  if(pathname==='/api/ota/releases'){
    if(!otaPublicKey||!otaArtifacts||!CFG.otaKeyId)return send(res,409,{error:'ota_trust_not_configured'});
    try{const manifest=verifyManifest(body,otaPublicKey,nowSec(),CFG.otaKeyId);const artifact=verifyOtaArtifact(manifest);fs.closeSync(artifact.fd);return send(res,200,{ok:true,release:ota.publish(body,otaPublicKey,CFG.otaKeyId)});}
    catch{return send(res,400,{error:'bad_ota_release'});}
  }
  if(!Array.isArray(body.machine_ids)||body.machine_ids.length<1||body.machine_ids.length>100||new Set(body.machine_ids).size!==body.machine_ids.length||body.machine_ids.some(id=>!Number.isSafeInteger(id)||id<1)||!Number.isSafeInteger(body.release_seq)||body.release_seq<1)return send(res,400,{error:'bad_ota_request'});
  // 每台设备独立给出确定结果；客户端重试同版本只领取原任务，不造成重复替换。
  const results=body.machine_ids.map(id=>{const machine=Q.machineById.get(id);if(!machine||deviceMerge.isMerged(id))return {machine_id:id,error:'unknown_machine'};try{return {machine_id:id,job:ota.create(id,machine.client_id,body.release_seq)};}catch{return {machine_id:id,error:'ota_not_eligible'};}});
  return send(res,200,{ok:true,results});
}
/** 功能：核验固定目录中签名清单绑定的程序；参数：已验签清单；返回值：持有只读句柄的程序，调用方负责关闭。 */
function verifyOtaArtifact(manifest){
  if(!otaArtifacts)throw Error('ota_artifacts_missing');
  const target=path.join(otaArtifacts,manifest.sha256+'.exe');
  if(fs.realpathSync(otaArtifacts)!==path.resolve(otaArtifacts)||fs.realpathSync(target)!==target||fs.lstatSync(target).isSymbolicLink())throw Error('ota_artifact_link');
  const fd=fs.openSync(target,'r');
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==manifest.size||stat.size>20*1024*1024)throw Error('bad_artifact_size');const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
    // 固定上界、同一句柄流式核验，避免路径复开与超大内存分配。
    while(position<stat.size){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-position),position);if(!count)throw Error('artifact_truncated');hash.update(buffer.subarray(0,count));position+=count;}
    if(hash.digest('hex')!==manifest.sha256)throw Error('bad_artifact_hash');return {fd,size:stat.size};
  }catch(error){fs.closeSync(fd);throw error;}
}
/** 功能：以设备令牌授权并流式下载本设备任务程序；参数：HTTP对象与任务路径；返回值：有界二进制响应或安全错误。 */
function handleOtaDownload(req,res,pathname){
  const machine=Q.machineByToken.get(String(req.headers['x-quota-token']??''));if(!machine||deviceMerge.isMerged(machine.machine_id))return send(res,401,{error:'bad_token'});
  let artifact;
  try{const job=ota.download(machine.machine_id,machine.client_id,pathname.split('/').pop());if(!job)return send(res,404,{error:'unknown_ota_job'});artifact=verifyOtaArtifact(JSON.parse(job.manifest));}
  catch{return send(res,404,{error:'ota_artifact_unavailable'});}
  res.writeHead(200,{'content-type':'application/octet-stream','content-length':artifact.size,'cache-control':'no-store','x-content-type-options':'nosniff'});
  const stream=fs.createReadStream('',{fd:artifact.fd,autoClose:true,start:0,end:artifact.size-1,highWaterMark:65536});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
function send(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// 缺少选择文件时使用唯一 Vue 源码的构建目录；选择值仍限定单段目录名，保护现有部署。
const panelSelector = path.join(HERE, 'web-current.json');
const panelVersion = fs.existsSync(panelSelector) ? JSON.parse(fs.readFileSync(panelSelector,'utf8')).version : null;
if (panelVersion !== null && (typeof panelVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(panelVersion) || panelVersion.includes('..'))) throw new Error('invalid_panel_version');
const PUBLIC_DIR = panelVersion ? path.join(HERE,'web-releases',panelVersion) : path.resolve(HERE,'../web/dist');
if (!fs.existsSync(path.join(PUBLIC_DIR,'index.html'))) throw new Error('panel_index_missing');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 功能：只提供所选面板版本内的静态文件；参数：pathname为URL路径，res为响应；返回值：静态响应或受控错误。 */
function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: 'bad_path' });
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  // 只允许所选 Vue 构建目录内的静态扩展名，防止路径穿越和意外暴露。
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden_path' });
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return send(res, 404, { error: 'not_found' });
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return send(res, 404, { error: 'not_found' });
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': panelVersion && /^\/assets\/[^/]+-[A-Za-z0-9_-]+\.(js|css)$/.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache' });
  res.end(buf);
}

function readBody(req, res, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!over) {
          over = true;
          // 不能 destroy 请求 socket，否则 413 响应发不出去；改为排空剩余数据并立即回错。
          send(res, 413, { error: 'body_too_large', limit_bytes: limit });
          req.resume();
          reject(Object.assign(new Error('too_large'), { code: 413 }));
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

/** 功能：分派 HTTP 请求并在异步读取后重新校验管理写入权限；参数：req 请求与 res 响应；返回值：异步完成或对应响应。 */
const server = http.createServer(async (req, res) => {
  const remote=requestSource(req,CFG.trustLoopbackProxy);
  // 本机代理校验通过后使用真实来源做读取授权；非代理部署保留原网络范围限制。
  if (remote===null||(!CFG.trustLoopbackProxy&&!ipAllowed(remote))) return send(res,403,{error:'ip_not_allowed'});

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // 解锁通道要在闸门之前放行，否则被挡住的来源永远进不来（口令校验在 handleUnlock 里）。
  if (req.method === 'POST' && pathname === '/api/unlock') {
    try {
      return handleUnlock(await readBody(req, res, 4096), remote, res);
    } catch (err) {
      if (err?.code === 413) return send(res, 413, { error: 'body_too_large' });
      return send(res, 500, { error: 'server_error', detail: String(err?.message ?? err) });
    }
  }

  try {
    if(pathname.startsWith('/api/browser-bindings/'))return await handleBrowserBindings(req,res,pathname,{bindings:browserBindings,security,devices:browserDevices,readBody,send,secure:Boolean(req.socket.encrypted||(CFG.trustLoopbackProxy&&req.headers['x-forwarded-proto']==='https'))});
    if (pathname === '/api/mcp') return await handleAccountMcp(req, res, accountMcpToken, lookupAccountDevices, readBody, send);
    // 读取闸门：配对/上报这两个写入接口不受限，否则新机器永远接不上。
    const isClientWrite = req.method === 'POST' && ['/api/pair', '/api/report', '/api/client/reporting-ack', '/api/client/migration-proof', '/api/client/migration-validate', '/api/client/migration-ack', '/api/client/ota/poll', '/api/client/ota/ack'].includes(pathname);
    if (req.method === 'GET' && /^\/api\/client\/ota\/download\/[a-f0-9-]{36}$/.test(pathname)) return handleOtaDownload(req,res,pathname);
    if (READ_GATE && !isClientWrite && !(panelVersion && req.method === 'GET' && !pathname.startsWith('/api/')) && !isLoopback(remote) && !ipReadAllowed(remote) && !browserBindings.status(browserToken(req.headers.cookie)).online) {
      return denyRead(pathname, res, remote);
    }
    if (req.method === 'POST' && (pathname === '/api/wecom/status' || pathname === '/api/wecom/save')) {
      return await handleWecomSettings(req, res, pathname === '/api/wecom/save');
    }
    if (req.method === 'POST' && pathname === '/api/wecom/test') return await handleWecomTest(req, res);
    if (req.method === 'POST' && (pathname === '/api/admin/bootstrap' || pathname === '/api/pairing-codes' || pathname === '/api/pairing-codes/list' || /^\/api\/pairing-codes\/\d+\/revoke$/.test(pathname))) {
      return await handleSecurity(req,res,pathname);
    }
    if (req.method === 'POST' && ['/api/ota/list','/api/ota/jobs','/api/ota/releases'].includes(pathname)) return await handleOta(req,res,pathname);
    if (req.method === 'POST' && ['/api/history-cleanup/policy','/api/history-cleanup/save','/api/history-cleanup/preview','/api/history-cleanup/execute'].includes(pathname)) {
      return await handleHistoryCleanup(req,res,pathname);
    }
    if(req.method==='POST' && /^\/api\/machine\/\d+\/(merge-preview|merge)$/.test(pathname))return await handleDeviceMerge(req,res,pathname);
    if(req.method==='POST' && /^\/api\/machine\/\d+\//.test(pathname) && deviceMerge.isMerged(Number(pathname.split('/')[3])))return send(res,409,{error:'device_already_merged'});
    if (req.method === 'POST' && ['/api/server-migration/list','/api/server-migration'].includes(pathname)) {
      if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{error:'bad_bootstrap'});
      if (pathname.endsWith('/list')) return send(res,200,{ok:true,...visibleMigration(migration.list())});
      const body=JSON.parse((await readBody(req,res,4096)) || '{}');
      // 地址迁移不能沿用口令轮换前已进入等待的请求授权。
      if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{error:'bad_bootstrap'});
      if (body.machine_id !== null && (!Number.isSafeInteger(body.machine_id) || body.machine_id < 1)) return send(res,400,{error:'bad_machine'});
      if(body.machine_id!==null&&deviceMerge.isMerged(body.machine_id))return send(res,409,{error:'device_already_merged'});
      try { return send(res,200,{ok:true,...visibleMigration(migration.set(body.machine_id,body.server_url))}); }
      catch(e) {if (['bad_server_url','unknown_machine'].includes(e.message)) return send(res,400,{error:e.message});throw e;}
    }
    if (req.method === 'GET' && pathname === '/api/state') return handleState(req, res);
    if (req.method === 'GET' && pathname === '/api/accounts') return handleAccounts(req, res, url.searchParams.get('include_hidden') === '1');
    if ((req.method === 'GET' || req.method === 'POST') && /^\/api\/account-status\/[^/]+$/.test(pathname)) return await handleAccountStatus(req, res, pathname);
    if (req.method === 'POST' && pathname === '/api/reporting-config') return await handleReportingConfig(req, res, null);
    if (req.method === 'POST' && /^\/api\/machine\/\d+\/reporting-config$/.test(pathname)) {
      return await handleReportingConfig(req, res, Number(pathname.split('/')[3]));
    }

    if(req.method==='POST' && /^\/api\/account\/[^/]+\/(delete-preview|delete)$/.test(pathname))return await handleAccountDelete(req,res,pathname);

    if ((req.method === 'POST' || req.method === 'DELETE')
        && pathname.startsWith('/api/account/') && pathname.endsWith('/alias')) {
      return await handleAlias(req, res, pathname, req.method);
    }

    if ((req.method === 'POST' || req.method === 'DELETE')
        && pathname.startsWith('/api/account/') && pathname.endsWith('/hidden')) {
      return await handleAccountHidden(req, res, pathname, req.method);
    }

    if (req.method === 'POST' && pathname.startsWith('/api/machine/') && pathname.endsWith('/label')) {
      const id = Number(pathname.split('/')[3]);
      if (!security.hasAdmin() || !security.verifyAdmin(req.headers['x-quota-bootstrap'])) {
        return send(res, 403, { error: 'bad_bootstrap' });
      }
      const body = JSON.parse((await readBody(req, res, 4096)) || '{}');
      // 设备名称写入前重新鉴权，阻止旧口令的慢请求继续执行。
      if (!security.verifyAdmin(req.headers['x-quota-bootstrap'])) return send(res,403,{error:'bad_bootstrap'});
      const label = String(body.label ?? '').trim().slice(0, 120);
      if (!label) return send(res, 400, { error: 'bad_label' });
      if (!Q.machineById.get(id)) return send(res, 404, { error: 'unknown_machine' });
      Q.setLabel.run(label, id);
      return send(res, 200, { ok: true, machine_id: id, label });
    }

    if (isClientWrite) {
      const raw = await readBody(req, res, 16 * 1024);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { error: 'bad_json' });
      }
      if (pathname === '/api/pair') return handlePair(req, res, body, remote);

      // 随机挑战不携带设备令牌；目标必须证明持有同一设备凭据后，客户端才会发送认证请求。
      if (pathname === '/api/client/migration-proof') {
        if (typeof body.client_id !== 'string' || body.client_id.length > 200 || typeof body.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(body.nonce)) return send(res,400,{error:'bad_challenge'});
        const known=Q.machineByClient.get(body.client_id);
        if (!known || deviceMerge.isMerged(known.machine_id)) return send(res,404,{error:'unknown_machine'});
        return send(res,200,{ok:true,client_id:known.client_id,proof:migrationProof(known.token,known.client_id,body.nonce)});
      }
      const machine = Q.machineByToken.get(String(req.headers['x-quota-token'] ?? ''));
      if (!machine || deviceMerge.isMerged(machine.machine_id)) return send(res, 401, { error: 'bad_token' });
      if (pathname === '/api/client/ota/poll') {
        try { ota.capability(machine.machine_id,machine.client_id,body.capability);return send(res,200,{ok:true,job:ota.claim(machine.machine_id,machine.client_id)}); }
        catch {return send(res,400,{error:'bad_ota_capability'});}
      }
      if (pathname === '/api/client/ota/ack') {
        try {ota.ack(machine.machine_id,machine.client_id,body.job_id,body.state,body.error??null);return send(res,200,{ok:true});}
        catch {return send(res,409,{error:'bad_ota_ack'});}
      }
      if (pathname === '/api/client/migration-validate') {
        if (body.client_id !== machine.client_id) return send(res,409,{error:'identity_mismatch'});
        return send(res,200,{ok:true,client_id:machine.client_id});
      }
      if (pathname === '/api/client/migration-ack') {
        const error=migration.acknowledge(machine.machine_id,body);
        return send(res,error || 200,{ok:!error,...(error?{error:'stale_migration'}:{})});
      }
      if (pathname === '/api/client/reporting-ack') {
        const error = reporting.acknowledge(machine.machine_id, body);
        return send(res, error || 200, { ok: !error, ...(error ? { error: error === 409 ? 'stale_config' : 'bad_reporting_ack' } : {}), reporting_config: reporting.forClient(machine.machine_id), migration_config: migration.describe(machine.machine_id) });
      }
      Q.touchAttempt.run(nowSec(), remote, machine.machine_id);
      return handleReport(req, res, body, machine, remote);
    }

    if (req.method === 'GET') return serveStatic(pathname, res);
    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err?.code === 413) return send(res, 413, { error: 'body_too_large' });
    return send(res, 500, { error: 'server_error', detail: String(err?.message ?? err) });
  }
});

/**
 * 功能：管理历史保留策略、只读预览与一次性确认删除，所有操作要求管理员授权。
 * 参数：req/res 为 HTTP 对象；pathname 区分 policy、save、preview、execute；请求含天数/版本或预览凭证/确认文本。
 * 返回值：策略、预览统计或实际删除计数；校验失败不删除。
 */
async function handleHistoryCleanup(req,res,pathname){
  if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
  try{
    const body=JSON.parse((await readBody(req,res,4096)) || '{}');
    // 策略和删除操作都重新鉴权；已失效的口令不得继续使用原预览。
    if(!security.verifyAdmin(req.headers['x-quota-bootstrap']))return send(res,403,{error:'bad_bootstrap'});
    if(!body || typeof body!=='object' || Array.isArray(body))return send(res,400,{error:'bad_cleanup_policy'});
    if(pathname.endsWith('/policy'))return send(res,200,{ok:true,policy:cleanup.policy()});
    if(pathname.endsWith('/save'))return send(res,200,{ok:true,policy:cleanup.save(body)});
    if(pathname.endsWith('/preview'))return send(res,200,{ok:true,...cleanup.preview(body.retention_days)});
    return send(res,200,{ok:true,...cleanup.execute(body.preview_token,body.confirmation)});
  }catch(error){
    if(error instanceof SyntaxError)return send(res,400,{error:'bad_json'});
    if(error.publicCode)return send(res,error.status,{error:error.publicCode});
    throw error;
  }
}

/** 功能：每轮最多清理200份完整报告，首次默认关闭；参数：无；返回值：无，错误记录固定码。 */
function purge() {
  try {
    const result=cleanup.automatic();
    if(result.deleted_rows)console.log(`purged ${result.deleted_rows} snapshot rows in ${result.deleted_reports} reports`);
  } catch {console.error('history_cleanup_failed');}
}

purge();
setInterval(purge, 6 * 60 * 60 * 1000).unref();

/** 功能：推送最新账号读数中到点的原始重置窗口；参数：无；返回值：无。 */
function notifyQuotaResets() {
  if (!wecomWebhook) return;
  try {
    const now = nowSec();
    const hidden = new Set(Q.hiddenAccounts.all().map((row) => row.account_id));
    const groups = buildGroups(Q.machines.all()
      .filter((machine) => !deviceMerge.isMerged(machine.machine_id))
      .map((machine) => describeMachine(machine, now)), now);
    const aliases = aliasMap();
    // 只处理近一分钟到点的原始时间，避免启动时集中补发过期提醒。
    for (const group of groups) {
      if (!group.account_id || hidden.has(group.account_id)) continue;
      for (const window of group.windows) {
        const at = window.reset_anchor_at;
        if (!Number.isSafeInteger(at) || at <= now - 60 || at > now) continue;
        // 先原子占位，重启或网络结果不确定时仍不重复发送。
        if (!claimResetNotice.run(group.account_id, window.kind, at).changes) continue;
        const name = aliases.get(group.account_id)?.display_name || group.account_id.slice(-8);
        const kind = window.kind === 'primary' ? '主窗口' : '次窗口';
        void sendWecomAlert(`Codex 账号 ${name} 的额度${kind}已到预计重置时间。`, 'reset_' + window.kind);
      }
    }
  } catch {
    console.warn('企微额度重置提醒检查失败。');
  }
}

setInterval(notifyQuotaResets, 15000).unref();

server.listen(CFG.port, CFG.host, () => {
  console.log(`codex-quota server on http://${CFG.host}:${CFG.port}  db=${CFG.db}`);
  console.log(`allowed sources: ${ALLOWED.map((n) => n.cidr).join(', ')}`);
  console.log(READ_GATE
    ? 'read gate: ON（只有已接入的机器能读面板；其余来源可用口令解锁本机 8 小时）'
    : 'read gate: OFF（--read-gate lan，内网段内任意来源都能读）');
  if (!security.hasAdmin()) console.log('WARNING: 管理口令未设置，无法生成配对码。');
});
