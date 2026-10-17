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

-- 3. Notification outbox/log: เก็บผลตอบกลับจริงจาก provider และสถานะ retry
CREATE TABLE IF NOT EXISTS notification_log (
  id                    BIGSERIAL PRIMARY KEY,
  channel               TEXT NOT NULL DEFAULT 'line',
  event_key             TEXT NOT NULL,
  notification_type     TEXT NOT NULL,
  recipient             TEXT NOT NULL,
  entity_type           TEXT,
  entity_id             TEXT,
  payload               JSONB NOT NULL DEFAULT '{}'::JSONB,
  payload_hash          TEXT NOT NULL,
  retry_key             UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'retry_scheduled', 'sent', 'duplicate', 'failed', 'skipped')),
  attempt_count         SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          SMALLINT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  provider_http_status  INTEGER,
  provider_request_id   TEXT,
  provider_response     JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_error            TEXT,
  attempts              JSONB NOT NULL DEFAULT '[]'::JSONB,
  next_attempt_at       TIMESTAMPTZ,
  last_attempt_at       TIMESTAMPTZ,
  sent_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, event_key, recipient)
);
CREATE INDEX IF NOT EXISTS idx_notification_log_retry
  ON notification_log (status, next_attempt_at)
  WHERE status = 'retry_scheduled';
CREATE INDEX IF NOT EXISTS idx_notification_log_created
  ON notification_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_entity
  ON notification_log (entity_type, entity_id);
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

-- 4. Soft delete: ลบแล้วกู้คืนได้
ALTER TABLE ppe_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_ppe_items_not_deleted
  ON ppe_items (id) WHERE deleted_at IS NULL;

-- 5. Admin notification recipients: กำหนดผู้รับและหัวข้อที่ต้องการรับได้จากหน้า Admin
CREATE TABLE IF NOT EXISTS notification_recipients (
  id           BIGSERIAL PRIMARY KEY,
  label        TEXT NOT NULL CHECK (char_length(trim(label)) BETWEEN 1 AND 120),
  line_user_id TEXT NOT NULL UNIQUE CHECK (line_user_id ~ '^U[0-9a-f]{32}$'),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  topics       TEXT[] NOT NULL DEFAULT ARRAY['all']::TEXT[],
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(topics) > 0),
  CHECK (topics <@ ARRAY['all','issue','loan','stock','receipt','system']::TEXT[])
);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_enabled
  ON notification_recipients (enabled) WHERE enabled = true;
ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_loan_transactions_due_reminders
  ON loan_transactions (status, "dueDate") WHERE status = 'on_loan';

-- ตรวจสอบผลลัพธ์
SELECT 'login_attempts' AS table_name, COUNT(*) FROM login_attempts
UNION ALL
SELECT 'audit_log', COUNT(*) FROM audit_log
UNION ALL
SELECT 'notification_log', COUNT(*) FROM notification_log
UNION ALL
SELECT 'notification_recipients', COUNT(*) FROM notification_recipients
UNION ALL
SELECT 'ppe_items (with deleted_at)', COUNT(*) FROM ppe_items;
