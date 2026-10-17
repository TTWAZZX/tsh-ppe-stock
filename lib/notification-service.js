import crypto from 'crypto';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const TERMINAL_STATUSES = new Set(['sent', 'duplicate', 'failed', 'skipped']);

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function createRetryKey(eventKey, recipient) {
  const chars = crypto.createHash('sha256').update(`${eventKey}:${recipient}`).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = '8';
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20).join('')}`;
}

function sanitizeProviderBody(value) {
  if (!value || typeof value !== 'object') return {};
  const serialized = JSON.stringify(value);
  return serialized.length <= 4000 ? value : { truncated: true, preview: serialized.slice(0, 3900) };
}

async function readProviderResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

function isRetryableStatus(status) {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

function retryDelayMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) return Math.min(2000, Math.max(250, seconds * 1000));
    const dateDelay = Date.parse(retryAfterHeader) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(2000, Math.max(250, dateDelay));
  }
  return Math.min(2000, 300 * (2 ** Math.max(0, attempt - 1)));
}

function scheduledRetryAt(attempt) {
  const delayMinutes = Math.min(60, 2 ** Math.max(0, attempt - 2));
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function publicResult(log, overrides = {}) {
  const status = overrides.status || log?.status || 'failed';
  return {
    sent: status === 'sent' || status === 'duplicate',
    accepted: status === 'sent' || status === 'duplicate',
    duplicatePrevented: status === 'duplicate',
    status,
    logId: log?.id ?? null,
    attemptCount: Number(log?.attempt_count || 0),
    maxAttempts: Number(log?.max_attempts || 0),
    requestId: log?.provider_request_id || null,
    providerStatus: log?.provider_http_status || null,
    reason: log?.last_error || overrides.reason || null,
    nextRetryAt: log?.next_attempt_at || null,
    ...overrides,
  };
}

export function createLineNotificationService({
  supabase,
  channelAccessToken,
  fetchImpl = globalThis.fetch,
  maxAttempts = process.env.NOTIFICATION_MAX_ATTEMPTS,
  inlineAttempts = process.env.NOTIFICATION_INLINE_ATTEMPTS,
  requestTimeoutMs = process.env.LINE_PUSH_TIMEOUT_MS,
} = {}) {
  if (!supabase) throw new Error('Notification service requires Supabase');

  const configuredMaxAttempts = clampInteger(maxAttempts, 5, 1, 10);
  const configuredInlineAttempts = clampInteger(inlineAttempts, 3, 1, 5);
  const configuredTimeoutMs = clampInteger(requestTimeoutMs, 7000, 1000, 15000);

  async function updateLog(id, changes) {
    const { data, error } = await supabase
      .from('notification_log')
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  async function getLog(id) {
    const { data, error } = await supabase.from('notification_log').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createOrGetLog({ recipient, messages, eventKey, notificationType, entityType, entityId, metadata }) {
    const payload = { messages, metadata: metadata && typeof metadata === 'object' ? metadata : {} };
    const row = {
      channel: 'line',
      event_key: eventKey,
      notification_type: notificationType || eventKey.split(':')[0] || 'general',
      recipient,
      entity_type: entityType || null,
      entity_id: entityId == null ? null : String(entityId),
      payload,
      payload_hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      retry_key: createRetryKey(eventKey, recipient),
      status: 'pending',
      attempt_count: 0,
      max_attempts: configuredMaxAttempts,
      next_attempt_at: new Date().toISOString(),
    };
    const { data: inserted, error: insertError } = await supabase
      .from('notification_log')
      .upsert(row, { onConflict: 'channel,event_key,recipient', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    if (insertError) throw insertError;
    if (inserted) return inserted;

    const { data: existing, error: existingError } = await supabase
      .from('notification_log')
      .select('*')
      .eq('channel', 'line')
      .eq('event_key', eventKey)
      .eq('recipient', recipient)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) throw new Error('Notification log could not be created');
    return existing;
  }

  async function claimLog(log, force = false) {
    const now = new Date().toISOString();
    let query = supabase.from('notification_log').update({ status: 'processing', updated_at: now }).eq('id', log.id);
    query = force
      ? query.in('status', ['pending', 'retry_scheduled', 'failed', 'skipped'])
      : query.in('status', ['pending', 'retry_scheduled']).lte('next_attempt_at', now);
    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw error;
    return data;
  }

  async function pushOnce(log, attemptNumber) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), configuredTimeoutMs);
    try {
      const response = await fetchImpl(LINE_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${channelAccessToken}`,
          'X-Line-Retry-Key': log.retry_key,
        },
        body: JSON.stringify({ to: log.recipient, messages: log.payload?.messages || [] }),
        signal: controller.signal,
      });
      const responseBody = sanitizeProviderBody(await readProviderResponse(response));
      return {
        attempt: attemptNumber,
        at: new Date().toISOString(),
        ok: response.ok || response.status === 409,
        retryable: isRetryableStatus(response.status),
        httpStatus: response.status,
        requestId: response.headers.get('x-line-request-id') || response.headers.get('x-line-accepted-request-id') || null,
        retryAfter: response.headers.get('retry-after') || null,
        response: responseBody,
        error: response.ok || response.status === 409 ? null : String(responseBody?.message || `LINE API HTTP ${response.status}`).slice(0, 1000),
        duplicate: response.status === 409,
      };
    } catch (error) {
      return {
        attempt: attemptNumber,
        at: new Date().toISOString(),
        ok: false,
        retryable: true,
        httpStatus: null,
        requestId: null,
        retryAfter: null,
        response: {},
        error: error?.name === 'AbortError' ? `LINE API timeout after ${configuredTimeoutMs}ms` : String(error?.message || 'LINE network error').slice(0, 1000),
        duplicate: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function deliverLog(inputLog, { force = false, attemptLimit = configuredInlineAttempts } = {}) {
    let log = await claimLog(inputLog, force);
    if (!log) return publicResult(await getLog(inputLog.id), { inProgress: true });

    const attempts = Array.isArray(log.attempts) ? [...log.attempts] : [];
    const remaining = Math.max(0, Number(log.max_attempts) - Number(log.attempt_count));
    const attemptsThisRun = Math.min(clampInteger(attemptLimit, configuredInlineAttempts, 1, 5), remaining);
    if (attemptsThisRun === 0) {
      log = await updateLog(log.id, { status: 'failed', next_attempt_at: null, last_error: 'จำนวนครั้ง retry ครบตามกำหนดแล้ว' });
      return publicResult(log);
    }

    for (let index = 0; index < attemptsThisRun; index += 1) {
      const attemptNumber = Number(log.attempt_count) + 1;
      const result = await pushOnce(log, attemptNumber);
      attempts.push(result);
      const common = {
        attempt_count: attemptNumber,
        attempts,
        provider_http_status: result.httpStatus,
        provider_request_id: result.requestId,
        provider_response: result.response,
        last_error: result.error,
        last_attempt_at: result.at,
      };

      if (result.ok) {
        log = await updateLog(log.id, {
          ...common,
          status: result.duplicate ? 'duplicate' : 'sent',
          last_error: null,
          next_attempt_at: null,
          sent_at: result.at,
        });
        return publicResult(log);
      }

      const exhausted = attemptNumber >= Number(log.max_attempts);
      if (!result.retryable || exhausted) {
        log = await updateLog(log.id, { ...common, status: 'failed', next_attempt_at: null });
        return publicResult(log);
      }

      log = await updateLog(log.id, { ...common, status: 'processing' });
      if (index < attemptsThisRun - 1) await wait(retryDelayMs(attemptNumber, result.retryAfter));
    }

    log = await updateLog(log.id, { status: 'retry_scheduled', next_attempt_at: scheduledRetryAt(Number(log.attempt_count)) });
    return publicResult(log);
  }

  async function markSkipped(input, reason) {
    try {
      const log = await createOrGetLog(input);
      if (TERMINAL_STATUSES.has(log.status)) return publicResult(log);
      return publicResult(await updateLog(log.id, { status: 'skipped', next_attempt_at: null, last_error: reason }));
    } catch (error) {
      console.error('[notification_log] skipped event could not be logged:', error.message);
      return { sent: false, accepted: false, status: 'log_unavailable', reason };
    }
  }

  async function send({ recipient, messages, eventKey, notificationType, entityType, entityId, metadata } = {}) {
    const normalizedRecipient = String(recipient || '').trim();
    const normalizedEventKey = String(eventKey || '').trim().slice(0, 250);
    const normalizedMessages = Array.isArray(messages) ? messages.slice(0, 5) : [];
    const input = {
      recipient: normalizedRecipient,
      messages: normalizedMessages,
      eventKey: normalizedEventKey || `invalid:${crypto.randomUUID()}`,
      notificationType,
      entityType,
      entityId,
      metadata,
    };
    if (!LINE_USER_ID_PATTERN.test(normalizedRecipient)) return markSkipped(input, 'invalid_or_missing_recipient');
    if (!normalizedEventKey) return markSkipped(input, 'missing_event_key');
    if (normalizedMessages.length < 1 || normalizedMessages.some(message => !message || typeof message !== 'object')) return markSkipped(input, 'invalid_messages');
    if (!channelAccessToken) return markSkipped(input, 'line_channel_access_token_not_configured');

    try {
      const log = await createOrGetLog(input);
      if (TERMINAL_STATUSES.has(log.status)) return publicResult(log, { idempotent: true });
      if (log.status === 'processing') return publicResult(log, { inProgress: true });
      if (log.status === 'retry_scheduled' && log.next_attempt_at && Date.parse(log.next_attempt_at) > Date.now()) return publicResult(log, { scheduled: true });
      return await deliverLog(log);
    } catch (error) {
      console.error('[notification_log] send aborted because durable log is unavailable:', error.message);
      return { sent: false, accepted: false, status: 'log_unavailable', reason: 'notification_log_unavailable' };
    }
  }

  async function retryById(id) {
    const logId = Number(id);
    if (!Number.isInteger(logId) || logId <= 0) throw new Error('รหัส Notification Log ไม่ถูกต้อง');
    let log = await getLog(logId);
    if (!log) throw new Error('ไม่พบ Notification Log');
    if (log.status === 'sent' || log.status === 'duplicate') return publicResult(log, { idempotent: true });
    if (Number(log.attempt_count) >= Number(log.max_attempts)) {
      log = await updateLog(log.id, {
        max_attempts: Math.min(20, Number(log.attempt_count) + configuredInlineAttempts),
        status: 'retry_scheduled',
        next_attempt_at: new Date().toISOString(),
      });
    }
    return deliverLog(log, { force: true });
  }

  async function retryDue({ limit = 10 } = {}) {
    const safeLimit = clampInteger(limit, 10, 1, 25);
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await supabase
      .from('notification_log')
      .update({ status: 'retry_scheduled', next_attempt_at: now, updated_at: now, last_error: 'Recovered stale processing notification' })
      .eq('status', 'processing')
      .lt('updated_at', stale);

    const { data, error } = await supabase
      .from('notification_log')
      .select('*')
      .eq('status', 'retry_scheduled')
      .lte('next_attempt_at', now)
      .order('next_attempt_at', { ascending: true })
      .limit(safeLimit);
    if (error) throw error;

    const results = [];
    for (const log of data || []) results.push(await deliverLog(log, { attemptLimit: 1 }));
    return { processed: results.length, sent: results.filter(result => result.sent).length, results };
  }

  async function list({ limit = 50, status } = {}) {
    const safeLimit = clampInteger(limit, 50, 1, 200);
    let query = supabase
      .from('notification_log')
      .select('id,channel,event_key,notification_type,recipient,entity_type,entity_id,status,attempt_count,max_attempts,provider_http_status,provider_request_id,last_error,next_attempt_at,last_attempt_at,sent_at,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (status) query = query.eq('status', String(status).slice(0, 30));
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(row => ({
      ...row,
      recipient: row.recipient ? `${row.recipient.slice(0, 6)}…${row.recipient.slice(-4)}` : '-',
    }));
  }

  return { send, retryById, retryDue, list };
}
