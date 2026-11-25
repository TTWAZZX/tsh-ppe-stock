BEGIN;

CREATE INDEX IF NOT EXISTS ppe_stock_movements_issue_date_idx
  ON public.ppe_stock_movements (created_at, reference_id)
  WHERE action IN ('approveVoucher', 'approvePartialVoucher') AND stock_delta < 0;
CREATE INDEX IF NOT EXISTS ppe_stock_movements_issue_ref_idx
  ON public.ppe_stock_movements (reference_id)
  WHERE action IN ('approveVoucher', 'approvePartialVoucher') AND stock_delta < 0;

CREATE OR REPLACE FUNCTION public.ppe_purchase_plan(p_history_days integer, p_coverage_days integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  snapshot timestamptz := statement_timestamp();
  today date := (snapshot AT TIME ZONE 'Asia/Bangkok')::date;
  start_day date;
  from_time timestamptz;
  result jsonb;
BEGIN
  IF p_history_days IS NULL OR p_history_days NOT IN (30, 60, 90)
    OR p_coverage_days IS NULL OR p_coverage_days NOT BETWEEN 1 AND 365 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'เลือกช่วงย้อนหลัง 30, 60 หรือ 90 วัน และระบุวันที่ต้องการให้สต็อกพอใช้ 1 ถึง 365 วัน';
  END IF;
  start_day := today - (p_history_days - 1);
  from_time := start_day::timestamp AT TIME ZONE 'Asia/Bangkok';

  WITH movement_usage AS (
    SELECT m.item_id, sum(-m.stock_delta) AS quantity
    FROM public.ppe_stock_movements m
    JOIN public.issue_vouchers v ON v.id = m.reference_id
    WHERE m.action IN ('approveVoucher', 'approvePartialVoucher') AND m.stock_delta < 0
      AND m.created_at BETWEEN from_time AND snapshot AND v.voided_at IS NULL
      AND v.status IN ('approved', 'partially_approved', 'completed')
    GROUP BY m.item_id
  ), legacy_vouchers AS (
    SELECT v.id, v.approved_items
    FROM public.issue_vouchers v
    WHERE v."timestamp"::timestamptz BETWEEN from_time AND snapshot AND v.voided_at IS NULL
      AND v.status IN ('approved', 'partially_approved', 'completed')
      AND NOT EXISTS (
        SELECT 1 FROM public.ppe_stock_movements m WHERE m.reference_id = v.id
          AND m.action IN ('approveVoucher', 'approvePartialVoucher') AND m.stock_delta < 0
      )
  ), legacy_lines AS MATERIALIZED (
    SELECT v.id,
      CASE WHEN e.line->>'itemId' ~ '^[1-9][0-9]{0,17}$' THEN (e.line->>'itemId')::bigint END AS item_id,
      CASE WHEN e.line->>'quantity' ~ '^[0-9]{1,6}$' THEN (e.line->>'quantity')::integer END AS quantity
    FROM legacy_vouchers v
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(v.approved_items) = 'array' THEN v.approved_items ELSE '[]'::jsonb END
    ) e(line) ON true
  ), usage AS (
    SELECT u.item_id, sum(u.quantity) AS quantity
    FROM (
      SELECT item_id, quantity FROM movement_usage
      UNION ALL
      SELECT item_id, quantity FROM legacy_lines WHERE item_id IS NOT NULL AND quantity > 0
    ) u GROUP BY u.item_id
  ), tagged AS (
    SELECT a.item_id, count(*) FILTER (WHERE a.available) AS quantity, count(*) AS active_tags
    FROM public.ppe_loan_assets a WHERE a.retired_at IS NULL GROUP BY a.item_id
  ), catalog AS (
    SELECT p.id, p.code, p.name, p.unit, coalesce(c.name, p.category, '') AS category,
      greatest(coalesce(p.stock, 0), 0) AS stock,
      coalesce(t.quantity, 0) AS tagged_stock,
      greatest(coalesce(p.stock, 0) - coalesce(t.quantity, 0), 0) AS available_stock,
      greatest(coalesce(p."reorderPoint", 0), 0) AS reorder_point,
      coalesce(u.quantity, 0) AS issued,
      coalesce(u.quantity, 0)::numeric / p_history_days AS daily_usage,
      coalesce(t.active_tags, 0) > 0 AND coalesce(p.stock, 0) <= coalesce(t.quantity, 0)
        AND coalesce(u.quantity, 0) = 0 AS loan_only
    FROM public.ppe_items p
    LEFT JOIN public.categories c ON c.id = p.category_id
    LEFT JOIN usage u ON u.item_id = p.id
    LEFT JOIN tagged t ON t.item_id = p.id
    WHERE p.deleted_at IS NULL
  ), targets AS (
    SELECT catalog.*, CASE WHEN loan_only THEN 0 ELSE greatest(reorder_point, ceil(issued::numeric * p_coverage_days / p_history_days)) END AS target_stock,
      NOT loan_only AND reorder_point > 0 AND available_stock <= reorder_point AS at_reorder_point
    FROM catalog
  ), rows AS (
    SELECT targets.*, CASE WHEN loan_only THEN 0 ELSE greatest(target_stock - available_stock, 0) END AS suggested
    FROM targets
  )
  SELECT jsonb_build_object(
    'startDate', start_day, 'endDate', today, 'asOf', snapshot,
    'historyDays', p_history_days, 'coverageDays', p_coverage_days,
    'unreconciledCount', (SELECT count(DISTINCT id) FROM legacy_lines WHERE quantity IS NULL OR item_id IS NULL),
    'legacyVoucherCount', (SELECT count(DISTINCT id) FROM legacy_lines WHERE item_id IS NOT NULL AND quantity > 0),
    'rows', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY
      (r.suggested > 0) DESC, r.at_reorder_point DESC, (r.available_stock = 0) DESC, r.code, r.id), '[]'::jsonb) FROM rows r)
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.ppe_purchase_plan(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_purchase_plan(integer, integer) TO service_role;

COMMIT;
