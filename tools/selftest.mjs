// 本机多机模拟自测：5 台客户端、共用账号分组、去重、异常输入。
// 用法：先起服务器，再 node --no-warnings tools/selftest.mjs [--base http://127.0.0.1:8799] [--bootstrap devsecret]
// 必须跑在空库上：去重断言比的是"该机器的上一次上报"，库里已有同名机器的旧数据时会误判。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', 'http://127.0.0.1:8799');
const BOOTSTRAP = arg('--bootstrap', 'devsecret');

let pass = 0;
let fail = 0;

const preState = await (await fetch(`${BASE}/api/state`)).json().catch(() => null);
if (!preState) { console.error(`连不上 ${BASE}，先把测试服务器起起来。`); process.exit(2); }
if (preState.machines.length) {
  console.error(`库里已有 ${preState.machines.length} 台机器，自测会误判去重。请换 --db 指向空库再跑。`);
  process.exit(2);
}
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function post(pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应留给调用方判断 */ }
  return { status: res.status, json, text };
}

let pairingCode;
/** 功能：使用隔离服务生成的永久测试配对码接入合成设备；参数：clientId、hostname、label 为设备字段；返回值：设备凭据响应。 */
async function pair(clientId, hostname, label) {
  if (!pairingCode) {
    const created = await post('/api/pairing-codes', { name:'自测合成配对码',kind:'permanent' }, { 'x-quota-bootstrap':BOOTSTRAP });
    if (created.status !== 200) throw new Error('无法生成自测配对码');
    pairingCode = created.json.code;
  }
  const r = await post('/api/pair', { client_id: clientId, hostname, label }, { 'x-quota-bootstrap': pairingCode });
  if (r.status !== 200) throw new Error(`pair ${clientId} failed: ${r.status} ${r.text}`);
  return r.json;
}

const now = Math.floor(Date.now() / 1000);
const ACCOUNT_A = '4b8895aa-3efa-4482-8d89-27a1c0000001';
const ACCOUNT_B = '9c112233-0000-1111-2222-333344445555';

function snapshot(over = {}) {
  return {
    source: 'session_tail',
    collected_at: now - 60,
    account_id: ACCOUNT_A,
    user_id: 'user-aaa',
    plan_type: 'pro',
    cli_version: '0.163.0-alpha.11',
    originator: 'Codex Desktop',
    primary: { used_percent: 42.5, window_minutes: 10080, resets_at: now + 3600 },
    secondary: { used_percent: 11.2, window_minutes: 300, resets_at: now + 900 },
    credits: { has_credits: true, unlimited: false, balance: '19478.4499340000' },
    hit_limit: null,
    source_seq: 73509889,
    last_session_mtime: now - 120,
    ...over,
  };
}

console.log(`\n== 配对 5 台（含中文名称）==`);
const m1 = await pair('selftest-1111', 'PC-A', '开发机A');
const m2 = await pair('selftest-2222', 'PC-A', 'NAS可达机');
const m3 = await pair('selftest-3333', 'PC-C', '老王的笔记本');
const m4 = await pair('selftest-4444', 'PC-D', '测试机D');
const m5 = await pair('selftest-5555', 'PC-E', '测试机E');
check('中文名称 UTF-8 往返正确', m3.label === '老王的笔记本', `got ${JSON.stringify(m3.label)}`);
check('同 client_id 重配幂等（token 不变）', (await pair('selftest-1111', 'PC-A', '开发机A')).token === m1.token);
check('不同机器各自独立 token', new Set([m1, m2, m3, m4, m5].map((m) => m.token)).size === 5);

console.log(`\n== 上报 ==`);
// M1 正常；M2 同一账号但读数更低且同样新鲜 → 应判分组 + 读数分歧
await post('/api/report', snapshot(), { 'x-quota-token': m1.token });
const dup = await post('/api/report', snapshot(), { 'x-quota-token': m1.token });
check('内容相同的第二次上报被标 is_duplicate', dup.json?.is_duplicate === true, JSON.stringify(dup.json));
const r2 = await post('/api/report', snapshot({ primary: { used_percent: 30.0, window_minutes: 10080, resets_at: now + 3600 }, source_seq: 1 }), { 'x-quota-token': m2.token });
check('内容不同的上报不标重复', r2.json?.is_duplicate === false);
check('变化后的上报返回新 report_id', r2.json?.report_id !== dup.json?.report_id);

