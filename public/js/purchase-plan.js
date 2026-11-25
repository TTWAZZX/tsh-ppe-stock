(() => {
  const byId = id => document.getElementById(id);
  const history = byId('purchaseHistoryDays');
  const coverage = byId('purchaseCoverageDays');
  const filter = byId('purchaseFilter');
  const search = byId('purchaseSearch');
  const selectPage = byId('purchaseSelectPage');
  const exportButton = byId('purchaseExport');
  const results = byId('purchasePlanResults');
  const status = byId('purchasePlanStatus');
  const list = byId('purchasePlanRows');
  const qty = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
  const shortDate = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
  const snapshotDate = new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
  });
  const pageSize = 20;
  const selected = new Set();
  const overrides = new Map();
  let plan = null;
  let request = null;
  let page = 1;
  let visible = [];
  let current = false;

  function settingsMatch() {
    return Boolean(plan && Number(history.value) === plan.historyDays && Number(coverage.value) === plan.coverageDays);
  }

  function amount(row) {
    return overrides.has(row.id) ? overrides.get(row.id) : row.suggested;
  }

  function canOrder(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function syncSelection() {
    const checked = visible.filter(row => selected.has(row.id)).length;
    const selectable = visible.filter(row => canOrder(amount(row)));
    selectPage.checked = selectable.length > 0 && selectable.every(row => selected.has(row.id));
    selectPage.indeterminate = checked > 0 && !selectPage.checked;
    selectPage.disabled = !selectable.length || Boolean(request);
    const hasInvalid = plan?.rows.some(row => selected.has(row.id) && !canOrder(amount(row)));
    byId('purchaseSelectionStatus').textContent = hasInvalid
      ? 'กรอกจำนวนเต็มมากกว่า 0 ให้ครบทุกรายการที่เลือกก่อนส่งออก'
      : `เลือกสำหรับส่งออก ${qty.format(selected.size)} รายการ`;
    exportButton.disabled = !current || !settingsMatch() || Boolean(request) || !selected.size || hasInvalid;
  }

  function renderRow(row) {
    const label = escapeLoanText([row.code, row.name].filter(Boolean).join(' '));
    const badge = row.loan_only ? 'อุปกรณ์ติดป้ายสำหรับยืม' : row.available_stock === 0 ? 'ไม่มีสต็อกที่เบิกได้'
      : row.at_reorder_point ? 'ถึงจุดสั่งซื้อ' : row.suggested > 0 ? 'ต่ำกว่าเป้าหมาย' : '';
    const metric = (label, value) => `<div><dt class="text-gray-600">${label}</dt><dd class="font-semibold text-gray-800">${qty.format(value)}</dd></div>`;
    const value = amount(row);
    return `<li class="rounded-xl border border-gray-200 p-3" data-purchase-row="${Number(row.id)}">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 break-words">
          <p class="font-bold text-gray-800">${escapeLoanText(row.name || row.code)}</p>
          <p class="text-xs text-gray-600">${escapeLoanText([row.code, row.category, row.unit].filter(Boolean).join(' · '))}</p>
        </div>
        ${badge ? `<span class="rounded-lg bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">${badge}</span>` : ''}
      </div>
      <div class="mt-3 grid gap-3 lg:grid-cols-4">
        <dl class="grid grid-cols-2 gap-2 text-sm lg:col-span-3 sm:grid-cols-3">
          ${metric('คงเหลือในคลัง', row.stock)}
          ${metric('เบิกได้', row.available_stock)}
          ${metric('จุดสั่งซื้อ', row.reorder_point)}
          ${metric('ยอดเบิกย้อนหลัง', row.issued)}
          ${metric('เบิกเฉลี่ยต่อวัน', row.daily_usage)}
          ${metric('ยอดเป้าหมาย', row.target_stock)}
        </dl>
        <div class="flex flex-wrap items-end gap-3 rounded-lg bg-blue-50 p-2 text-sm">
          <div class="min-w-0 flex-1">
            <label for="purchaseQuantity${Number(row.id)}" class="block font-semibold text-blue-900">จำนวนสำหรับส่งออก<span class="sr-only"> ${label}</span></label>
            <input id="purchaseQuantity${Number(row.id)}" data-order="${Number(row.id)}" type="number" min="0" max="${Number.MAX_SAFE_INTEGER}" step="1"
              inputmode="numeric" value="${Number.isFinite(value) ? value : ''}"
              class="min-h-11 w-full rounded-lg border border-blue-200 bg-white px-2">
            <p class="text-xs text-blue-800">แนะนำ ${qty.format(row.suggested)}</p>
          </div>
          <label class="inline-flex min-h-11 items-center gap-2"><input type="checkbox" data-select-row="${Number(row.id)}"
            ${selected.has(row.id) ? 'checked' : ''} aria-label="เลือก ${label}"> เลือก</label>
        </div>
      </div>
      ${row.tagged_stock > 0 ? `<p class="mt-2 text-xs text-gray-600">กันไว้สำหรับยืมด้วยป้าย QR ${qty.format(row.tagged_stock)} ${escapeLoanText(row.unit || '')}</p>` : ''}
    </li>`;
  }

  function render() {
    if (!plan) return;
    const query = search.value.trim().toLocaleLowerCase('th-TH');
    const rows = plan.rows.filter(row => {
      const matches = [row.code, row.name, row.category].filter(Boolean).join(' ').toLocaleLowerCase('th-TH').includes(query);
      const mode = filter.value;
      return matches && (mode === 'all' || row.suggested > 0
        || (mode === 'attention' && !row.loan_only && (row.at_reorder_point || !row.available_stock)));
    });
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.max(1, Math.min(page, totalPages));
    visible = rows.slice((page - 1) * pageSize, page * pageSize);
    list.innerHTML = visible.length ? visible.map(renderRow).join('') : '<li class="p-3 text-sm text-gray-600">ไม่พบรายการตามตัวกรอง</li>';
    byId('purchasePagination').textContent = `หน้า ${page}/${totalPages} · พบ ${qty.format(rows.length)} รายการ`;
    byId('purchasePrevious').disabled = page === 1;
    byId('purchaseNext').disabled = page === totalPages;
    syncSelection();
  }

  async function calculate() {
    if (request || !isAdmin) return;
    const marker = {};
    request = marker;
    current = false;
    byId('purchaseCalculate').disabled = true;
    status.textContent = 'กำลังคำนวณจากสต็อกและยอดเบิก…';
    syncSelection();
    try {
      const data = await apiCall('getPurchasePlan', {
        historyDays: Number(history.value), coverageDays: Number(coverage.value),
      }, { silent: true });
      if (request !== marker || !isAdmin) return;
      plan = data;
      current = true;
      const ids = new Set(plan.rows.map(row => row.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      for (const id of overrides.keys()) if (!ids.has(id)) overrides.delete(id);
      page = 1;
      byId('purchasePlanSource').textContent = `ยอดเบิก ${shortDate.format(new Date(plan.startDate))} – ${shortDate.format(new Date(plan.endDate))} · เป้าหมาย ${plan.coverageDays} วัน · คำนวณเมื่อ ${snapshotDate.format(new Date(plan.asOf))}`;
      const warning = byId('purchasePlanWarning');
      warning.textContent = plan.unreconciledCount > 0
        ? `มีใบเบิกเก่า ${qty.format(plan.unreconciledCount)} ใบที่ข้อมูลไม่ครบ ระบบนับเฉพาะยอดที่ตรวจสอบได้` : '';
      warning.classList.toggle('hidden', !warning.textContent);
      results.classList.remove('hidden');
      status.textContent = settingsMatch() ? '' : 'กดคำนวณใหม่เพื่อใช้ช่วงวันที่เลือก';
      render();
    } catch (error) {
      if (request === marker && !error.authenticationRedirected) status.textContent = error.message || 'คำนวณรายการเตรียมสั่งซื้อไม่สำเร็จ';
    } finally {
      if (request === marker) {
        request = null;
        byId('purchaseCalculate').disabled = false;
        syncSelection();
      }
    }
  }

  byId('purchasePlanForm').addEventListener('submit', event => {
    event.preventDefault();
    calculate();
  });
  byId('purchasePlanForm').addEventListener('input', () => {
    if (!request && plan) status.textContent = settingsMatch() && current ? '' : 'กดคำนวณใหม่ก่อนส่งออก';
    syncSelection();
  });
  search.addEventListener('input', () => { page = 1; render(); });
  filter.addEventListener('change', () => { page = 1; render(); });
  byId('purchasePrevious').addEventListener('click', () => { page--; render(); });
  byId('purchaseNext').addEventListener('click', () => { page++; render(); });
  selectPage.addEventListener('change', () => {
    for (const row of visible) {
      if (!selectPage.checked) selected.delete(row.id);
      else if (canOrder(amount(row))) selected.add(row.id);
    }
    render();
  });
  list.addEventListener('input', event => {
    const field = event.target;
    if (!field.dataset.order) return;
    const id = Number(field.dataset.order);
    const value = Number(field.value);
    if (!field.validity.valid || field.value === '') overrides.set(id, NaN);
    else overrides.set(id, value);
    syncSelection();
  });
  list.addEventListener('change', event => {
    const field = event.target;
    if (!field.dataset.selectRow) return;
    const id = Number(field.dataset.selectRow);
    if (field.checked) selected.add(id);
    else selected.delete(id);
    syncSelection();
  });

  exportButton.addEventListener('click', () => {
    if (!isAdmin || exportButton.disabled || !plan) return;
    const headers = ['รหัส', 'อุปกรณ์', 'หมวดหมู่', 'หน่วย', 'คงเหลือในคลัง', 'กันสำหรับยืม QR', 'เบิกได้', 'จุดสั่งซื้อ',
      'ยอดเบิกย้อนหลัง', 'เบิกเฉลี่ยต่อวัน', 'ยอดเป้าหมาย', 'แนะนำ', 'จำนวนส่งให้จัดซื้อ', 'ตั้งแต่วันที่', 'ถึงวันที่', 'เป้าหมายพอใช้ (วัน)', 'เวลาที่คำนวณ'];
    const rows = plan.rows.filter(row => selected.has(row.id)).map(row => [
      row.code, row.name, row.category, row.unit, row.stock, row.tagged_stock, row.available_stock, row.reorder_point,
      row.issued, row.daily_usage, row.target_stock, row.suggested, amount(row), plan.startDate, plan.endDate, plan.coverageDays, plan.asOf,
    ]);
    const csv = [headers, ...rows].map(row => row.map(value => {
      if (typeof value === 'string' && /^\s*[=+\-@]/.test(value.trimStart())) return csvCell("'" + value);
      return csvCell(value);
    }).join(',')).join('\r\n');
    downloadCsvFile('\ufeff' + csv, `ppe-purchase-plan-${plan.endDate}.csv`);
  });

  window.PurchasePlan = {
    load() { if (!plan && !request) calculate(); },
    reset() {
      plan = null;
      request = null;
      current = false;
      page = 1;
      visible = [];
      selected.clear();
      overrides.clear();
      status.textContent = '';
      list.replaceChildren();
      byId('purchaseCalculate').disabled = false;
      results.classList.add('hidden');
    },
  };
})();
