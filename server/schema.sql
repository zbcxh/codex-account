-- Codex 额度监控：局域网服务器存储
CREATE TABLE IF NOT EXISTS wecom_delivery (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    triggered_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    result_code TEXT,
    device_name TEXT
);
-- 缺行沿用本地配置，NULL 表示在线停用；地址含推送凭据，仅服务端读取。
CREATE TABLE IF NOT EXISTS wecom_notification (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    webhook TEXT
);
CREATE TABLE IF NOT EXISTS wecom_reset_notice (
    account_id TEXT NOT NULL,
    window_kind TEXT NOT NULL,
    resets_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, window_kind, resets_at)
);
-- 额度是账号级全局窗口，机器只是消费者；因此账号列放在快照里而非机器表上。

CREATE TABLE IF NOT EXISTS machine (
    machine_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id          TEXT    NOT NULL UNIQUE,
    token              TEXT    NOT NULL,
    label              TEXT    NOT NULL,
    hostname           TEXT,
    last_ip            TEXT,
    created_at         INTEGER NOT NULL,
    last_seen_at       INTEGER,
    last_ok_at         INTEGER,
    online_since       INTEGER,
    last_report_id     TEXT,
    last_session_mtime INTEGER
);

-- 一次上报可能带多个窗口（primary + secondary），每个窗口一行，用 report_id 归组。
CREATE TABLE IF NOT EXISTS quota_snapshot (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id     INTEGER NOT NULL REFERENCES machine(machine_id),
    report_id      TEXT    NOT NULL,
    source         TEXT    NOT NULL,
    window_kind    TEXT    NOT NULL,
    collected_at   INTEGER NOT NULL,
    reported_at    INTEGER NOT NULL,
    skew_sec       INTEGER NOT NULL DEFAULT 0,
    is_duplicate   INTEGER NOT NULL DEFAULT 0,
    account_id     TEXT,
    user_id        TEXT,
    plan_type      TEXT,
    cli_version    TEXT,
    collector_version TEXT,
    collector_build TEXT,
    collector_sha256 TEXT,
    originator     TEXT,
    window_minutes INTEGER,
    used_percent   REAL,
    resets_at      INTEGER,
    balance        TEXT,
    has_credits    INTEGER,
    unlimited      INTEGER,
    hit_limit      TEXT,
    source_seq     INTEGER
);

CREATE INDEX IF NOT EXISTS ix_snap_machine ON quota_snapshot(machine_id, reported_at);
CREATE INDEX IF NOT EXISTS ix_snap_acct    ON quota_snapshot(account_id, reported_at);
CREATE INDEX IF NOT EXISTS ix_snap_report  ON quota_snapshot(report_id);

-- 会话文件里的账号是 UUID，人看不出是谁的号。这张表只做显示层的名字映射，
-- 不参与额度计算，也不存任何凭据。删掉它不影响历史快照。
CREATE TABLE IF NOT EXISTS account_alias (
    account_id   TEXT    PRIMARY KEY,
    display_name TEXT    NOT NULL,
    owner        TEXT,
    note         TEXT,
    updated_at   INTEGER NOT NULL
);

-- 隐藏账号只影响面板展示；额度历史和名称映射均保留。
CREATE TABLE IF NOT EXISTS account_hidden (
    account_id TEXT PRIMARY KEY,
    hidden_at  INTEGER NOT NULL
);

-- 管理员维护账号状态，推荐排序使用该状态而不是采集器上报推断。
CREATE TABLE IF NOT EXISTS account_status (
    account_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('normal','restricted','unknown')) DEFAULT 'unknown',
    updated_at INTEGER NOT NULL
);

-- 服务端期望配置与客户端确认的实际配置分开保存，避免尚未应用就改变在线阈值。
CREATE TABLE IF NOT EXISTS reporting_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    default_interval_minutes INTEGER NOT NULL CHECK (default_interval_minutes BETWEEN 1 AND 1440),
    version INTEGER NOT NULL CHECK (version >= 1)
);
INSERT OR IGNORE INTO reporting_policy VALUES (1, 5, 1);
CREATE TABLE IF NOT EXISTS machine_reporting (
    machine_id INTEGER PRIMARY KEY REFERENCES machine(machine_id),
    override_interval_minutes INTEGER CHECK (override_interval_minutes BETWEEN 1 AND 1440),
    applied_interval_minutes INTEGER CHECK (applied_interval_minutes BETWEEN 1 AND 1440),
    applied_version INTEGER NOT NULL DEFAULT 0,
    apply_error TEXT,
    updated_at INTEGER
);
