/**
 * API Client — replaces callServerFunction()
 *
 * ปัญหาเดิม:
 *   - _apiCallInProgress บล็อก ALL requests พร้อมกัน
 *   - ไม่รองรับ concurrent calls
 *   - ไม่มี AbortController
 *
 * ระบบใหม่:
 *   - แต่ละ action มี loading key ของตัวเอง
 *   - concurrent requests ต่าง key ทำงานพร้อมกันได้
 *   - deduplication สำหรับ background refresh
 *   - AbortController ทุก request
 */

/**
 * Loading key mapping สำหรับทุก action
 * Format: "scope.action"
 *
 * scope:
 *   "page"    → skeleton ระดับ page
 *   "widget"  → skeleton ระดับ component
 *   "action"  → global overlay (mutating operations)
 */
const ACTION_LOADING_KEYS = {
  // ── Read / Background (ใช้ skeleton ไม่ใช่ overlay) ──────────────────────
  getInitialData:       { key: 'page.dashboard',    deduplicate: true  },
  getFeedbackList:      { key: 'widget.feedback',   deduplicate: true  },
  getMatrixData:        { key: 'widget.matrix',     deduplicate: true  },
  getNotificationLogs:  { key: 'widget.notifications', deduplicate: true },
  getNotificationRecipients: { key: 'widget.notificationRecipients', deduplicate: true },

  // ── Mutating (ใช้ overlay เพราะ user ต้องรอ) ─────────────────────────────
  addNewVoucher:        { key: 'action.addVoucher',       overlay: true },
  approveVoucher:       { key: 'action.approveVoucher',   overlay: true },
  approvePartialVoucher:{ key: 'action.approveVoucher',   overlay: true }, // same key = dedupe
  rejectVoucher:        { key: 'action.rejectVoucher',    overlay: true },
  confirmReceive:       { key: 'action.confirmReceive',   overlay: true },
  borrowItem:           { key: 'action.borrowItem',       overlay: true },
  returnItem:           { key: 'action.returnItem',       overlay: true },
  deletePpeItem:        { key: 'action.deleteItem',       overlay: true },
  savePpeItem:          { key: 'action.saveItem',         overlay: true },
  saveCategory:         { key: 'action.saveCategory',     overlay: true },
  deleteCategory:       { key: 'action.deleteCategory',   overlay: true },
  saveDepartment:       { key: 'action.saveDepartment',   overlay: true },
  saveMatrixRule:       { key: 'action.saveMatrix',       overlay: true },
  deleteMatrixRule:     { key: 'action.deleteMatrix',     overlay: true },
  uploadDocument:       { key: 'action.uploadDoc',        overlay: true, timeoutMs: 90000 },
  deleteDocument:       { key: 'action.deleteDoc',        overlay: true },
  deleteVoucher:        { key: 'action.deleteVoucher',    overlay: true },
  saveFeedback:         { key: 'action.feedback',         overlay: true },
  adminLogin:           { key: 'action.login',            overlay: true },
  checkAdminCredentials:{ key: 'action.login',            overlay: true },
  updateStockLevels:    { key: 'action.stock',            overlay: true },
  saveNotificationRecipient: { key: 'action.notificationRecipient', overlay: true },
  toggleNotificationRecipient: { key: 'action.notificationRecipient', overlay: true },
  retryNotification:    { key: 'action.notificationRetry', overlay: true },
  retryDueNotifications:{ key: 'action.notificationRetry', overlay: true },
  runLoanDueReminders:  { key: 'action.loanReminder',      overlay: true },
};

const DEFAULT_CONFIG = { key: 'action.generic', overlay: true };
const DEFAULT_READ_TIMEOUT_MS = 30000;
const DEFAULT_ACTION_TIMEOUT_MS = 45000;

// ─── Main API Call Function ──────────────────────────────────────────────────

/**
 * Call the server API with enterprise loading management.
 * Drop-in replacement for callServerFunction().
 *
 * @param {string} action - API action name
 * @param {object|null} payload - Request payload
 * @param {object} [options]
 * @param {string} [options.loadingMessage] - Custom overlay message
 * @param {boolean} [options.silent] - Skip loading UI entirely
 * @param {number} [options.timeoutMs] - Request timeout override; use 0 to disable
 * @returns {Promise<any>} - result.data from server
 */
async function apiCall(action, payload = null, options = {}) {
  const config = ACTION_LOADING_KEYS[action] ?? DEFAULT_CONFIG;
  const key     = config.key;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const offlineError = new Error('ขณะนี้ออฟไลน์ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    offlineError.name = 'OfflineError';
    offlineError.code = 'OFFLINE';
    offlineError.retryable = true;
    window.dispatchEvent(new CustomEvent('ppe:offline-request', { detail: { action } }));
    throw offlineError;
  }

  // Prefer the cached token, but recover directly from the initialized LIFF
  // SDK when page state was restored without rerunning our assignment code.
  // LINE can resume a recent LIFF view with its SDK session still available.
  let lineAccessToken = String(window._lineAccessToken || '').trim();
  if (!lineAccessToken && !window._adminToken) {
    try {
      if (window.liff?.isLoggedIn?.()) {
        lineAccessToken = String(window.liff.getAccessToken?.() || '').trim();
        if (lineAccessToken) window._lineAccessToken = lineAccessToken;
      }
    } catch (error) {
      console.warn('Unable to recover LINE access token from LIFF SDK:', error);
    }
  }

  // Build request body
  const body = {
    action,
    payload: {
      ...(payload ?? {}),
      ...(window._adminToken ? { adminToken: window._adminToken } : {}),
      ...(lineAccessToken ? { lineAccessToken } : {}),
    }
  };

  // Message for overlay
  const message = options.loadingMessage ?? _getDefaultMessage(action);
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? (
    key.startsWith('action.') ? DEFAULT_ACTION_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS
  );

  if (options.silent) {
    return _doFetch(body, null, timeoutMs);
  }

  return LoadingManager.wrap(
    key,
    async (signal) => _doFetch(body, signal, timeoutMs),
    {
      deduplicate: config.deduplicate ?? false,
      message,
    }
  );
}

