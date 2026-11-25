BEGIN;

CREATE TABLE IF NOT EXISTS public.ppe_loan_assets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES public.ppe_items(id),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  qr_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ppe_loan_assets_label_idx ON public.ppe_loan_assets(lower(btrim(label)));
CREATE INDEX IF NOT EXISTS ppe_loan_assets_ready_idx ON public.ppe_loan_assets(item_id) WHERE available AND retired_at IS NULL;
ALTER TABLE public.ppe_loan_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ppe_loan_assets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ppe_loan_assets TO service_role;

ALTER TABLE public.loan_transactions
  ADD COLUMN IF NOT EXISTS loan_asset_id bigint REFERENCES public.ppe_loan_assets(id),
  ADD COLUMN IF NOT EXISTS loan_asset_label text;
CREATE UNIQUE INDEX IF NOT EXISTS ppe_loan_asset_active_idx ON public.loan_transactions(loan_asset_id)
  WHERE loan_asset_id IS NOT NULL AND status = 'on_loan';

CREATE OR REPLACE FUNCTION public.ppe_protect_tagged_stock()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM public.ppe_loan_assets WHERE item_id = NEW.id AND retired_at IS NULL
  ) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'กรุณารับคืนและเลิกใช้ป้าย QR ของอุปกรณ์รุ่นนี้ก่อนนำออกจากคลัง';
  END IF;
  IF coalesce(NEW.stock, 0) < coalesce(OLD.stock, 0) AND coalesce(NEW.stock, 0) < (
    SELECT count(*) FROM public.ppe_loan_assets WHERE item_id = NEW.id AND retired_at IS NULL AND available
  ) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'ยอดจะต่ำกว่าจำนวนชิ้นที่มีป้าย QR พร้อมยืม หากต้องการยืมชิ้นที่ติดป้าย ให้สแกน QR ของชิ้นนั้น';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ppe_protect_tagged_stock ON public.ppe_items;
CREATE TRIGGER ppe_protect_tagged_stock BEFORE UPDATE OF stock, deleted_at ON public.ppe_items
FOR EACH ROW EXECUTE FUNCTION public.ppe_protect_tagged_stock();

