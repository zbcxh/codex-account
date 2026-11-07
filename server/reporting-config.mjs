/**
 * 功能：校验分钟数，拒绝字符串、布尔值和非整数。
 * 参数：value 为客户端或管理员提交的值。
 * 返回值：是否为 1 至 1440 的整数分钟数。
 */
export function validInterval(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440;
}

/**
 * 功能：管理期望上报周期和设备实际周期，配置确认不改变额度历史及在线心跳。
 * 参数：db 为已初始化 reporting_policy 与 machine_reporting 表的 SQLite 连接。
 * 返回值：ReportingConfig 实例。
 */
export class ReportingConfig {
  /** 功能：预编译配置读写语句；参数：db 为 SQLite 连接；返回值：实例。 */
  constructor(db) {
    this.db = db;
    this.global = db.prepare('SELECT default_interval_minutes, version FROM reporting_policy WHERE id = 1');
    this.device = db.prepare('SELECT * FROM machine_reporting WHERE machine_id = ?');
    this.record = db.prepare(`INSERT INTO machine_reporting (machine_id, applied_interval_minutes, applied_version, apply_error, updated_at)
      VALUES (?, ?, ?, ?, unixepoch()) ON CONFLICT(machine_id) DO UPDATE SET
      applied_interval_minutes=excluded.applied_interval_minutes, applied_version=excluded.applied_version,
      apply_error=excluded.apply_error, updated_at=excluded.updated_at`);
  }

  /** 功能：读取默认周期及版本；参数：无；返回值：全局配置对象。 */
  policy() { return this.global.get(); }

  /** 功能：计算设备期望与实际配置；参数：id 为设备编号；返回值：配置、待应用标记与错误码。 */
  describe(id) {
    const policy = this.policy();
    const device = this.device.get(id);
    const desired = device?.override_interval_minutes ?? policy.default_interval_minutes;
    // 旧客户端未报告实际周期时沿用原来的五分钟，默认设置不能替它假装已经应用。
    const applied = device?.applied_interval_minutes ?? 5;
    const version = device?.applied_version ?? 0;
    return {
      ...policy,
      override_interval_minutes: device?.override_interval_minutes ?? null,
      desired_interval_minutes: desired,
      applied_interval_minutes: applied,
      actual_known: device?.applied_interval_minutes != null,
      applied_version: version,
      pending: version !== policy.version || applied !== desired || Boolean(device?.apply_error),
      apply_error: device?.apply_error ?? null,
    };
  }

  /** 功能：构造上报响应下发值；参数：id 为设备编号；返回值：无凭据的周期与确认信息。 */
  forClient(id) {
    const config = this.describe(id);
    return { version: config.version, interval_minutes: config.desired_interval_minutes,
      applied_version: config.applied_version, applied_interval_minutes: config.applied_interval_minutes };
  }

  /** 功能：校验设备实际调度状态；参数：status 为可选上报字段；返回值：是否合法。 */
  validStatus(status) {
    return status === undefined || (status !== null && typeof status === 'object' && !Array.isArray(status)
      && Number.isSafeInteger(status.version) && status.version >= 0 && validInterval(status.interval_minutes));
  }

  /** 功能：在额度上报事务内记录真实周期；参数：id 为设备编号，status 为已校验状态；返回值：无。 */
  observe(id, status) {
    if (!status) return;
    const config = this.describe(id);
    // 迟到队列与恢复旧数据库后的未知版本不能倒退已确认的调度信息。
    if (status.version < config.applied_version || status.version > config.version) return;
    const matches = status.version === config.version && status.interval_minutes === config.desired_interval_minutes;
    this.record.run(id, status.interval_minutes, status.version, matches ? null : config.apply_error);
  }

  /** 功能：事务更新默认或单台覆盖；参数：id 为设备编号或 null，minutes 为分钟数或继承用的 null；返回值：最新配置。 */
  set(id, minutes) {
    if (!(id !== null && minutes === null) && !validInterval(minutes)) throw new Error('bad_interval');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = id === null ? this.policy().default_interval_minutes : (this.device.get(id)?.override_interval_minutes ?? null);
      if (previous !== minutes) {
        if (id === null) this.db.prepare('UPDATE reporting_policy SET default_interval_minutes=? WHERE id=1').run(minutes);
        else this.db.prepare(`INSERT INTO machine_reporting(machine_id, override_interval_minutes) VALUES (?, ?)
          ON CONFLICT(machine_id) DO UPDATE SET override_interval_minutes=excluded.override_interval_minutes, apply_error=NULL`).run(id, minutes);
        this.db.prepare('UPDATE reporting_policy SET version=version+1 WHERE id=1').run();
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return id === null ? this.policy() : this.describe(id);
  }

  /** 功能：记录目标版本的应用确认；参数：id 为设备编号，body 含 version、interval_minutes 和可选错误码；返回值：HTTP 错误码或零。 */
  acknowledge(id, body) {
    if (!this.validStatus(body) || body === undefined || (body.error != null &&
      (typeof body.error !== 'string' || !/^[a-z_]{1,64}$/.test(body.error)))) return 400;
    const config = this.describe(id);
    if (body.version !== config.version) return 409;
    if (!body.error && body.interval_minutes !== config.desired_interval_minutes) return 400;
    this.record.run(id, body.interval_minutes, body.error ? config.applied_version : body.version, body.error ?? null);
    return 0;
  }
}