// M3 用尽 + 无 secondary + 另一账号
const exhausted = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'exhausted.json'), 'utf8'));
await post('/api/report', { ...exhausted, account_id: ACCOUNT_B, collected_at: now, primary: { ...exhausted.primary, resets_at: now + 7200 }, last_session_mtime: now }, { 'x-quota-token': m3.token });
// M4 无账号、无 credits
const noacct = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'no-account-no-credits.json'), 'utf8'));
await post('/api/report', { ...noacct, collected_at: now, primary: { ...noacct.primary, resets_at: now + 600 }, secondary: { ...noacct.secondary, resets_at: now + 86400 }, last_session_mtime: now - 3600 }, { 'x-quota-token': m4.token });
// M5 故意不报（模拟失联机器）

console.log(`\n== 鉴权与输入边界 ==`);
check('错 token → 401', (await post('/api/report', snapshot(), { 'x-quota-token': 'nope' })).status === 401);
check('无 token → 401', (await post('/api/report', snapshot())).status === 401);
check('缺 primary → 400', (await post('/api/report', { collected_at: now }, { 'x-quota-token': m1.token })).status === 400);
check('错 bootstrap 配对 → 403', (await post('/api/pair', { client_id: 'x-bad', hostname: 'H' }, { 'x-quota-bootstrap': 'wrong' })).status === 403);
const big = JSON.stringify(snapshot({ originator: 'z'.repeat(20000) }));
check('超大 body → 413', (await post('/api/report', big, { 'x-quota-token': m1.token })).status === 413);
check('used_percent 非数字 → 400', (await post('/api/report', snapshot({ primary: { used_percent: 'abc', window_minutes: 300 } }), { 'x-quota-token': m1.token })).status === 400);

console.log(`\n== 面板数据 /api/state ==`);
const st = (await fetch(`${BASE}/api/state`)).json();
const state = await st;
const byLabel = Object.fromEntries(state.machines.map((m) => [m.label, m]));
const groupOf = (acct) => state.accounts.find((a) => a.account_id === acct);

const testMachines = state.machines.filter((m) => String(m.client_id).startsWith('selftest'));
check('机器区包含 5 台（含失联的测试机E）', testMachines.length === 5, `got ${testMachines.length}`);
const groupA = groupOf(ACCOUNT_A);
check('同账号两台被归为一组', groupA && groupA.machine_ids.length === 2, JSON.stringify(groupA?.machine_ids));
check('共用账号组 shared=true', groupA?.shared === true);
check('两台新鲜读数差异大 → 标 divergence', groupA?.divergence === true);
check('组额度取组内最新鲜读数', Math.abs(groupA?.windows[0]?.used_percent - 30.0) < 0.01, `got ${groupA?.windows[0]?.used_percent}`);
const groupB = groupOf(ACCOUNT_B);
check('独占账号成单机组', groupB?.machine_ids.length === 1 && groupB?.shared === false);
check('无 secondary 时只有一条窗口（不是缺数据）', groupB?.windows.length === 1);
check('用尽是正常状态：used_percent=100 且 hit_limit 保留', groupB?.windows[0]?.used_percent === 100 && groupB?.hit_limit === 'weekly');

