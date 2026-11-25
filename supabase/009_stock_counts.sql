BEGIN;

CREATE TABLE IF NOT EXISTS public.ppe_stock_counts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'cancelled')),
  revision integer NOT NULL DEFAULT 1,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by text NOT NULL,
  closed_at timestamptz,
  closed_by text,
  reason text
);

CREATE TABLE IF NOT EXISTS public.ppe_stock_count_lines (
  count_id bigint NOT NULL REFERENCES public.ppe_stock_counts(id),
  item_id bigint NOT NULL,
  code text,
  name text NOT NULL,
  unit text,
  expected_stock integer NOT NULL CHECK (expected_stock >= 0),
  movement_id bigint NOT NULL,
  counted_stock integer CHECK (counted_stock >= 0),
  PRIMARY KEY (count_id, item_id)
);

ALTER TABLE public.ppe_stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ppe_stock_count_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ppe_stock_counts, public.ppe_stock_count_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ppe_stock_counts, public.ppe_stock_count_lines TO service_role;
GRANT USAGE ON SEQUENCE public.ppe_stock_counts_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.ppe_get_stock_count(p_id bigint)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT to_jsonb(r) || jsonb_build_object('lines', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'item_id', l.item_id, 'code', l.code, 'name', l.name, 'unit', l.unit,
      'expected_stock', l.expected_stock, 'counted_stock', l.counted_stock,
      'state', CASE
        WHEN r.status <> 'open' THEN 'closed'
        WHEN p.id IS NULL OR p.deleted_at IS NOT NULL THEN 'removed'
        WHEN coalesce(p.stock, 0) <> l.expected_stock OR coalesce(last_move.id, 0) <> l.movement_id THEN 'changed'
        ELSE 'ready' END
    ) ORDER BY l.code, l.item_id), '[]'::jsonb)
    FROM public.ppe_stock_count_lines l
    LEFT JOIN public.ppe_items p ON p.id = l.item_id
    LEFT JOIN LATERAL (
      SELECT m.id FROM public.ppe_stock_movements m WHERE m.item_id = l.item_id ORDER BY m.id DESC LIMIT 1
    ) last_move ON r.status = 'open'
    WHERE l.count_id = r.id
  ))
  FROM public.ppe_stock_counts r WHERE r.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.ppe_mutate_stock_count(
  p_action text, p_payload jsonb, p_actor text, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  request_row public.ppe_inventory_requests%ROWTYPE;
  equipment public.ppe_items%ROWTYPE;
  stock_count public.ppe_stock_counts%ROWTYPE;
  target_id bigint;
  target_item bigint;
  item_ids bigint[];
  line_count bigint;
  changed_count bigint := 0;
  operation text := 'stockCount:' || p_action;
  reason_text text := btrim(coalesce(p_payload->>'reason', ''));
  audit_details jsonb := '{}'::jsonb;
  outcome jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('start', 'save', 'recount', 'apply', 'cancel')
    OR p_request_id IS NULL OR coalesce(p_actor, '') !~ '^admin:.+'
    OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'คำขอตรวจนับไม่ถูกต้อง';
  END IF;

  INSERT INTO public.ppe_inventory_requests(actor, request_id, action, payload)
  VALUES (p_actor, p_request_id, operation, p_payload) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT request_row FROM public.ppe_inventory_requests
    WHERE actor = p_actor AND request_id = p_request_id;
    IF request_row.action <> operation OR request_row.payload <> p_payload THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'รหัสคำขอถูกใช้กับข้อมูลอื่นแล้ว';
    END IF;
    RETURN request_row.result;
  END IF;

  IF p_action = 'start' THEN
    IF jsonb_typeof(p_payload->'itemIds') IS DISTINCT FROM 'array'
      OR coalesce(length(btrim(p_payload->>'title')), 0) NOT BETWEEN 1 AND 120 THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาระบุชื่อรอบและเลือกอุปกรณ์';
    END IF;
    SELECT array_agg(DISTINCT ids.value::bigint ORDER BY ids.value::bigint) INTO item_ids
    FROM jsonb_array_elements_text(p_payload->'itemIds') ids;
    IF coalesce(cardinality(item_ids), 0) NOT BETWEEN 1 AND 1000
      OR cardinality(item_ids) <> jsonb_array_length(p_payload->'itemIds') THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'เลือกอุปกรณ์ 1 ถึง 1,000 รายการโดยไม่ซ้ำกัน';
    END IF;
    PERFORM p.id FROM public.ppe_items p WHERE p.id = ANY(item_ids) AND p.deleted_at IS NULL ORDER BY p.id FOR UPDATE;
    GET DIAGNOSTICS line_count = ROW_COUNT;
    IF line_count <> cardinality(item_ids) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'มีอุปกรณ์ที่ออกจากคลังแล้ว กรุณาอัปเดตรายการ';
    END IF;
    INSERT INTO public.ppe_stock_counts(title, opened_by)
    VALUES (btrim(p_payload->>'title'), p_actor) RETURNING * INTO stock_count;
    INSERT INTO public.ppe_stock_count_lines(count_id, item_id, code, name, unit, expected_stock, movement_id)
    SELECT stock_count.id, p.id, p.code, p.name, p.unit, coalesce(p.stock, 0),
      coalesce((SELECT max(m.id) FROM public.ppe_stock_movements m WHERE m.item_id = p.id), 0)
    FROM public.ppe_items p WHERE p.id = ANY(item_ids);
    audit_details := jsonb_build_object('lineCount', line_count);
  ELSE
    target_id := (p_payload->>'id')::bigint;
    SELECT * INTO stock_count FROM public.ppe_stock_counts r WHERE r.id = target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบรอบตรวจนับ'; END IF;
    IF stock_count.status <> 'open' OR stock_count.revision IS DISTINCT FROM (p_payload->>'revision')::integer THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'รอบตรวจนับถูกอัปเดตแล้ว กรุณาโหลดข้อมูลล่าสุด';
    END IF;

    CASE p_action
      WHEN 'save' THEN
        IF jsonb_typeof(p_payload->'counts') IS DISTINCT FROM 'array' THEN
          RAISE SQLSTATE 'PT400' USING MESSAGE = 'ข้อมูลยอดตรวจนับไม่ถูกต้อง';
        END IF;
        SELECT count(DISTINCT c.item_id) INTO line_count
        FROM jsonb_to_recordset(p_payload->'counts') AS c(item_id bigint, counted_stock integer)
        WHERE c.counted_stock IS NULL OR c.counted_stock >= 0;
        IF line_count NOT BETWEEN 1 AND 1000 OR line_count <> jsonb_array_length(p_payload->'counts') THEN
          RAISE SQLSTATE 'PT400' USING MESSAGE = 'ยอดตรวจนับต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป และเลือกอุปกรณ์ได้ครั้งละหนึ่งรายการต่อชิ้น';
        END IF;
        UPDATE public.ppe_stock_count_lines l SET counted_stock = c.counted_stock
        FROM jsonb_to_recordset(p_payload->'counts') AS c(item_id bigint, counted_stock integer)
        WHERE l.count_id = target_id AND l.item_id = c.item_id;
        GET DIAGNOSTICS changed_count = ROW_COUNT;
        IF changed_count <> line_count THEN
          RAISE SQLSTATE 'PT400' USING MESSAGE = 'มีอุปกรณ์ที่ไม่อยู่ในรอบนี้';
        END IF;
        audit_details := jsonb_build_object('lineCount', line_count);

      WHEN 'recount' THEN
        target_item := (p_payload->>'itemId')::bigint;
        SELECT * INTO equipment FROM public.ppe_items p WHERE p.id = target_item AND p.deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'อุปกรณ์ออกจากคลังแล้ว กรุณายกเลิกรอบและเปิดใหม่'; END IF;
        SELECT jsonb_build_object('itemId', l.item_id, 'previousStock', l.expected_stock, 'previousCount', l.counted_stock,
          'latestStock', coalesce(equipment.stock, 0)) INTO audit_details
        FROM public.ppe_stock_count_lines l WHERE l.count_id = target_id AND l.item_id = target_item;
        IF NOT FOUND THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'อุปกรณ์นี้ไม่อยู่ในรอบตรวจนับ'; END IF;
        UPDATE public.ppe_stock_count_lines l SET expected_stock = coalesce(equipment.stock, 0), counted_stock = NULL,
          movement_id = coalesce((SELECT max(m.id) FROM public.ppe_stock_movements m WHERE m.item_id = target_item), 0)
        WHERE l.count_id = target_id AND l.item_id = target_item;

      WHEN 'apply' THEN
        IF EXISTS (SELECT 1 FROM public.ppe_stock_count_lines l WHERE l.count_id = target_id AND l.counted_stock IS NULL) THEN
          RAISE SQLSTATE 'PT409' USING MESSAGE = 'กรุณานับและบันทึกยอดให้ครบก่อนปิดรอบ';
        END IF;
        IF length(reason_text) NOT BETWEEN 1 AND 500 THEN
          RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาระบุเหตุผลก่อนปิดรอบ';
        END IF;
        -- Match the item-lock order used by voucher approvals and other stock mutations.
        PERFORM p.id FROM public.ppe_items p JOIN public.ppe_stock_count_lines l ON l.item_id = p.id
        WHERE l.count_id = target_id ORDER BY p.id FOR UPDATE OF p;
        IF EXISTS (
          SELECT 1 FROM public.ppe_stock_count_lines l LEFT JOIN public.ppe_items p ON p.id = l.item_id
          WHERE l.count_id = target_id AND (p.id IS NULL OR p.deleted_at IS NOT NULL
            OR coalesce(p.stock, 0) <> l.expected_stock
            OR coalesce((SELECT max(m.id) FROM public.ppe_stock_movements m WHERE m.item_id = l.item_id), 0) <> l.movement_id)
        ) THEN
          RAISE SQLSTATE 'PT409' USING MESSAGE = 'สต็อกเปลี่ยนระหว่างรอบ กรุณาตรวจรายการและนับใหม่ก่อนปิดรอบ';
        END IF;
        WITH adjusted AS (
          UPDATE public.ppe_items p SET stock = l.counted_stock
          FROM public.ppe_stock_count_lines l
          WHERE l.count_id = target_id AND p.id = l.item_id AND l.counted_stock <> l.expected_stock
          RETURNING p.id, p.stock, (l.counted_stock::bigint - l.expected_stock) AS delta
        )
        INSERT INTO public.ppe_stock_movements(item_id, stock_delta, stock_after, action, reference_id, actor, request_id)
        SELECT id, delta, stock, 'applyStockCount', target_id, p_actor, p_request_id FROM adjusted;
        GET DIAGNOSTICS changed_count = ROW_COUNT;
        audit_details := jsonb_build_object('adjustedItems', changed_count, 'reason', reason_text);

      WHEN 'cancel' THEN
        IF length(reason_text) NOT BETWEEN 1 AND 500 THEN
          RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาระบุเหตุผลที่ยกเลิกรอบ';
        END IF;
        audit_details := jsonb_build_object('reason', reason_text);
    END CASE;

    UPDATE public.ppe_stock_counts r SET revision = r.revision + 1,
      status = CASE p_action WHEN 'apply' THEN 'applied' WHEN 'cancel' THEN 'cancelled' ELSE r.status END,
      closed_at = CASE WHEN p_action IN ('apply', 'cancel') THEN now() ELSE r.closed_at END,
      closed_by = CASE WHEN p_action IN ('apply', 'cancel') THEN p_actor ELSE r.closed_by END,
      reason = CASE WHEN p_action IN ('apply', 'cancel') THEN reason_text ELSE r.reason END
    WHERE r.id = target_id RETURNING * INTO stock_count;
  END IF;

  INSERT INTO public.audit_log(actor, action, entity_type, entity_id, details)
  VALUES (p_actor, operation, 'ppe_stock_counts', stock_count.id::text,
    audit_details || jsonb_build_object('revision', stock_count.revision, 'requestId', p_request_id));
  outcome := jsonb_build_object('id', stock_count.id, 'status', stock_count.status, 'revision', stock_count.revision);
  UPDATE public.ppe_inventory_requests SET result = outcome WHERE actor = p_actor AND request_id = p_request_id;
  RETURN outcome;
END;
$$;

REVOKE ALL ON FUNCTION public.ppe_get_stock_count(bigint), public.ppe_mutate_stock_count(text, jsonb, text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_get_stock_count(bigint), public.ppe_mutate_stock_count(text, jsonb, text, uuid)
TO service_role;

COMMIT;
