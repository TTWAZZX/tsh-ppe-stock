BEGIN;

ALTER TABLE public.ppe_documents
  ADD COLUMN IF NOT EXISTS document_state text NOT NULL DEFAULT 'ready'
    CHECK (document_state IN ('uploading', 'ready', 'deleting')),
  ADD COLUMN IF NOT EXISTS document_state_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS ppe_documents_cleanup_idx ON public.ppe_documents (document_state_at, id)
  WHERE document_state IN ('uploading', 'deleting');

COMMIT;