const unknownGroups = state.accounts.filter((a) => !a.account_known);
check('无 account_id 的机器各自独立成组、不互相合并', unknownGroups.every((g) => g.machine_ids.length === 1));
const mD = byLabel['测试机D'];
check('无 credits 显示为 has_credits=0 而非 0 元', mD?.has_credits === 0 && mD?.balance === null);
check('balance 按字符串原样保存（不被 float 截断）', byLabel['开发机A']?.balance === '19478.4499340000', `got ${byLabel['开发机A']?.balance}`);
check('周窗口与 5 小时窗口都在同一台机器上呈现', (byLabel['开发机A']?.windows.length ?? 0) === 2);
check('primary 排在前面', byLabel['开发机A']?.windows[0]?.kind === 'primary');
check('reset_in_sec 由服务器时钟算出', byLabel['开发机A']?.windows[0]?.reset_in_sec > 3000);
check('有上报的机器状态为 green', byLabel['开发机A']?.stale === 'green');
check('失联机器（从未上报）状态为 grey', byLabel['测试机E']?.stale === 'grey' && byLabel['测试机E']?.has_report === false);
check('account_id 出现在快照层，便于将来按账号查历史', state.accounts.some((a) => a.account_id === ACCOUNT_A));

console.log(`\n== 改名 ==`);
const renamed = await post('/api/machine/' + m4.machine_id + '/label', { label: '改名后的D' }, { 'x-quota-bootstrap': BOOTSTRAP });
check('面板改名生效', renamed.status === 200 && renamed.json?.label === '改名后的D');
check('改名需 bootstrap，未带则 403', (await post('/api/machine/1/label', { label: 'x' })).status === 403);

