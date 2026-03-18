-- ============================================================
-- TSH PPE Stock — Enterprise Migration Script
-- รันใน Supabase SQL Editor (ทำครั้งเดียว)
-- ============================================================

-- 1. Account lockout: บันทึกความพยายาม login
CREATE TABLE IF NOT EXISTS login_attempts (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT NOT NULL,
  ip           TEXT,
  success      BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time
  ON login_attempts (username, attempted_at DESC);
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;

-- 2. Audit log: บันทึกทุก action (ลบไม่ได้)
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor   ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_action  ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- 3. Soft delete: ลบแล้วกู้คืนได้
ALTER TABLE ppe_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_ppe_items_not_deleted
  ON ppe_items (id) WHERE deleted_at IS NULL;

-- ตรวจสอบผลลัพธ์
SELECT 'login_attempts' AS table_name, COUNT(*) FROM login_attempts
UNION ALL
SELECT 'audit_log', COUNT(*) FROM audit_log
UNION ALL
SELECT 'ppe_items (with deleted_at)', COUNT(*) FROM ppe_items;
