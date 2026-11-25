BEGIN;

CREATE OR REPLACE FUNCTION public.ppe_save_issue_feedback(
  p_voucher_id bigint, p_item_id bigint, p_line_user text, p_rating integer, p_comment text, p_employee_name text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  voucher public.issue_vouchers%ROWTYPE;
  entry public.feedback%ROWTYPE;
  name text;
BEGIN
  SELECT * INTO voucher FROM public.issue_vouchers v
  WHERE v.id = p_voucher_id AND v.userid = p_line_user AND v.voided_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'PT403' USING MESSAGE = 'คุณไม่มีสิทธิ์ประเมินใบเบิกนี้'; END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE SQLSTATE 'PT400' USING MESSAGE = 'คะแนนต้องอยู่ระหว่าง 1 ถึง 5';
  END IF;
  IF voucher.status_received IS DISTINCT FROM 'received'
    OR voucher.status NOT IN ('approved', 'partially_approved', 'completed')
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(voucher.approved_items, '[]'::jsonb)) AS lines(line)
      WHERE line->>'itemId' = p_item_id::text
    )
  THEN RAISE SQLSTATE 'PT409' USING MESSAGE = 'ให้คะแนนได้เฉพาะอุปกรณ์ที่ได้รับจริง'; END IF;

  SELECT * INTO entry FROM public.feedback f WHERE f.transaction_id::text = p_voucher_id::text
    AND f.item_id::text = p_item_id::text AND coalesce(f.feedback_type, 'issue') = 'issue'
  ORDER BY f.created_at DESC LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('status', 'success', 'data', jsonb_build_array(to_jsonb(entry)), 'alreadyRated', true); END IF;

  SELECT coalesce(lines.line->>'itemName', p.name) INTO name
  FROM jsonb_array_elements(voucher.approved_items) AS lines(line)
  LEFT JOIN public.ppe_items p ON p.id = p_item_id WHERE lines.line->>'itemId' = p_item_id::text;
  SELECT * INTO entry FROM jsonb_populate_record(NULL::public.feedback, jsonb_build_object(
    'transaction_id', p_voucher_id, 'item_id', p_item_id, 'rating', p_rating
  ));
  INSERT INTO public.feedback(transaction_id, item_id, item_name, feedback_type, rating, comment, user_name)
  VALUES (entry.transaction_id, entry.item_id, coalesce(name, 'อุปกรณ์ #' || p_item_id), 'issue',
    entry.rating, left(coalesce(p_comment, ''), 1000), left(p_employee_name, 150)) RETURNING * INTO entry;
  RETURN jsonb_build_object('status', 'success', 'data', jsonb_build_array(to_jsonb(entry)));
END;
$$;

REVOKE ALL ON FUNCTION public.ppe_save_issue_feedback(bigint, bigint, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ppe_save_issue_feedback(bigint, bigint, text, integer, text, text) TO service_role;

COMMIT;