/**
 * Background refresh — silent (no overlay/skeleton shown).
 * Use for auto-refresh polling or post-mutation refresh.
 * Fix: was incorrectly using { silent: false }
 *
 * @param {string} action
 * @param {object} payload
 */
async function apiRefresh(action, payload = null) {
  return apiCall(action, payload, { silent: true });
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function _doFetch(body, signal, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
  const requestController = new AbortController();
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const requestStartedAt = now();
  const requestId = globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let metricStatus = 0;
  let metricOutcome = 'failure';
  let metricRequestId = requestId;
  let timedOut = false;
  let timeoutId = null;
  const abortFromParent = () => requestController.abort(signal?.reason);

  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });

  if (Number(timeoutMs) > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, Number(timeoutMs));
  }

  try {
    const response = await fetch('/api/ppe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
      body:    JSON.stringify(body),
      signal:  requestController.signal,
    });
    metricStatus = response.status;
    metricRequestId = response.headers?.get?.('x-request-id') || requestId;
    metricOutcome = response.ok ? 'success' : 'failure';

    if (signal?.aborted) return null;

    const result = await response.json();

    if (!response.ok) {
      const error = new Error(result.message || `API Error: ${response.status}`);
      error.statusCode = response.status;
      error.code = result.code || '';
      error.details = result.details || null;
      if (response.status === 401 && typeof window.handleLineSessionExpired === 'function') {
        try {
          error.authenticationRedirected = Boolean(await window.handleLineSessionExpired(error.message));
        } catch (reauthError) {
          console.error('LINE re-authentication failed:', reauthError);
        }
      }
      if (response.status === 403 && typeof window.handleAdminSessionExpired === 'function') {
        try {
          error.authenticationRedirected = Boolean(window.handleAdminSessionExpired(error.message));
        } catch (reauthError) {
          console.error('Admin re-authentication failed:', reauthError);
        }
      }
      throw error;
    }

    return result.data;
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error('การเชื่อมต่อใช้เวลานานเกินไป กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      timeoutError.name = 'TimeoutError';
      timeoutError.code = 'REQUEST_TIMEOUT';
      timeoutError.retryable = true;
      timeoutError.timeoutMs = Number(timeoutMs);
      throw timeoutError;
    }
    if (error instanceof TypeError && typeof navigator !== 'undefined' && navigator.onLine === false) {
      const offlineError = new Error('ขณะนี้ออฟไลน์ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
      offlineError.name = 'OfflineError';
      offlineError.code = 'OFFLINE';
      offlineError.retryable = true;
      throw offlineError;
    }
    throw error;
  } finally {
    window.PpeObservability?.recordApiMetric({
      route: '/api/ppe',
      method: 'POST',
      status: metricStatus,
      durationMs: Math.round((now() - requestStartedAt) * 10) / 10,
      outcome: metricOutcome,
      requestId: metricRequestId,
    });
    if (timeoutId !== null) clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

function _getDefaultMessage(action) {
  const messages = {
    addNewVoucher:    'กำลังบันทึกใบเบิก...',
    approveVoucher:   'กำลังอนุมัติ...',
    rejectVoucher:    'กำลังปฏิเสธ...',
    confirmReceive:   'กำลังยืนยันการรับ...',
    borrowItem:       'กำลังบันทึกการยืม...',
    returnItem:       'กำลังบันทึกการคืน...',
    saveCategory:     'กำลังบันทึกหมวดหมู่...',
    deleteCategory:   'กำลังลบหมวดหมู่...',
    deleteVoucher:    'กำลังลบใบเบิก...',
    saveMatrixRule:    'กำลังบันทึกมาตรฐาน PPE...',
    deleteMatrixRule:  'กำลังลบมาตรฐาน PPE...',
    deleteDocument:    'กำลังลบเอกสาร...',
    saveNotificationRecipient: 'กำลังบันทึกผู้รับแจ้งเตือน...',
    toggleNotificationRecipient: 'กำลังแก้ไขผู้รับแจ้งเตือน...',
    retryNotification: 'กำลังลองส่งข้อความอีกครั้ง...',
    retryDueNotifications: 'กำลังประมวลผลข้อความค้าง...',
    runLoanDueReminders: 'กำลังตรวจสอบกำหนดคืน...',
    deletePpeItem:    'กำลังลบรายการ...',
    uploadDocument:   'กำลังอัปโหลดเอกสาร...',
    saveFeedback:     'กำลังส่งความคิดเห็น...',
    adminLogin:       'กำลังเข้าสู่ระบบ...',
    checkAdminCredentials: 'กำลังเข้าสู่ระบบ...',
  };
  return messages[action] ?? 'กำลังดำเนินการ...';
}

window.apiCall    = apiCall;
window.apiRefresh = apiRefresh;
