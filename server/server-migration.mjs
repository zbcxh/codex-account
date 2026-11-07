import crypto from 'node:crypto';

/** 功能：规范化基础地址，禁止凭据、查询、片段和控制字符；参数：value 为地址；返回值：规范地址或抛出校验错误。 */
export function migrationUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\\\s\x00-\x1f]/.test(value)) throw new Error('bad_server_url');
  let u; try {u = new URL(value);} catch {throw new Error('bad_server_url');}
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('bad_server_url');
  return u.href.replace(/\/+$/, '');
}
/** 功能：生成只证明持有设备令牌的随机挑战响应；参数：token、clientId、nonce；返回值：小写 HMAC，不回显令牌。 */
export function migrationProof(token, clientId, nonce) {
  return crypto.createHmac('sha256', token).update('codex-quota-migration-v1\n' + clientId + '\n' + nonce).digest('hex');
}
/** 功能：管理全局和单设备地址迁移，不改账号、令牌和额度；参数：db 为数据库；返回值：迁移管理实例。 */
export class ServerMigration {
  /** 功能：创建独立的兼容扩展表；参数：db；返回值：实例。 */
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS server_migration_policy(id INTEGER PRIMARY KEY CHECK(id=1), server_url TEXT, version INTEGER NOT NULL DEFAULT 1);
      INSERT OR IGNORE INTO server_migration_policy(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS machine_server_migration(machine_id INTEGER PRIMARY KEY REFERENCES machine(machine_id), override_url TEXT,
        applied_version INTEGER NOT NULL DEFAULT 0, applied_url TEXT, apply_error TEXT, updated_at INTEGER);`);
  }
  /** 功能：读取有效目标和确认结果；参数：id 为设备编号；返回值：配置对象。 */
  describe(id) {
    const p = this.db.prepare('SELECT server_url,version FROM server_migration_policy WHERE id=1').get();
    const d = this.db.prepare('SELECT * FROM machine_server_migration WHERE machine_id=?').get(id);
    return {version:p.version, server_url:d?.override_url ?? p.server_url, override_url:d?.override_url ?? null,
      applied_version:d?.applied_version ?? 0, applied_url:d?.applied_url ?? null, apply_error:d?.apply_error ?? null};
  }
  /** 功能：读取管理页面安全状态；参数：无；返回值：默认设置及各设备状态。 */
  list() {
    return {...this.db.prepare('SELECT server_url,version FROM server_migration_policy WHERE id=1').get(),
      machines:this.db.prepare('SELECT machine_id,label FROM machine ORDER BY label').all().map(m=>({...m,...this.describe(m.machine_id)}))};
  }
  /** 功能：事务保存地址；参数：id 为设备编号或全局 null，value 为地址或取消/继承 null；返回值：最新安全状态。 */
  set(id, value) {
    const url = value === null ? null : migrationUrl(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (id === null) this.db.prepare('UPDATE server_migration_policy SET server_url=?,version=version+1 WHERE id=1').run(url);
      else {
        if (!this.db.prepare('SELECT 1 FROM machine WHERE machine_id=?').get(id)) throw new Error('unknown_machine');
        this.db.prepare(`INSERT INTO machine_server_migration(machine_id,override_url) VALUES(?,?) ON CONFLICT(machine_id)
          DO UPDATE SET override_url=excluded.override_url,apply_error=NULL`).run(id,url);
        this.db.prepare('UPDATE server_migration_policy SET version=version+1 WHERE id=1').run();
      }
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    return this.list();
  }
  /** 功能：记录原服务器收到的迁移结果，不更新在线心跳；参数：id、body 含版本/地址/固定错误码；返回值：HTTP 错误码或零。 */
  acknowledge(id, body) {
    const c=this.describe(id);
    if (!Number.isSafeInteger(body.version) || typeof body.server_url !== 'string' ||
      (body.error != null && body.error !== 'migration_validation_failed')) return 400;
    if (body.version !== c.version || body.server_url !== c.server_url) return 409;
    this.db.prepare(`INSERT INTO machine_server_migration(machine_id,applied_version,applied_url,apply_error,updated_at) VALUES(?,?,?,?,unixepoch())
      ON CONFLICT(machine_id) DO UPDATE SET applied_version=excluded.applied_version,applied_url=excluded.applied_url,apply_error=excluded.apply_error,updated_at=excluded.updated_at`)
      .run(id,body.error ? c.applied_version : body.version,body.error ? c.applied_url : body.server_url,body.error ?? null);
    return 0;
  }
}
