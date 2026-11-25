BEGIN;

-- The old partial-approval workflow audited the submitted quantities after approval.
-- Accept a single consistent audit record and leave the rest for manual review.
WITH unique_audit AS (
  SELECT entity_id, (jsonb_agg(details->'items' ORDER BY id)->0) AS actual
  FROM public.audit_log
  WHERE action = 'approvePartialVoucher' AND entity_type = 'issue_vouchers'
  GROUP BY entity_id HAVING count(*) = 1
), candidates AS MATERIALIZED (
  SELECT v.id, public.ppe_json_array(to_jsonb(v."itemsJson")) AS requested, a.actual
  FROM public.issue_vouchers v JOIN unique_audit a ON a.entity_id = v.id::text
  WHERE v.status = 'partially_approved' AND v.approved_items IS NULL
    AND public.ppe_valid_items(public.ppe_json_array(to_jsonb(v."itemsJson")))
    AND public.ppe_valid_items(a.actual, true)
), verified AS (
  SELECT c.id, jsonb_agg(jsonb_build_object('itemId', (a.line->>'itemId')::bigint, 'quantity', (a.line->>'quantity')::integer)
    ORDER BY (a.line->>'itemId')::bigint) FILTER (WHERE (a.line->>'quantity')::integer > 0) AS actual
  FROM candidates c
  CROSS JOIN LATERAL jsonb_array_elements(c.actual) AS a(line)
  LEFT JOIN LATERAL jsonb_array_elements(c.requested) AS r(line)
    ON (a.line->>'itemId')::bigint = (r.line->>'itemId')::bigint
  GROUP BY c.id, c.requested
  HAVING count(*) = jsonb_array_length(c.requested)
    AND bool_and(r.line IS NOT NULL AND (a.line->>'quantity')::integer <= (r.line->>'quantity')::integer)
    AND bool_or((a.line->>'quantity')::integer < (r.line->>'quantity')::integer)
    AND bool_or((a.line->>'quantity')::integer > 0)
)
UPDATE public.issue_vouchers v SET approved_items = verified.actual
FROM verified WHERE v.id = verified.id;

COMMIT;
