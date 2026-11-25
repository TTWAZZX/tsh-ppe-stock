BEGIN;

CREATE OR REPLACE FUNCTION public.ppe_issue_report(
  p_start date, p_end date, p_department text, p_status text, p_page integer, p_page_size integer, p_search text
) RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH vouchers AS (
    SELECT v.id, v."timestamp"::timestamptz AS issued_at, v."user", v.department, v.status,
      CASE WHEN v.status IN ('approved', 'partially_approved', 'completed') THEN v.approved_items
           ELSE public.ppe_json_array(to_jsonb(v."itemsJson")) END AS items
    FROM public.issue_vouchers v
    WHERE v.voided_at IS NULL
      AND (p_start IS NULL OR v."timestamp"::timestamptz >= (p_start::timestamp AT TIME ZONE 'Asia/Bangkok'))
      AND (p_end IS NULL OR v."timestamp"::timestamptz < ((p_end + 1)::timestamp AT TIME ZONE 'Asia/Bangkok'))
      AND (p_department = '' OR v.department = p_department)
      AND (p_status = 'all'
        OR (p_status = 'issued' AND v.status IN ('approved', 'partially_approved', 'completed'))
        OR (p_status = 'pending' AND v.status IN ('pending', 'processing'))
        OR (p_status = 'rejected' AND v.status = 'rejected'))
  ), filtered_rows AS MATERIALIZED (
    SELECT v.id, v.issued_at, v."user", v.department, v.status, i.line IS NULL AS unknown_quantity,
      CASE WHEN i.line->>'quantity' ~ '^[0-9]{1,6}$' THEN (i.line->>'quantity')::integer END AS quantity,
      coalesce(i.line->>'itemName', p.name, '-') AS item_name,
      coalesce(i.line->>'itemCode', p.code, '-') AS item_code, i.position
    FROM vouchers v
    LEFT JOIN LATERAL jsonb_array_elements(coalesce(v.items, '[]'::jsonb)) WITH ORDINALITY AS i(line, position) ON true
    LEFT JOIN public.ppe_items p ON p.id = CASE WHEN i.line->>'itemId' ~ '^[1-9][0-9]{0,14}$' THEN (i.line->>'itemId')::bigint END
    WHERE p_search = '' OR strpos(lower(concat_ws(' ', v.id, v."user", v.department,
      i.line->>'itemName', p.name, i.line->>'itemCode', p.code)), lower(p_search)) > 0
  ), page AS (
    SELECT * FROM filtered_rows ORDER BY issued_at DESC, id DESC, position
    OFFSET (p_page - 1)::bigint * p_page_size LIMIT p_page_size
  ), department_totals AS (
    SELECT coalesce(nullif(department, ''), 'ไม่ระบุแผนก') AS label, sum(quantity) AS quantity
    FROM filtered_rows WHERE quantity IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10
  ), item_totals AS (
    SELECT item_code, item_name, sum(quantity) AS quantity
    FROM filtered_rows WHERE quantity IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT 10
  )
  SELECT jsonb_build_object(
    'totalRows', (SELECT count(*) FROM filtered_rows),
    'voucherCount', (SELECT count(DISTINCT id) FROM filtered_rows),
    'confirmedVoucherCount', (SELECT count(DISTINCT id) FROM filtered_rows WHERE quantity IS NOT NULL),
    'totalQuantity', (SELECT coalesce(sum(quantity), 0) FROM filtered_rows),
    'unreconciledCount', (SELECT count(DISTINCT id) FROM filtered_rows WHERE unknown_quantity AND status IN ('approved', 'partially_approved', 'completed')),
    'departments', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.quantity DESC, d.label), '[]'::jsonb) FROM department_totals d),
    'items', (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.quantity DESC, i.item_code, i.item_name), '[]'::jsonb) FROM item_totals i),
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', issued_at, 'voucherId', id, 'user', "user",
      'department', department, 'status', status, 'quantity', quantity, 'itemName', item_name, 'itemCode', item_code,
      'unknownQuantity', unknown_quantity) ORDER BY issued_at DESC, id DESC, position), '[]'::jsonb) FROM page)
  );
$$;

REVOKE ALL ON FUNCTION public.ppe_issue_report(date, date, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_issue_report(date, date, text, text, integer, integer, text) TO service_role;

COMMIT;