console.log(`\n== 账号映射 ==`);
async function get(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
}
async function raw(method, pathname, body, headers = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const MANUAL = 'manual-only-alias-0001';
check('映射写操作需要 bootstrap，未带则 403', (await raw('POST', `/api/account/${ACCOUNT_A}/alias`, { display_name: 'x' })).status === 403);
check('空映射名 → 400', (await raw('POST', `/api/account/${ACCOUNT_A}/alias`, { display_name: '   ' }, { 'x-quota-bootstrap': BOOTSTRAP })).status === 400);
check('账号 id 含非法字符 → 400', (await raw('POST', '/api/account/a%2Fb/alias', { display_name: 'x' }, { 'x-quota-bootstrap': BOOTSTRAP })).status === 400);
const aliasSave = await raw('POST', `/api/account/${ACCOUNT_A}/alias`,
  { display_name: '张三的主号', owner: '张三', note: '公司配的' }, { 'x-quota-bootstrap': BOOTSTRAP });
check('保存映射 → 200 且回显字段', aliasSave.status === 200 && aliasSave.json?.owner === '张三', JSON.stringify(aliasSave.json));
await raw('POST', `/api/account/${MANUAL}/alias`, { display_name: '手工加的还没上报的号' }, { 'x-quota-bootstrap': BOOTSTRAP });

const st2 = await (await fetch(`${BASE}/api/state`)).json();
check('/api/state 里账号组带 display_name', st2.accounts.find((a) => a.account_id === ACCOUNT_A)?.display_name === '张三的主号');
check('/api/state 里机器也带 display_name', st2.machines.find((m) => m.account_id === ACCOUNT_A)?.display_name === '张三的主号');
check('/api/state 的 owners 不进额度：分组数不变', st2.accounts.length === state.accounts.length);
check('/api/state 列出全部映射', (st2.aliases ?? []).some((a) => a.account_id === ACCOUNT_A && a.display_name === '张三的主号')
  && st2.aliases.length >= 2, `got ${JSON.stringify(st2.aliases)}`);

const accts = (await (await fetch(`${BASE}/api/accounts`)).json()).accounts;
const rowA = accts.find((r) => r.account_id === ACCOUNT_A);
check('/api/accounts 汇总历史+当前账号', rowA && rowA.snap_rows >= 2 && rowA.in_use === true, JSON.stringify(rowA));
check('/api/accounts 给出窗口标签与机器数', rowA?.window_label === '周(7天)' && rowA?.machine_count === 2, JSON.stringify({ w: rowA?.window_label, c: rowA?.machine_count }));
check('/api/accounts 列出只有映射、没有读数的账号', accts.some((r) => r.account_id === MANUAL && r.in_use === false && r.snap_rows === 0));
check('/api/accounts 里没有 account_id 的上报不入表', accts.every((r) => r.account_id));

check('删除不存在的映射 → 404', (await raw('DELETE', `/api/account/never-seen-00000/alias`, undefined, { 'x-quota-bootstrap': BOOTSTRAP })).status === 404);
const del = await raw('DELETE', `/api/account/${MANUAL}/alias`, undefined, { 'x-quota-bootstrap': BOOTSTRAP });
check('删除映射 → 200', del.status === 200, JSON.stringify(del.json));
check('删除后 /api/accounts 不再列出该账号',
  !(await (await fetch(`${BASE}/api/accounts`)).json()).accounts.some((r) => r.account_id === MANUAL));

console.log(`\n== 面板静态资源 ==`);
const idx = await get('/');
check('/ 返回面板 HTML', idx.status === 200 && idx.type.startsWith('text/html') && idx.text.includes('id="nav"'));
for (const p of ['/app.js', '/ui/nav.js', '/lib/api.js', '/views/mapping.js']) {
  const r = await get(p);
  check(`${p} 以 text/javascript 提供`, r.status === 200 && r.type.startsWith('text/javascript'), `${r.status} ${r.type}`);
}
const css = await get('/style.css');
check('/style.css 有浅色主题变量块', css.status === 200 && /data-theme=['"]?light/.test(css.text));
const escape = await get('/%2e%2e/server.mjs');
check('目录穿越拿不到源码', escape.status !== 200 && !escape.text.includes('DatabaseSync'), `${escape.status}`);
check('未知路径 → 404 json', (await get('/nope.js')).status === 404);

console.log(`\n== 重置倒计时按窗口推算（闲置机器不卡死）==`);
const WEEK = 10080 * 60;
const ROLL_ACCT = '7d7d7d7d-1111-2222-3333-444455556666';
const mr = await pair('selftest-rolling', 'PC-R', '推算测试机');
// 每次换一个 used_percent，避免撞上内容去重签名（签名不含 resets_at）。
// 快照按观察顺序递增；重置锚点可很旧，两者是不同时间。
let rollObservation = now - 100;
async function rollProbe(usedPct, minutes, anchor) {
  await post('/api/report', snapshot({
    account_id: ROLL_ACCT,
    collected_at: ++rollObservation,
    last_session_mtime: anchor,
    primary: { used_percent: usedPct, window_minutes: minutes, resets_at: anchor },
    secondary: null,
    source_seq: anchor,
  }), { 'x-quota-token': mr.token });
  const s = await (await fetch(`${BASE}/api/state`)).json();
  return { w: s.machines.find((m) => m.client_id === 'selftest-rolling')?.windows[0] ?? null, srvNow: s.server_now };
}

// 锚点故意比 now 早"3 个整周期再往后 30 秒"：整套自测在本机可能跑在同一秒内，
// 若锚点恰好等于 server_now，滚出来的重置点会等于当前时刻（差 0 秒），断言就误判。
const ROLL_ANCHOR = now - 3 * WEEK + 30;
const past3 = await rollProbe(61, 10080, ROLL_ANCHOR);
check('锚点已过 3 个周期 → 滚到下一周期且标推算', past3.w?.reset_estimated === true && past3.w?.resets_at > past3.srvNow,
  JSON.stringify(past3.w));
check('推算值仍是整数个窗口，原始实测锚点保留',
  past3.w?.reset_anchor_at === ROLL_ANCHOR && (past3.w.resets_at - past3.w.reset_anchor_at) % WEEK === 0,
  JSON.stringify({ a: past3.w?.reset_anchor_at, r: past3.w?.resets_at }));
check('reset_in_sec 与推算后的锚点一致', Math.abs(past3.w?.reset_in_sec - (past3.w.resets_at - past3.srvNow)) < 2);

const acctRoll = (await (await fetch(`${BASE}/api/accounts`)).json()).accounts.find((r) => r.account_id === ROLL_ACCT);
check('/api/accounts 的锚点同样按窗口滚过并标推算',
  acctRoll?.reset_estimated === true && acctRoll?.resets_at > past3.srvNow && acctRoll?.reset_anchor_at === ROLL_ANCHOR,
  JSON.stringify(acctRoll));

const past20 = await rollProbe(62, 10080, now - 20 * WEEK);
check('太老的读数不硬推（超过 12 个周期）→ 保持"重置点已过"', past20.w?.reset_estimated === false && past20.w?.resets_at < past20.srvNow,
  JSON.stringify(past20.w));

const noMinutes = await rollProbe(63, null, now - 3600);
check('窗口长度未知无法推算 → 原样返回', noMinutes.w?.reset_estimated === false && noMinutes.w?.resets_at === now - 3600,
  JSON.stringify(noMinutes.w));

const future = await rollProbe(64, 10080, now + 7200);
check('未来锚点不动它', future.w?.reset_estimated === false && future.w?.resets_at === now + 7200 && future.w?.reset_anchor_at === now + 7200,
  JSON.stringify(future.w));

const stRoll = await (await fetch(`${BASE}/api/state`)).json();
const normalW = stRoll.machines.find((m) => m.label === '开发机A')?.windows[0];
check('有新鲜读数的机器不带推算标记', normalW?.reset_estimated === false && normalW?.reset_anchor_at === normalW?.resets_at,
  JSON.stringify(normalW));

check('左侧外链位于映射前并在右侧页签中打开',
  idx.text.includes('codex-reset.com') && idx.text.includes('id="externalTabBar"') && idx.text.includes('id="externalPages"') && !/href="https:\/\/codex-reset\.com[^\"]*"[^>]*target="_blank"/.test(idx.text)
  && idx.text.indexOf('codex-reset.com') < idx.text.indexOf('#/mapping'), '外链缺失或位置不对');

// ---------- 读取闸门：非回环来源必须是已接入的机器 ----------
// 用 127.0.0.6 / 127.0.0.7 作来源（服务器只把 127.0.0.1 与 ::1 当本机豁免，其余按已接入 IP 集合判定）。
function rawFrom(method, pathname, { from, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const req = http.request(
      { host: u.hostname, port: Number(u.port), path: pathname, method, localAddress: from,
        headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* HTML 响应没有 JSON */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const LOCKED_IP = '127.0.0.6';
const gatePage = await rawFrom('GET', '/', { from: LOCKED_IP });
check('未接入来源打开面板 → 403 解锁页（没有任何额度数据）',
  gatePage.status === 403 && gatePage.text.includes('还没接入') && !gatePage.text.includes('账号额度 · Codex 额度监控'),
  `status=${gatePage.status} len=${gatePage.text.length}`);
const gateApi = await rawFrom('GET', '/api/state', { from: LOCKED_IP });
check('未接入来源读 /api/state → 403 not_paired',
  gateApi.status === 403 && gateApi.json?.error === 'not_paired', gateApi.text.slice(0, 120));
const gateBadKey = await rawFrom('POST', '/api/unlock', { from: LOCKED_IP, body: { key: '瞎猜的口令' } });
check('口令错解不开锁', gateBadKey.status === 403 && gateBadKey.json?.error === 'bad_key', gateBadKey.text.slice(0, 120));
const gateKey = await rawFrom('POST', '/api/unlock', { from: LOCKED_IP, body: { key: BOOTSTRAP } });
const gateAfterKey = await rawFrom('GET', '/api/state', { from: LOCKED_IP });
check('口令对 → 该来源解锁后能读数据',
  gateKey.status === 200 && gateAfterKey.status === 200 && Array.isArray(gateAfterKey.json?.machines),
  `unlock=${gateKey.status} state=${gateAfterKey.status}`);

const NEW_IP = '127.0.0.7';
const pairBefore = await rawFrom('GET', '/api/state', { from: NEW_IP });
const pairRes = await rawFrom('POST', '/api/pair', {
  from: NEW_IP, body: { client_id: 'gate-new-machine', hostname: 'GATE-NEW' },
  headers: { 'x-quota-bootstrap': BOOTSTRAP },
});
const readNewIp = await rawFrom('GET', '/api/state', { from: NEW_IP });
check('配对写入不受闸门挡住（不然新机器永远接不进来）',
  pairBefore.status === 403 && pairRes.status === 200, `before=${pairBefore.status} pair=${pairRes.status}`);
check('配对成功后立刻可读，不用等第一次上报', readNewIp.status === 200, `state=${readNewIp.status}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
