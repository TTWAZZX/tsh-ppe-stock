BEGIN;

LOCK TABLE public.categories, public.ppe_items, public.issue_vouchers,
  public.receive_transactions, public.loan_transactions IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.issue_vouchers
  ADD COLUMN IF NOT EXISTS approved_items jsonb,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text,
  ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE public.receive_transactions ADD COLUMN IF NOT EXISTS ppe_item_id bigint;
ALTER TABLE public.ppe_documents ADD COLUMN IF NOT EXISTS storage_path text;

CREATE TABLE IF NOT EXISTS public.ppe_employee_access (
  line_user_id text PRIMARY KEY CHECK (line_user_id ~ '^U[0-9a-f]{32}$'),
  employee_id text NOT NULL UNIQUE CHECK (length(trim(employee_id)) BETWEEN 1 AND 50),
  employee_name text NOT NULL CHECK (length(trim(employee_name)) BETWEEN 1 AND 150),
  department text NOT NULL CHECK (length(trim(department)) BETWEEN 1 AND 150),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.ppe_inventory_requests (
  actor text NOT NULL,
  request_id uuid NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor, request_id)
);

CREATE TABLE IF NOT EXISTS public.ppe_stock_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL,
  stock_delta bigint NOT NULL,
  loan_delta bigint NOT NULL DEFAULT 0,
  stock_after bigint NOT NULL CHECK (stock_after >= 0),
  action text NOT NULL,
  reference_id bigint NOT NULL,
  actor text NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ppe_stock_movements_item_idx ON public.ppe_stock_movements (item_id, id);