CREATE OR REPLACE FUNCTION public.ppe_mutate_loan_asset(
  p_action text, p_payload jsonb, p_actor text, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  asset public.ppe_loan_assets%ROWTYPE;
  previous public.ppe_inventory_requests%ROWTYPE;
  item_stock integer;
  item_key bigint;
  label_text text := btrim(coalesce(p_payload->>'label', ''));
  outcome jsonb;
  req_action text := 'loanAsset:' || p_action;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('register','retire') OR coalesce(p_actor,'') !~ '^admin:.+'
    OR p_request_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'ข้อมูลป้ายอุปกรณ์ไม่ถูกต้อง';
  END IF;
  INSERT INTO public.ppe_inventory_requests(actor, request_id, action, payload)
  VALUES (p_actor, p_request_id, req_action, p_payload) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT previous FROM public.ppe_inventory_requests WHERE actor = p_actor AND request_id = p_request_id;
    IF previous.action <> req_action OR previous.payload <> p_payload THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'รหัสคำขอถูกใช้กับรายการอื่นแล้ว';
    END IF;
    RETURN previous.result;
  END IF;

  IF p_action = 'register' THEN
    IF length(label_text) NOT BETWEEN 1 AND 80 THEN RAISE SQLSTATE 'PT400' USING MESSAGE = 'กรุณาระบุรหัสประจำชิ้น'; END IF;
    item_key := (p_payload->>'itemId')::bigint;
    SELECT coalesce(stock, 0) INTO item_stock FROM public.ppe_items WHERE id = item_key AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบอุปกรณ์ในคลัง'; END IF;
    IF item_stock <= (SELECT count(*) FROM public.ppe_loan_assets WHERE item_id = item_key AND retired_at IS NULL AND available) THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'ไม่มีชิ้นที่พร้อมติดป้ายเพิ่ม ตรวจยอดคงเหลือและป้ายที่มีอยู่';
    END IF;
    INSERT INTO public.ppe_loan_assets(item_id, label) VALUES (item_key, label_text)
    ON CONFLICT (lower(btrim(label))) DO NOTHING RETURNING * INTO asset;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'รหัสประจำชิ้นนี้ถูกใช้แล้ว'; END IF;
  ELSE
    SELECT a.item_id INTO item_key FROM public.ppe_loan_assets a WHERE a.id = (p_payload->>'id')::bigint;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบป้ายอุปกรณ์'; END IF;
    PERFORM p.id FROM public.ppe_items p WHERE p.id = item_key FOR UPDATE;
    UPDATE public.ppe_loan_assets a SET retired_at = now()
    WHERE a.id = (p_payload->>'id')::bigint AND a.retired_at IS NULL AND a.available RETURNING * INTO asset;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'ป้ายนี้เลิกใช้แล้วหรืออุปกรณ์ยังถูกยืมอยู่'; END IF;
  END IF;
  INSERT INTO public.audit_log(actor, action, entity_type, entity_id, details)
  VALUES (p_actor, req_action, 'ppe_loan_assets', asset.id::text, jsonb_build_object('itemId', asset.item_id, 'label', asset.label));
  outcome := jsonb_build_object('id', asset.id);
  UPDATE public.ppe_inventory_requests SET result = outcome WHERE actor = p_actor AND request_id = p_request_id;
  RETURN outcome;
END;
$$;

CREATE OR REPLACE FUNCTION public.ppe_apply_asset_loan(
  p_action text, p_payload jsonb, p_actor text, p_request_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  asset public.ppe_loan_assets%ROWTYPE;
  previous public.ppe_inventory_requests%ROWTYPE;
  outcome jsonb;
  item_key bigint;
  loan_key bigint;
  token uuid := (p_payload->>'assetToken')::uuid;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('borrowItem','returnItem') OR p_request_id IS NULL
    OR nullif(p_actor,'') IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR (p_action = 'returnItem' AND p_actor !~ '^admin:.+') THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'คำขอยืม–คืนไม่ถูกต้อง';
  END IF;
  -- Serialize a retry before reserving a tagged unit. The inventory RPC still owns the request record.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor || ':' || p_request_id::text, 0));
  SELECT * INTO previous FROM public.ppe_inventory_requests WHERE actor = p_actor AND request_id = p_request_id;
  IF FOUND THEN
    RETURN public.ppe_apply_inventory(p_action, p_payload, p_actor, p_request_id);
  END IF;

  IF p_action = 'borrowItem' AND token IS NOT NULL THEN
    item_key := (p_payload->>'itemId')::bigint;
    PERFORM p.id FROM public.ppe_items p WHERE p.id = item_key AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'ไม่พบอุปกรณ์ในคลัง'; END IF;
    UPDATE public.ppe_loan_assets a SET available = false
    WHERE a.item_id = item_key AND a.qr_token = token AND a.available AND a.retired_at IS NULL
    RETURNING * INTO asset;
    IF NOT FOUND THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'อุปกรณ์ตามป้ายนี้ไม่พร้อมให้ยืม กรุณาสแกนชิ้นอื่น'; END IF;
  ELSIF p_action = 'returnItem' AND token IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.loan_transactions l JOIN public.ppe_loan_assets a ON a.id = l.loan_asset_id
    WHERE l."loanId" = (p_payload->>'loanId')::bigint AND a.qr_token = token
  ) THEN
    RAISE SQLSTATE 'PT409' USING MESSAGE = 'ป้าย QR ไม่ตรงกับรายการที่ต้องการรับคืน';
  END IF;

  outcome := public.ppe_apply_inventory(p_action, p_payload, p_actor, p_request_id);
  IF p_action = 'borrowItem' AND asset.id IS NOT NULL THEN
    loan_key := (outcome#>>'{loan,loanId}')::bigint;
    UPDATE public.loan_transactions l SET loan_asset_id = asset.id, loan_asset_label = asset.label WHERE l."loanId" = loan_key;
    outcome := jsonb_set(outcome, '{loan}', (outcome->'loan') || jsonb_build_object('loan_asset_id', asset.id, 'loan_asset_label', asset.label));
    UPDATE public.ppe_inventory_requests SET result = outcome WHERE actor = p_actor AND request_id = p_request_id;
  ELSIF p_action = 'returnItem' THEN
    UPDATE public.ppe_loan_assets SET available = true WHERE id = (outcome#>>'{loan,loan_asset_id}')::bigint;
  END IF;
  RETURN outcome;
END;
$$;

REVOKE ALL ON FUNCTION public.ppe_protect_tagged_stock(), public.ppe_mutate_loan_asset(text,jsonb,text,uuid),
  public.ppe_apply_asset_loan(text,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_protect_tagged_stock(), public.ppe_mutate_loan_asset(text,jsonb,text,uuid),
  public.ppe_apply_asset_loan(text,jsonb,text,uuid) TO service_role;

COMMIT;
