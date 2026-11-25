BEGIN;

ALTER TABLE public.ppe_items ADD COLUMN IF NOT EXISTS category_id bigint;

-- Keep unresolved rows intact. Only a unique match may be assigned automatically.
WITH candidates AS (
  SELECT p.id, min(c.id) AS category_id
  FROM public.ppe_items p
  JOIN public.categories c ON lower(btrim(c.name)) = lower(btrim(p.category))
  WHERE p.category_id IS NULL AND nullif(btrim(p.category), '') IS NOT NULL
  GROUP BY p.id HAVING count(*) = 1
)
UPDATE public.ppe_items p SET category_id = candidates.category_id
FROM candidates WHERE p.id = candidates.id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ppe_items'::regclass AND conname = 'ppe_items_category_id_fkey') THEN
    ALTER TABLE public.ppe_items ADD CONSTRAINT ppe_items_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ppe_items_category_id_idx ON public.ppe_items (category_id);

CREATE OR REPLACE FUNCTION public.ppe_check_category_name()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  normalized_name text := lower(btrim(NEW.name));
BEGIN
  IF nullif(normalized_name, '') IS NULL OR length(btrim(NEW.name)) > 100 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'ชื่อหมวดหมู่ต้องมีความยาว 1 ถึง 100 ตัวอักษร';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(normalized_name, 607));
  IF EXISTS (SELECT 1 FROM public.categories c
    WHERE lower(btrim(c.name)) = normalized_name AND c.id IS DISTINCT FROM NEW.id) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'มีหมวดหมู่ชื่อนี้อยู่แล้ว';
  END IF;
  NEW.name := btrim(NEW.name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ppe_check_category_name ON public.categories;
CREATE TRIGGER ppe_check_category_name BEFORE INSERT OR UPDATE OF name ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.ppe_check_category_name();

CREATE OR REPLACE FUNCTION public.ppe_save_categorized_inventory(p_payload jsonb, p_actor text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  selected public.categories%ROWTYPE;
  prior public.ppe_inventory_requests%ROWTYPE;
  outcome jsonb;
  target_id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor || ':' || p_request_id::text, 608));
  SELECT * INTO prior FROM public.ppe_inventory_requests r
  WHERE r.actor = p_actor AND r.request_id = p_request_id;
  IF FOUND THEN
    IF prior.action = 'savePpeItem' AND prior.payload = p_payload THEN
      RETURN prior.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'รหัสคำขอนี้ถูกใช้กับข้อมูลอื่นแล้ว';
  END IF;

  IF jsonb_typeof(p_payload->'categoryId') = 'number' THEN
    SELECT * INTO selected FROM public.categories c WHERE c.id = (p_payload->>'categoryId')::bigint FOR SHARE;
  ELSE
    SELECT c.* INTO selected FROM public.categories c
    WHERE c.name = p_payload->>'category'
      AND (SELECT count(*) FROM public.categories other WHERE other.name = c.name) = 1
    FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาเลือกหมวดหมู่จากรายการปัจจุบัน'; END IF;

  -- The P1 routine still receives the compatibility label. Link the stable ID
  -- within the same transaction, then store the original request for retries.
  outcome := public.ppe_apply_inventory('savePpeItem', p_payload || jsonb_build_object('category', selected.name), p_actor, p_request_id);
  target_id := (outcome->'item'->>'id')::bigint;
  UPDATE public.ppe_items p SET category_id = selected.id WHERE p.id = target_id;
  outcome := jsonb_set(outcome, '{item,category_id}', to_jsonb(selected.id));
  UPDATE public.ppe_inventory_requests r SET payload = p_payload, result = outcome
  WHERE r.actor = p_actor AND r.request_id = p_request_id;
  RETURN outcome;
END;
$$;

REVOKE ALL ON FUNCTION public.ppe_save_categorized_inventory(jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_save_categorized_inventory(jsonb, text, uuid) TO service_role;

CREATE INDEX IF NOT EXISTS idx_notification_log_due_work
  ON public.notification_log (next_attempt_at, id) WHERE status IN ('pending', 'retry_scheduled');

COMMIT;
