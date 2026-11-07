import crypto from 'node:crypto';

/** 功能：创建不含敏感内容的业务错误；参数：code 为错误码；返回值：带 HTTP 状态的错误。 */
function rejected(code, status = 400) {
  return Object.assign(new Error(code), { status, publicCode: code });
}

/** 功能：定长比较摘要；参数：a、b 为摘要字符串；返回值：是否一致。 */
function equalDigest(a, b) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** 功能：管理管理员授权摘要及三种配对码；参数：db 为既有 SQLite 连接，initialBootstrap 为首次授权口令；返回值：安全管理实例。 */
export class PairingSecurity {
  /** 功能：初始化安全表和跨重启稳定的初始口令盐，不更改设备或额度；参数：db、initialBootstrap；返回值：实例。 */
  constructor(db, initialBootstrap) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_authorization (
        id INTEGER PRIMARY KEY CHECK(id = 1), salt TEXT NOT NULL, digest TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_bootstrap_salt (
        id INTEGER PRIMARY KEY CHECK(id = 1), salt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_code (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('single','timed','permanent')),
        digest TEXT NOT NULL UNIQUE, starts_at INTEGER NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL,
        revoked_at INTEGER, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, consumed_client_id TEXT
      );
      CREATE TABLE IF NOT EXISTS pairing_claim (
        code_id INTEGER NOT NULL REFERENCES pairing_code(id), client_id TEXT NOT NULL, claimed_at INTEGER NOT NULL,
        PRIMARY KEY(code_id, client_id)
      );
    `);
    const saved = db.prepare('SELECT salt, digest FROM admin_authorization WHERE id=1').get();
    // 旧配置仅作为初始来源；一旦页面修改，持久化摘要优先，重启不能复活旧口令。
    if (!saved && initialBootstrap) {
      // 只持久化每库随机盐，保留初始配置口令可更换的兼容语义，不把初始摘要当成页面轮换后的永久口令。
      db.prepare('INSERT OR IGNORE INTO admin_bootstrap_salt(id,salt) VALUES(1,?)').run(crypto.randomBytes(16).toString('hex'));
      const initialSalt = db.prepare('SELECT salt FROM admin_bootstrap_salt WHERE id=1').get().salt;
      this.admin = this.derive(initialBootstrap, initialSalt);
    } else this.admin = saved || null;
  }

  /** 功能：计算管理员口令的加盐慢摘要；参数：secret为临时明文，salt为可选的既有每库随机盐；返回值：盐和摘要。 */
  derive(secret, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, digest: crypto.scryptSync(secret, salt, 32).toString('hex') };
  }

  /** 功能：计算不暴露口令摘要的授权代际；参数：无；返回值：同口令跨重启稳定、换口令变化的代际或空串。 */
  generation() { return this.admin ? crypto.createHash('sha256').update(this.admin.salt + ':' + this.admin.digest).digest('hex') : ''; }

  /** 功能：判断是否配置管理授权；参数：无；返回值：布尔值。 */
  hasAdmin() { return this.admin !== null; }

  /** 功能：校验当前管理口令；参数：secret 为请求携带值；返回值：是否匹配。 */
  verifyAdmin(secret) {
    if (!this.admin || typeof secret !== 'string' || !secret.length || Buffer.byteLength(secret) > 1024) return false;
    return equalDigest(crypto.scryptSync(secret, this.admin.salt, 32).toString('hex'), this.admin.digest);
  }

  /** 功能：持久化新管理口令并立即生效；参数：current 为旧口令，next 为新口令，confirmation 为确认值；返回值：无。 */
  changeAdmin(current, next, confirmation) {
    if (!this.verifyAdmin(current)) throw rejected('bad_bootstrap', 403);
    if (typeof next !== 'string' || next !== confirmation || next.trim() !== next || next.length < 16 || Buffer.byteLength(next) > 256) throw rejected('bad_new_bootstrap');
    if (this.verifyAdmin(next)) throw rejected('bootstrap_unchanged');
    const value = this.derive(next);
    this.db.prepare(`INSERT INTO admin_authorization(id,salt,digest,updated_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,digest=excluded.digest,updated_at=excluded.updated_at`).run(value.salt, value.digest, Math.floor(Date.now()/1000));
    this.admin = value;
  }

  /** 功能：创建仅供配对的高熵随机码；参数：body 含名称、类型及可选有效期；返回值：仅此一次返回的明文和安全元数据。 */
  createCode(body) {
    const now = Math.floor(Date.now()/1000);
    const { kind } = body;
    if (!['single','timed','permanent'].includes(kind)) throw rejected('bad_pairing_kind');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) throw rejected('bad_pairing_name');
    const start = body.starts_at ?? now;
    const end = kind === 'permanent' ? null : (body.expires_at ?? (kind === 'single' ? now+600 : null));
    // 时间使用服务端秒级整数；永久码也可预约开始，限时码必须提供结束时间。
    if (!Number.isSafeInteger(start) || start < 0 || start > 253402300799 ||
        (end !== null && (!Number.isSafeInteger(end) || end <= start || end <= now || end > 253402300799)) ||
        (kind !== 'permanent' && end === null) || (kind === 'permanent' && body.expires_at != null)) throw rejected('bad_pairing_time');
    const code = crypto.randomBytes(24).toString('base64url');
    const digest = crypto.createHash('sha256').update(code).digest('hex');
    const row = this.db.prepare('INSERT INTO pairing_code(name,kind,digest,starts_at,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(name,kind,digest,start,end,now);
    return { id: Number(row.lastInsertRowid), code, kind, starts_at: start, expires_at: end };
  }

  /** 功能：列出配对码管理元数据；参数：无；返回值：不含明文及摘要的列表。 */
  listCodes() {
    const now = Math.floor(Date.now()/1000);
    return this.db.prepare(`SELECT id,name,kind,starts_at,expires_at,created_at,revoked_at,uses,last_used_at FROM pairing_code ORDER BY id DESC`).all().map(row => ({
      ...row, status: row.revoked_at !== null ? 'revoked' : row.kind === 'single' && row.uses > 0 ? 'used' :
        row.expires_at !== null && now >= row.expires_at ? 'expired' : now < row.starts_at ? 'scheduled' : 'active'
    }));
  }

  /** 功能：撤销配对码，保留已配对设备；参数：id 为配对码编号；返回值：无。 */
  revokeCode(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw rejected('bad_pairing_id');
    if (!this.db.prepare('SELECT id FROM pairing_code WHERE id=?').get(id)) throw rejected('unknown_pairing_code',404);
    this.db.prepare('UPDATE pairing_code SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(Math.floor(Date.now()/1000),id);
  }

  /** 功能：事务核销配对码并注册设备，保护原有身份及令牌；参数：code、clientId、proof 为码/身份/可选旧设备令牌，register 为注册回调；返回值：设备记录。 */
  redeem(code, clientId, proof, register) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) throw rejected('bad_pairing_code',403);
    const digest = crypto.createHash('sha256').update(code).digest('hex');
    const now = Math.floor(Date.now()/1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM pairing_code WHERE digest=?').get(digest);
      if (!row || row.revoked_at !== null || now < row.starts_at || (row.expires_at !== null && now >= row.expires_at)) throw rejected('pairing_code_unavailable',403);
      const claim = this.db.prepare('SELECT claimed_at FROM pairing_claim WHERE code_id=? AND client_id=?').get(row.id,clientId);
      const retry = claim && now >= claim.claimed_at && now-claim.claimed_at <= 600;
      if (row.kind === 'single' && row.uses > 0 && !(row.consumed_client_id === clientId && retry)) throw rejected('pairing_code_used',403);
      const existing = this.db.prepare('SELECT * FROM machine WHERE client_id=?').get(clientId);
      // 已有设备不能仅凭可复制的 client_id 被另一张配对码取回令牌；同码短期重试例外。
      const proofOk = existing && typeof proof === 'string' && Buffer.byteLength(proof) <= 1024 &&
        equalDigest(crypto.createHash('sha256').update(proof).digest('hex'),crypto.createHash('sha256').update(existing.token).digest('hex'));
      if (existing && !retry && !proofOk) throw rejected('existing_device_requires_token',409);
      const machine = register(existing);
      if (!claim) {
        this.db.prepare('INSERT INTO pairing_claim(code_id,client_id,claimed_at) VALUES(?,?,?)').run(row.id,clientId,now);
        this.db.prepare(`UPDATE pairing_code SET uses=uses+1,last_used_at=?,consumed_client_id=CASE WHEN kind='single' THEN ? ELSE consumed_client_id END WHERE id=?`).run(now,clientId,row.id);
      }
      this.db.exec('COMMIT');
      return machine;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
