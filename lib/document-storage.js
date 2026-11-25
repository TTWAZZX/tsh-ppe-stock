import { randomUUID } from 'node:crypto';

export const MAX_PDF_BYTES = 3 * 1024 * 1024;
export const MAX_PPE_REQUEST_BYTES = 4_300_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_PDF_BYTES / 3) * 4;
const DOCUMENT_COLUMNS = 'id,title,file_type,created_at';
const CLEANUP_DELAY_MS = 30 * 60_000;

function documentError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function decodePdfUpload({ fileName, fileBase64 }) {
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.pdf') || fileName.length > 255
      || typeof fileBase64 !== 'string' || !fileBase64) {
    throw documentError(400, 'กรุณาเลือกไฟล์ PDF ที่ถูกต้อง');
  }
  if (fileBase64.length > MAX_BASE64_CHARS) throw documentError(413, 'ไฟล์ PDF ใหญ่เกิน 3 MiB');
  const buffer = Buffer.from(fileBase64, 'base64');
  if (buffer.length > MAX_PDF_BYTES) throw documentError(413, 'ไฟล์ PDF ใหญ่เกิน 3 MiB');
  if (buffer.toString('base64') !== fileBase64 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw documentError(400, 'ไฟล์นี้ไม่ใช่ PDF ที่ถูกต้อง');
  }
  return buffer;
}

function storagePath(doc, projectUrl) {
  if (doc.storage_path) return doc.storage_path;
  try {
    const url = new URL(doc.file_url);
    const prefix = '/storage/v1/object/public/documents/';
    if (url.origin !== new URL(projectUrl).origin || !url.pathname.startsWith(prefix)) return null;
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    return path && path.split('/').every(part => part && part !== '..' && part !== '.') ? path : null;
  } catch {
    return null;
  }
}

export function createDocumentStorage(supabase, projectUrl) {
  const documents = () => supabase.from('ppe_documents');
  const bucket = () => supabase.storage.from('documents');
  const currentTime = () => new Date().toISOString();

  async function transition(id, from, to) {
    const { data, error } = await documents().update({ document_state: to, document_state_at: currentTime() })
      .eq('id', id).eq('document_state', from)
      .select(DOCUMENT_COLUMNS + ',storage_path,file_url,document_state').maybeSingle();
    if (error) throw error;
    return data;
  }

  async function purge(doc) {
    const path = storagePath(doc, projectUrl);
    if (path) {
      const { error } = await bucket().remove([path]);
      if (error) throw error;
    }
    const { error } = await documents().delete().eq('id', doc.id).eq('document_state', 'deleting');
    if (error) throw error;
  }

  async function upload({ title, buffer, user }) {
    const path = randomUUID() + '.pdf';
    const { data: reserved, error: reservationError } = await documents().insert({
      title, file_url: '', storage_path: path, file_type: 'pdf', uploaded_by: user, document_state: 'uploading',
    }).select('id').single();
    if (reservationError) throw reservationError;

    try {
      const { error } = await bucket().upload(path, buffer, { contentType: 'application/pdf', upsert: false });
      if (error) throw error;
      const doc = await transition(reserved.id, 'uploading', 'ready');
      if (!doc) throw documentError(409, 'การอัปโหลดหมดเวลา กรุณาลองใหม่');
      const { id, title, file_type, created_at } = doc;
      return { id, title, file_type, created_at };
    } catch (error) {
      try {
        const pending = await transition(reserved.id, 'uploading', 'deleting');
        if (pending) await purge(pending);
        else {
          // The publish can commit even when the response is lost. Preserve a published object.
          const { data: published, error: readError } = await documents()
            .select(DOCUMENT_COLUMNS).eq('id', reserved.id).eq('document_state', 'ready').maybeSingle();
          if (readError) throw readError;
          if (published) return published;
        }
      } catch {
        console.warn(JSON.stringify({ event: 'document_cleanup_deferred', operation: 'upload' }));
      }
      throw error;
    }
  }

  async function signedUrl(id) {
    const { data: doc, error: readError } = await documents().select('storage_path,file_url')
      .eq('id', id).eq('document_state', 'ready').maybeSingle();
    if (readError) throw readError;
    if (!doc) throw documentError(404, 'ไม่พบเอกสาร');
    const path = storagePath(doc, projectUrl);
    if (!path) throw documentError(409, 'เอกสารนี้ยังไม่ได้ย้ายไปยังพื้นที่จัดเก็บภายใน');
    const { data, error } = await bucket().createSignedUrl(path, 300);
    if (error) throw error;
    return { url: data.signedUrl };
  }

  async function remove(id) {
    const doc = await transition(id, 'ready', 'deleting');
    if (!doc) {
      const { data, error } = await documents().select('id,document_state').eq('id', id).maybeSingle();
      if (error) throw error;
      if (data?.document_state === 'uploading') throw documentError(409, 'กำลังอัปโหลดเอกสาร กรุณาลองใหม่');
      if (data?.document_state === 'deleting') return { status: 'cleanup_pending' };
      return { status: 'success' };
    }
    try {
      await purge(doc);
      return { status: 'success' };
    } catch {
      console.warn(JSON.stringify({ event: 'document_cleanup_deferred', operation: 'delete' }));
      return { status: 'cleanup_pending' };
    }
  }

  async function retryCleanup() {
    const { data, error } = await documents().select('id,storage_path,file_url,document_state')
      .in('document_state', ['uploading', 'deleting'])
      .lt('document_state_at', new Date(Date.now() - CLEANUP_DELAY_MS).toISOString())
      .order('document_state_at').order('id').limit(10);
    if (error) throw error;
    const outcomes = await Promise.allSettled((data || []).map(async doc => {
      const pending = doc.document_state === 'uploading' ? await transition(doc.id, 'uploading', 'deleting') : doc;
      if (!pending) return false;
      try {
        await purge(pending);
      } catch (error) {
        // Give other due documents a turn when the oldest one repeatedly fails.
        const { error: rescheduleError } = await documents().update({ document_state_at: currentTime() })
          .eq('id', doc.id).eq('document_state', 'deleting');
        if (rescheduleError) console.warn(JSON.stringify({ event: 'document_cleanup_deferred', operation: 'reschedule' }));
        throw error;
      }
      return true;
    }));
    return {
      cleaned: outcomes.filter(result => result.status === 'fulfilled' && result.value).length,
      failed: outcomes.filter(result => result.status === 'rejected').length,
    };
  }

  return { upload, signedUrl, remove, retryCleanup };
}