CREATE INDEX IF NOT EXISTS ppe_issue_owner_idx ON public.issue_vouchers (userid, id DESC);
CREATE INDEX IF NOT EXISTS ppe_issue_report_idx ON public.issue_vouchers ("timestamp", id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS ppe_loan_owner_idx ON public.loan_transactions (userid, "loanId" DESC);

DO $$
DECLARE
  entry record;
  max_value bigint;
  current_value bigint;
  used boolean;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('ppe_category_seq', 'categories', 'id'),
    ('ppe_item_seq', 'ppe_items', 'id'),
    ('ppe_issue_seq', 'issue_vouchers', 'id'),
    ('ppe_receive_seq', 'receive_transactions', 'id'),
    ('ppe_loan_seq', 'loan_transactions', 'loanId'),
    ('ppe_code_seq', 'ppe_items', 'code')
  ) AS sequences(sequence_name, table_name, column_name)
  LOOP
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', entry.sequence_name);
    IF entry.column_name = 'code' THEN
      SELECT max(substring(upper(trim(code)) from '^PPE([0-9]+)$')::numeric)::bigint
      INTO max_value FROM public.ppe_items;
    ELSE
      EXECUTE format('SELECT max(%I)::bigint FROM public.%I', entry.column_name, entry.table_name) INTO max_value;
    END IF;
    EXECUTE format('SELECT last_value, is_called FROM public.%I', entry.sequence_name) INTO current_value, used;
    PERFORM setval(format('public.%I', entry.sequence_name)::regclass,
      greatest(current_value, coalesce(max_value, 1)), used OR coalesce(max_value >= current_value, false));
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated', entry.sequence_name);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO service_role', entry.sequence_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.ppe_json_array(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    value := (value #>> '{}')::jsonb;
  END IF;
  IF jsonb_typeof(value) = 'array' THEN RETURN value; END IF;
  RETURN '[]'::jsonb;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.ppe_valid_items(items jsonb, allow_zero boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(items) = 'array' THEN
    (SELECT jsonb_array_length(items) BETWEEN 1 AND 100
      AND count(*) = count(DISTINCT CASE WHEN (line->>'itemId') ~ '^[1-9][0-9]{0,14}$' THEN (line->>'itemId')::bigint END)
      AND coalesce(bool_and(CASE WHEN (line->>'quantity') ~ '^[0-9]{1,6}$'
        THEN (line->>'quantity')::integer >= CASE WHEN allow_zero THEN 0 ELSE 1 END
        ELSE false END), false)
     FROM jsonb_array_elements(items) AS entries(line))
    ELSE false END;
$$;

-- Fully approved legacy vouchers used the requested quantities. Partial or
-- malformed records remain flagged for reconciliation against actual stock evidence.
UPDATE public.issue_vouchers AS voucher
SET approved_items = public.ppe_json_array(to_jsonb(voucher."itemsJson"))
WHERE voucher.status = 'approved'
  AND voucher.approved_items IS NULL
  AND public.ppe_valid_items(public.ppe_json_array(to_jsonb(voucher."itemsJson")));

CREATE OR REPLACE FUNCTION public.ppe_next_code()
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'PPE' || lpad(next_code, greatest(3, length(next_code)), '0')
  FROM (SELECT (last_value + CASE WHEN is_called THEN 1 ELSE 0 END)::text AS next_code
        FROM public.ppe_code_seq) AS preview;
$$;

CREATE OR REPLACE FUNCTION public.ppe_incomplete_issue_feedback(p_line_user text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('voucherId', v.id, 'total', progress.total,
    'ratedCount', progress.total - progress.remaining, 'missingItemIds', progress.items)
  FROM public.issue_vouchers v
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,
      count(*) FILTER (WHERE NOT reviewed) AS remaining,
      jsonb_agg((item_id)::bigint ORDER BY (item_id)::bigint) FILTER (WHERE NOT reviewed) AS items
    FROM (
      SELECT line->>'itemId' AS item_id, EXISTS (
        SELECT 1 FROM public.feedback f WHERE f.transaction_id::text = v.id::text
          AND f.item_id::text = line->>'itemId' AND coalesce(f.feedback_type, 'issue') = 'issue'
      ) AS reviewed
      FROM jsonb_array_elements(coalesce(v.approved_items, '[]'::jsonb)) AS entries(line)
    ) AS appraisals
  ) AS progress
  WHERE v.userid = p_line_user AND v.voided_at IS NULL AND v.status_received = 'received'
    AND v.status IN ('approved', 'partially_approved', 'completed') AND progress.remaining > 0
  ORDER BY v.received_at, v.id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.ppe_apply_inventory(
  p_action text, p_payload jsonb, p_actor text, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  request_row public.ppe_inventory_requests%ROWTYPE;
  voucher public.issue_vouchers%ROWTYPE;
  equipment public.ppe_items%ROWTYPE;
  loan public.loan_transactions%ROWTYPE;
  receipt public.receive_transactions%ROWTYPE;
  category public.categories%ROWTYPE;
  requested jsonb;
  actual jsonb := '[]'::jsonb;
  changed_items jsonb := '[]'::jsonb;
  outcome jsonb;
  missing_feedback jsonb;
  entry record;
  target_id bigint;
  target_item_id bigint;
  code_number text;
  stock_delta bigint;
  loan_delta bigint;
  next_status text;
  note text := left(trim(coalesce(p_payload->>'note', '')), 500);
BEGIN
  IF p_request_id IS NULL OR nullif(p_actor, '') IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'Invalid inventory request';
  END IF;
  INSERT INTO public.ppe_inventory_requests(actor, request_id, action, payload)
  VALUES (p_actor, p_request_id, p_action, p_payload) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT request_row FROM public.ppe_inventory_requests
    WHERE actor = p_actor AND request_id = p_request_id;
    IF request_row.action <> p_action OR request_row.payload <> p_payload THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'Request ID was already used for different inventory data';
    END IF;
    RETURN request_row.result || jsonb_build_object('replayed', true);
  END IF;

  CASE p_action
    WHEN 'createCategory' THEN
      INSERT INTO public.categories(id, name) VALUES (nextval('public.ppe_category_seq'), p_payload->>'name')
      RETURNING * INTO category;
      outcome := to_jsonb(category);

    WHEN 'savePpeItem' THEN
      target_id := (p_payload->>'id')::bigint;
      IF NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.name = p_payload->>'category') THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'ไม่พบหมวดหมู่ที่เลือก';
      END IF;
      IF target_id IS NULL THEN
        code_number := nextval('public.ppe_code_seq')::text;
        INSERT INTO public.ppe_items (id, code, name, category, unit, stock, "reorderPoint", "onLoanQuantity", price, image_url)
        VALUES (nextval('public.ppe_item_seq'), 'PPE' || lpad(code_number, greatest(3, length(code_number)), '0'),
          p_payload->>'name', p_payload->>'category', p_payload->>'unit', (p_payload->>'stock')::integer,
          (p_payload->>'reorderPoint')::integer, 0, (p_payload->>'price')::numeric, p_payload->>'imageUrl')
        RETURNING * INTO equipment;
        stock_delta := equipment.stock;
      ELSE
        SELECT * INTO equipment FROM public.ppe_items p WHERE p.id = target_id AND p.deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบอุปกรณ์'; END IF;
        IF coalesce(equipment.stock, 0) IS DISTINCT FROM (p_payload->>'expectedStock')::integer THEN
          RAISE SQLSTATE 'PT409' USING MESSAGE = 'ยอดสต็อกเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนแก้ไข';
        END IF;
        stock_delta := (p_payload->>'stock')::bigint - coalesce(equipment.stock, 0);
        UPDATE public.ppe_items p SET name = p_payload->>'name', category = p_payload->>'category',
          unit = p_payload->>'unit', stock = (p_payload->>'stock')::integer,
          "reorderPoint" = (p_payload->>'reorderPoint')::integer, price = (p_payload->>'price')::numeric,
          image_url = p_payload->>'imageUrl'
        WHERE p.id = target_id RETURNING * INTO equipment;
      END IF;
      IF stock_delta <> 0 THEN
        INSERT INTO public.ppe_stock_movements(item_id, stock_delta, stock_after, action, reference_id, actor, request_id)
        VALUES (equipment.id, stock_delta, equipment.stock, p_action, equipment.id, p_actor, p_request_id);
      END IF;
      outcome := jsonb_build_object('item', to_jsonb(equipment), 'isNew', target_id IS NULL);

    WHEN 'deletePpeItem' THEN
      target_id := (p_payload->>'id')::bigint;
      SELECT * INTO equipment FROM public.ppe_items p WHERE p.id = target_id AND p.deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบอุปกรณ์'; END IF;
      IF EXISTS (SELECT 1 FROM public.loan_transactions l WHERE l."itemId" = target_id AND l.status = 'on_loan') THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'อุปกรณ์ยังมีรายการยืมที่ยังไม่คืน';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.issue_vouchers v
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN v.status IN ('pending', 'processing')
          THEN public.ppe_json_array(to_jsonb(v."itemsJson"))
          ELSE coalesce(v.approved_items, public.ppe_json_array(to_jsonb(v."itemsJson"))) END) AS entries(line)
        WHERE v.voided_at IS NULL AND line->>'itemId' = target_id::text
          AND (v.status IN ('pending', 'processing') OR
            (v.status IN ('approved', 'partially_approved') AND v.status_received IS DISTINCT FROM 'received'))
      ) THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'อุปกรณ์อยู่ในใบเบิกที่กำลังดำเนินการ';
      END IF;
      UPDATE public.ppe_items p SET deleted_at = now() WHERE p.id = target_id;
      outcome := jsonb_build_object('status', 'success');

    WHEN 'addNewVoucher' THEN
      requested := p_payload->'items';
      IF NOT public.ppe_valid_items(requested) THEN
        RAISE SQLSTATE 'PT400' USING MESSAGE = 'รายการหรือจำนวนอุปกรณ์ไม่ถูกต้อง';
      END IF;
      IF p_actor NOT LIKE 'admin:%' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(p_actor, 2042));
        missing_feedback := public.ppe_incomplete_issue_feedback(p_actor);
        IF missing_feedback IS NOT NULL THEN
          RAISE SQLSTATE 'PT409' USING MESSAGE = 'กรุณาให้คะแนนอุปกรณ์ที่ได้รับก่อนสร้างใบเบิกใหม่',
            DETAIL = missing_feedback::text;
        END IF;
      END IF;
      FOR entry IN SELECT (line->>'itemId')::bigint AS item_id, (line->>'quantity')::integer AS quantity
        FROM jsonb_array_elements(requested) AS lines(line) ORDER BY 1
      LOOP
        SELECT * INTO equipment FROM public.ppe_items p WHERE p.id = entry.item_id AND p.deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'ไม่พบอุปกรณ์ในคลัง'; END IF;
        actual := actual || jsonb_build_array(jsonb_build_object('itemId', equipment.id, 'quantity', entry.quantity,
          'itemName', equipment.name, 'itemCode', equipment.code, 'unit', equipment.unit));
      END LOOP;
      SELECT * INTO voucher FROM jsonb_populate_record(NULL::public.issue_vouchers, jsonb_build_object('itemsJson', actual));
      INSERT INTO public.issue_vouchers (id, "timestamp", "user", department, employeeid, userid, status, "adminNotes", "itemsJson")
      VALUES (nextval('public.ppe_issue_seq'), now(), p_payload->>'user', p_payload->>'department',
        p_payload->>'employeeId', p_payload->>'userId', 'pending', '', voucher."itemsJson")
      RETURNING * INTO voucher;
      outcome := to_jsonb(voucher);

    WHEN 'approveVoucher', 'approvePartialVoucher', 'rejectVoucher', 'deleteVoucher', 'reverseVoucher', 'confirmReceive' THEN
      target_id := (p_payload->>'voucherId')::bigint;
      SELECT * INTO voucher FROM public.issue_vouchers v WHERE v.id = target_id FOR UPDATE;
      IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบใบเบิก'; END IF;
      IF voucher.voided_at IS NOT NULL THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'ใบเบิกถูกยกเลิกแล้ว';
      END IF;
      requested := public.ppe_json_array(to_jsonb(voucher."itemsJson"));

      CASE p_action
        WHEN 'deleteVoucher' THEN
          IF coalesce(voucher.status::text, '') NOT IN ('pending', 'rejected') OR note = '' THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'ยกเลิกได้เฉพาะใบเบิกที่รออนุมัติหรือถูกปฏิเสธ และต้องระบุเหตุผล';
          END IF;
        WHEN 'reverseVoucher' THEN
          IF coalesce(voucher.status::text, '') NOT IN ('approved', 'partially_approved') OR voucher.status_received = 'received'
             OR NOT coalesce(public.ppe_valid_items(voucher.approved_items), false) OR note = '' THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'กลับยอดได้เฉพาะใบเบิกที่ยังไม่รับและมียอดอนุมัติที่ยืนยันแล้ว';
          END IF;
          actual := voucher.approved_items;
        WHEN 'rejectVoucher' THEN
          IF voucher.status IS DISTINCT FROM 'pending' OR note = '' THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'ปฏิเสธได้เฉพาะใบเบิกที่รออนุมัติและต้องระบุเหตุผล';
          END IF;
          next_status := 'rejected';
        WHEN 'confirmReceive' THEN
          IF p_actor NOT LIKE 'admin:%' AND voucher.userid IS DISTINCT FROM p_actor THEN
            RAISE SQLSTATE 'PT403' USING MESSAGE = 'คุณไม่มีสิทธิ์ยืนยันรับของสำหรับใบเบิกนี้';
          END IF;
          IF coalesce(voucher.status::text, '') NOT IN ('approved', 'partially_approved', 'completed') OR voucher.approved_items IS NULL THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'ยังไม่มียอดอนุมัติที่ยืนยันได้สำหรับใบเบิกนี้';
          END IF;
          IF nullif(voucher.userid, '') IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(voucher.userid, 2042));
          END IF;
          IF voucher.status_received = 'received' THEN
            outcome := jsonb_build_object('status', 'already_received', 'voucher', to_jsonb(voucher));
          ELSE
            UPDATE public.issue_vouchers v SET status_received = 'received', received_at = now(),
              received_by = left(p_payload->>'receivedBy', 150) WHERE v.id = target_id RETURNING * INTO voucher;
            outcome := jsonb_build_object('status', 'received', 'voucher', to_jsonb(voucher));
          END IF;
        ELSE
          IF voucher.status IS DISTINCT FROM 'pending' OR NOT public.ppe_valid_items(requested) THEN
            RAISE SQLSTATE 'PT409' USING MESSAGE = 'ใบเบิกถูกจัดการแล้วหรือข้อมูลอุปกรณ์ไม่สมบูรณ์';
          END IF;
          actual := CASE WHEN p_action = 'approveVoucher' THEN requested ELSE p_payload->'items' END;
          IF NOT coalesce(public.ppe_valid_items(actual, true), false) THEN
            RAISE SQLSTATE 'PT400' USING MESSAGE = 'จำนวนอนุมัติไม่ถูกต้อง';
          END IF;
          IF jsonb_array_length(actual) <> jsonb_array_length(requested) OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(actual) AS a(line)
            LEFT JOIN jsonb_array_elements(requested) AS r(line) ON (a.line->>'itemId')::bigint = (r.line->>'itemId')::bigint
            WHERE r.line IS NULL OR (a.line->>'quantity')::integer > (r.line->>'quantity')::integer
          ) THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'รายการอนุมัติต้องตรงกับใบเบิกและไม่เกินจำนวนที่ขอ'; END IF;
          SELECT CASE WHEN bool_and((a.line->>'quantity')::integer = (r.line->>'quantity')::integer)
            THEN 'approved' ELSE 'partially_approved' END INTO next_status
          FROM jsonb_array_elements(actual) AS a(line)
          JOIN jsonb_array_elements(requested) AS r(line) ON (a.line->>'itemId')::bigint = (r.line->>'itemId')::bigint;
          SELECT coalesce(jsonb_agg(line), '[]'::jsonb) INTO actual
            FROM jsonb_array_elements(actual) AS lines(line) WHERE (line->>'quantity')::integer > 0;
          IF actual = '[]'::jsonb THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'ใบเบิกต้องมีอุปกรณ์ที่อนุมัติอย่างน้อยหนึ่งรายการ'; END IF;
      END CASE;

      IF actual <> '[]'::jsonb AND p_action IN ('approveVoucher', 'approvePartialVoucher', 'reverseVoucher') THEN
        FOR entry IN SELECT (line->>'itemId')::bigint AS item_id, (line->>'quantity')::integer AS quantity
          FROM jsonb_array_elements(actual) AS lines(line) ORDER BY 1
        LOOP
          stock_delta := CASE WHEN p_action = 'reverseVoucher' THEN entry.quantity ELSE -entry.quantity END;
          UPDATE public.ppe_items p SET stock = coalesce(p.stock, 0) + stock_delta
          WHERE p.id = entry.item_id AND p.deleted_at IS NULL
            AND coalesce(p.stock, 0) + stock_delta >= 0 RETURNING * INTO equipment;
          IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'สต็อกไม่พอหรืออุปกรณ์ไม่อยู่ในคลัง'; END IF;
          INSERT INTO public.ppe_stock_movements(item_id, stock_delta, stock_after, action, reference_id, actor, request_id)
          VALUES (equipment.id, stock_delta, equipment.stock, p_action, target_id, p_actor, p_request_id);
          changed_items := changed_items || jsonb_build_array(jsonb_build_object(
            'id', equipment.id, 'stock', equipment.stock, 'quantity', entry.quantity,
            'itemId', equipment.id, 'itemName', equipment.name, 'itemCode', equipment.code, 'unit', equipment.unit));
        END LOOP;
      END IF;

      IF p_action IN ('deleteVoucher', 'reverseVoucher') THEN
        UPDATE public.issue_vouchers v SET voided_at = now(), voided_by = p_actor, void_reason = note
        WHERE v.id = target_id RETURNING * INTO voucher;
      ELSIF p_action = 'rejectVoucher' THEN
        UPDATE public.issue_vouchers v SET status = 'rejected', "adminNotes" = note WHERE v.id = target_id RETURNING * INTO voucher;
      ELSIF p_action IN ('approveVoucher', 'approvePartialVoucher') THEN
        SELECT jsonb_agg(line - 'stock' - 'id') INTO actual FROM jsonb_array_elements(changed_items) AS lines(line);
        UPDATE public.issue_vouchers v SET
          status = (jsonb_populate_record(NULL::public.issue_vouchers, jsonb_build_object('status', next_status))).status,
          "adminNotes" = note, approved_items = actual, approved_at = now()
        WHERE v.id = target_id RETURNING * INTO voucher;
      END IF;
      outcome := coalesce(outcome, jsonb_build_object('voucher', to_jsonb(voucher), 'updatedStockItems', changed_items));

    WHEN 'borrowItem', 'returnItem', 'addReceiveTransaction' THEN
      loan_delta := 0;
      target_item_id := (p_payload->>'itemId')::bigint;
      IF p_action = 'borrowItem' THEN
        stock_delta := -1;
        loan_delta := 1;
        target_id := nextval('public.ppe_loan_seq');
      ELSIF p_action = 'returnItem' THEN
        target_id := (p_payload->>'loanId')::bigint;
        SELECT * INTO loan FROM public.loan_transactions l WHERE l."loanId" = target_id FOR UPDATE;
        IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบรายการยืม'; END IF;
        IF loan.status IS DISTINCT FROM 'on_loan' THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'รายการนี้ถูกคืนหรือจัดการไปแล้ว'; END IF;
        target_item_id := loan."itemId";
        stock_delta := 1;
        loan_delta := -1;
      ELSE
        stock_delta := (p_payload->>'quantity')::bigint;
        IF stock_delta IS NULL OR stock_delta NOT BETWEEN 1 AND 999999 THEN
          RAISE SQLSTATE 'PT400' USING MESSAGE = 'จำนวนรับเข้าไม่ถูกต้อง';
        END IF;
        target_id := nextval('public.ppe_receive_seq');
      END IF;
      UPDATE public.ppe_items p SET stock = coalesce(p.stock, 0) + stock_delta,
        "onLoanQuantity" = greatest(0, coalesce(p."onLoanQuantity", 0) + loan_delta)
      WHERE p.id = target_item_id AND coalesce(p.stock, 0) + stock_delta >= 0 AND (p.deleted_at IS NULL OR p_action = 'returnItem')
      RETURNING * INTO equipment;
      IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'สต็อกไม่พอหรืออุปกรณ์ไม่อยู่ในคลัง'; END IF;
      IF p_action = 'borrowItem' THEN
        SELECT * INTO loan FROM jsonb_populate_record(NULL::public.loan_transactions,
          jsonb_build_object('dueDate', p_payload->>'dueDate'));
        INSERT INTO public.loan_transactions ("loanId", "itemId", "borrowerName", employeeid, userid, department,
          "borrowDate", "dueDate", status, notes)
        VALUES (target_id, target_item_id, p_payload->>'borrowerName', p_payload->>'employeeId', p_payload->>'userId',
          p_payload->>'department', now(), loan."dueDate", 'on_loan', p_payload->>'notes') RETURNING * INTO loan;
      ELSIF p_action = 'returnItem' THEN
        UPDATE public.loan_transactions l SET status = 'returned', "returnDate" = now()
        WHERE l."loanId" = target_id RETURNING * INTO loan;
      ELSE
        SELECT * INTO receipt FROM jsonb_populate_record(NULL::public.receive_transactions, jsonb_build_object('type', p_payload->>'type'));
        INSERT INTO public.receive_transactions (id, "timestamp", "itemName", ppe_item_id, type, quantity, "user", department, status)
        VALUES (target_id, now(), equipment.name, target_item_id, receipt.type, stock_delta, p_payload->>'user',
          p_payload->>'department', 'completed') RETURNING * INTO receipt;
      END IF;
      INSERT INTO public.ppe_stock_movements(item_id, stock_delta, loan_delta, stock_after, action, reference_id, actor, request_id)
      VALUES (target_item_id, stock_delta, loan_delta, equipment.stock, p_action, target_id, p_actor, p_request_id);
      INSERT INTO public.audit_log(actor, action, entity_type, entity_id, details)
      VALUES (p_actor, p_action, CASE WHEN p_action = 'addReceiveTransaction' THEN 'receive_transactions' ELSE 'loan_transactions' END,
        target_id::text, jsonb_strip_nulls(jsonb_build_object('itemId', target_item_id, 'quantity', abs(stock_delta),
          'type', p_payload->>'type', 'department', p_payload->>'department', 'receiver', p_payload->>'user',
          'requestId', p_request_id)));
      outcome := jsonb_build_object('loan', CASE WHEN p_action <> 'addReceiveTransaction' THEN to_jsonb(loan) ELSE NULL END,
        'transaction', CASE WHEN p_action = 'addReceiveTransaction' THEN to_jsonb(receipt) ELSE NULL END,
        'updatedItem', jsonb_build_object('id', equipment.id, 'stock', equipment.stock, 'code', equipment.code,
          'onLoanQuantity', equipment."onLoanQuantity", 'name', equipment.name, 'unit', equipment.unit, 'image_url', equipment.image_url));

    ELSE RAISE SQLSTATE 'PT400' USING MESSAGE = 'Unknown inventory action';
  END CASE;
  UPDATE public.ppe_inventory_requests SET result = outcome WHERE actor = p_actor AND request_id = p_request_id;
  RETURN outcome;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'categories', 'departments', 'ppe_items', 'issue_vouchers', 'receive_transactions', 'loan_transactions',
    'feedback', 'ppe_matrix', 'ppe_documents', 'ppe_employee_access', 'ppe_inventory_requests', 'ppe_stock_movements'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END $$;

GRANT INSERT ON public.audit_log TO service_role;
DO $$
DECLARE audit_sequence regclass := pg_get_serial_sequence('public.audit_log', 'id')::regclass;
BEGIN
  IF audit_sequence IS NOT NULL THEN EXECUTE format('GRANT USAGE ON SEQUENCE %s TO service_role', audit_sequence); END IF;
END $$;

INSERT INTO storage.buckets (id, name, public) VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO UPDATE SET public = false;
DROP POLICY IF EXISTS ppe_documents_api_only ON storage.objects;
CREATE POLICY ppe_documents_api_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (bucket_id <> 'documents') WITH CHECK (bucket_id <> 'documents');

REVOKE ALL ON FUNCTION public.ppe_json_array(jsonb), public.ppe_valid_items(jsonb, boolean),
  public.ppe_next_code(), public.ppe_apply_inventory(text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_json_array(jsonb), public.ppe_valid_items(jsonb, boolean),
  public.ppe_next_code(), public.ppe_apply_inventory(text, jsonb, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.ppe_incomplete_issue_feedback(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_incomplete_issue_feedback(text) TO service_role;

COMMIT;
