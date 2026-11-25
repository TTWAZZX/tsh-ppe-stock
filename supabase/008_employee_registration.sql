BEGIN;

CREATE TABLE IF NOT EXISTS public.ppe_employee_registrations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_user_id text NOT NULL UNIQUE CHECK (line_user_id ~ '^U[0-9a-f]{32}$'),
  employee_id text NOT NULL CHECK (length(btrim(employee_id)) BETWEEN 1 AND 50),
  employee_name text NOT NULL CHECK (length(btrim(employee_name)) BETWEEN 1 AND 150),
  department text NOT NULL CHECK (length(btrim(department)) BETWEEN 1 AND 150),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text,
  rejection_reason text
);
CREATE INDEX IF NOT EXISTS ppe_employee_registrations_pending_idx
  ON public.ppe_employee_registrations (id) WHERE status = 'pending';
ALTER TABLE public.ppe_employee_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ppe_employee_registrations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ppe_employee_registrations TO service_role;

CREATE OR REPLACE FUNCTION public.ppe_submit_employee_registration(
  p_line_user_id text, p_employee_id text, p_employee_name text, p_department_id bigint
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  department_name text;
  request_row public.ppe_employee_registrations%ROWTYPE;
BEGIN
  IF p_line_user_id IS NULL OR p_line_user_id !~ '^U[0-9a-f]{32}$'
    OR coalesce(length(btrim(p_employee_id)), 0) NOT BETWEEN 1 AND 50
    OR coalesce(length(btrim(p_employee_name)), 0) NOT BETWEEN 1 AND 150 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาระบุข้อมูลพนักงานให้ครบและถูกต้อง';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ppe_employee_access a WHERE a.line_user_id = p_line_user_id) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'บัญชีนี้มีทะเบียนพนักงานแล้ว กรุณารีเฟรชหรือติดต่อผู้ดูแลระบบ';
  END IF;
  SELECT d.name INTO department_name FROM public.departments d WHERE d.id = p_department_id FOR SHARE;
  IF department_name IS NULL THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาเลือกแผนกจากรายการปัจจุบัน';
  END IF;

  INSERT INTO public.ppe_employee_registrations AS registration (line_user_id, employee_id, employee_name, department)
  VALUES (p_line_user_id, btrim(p_employee_id), btrim(p_employee_name), department_name)
  ON CONFLICT (line_user_id) DO UPDATE
    SET employee_id = excluded.employee_id, employee_name = excluded.employee_name, department = excluded.department,
        status = 'pending', revision = registration.revision + 1, submitted_at = now(),
        reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL
    WHERE registration.status = 'rejected'
  RETURNING * INTO request_row;

  IF NOT FOUND THEN
    SELECT * INTO request_row FROM public.ppe_employee_registrations r WHERE r.line_user_id = p_line_user_id;
    IF request_row.status IS DISTINCT FROM 'pending' OR request_row.employee_id IS DISTINCT FROM btrim(p_employee_id)
      OR request_row.employee_name IS DISTINCT FROM btrim(p_employee_name) OR request_row.department IS DISTINCT FROM department_name THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'มีคำขอลงทะเบียนอยู่แล้ว กรุณารีเฟรชเพื่อดูสถานะ';
    END IF;
  END IF;
  RETURN jsonb_build_object('status', request_row.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.ppe_review_employee_registrations(
  p_requests jsonb, p_decision text, p_reviewer text, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  request_row public.ppe_employee_registrations%ROWTYPE;
  selection record;
  reviewed_count integer := 0;
BEGIN
  IF coalesce(jsonb_typeof(p_requests), '') <> 'array' OR coalesce(p_decision, '') NOT IN ('approved', 'rejected')
    OR coalesce(p_reviewer, '') NOT LIKE 'admin:%' OR (p_decision = 'rejected' AND coalesce(length(btrim(p_reason)), 0) NOT BETWEEN 1 AND 500) THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'ข้อมูลการพิจารณาไม่ถูกต้อง';
  END IF;
  IF jsonb_array_length(p_requests) NOT BETWEEN 1 AND 100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'เลือกคำขอได้ครั้งละ 1 ถึง 100 รายการ';
  END IF;

  -- Serialize directory writes across administrators and manual roster imports.
  IF p_decision = 'approved' THEN LOCK TABLE public.ppe_employee_access IN SHARE ROW EXCLUSIVE MODE; END IF;
  FOR selection IN SELECT * FROM jsonb_to_recordset(p_requests) AS selected(id bigint, revision integer) ORDER BY selected.id
  LOOP
    SELECT * INTO request_row FROM public.ppe_employee_registrations r WHERE r.id = selection.id FOR UPDATE;
    IF NOT FOUND OR request_row.revision IS DISTINCT FROM selection.revision
      OR request_row.status IS DISTINCT FROM 'pending' THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'คำขอมีการเปลี่ยนแปลงแล้ว กรุณาโหลดรายการใหม่';
    END IF;
    IF p_decision = 'approved' THEN
      PERFORM 1 FROM public.departments d WHERE d.name = request_row.department FOR SHARE;
      IF NOT FOUND THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'มีแผนกที่ไม่อยู่ในมาสเตอร์ กรุณาให้พนักงานส่งคำขอใหม่';
      END IF;
      IF EXISTS (SELECT 1 FROM public.ppe_employee_access a WHERE a.line_user_id = request_row.line_user_id
        OR lower(btrim(a.employee_id)) = lower(btrim(request_row.employee_id))) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'มีบัญชี LINE หรือรหัสพนักงานที่ผูกไว้แล้ว กรุณาตรวจรายการที่เลือก';
      END IF;
      INSERT INTO public.ppe_employee_access(line_user_id, employee_id, employee_name, department, active)
      VALUES (request_row.line_user_id, request_row.employee_id, request_row.employee_name, request_row.department, true);
    END IF;
    UPDATE public.ppe_employee_registrations r SET status = p_decision, reviewed_at = now(), reviewed_by = p_reviewer,
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN btrim(p_reason) END WHERE r.id = request_row.id;
    INSERT INTO public.audit_log(actor, action, entity_type, entity_id, details)
    VALUES (p_reviewer, 'reviewEmployeeRegistration', 'ppe_employee_registrations', request_row.id::text,
      jsonb_build_object('decision', p_decision, 'revision', request_row.revision));
    reviewed_count := reviewed_count + 1;
  END LOOP;
  RETURN jsonb_build_object('reviewed', reviewed_count);
END;
$$;

REVOKE ALL ON FUNCTION public.ppe_submit_employee_registration(text, text, text, bigint),
  public.ppe_review_employee_registrations(jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_submit_employee_registration(text, text, text, bigint),
  public.ppe_review_employee_registrations(jsonb, text, text, text) TO service_role;

COMMIT;
