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
  saveDepartment:       { key: 'action.saveDepartment',   overlay: true },
  saveMatrixRule:       { key: 'action.saveMatrix',       overlay: true },
  deleteMatrixRule:     { key: 'action.deleteMatrix',     overlay: true },
  uploadDocument:       { key: 'action.uploadDoc',        overlay: true },
  deleteDocument:       { key: 'action.deleteDoc',        overlay: true },
  saveFeedback:         { key: 'action.feedback',         overlay: true },
  adminLogin:           { key: 'action.login',            overlay: true },
  updateStockLevels:    { key: 'action.stock',            overlay: true },
};

const DEFAULT_CONFIG = { key: 'action.generic', overlay: true };

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
 * @returns {Promise<any>} - result.data from server
 */
async function apiCall(action, payload = null, options = {}) {
  const config = ACTION_LOADING_KEYS[action] ?? DEFAULT_CONFIG;
  const key     = config.key;

  // Build request body
  const body = {
    action,
    payload: { ...(payload ?? {}), ...(window._adminToken ? { adminToken: window._adminToken } : {}) }
  };

  // Message for overlay
  const message = options.loadingMessage ?? _getDefaultMessage(action);

  if (options.silent) {
    return _doFetch(body, null);
  }

  return LoadingManager.wrap(
    key,
    async (signal) => _doFetch(body, signal),
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

async function _doFetch(body, signal) {
  const response = await fetch('/api/ppe', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal,  // AbortController support
  });

  if (signal?.aborted) return null;

  const result = await response.json();

  if (!response.ok) {
    const error = new Error(result.message || `API Error: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  return result.data;
}

function _getDefaultMessage(action) {
  const messages = {
    addNewVoucher:    'กำลังบันทึกใบเบิก...',
    approveVoucher:   'กำลังอนุมัติ...',
    rejectVoucher:    'กำลังปฏิเสธ...',
    confirmReceive:   'กำลังยืนยันการรับ...',
    borrowItem:       'กำลังบันทึกการยืม...',
    returnItem:       'กำลังบันทึกการคืน...',
    deletePpeItem:    'กำลังลบรายการ...',
    uploadDocument:   'กำลังอัปโหลดเอกสาร...',
    saveFeedback:     'กำลังส่งความคิดเห็น...',
    adminLogin:       'กำลังเข้าสู่ระบบ...',
  };
  return messages[action] ?? 'กำลังดำเนินการ...';
}

window.apiCall    = apiCall;
window.apiRefresh = apiRefresh;
