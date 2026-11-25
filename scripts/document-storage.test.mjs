import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createDocumentStorage, decodePdfUpload, MAX_PDF_BYTES, MAX_PPE_REQUEST_BYTES } from '../lib/document-storage.js';

const buffer = Buffer.from('%PDF-1.7\nfixture\n%%EOF');
const project = 'https://fixture.example';

function fixture() {
  const rows = [];
  const objects = new Set();
  const flags = {};
  const query = () => {
    let operation = 'select';
    let values;
    const filters = [];
    const execute = async (single = false) => {
      const matched = rows.filter(row => filters.every(filter => filter(row)));
      if (operation === 'insert') {
        const row = { id: rows.length + 1, created_at: new Date().toISOString(), ...values };
        rows.push(row);
        return { data: row };
      }
      if (operation === 'update') {
        if (values.document_state === 'ready' && flags.failPublish) return { error: Error('publish failed') };
        for (const row of matched) Object.assign(row, values);
        if (values.document_state === 'ready' && flags.losePublishResponse) return { error: Error('response lost') };
      }
      if (operation === 'delete') {
        if (flags.failMetadataDelete) return { error: Error('database unavailable') };
        for (const row of matched) rows.splice(rows.indexOf(row), 1);
      }
      return { data: single ? matched[0] || null : matched };
    };
    return {
      select() { return this; },
      insert(data) { operation = 'insert'; values = data; return this; },
      update(data) { operation = 'update'; values = data; return this; },
      delete() { operation = 'delete'; return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      in(key, options) { filters.push(row => options.includes(row[key])); return this; },
      lt(key, value) { filters.push(row => row[key] < value); return this; },
      order() { return this; },
      limit() { return this; },
      single() { return execute(true); },
      maybeSingle() { return execute(true); },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
  };
  const supabase = {
    from(table) { assert.equal(table, 'ppe_documents'); return query(); },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'documents');
        return {
          async upload(path) { objects.add(path); return {}; },
          async remove(paths) {
            if (flags.failStorageDelete) return { error: Error('storage unavailable') };
            for (const path of paths) objects.delete(path);
            return {};
          },
          async createSignedUrl(path, expiresIn) {
            assert.equal(expiresIn, 300);
            assert.ok(objects.has(path));
            return { data: { signedUrl: project + '/' + path } };
          },
        };
      },
    },
  };
  return { service: createDocumentStorage(supabase, project), rows, objects, flags };
}

const upload = service => service.upload({ title: 'Fixture PDF', buffer, user: 'admin' });
const age = rows => { for (const row of rows) row.document_state_at = '2020-01-01T00:00:00.000Z'; };

test('accepts the PDF boundary and keeps its encoded request below the function limit', () => {
  const max = Buffer.alloc(MAX_PDF_BYTES, 0x20);
  buffer.copy(max);
  const file = { fileName: 'fixture.pdf', fileBase64: max.toString('base64') };
  assert.equal(decodePdfUpload(file).length, MAX_PDF_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ action: 'uploadDocument', payload: file })) < MAX_PPE_REQUEST_BYTES);
  assert.throws(() => decodePdfUpload({ ...file, fileBase64: Buffer.alloc(MAX_PDF_BYTES + 1).toString('base64') }), error => error.statusCode === 413);
  assert.throws(() => decodePdfUpload({ ...file, fileBase64: Buffer.from('plain text').toString('base64') }), error => error.statusCode === 400);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /file.size > 3 \* 1024 \* 1024/);
});

test('cleans up a failed publish and preserves a publish whose response was lost', async () => {
  const { service, rows, objects, flags } = fixture();
  flags.failPublish = true;
  await assert.rejects(upload(service), /publish failed/);
  assert.equal(rows.length, 0);
  assert.equal(objects.size, 0);
  flags.failPublish = false;
  flags.losePublishResponse = true;
  const doc = await upload(service);
  assert.equal(rows[0].document_state, 'ready');
  assert.equal(objects.size, 1);
  assert.match((await service.signedUrl(doc.id)).url, /\.pdf$/);
});

test('hides a document immediately and retries both storage and database cleanup', async () => {
  const { service, rows, objects, flags } = fixture();
  const doc = await upload(service);
  flags.failStorageDelete = true;
  assert.equal((await service.remove(doc.id)).status, 'cleanup_pending');
  assert.equal(rows[0].document_state, 'deleting');
  await assert.rejects(service.signedUrl(doc.id), error => error.statusCode === 404);
  age(rows);
  assert.equal((await service.retryCleanup()).failed, 1);
  flags.failStorageDelete = false;
  flags.failMetadataDelete = true;
  age(rows);
  assert.equal((await service.retryCleanup()).failed, 1);
  assert.equal(objects.size, 0);
  flags.failMetadataDelete = false;
  age(rows);
  assert.equal((await service.retryCleanup()).cleaned, 1);
  assert.equal(rows.length, 0);
});
