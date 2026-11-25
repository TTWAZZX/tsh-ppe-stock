(() => {
  const page = document.getElementById('stockCountPage');
  const content = document.getElementById('stockCountContent');
  const status = document.getElementById('stockCountStatus');
  const statuses = { open: 'กำลังตรวจนับ', applied: 'ปิดรอบแล้ว', cancelled: 'ยกเลิกรอบ' };
  const panel = 'rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6';
  const button = 'min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold disabled:opacity-50';
  const primary = 'min-h-11 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50';
  const input = 'min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';
  const drafts = new Map();
  const selection = new Set();
  let rounds = [];
  let nextBefore = null;
  let round = null;
  let roundId = null;
  let request = null;
  let view = '';
  let lineSearch = '';

  function report(message = '') {
    status.textContent = message;
    status.classList.toggle('hidden', !message);
  }

  function dateLabel(value) {
    return new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  }

  function setBusy() {
    content.setAttribute('aria-busy', String(Boolean(request)));
    const area = content.querySelector('fieldset');
    if (area) area.disabled = Boolean(request);
  }

  async function perform(task) {
    if (request || !isAdmin) return;
    const current = {};
    request = current;
    setBusy();
    report();
    try {
      await task();
    } catch (error) {
      if (request === current && !error.authenticationRedirected) report(error.message || 'ทำรายการตรวจนับไม่สำเร็จ');
    } finally {
      if (request === current) {
        request = null;
        setBusy();
      }
    }
  }

  function show(markup) {
    content.innerHTML = `<fieldset class="min-w-0 space-y-4">${markup}</fieldset>`;
    setBusy();
  }

  function renderRounds() {
    show(`<section class="${panel} space-y-3" aria-labelledby="stockCountRoundsTitle">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id="stockCountRoundsTitle" class="font-bold text-gray-800">รอบตรวจนับ</h3>
        <div class="flex flex-wrap gap-2">
          <button type="button" data-action="reloadList" class="${button}">โหลดใหม่</button>
          <button type="button" data-action="new" class="${primary}">เปิดรอบใหม่</button>
        </div>
      </div>
      ${rounds.length ? `<ul class="space-y-2">${rounds.map(row => `<li>
        <button type="button" data-round="${Number(row.id)}" class="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3 text-left hover:bg-blue-50">
          <span class="min-w-0 break-words"><span class="block font-semibold text-gray-800">#${Number(row.id)} ${escapeLoanText(row.title)}</span>
          <span class="text-sm text-gray-600">${dateLabel(row.opened_at)}</span></span>
          <span class="rounded-lg bg-blue-50 px-2 py-1 text-sm font-semibold text-blue-700">${statuses[row.status]}</span>
        </button>
      </li>`).join('')}</ul>` : '<p class="text-sm text-gray-600">ยังไม่มีรอบตรวจนับ</p>'}
      ${nextBefore ? `<button type="button" data-action="more" class="${button}">ดูรอบก่อนหน้า</button>` : ''}
    </section>`);
  }

  async function loadRounds(before = null) {
    view = 'list';
    round = null;
    roundId = null;
    drafts.clear();
    if (!before) {
      rounds = [];
      nextBefore = null;
    }
    renderRounds();
    const data = await apiCall('listStockCounts', before ? { before } : null, { silent: true });
    if (!isAdmin) return;
    rounds.push(...data.rounds);
    nextBefore = data.nextBefore;
    renderRounds();
  }

  function renderStart() {
    view = 'start';
    selection.clear();
    show(`<section class="${panel} space-y-3" aria-labelledby="stockCountNewTitle">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 id="stockCountNewTitle" class="font-bold text-gray-800">เปิดรอบตรวจนับ</h3>
        <button type="button" data-action="back" class="${button}">กลับไปรอบตรวจนับ</button>
      </div>
      <label class="block text-sm font-semibold" for="stockCountTitle">ชื่อรอบ</label>
      <input type="text" id="stockCountTitle" maxlength="120" class="${input}" placeholder="เช่น รอบตรวจนับประจำเดือน">
      <label class="block text-sm font-semibold" for="stockCountSearch">เลือกอุปกรณ์ในรอบนี้</label>
      <input type="search" id="stockCountSearch" class="${input}" placeholder="ค้นหาด้วยชื่อหรือรหัส PPE">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <label class="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" id="stockCountSelectVisible"> เลือกทั้งหมดที่แสดง</label>
        <span id="stockCountSelected" class="text-sm text-gray-600" role="status"></span>
      </div>
      <div id="stockCountCatalog" class="max-h-72 space-y-2 overflow-y-auto"></div>
      <button type="button" data-action="start" class="${primary}">เริ่มตรวจนับ</button>
    </section>`);
    renderCatalog();
    document.getElementById('stockCountTitle').focus();
  }

  function catalogItems() {
    const search = document.getElementById('stockCountSearch').value.trim().toLocaleLowerCase('th-TH');
    return (currentData.ppeItems || []).filter(item =>
      !item.deleted_at && `${item.code || ''} ${item.name}`.toLocaleLowerCase('th-TH').includes(search));
  }

  function syncSelection() {
    const visible = catalogItems();
    const selectedVisible = visible.filter(item => selection.has(Number(item.id))).length;
    const selectAll = document.getElementById('stockCountSelectVisible');
    selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
    selectAll.indeterminate = selectedVisible > 0 && !selectAll.checked;
    selectAll.disabled = visible.length === 0;
    document.getElementById('stockCountSelected').textContent = `เลือกแล้ว ${selection.size.toLocaleString('th-TH')} รายการ`;
  }

  function renderCatalog() {
    document.getElementById('stockCountCatalog').innerHTML = catalogItems().map(item => {
      const id = Number(item.id);
      return `<label class="flex min-h-11 items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
        <input type="checkbox" data-item="${id}" ${selection.has(id) ? 'checked' : ''}>
        <span class="min-w-0 break-words text-sm">${escapeLoanText(item.code)} ${escapeLoanText(item.name)}</span>
      </label>`;
    }).join('') || '<p class="text-sm text-gray-600">ไม่พบอุปกรณ์ที่ค้นหา</p>';
    syncSelection();
  }

  function difference(value, expected) {
    if (value === '' || value == null || !Number.isInteger(Number(value))
      || Number(value) < 0 || Number(value) > 2147483647) return '—';
    const delta = Number(value) - expected;
    return delta > 0 ? `+${delta}` : String(delta);
  }

  function renderRound() {
    if (!round) {
      show(`<section class="${panel} flex flex-wrap gap-2">
        <button type="button" data-action="reloadRound" class="${button}">โหลดรายละเอียดรอบ</button>
        <button type="button" data-action="back" class="${button}">กลับไปรอบตรวจนับ</button>
      </section>`);
      return;
    }
    const open = round.status === 'open';
    show(`<section class="${panel} space-y-3" aria-labelledby="stockCountDetailTitle">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 id="stockCountDetailTitle" class="break-words font-bold text-gray-800">#${Number(round.id)} ${escapeLoanText(round.title)}</h3>
          <p class="mt-1 text-sm text-gray-600">${statuses[round.status]} · เปิด ${dateLabel(round.opened_at)}</p>
          ${round.closed_at ? `<p class="text-sm text-gray-600">ปิด ${dateLabel(round.closed_at)} โดย ${escapeLoanText(round.closed_by)}</p>
            <p class="break-words text-sm text-gray-700">เหตุผล ${escapeLoanText(round.reason)}</p>` : ''}
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" data-action="reloadRound" class="${button}">โหลดรอบล่าสุด</button>
          <button type="button" data-action="back" class="${button}">กลับไปรอบตรวจนับ</button>
        </div>
      </div>
      <p id="stockCountProgress" class="text-sm text-gray-600" role="status"></p>
      ${open && round.lines.some(line => line.state === 'changed' || line.state === 'removed')
        ? '<p class="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">มีรายการเปลี่ยนระหว่างรอบ ตรวจรายการที่แจ้งเตือนก่อนปรับยอด</p>' : ''}
      ${open ? `<div class="flex flex-wrap gap-2">
        <button type="button" data-action="save" class="${primary}">บันทึกยอดที่นับ</button>
        <button type="button" data-action="apply" class="${button}">ยืนยันปรับยอดและปิดรอบ</button>
        <button type="button" data-action="cancel" class="${button} text-red-700">ยกเลิกรอบ</button>
      </div>` : ''}
      <div>
        <label class="block text-sm font-semibold" for="stockCountLineSearch">ค้นหาในรอบนี้</label>
        <input id="stockCountLineSearch" type="search" class="${input}" value="${escapeLoanText(lineSearch)}" placeholder="ชื่อหรือรหัส PPE">
      </div>
      <p id="stockCountNoMatch" class="hidden text-sm text-gray-600">ไม่พบอุปกรณ์ที่ค้นหา</p>
      <ul class="space-y-2">${round.lines.map(line => renderLine(line, open)).join('')}</ul>
    </section>`);
    filterLines();
    syncRound();
  }

  function renderLine(line, open) {
    const id = Number(line.item_id);
    const displayCount = drafts.has(id) ? drafts.get(id) : line.counted_stock;
    return `<li data-stock-count-line="${escapeLoanText(`${line.code || ''} ${line.name}`.toLocaleLowerCase('th-TH'))}" class="rounded-xl border border-gray-200 p-3">
      <div class="grid gap-3 sm:grid-cols-4">
        <div class="min-w-0 break-words">
          <p class="font-semibold text-gray-800">${escapeLoanText(line.name)}</p>
          <p class="text-sm text-gray-600">${escapeLoanText(line.code)} · ${escapeLoanText(line.unit || 'หน่วย')}</p>
        </div>
        <p class="text-sm text-gray-700"><span class="block text-gray-600">ยอดในระบบ ณ เวลาอ้างอิง</span>${line.expected_stock}</p>
        ${open && line.state === 'ready'
          ? `<div><label class="block text-sm text-gray-600" for="stockCountItem${id}">ยอดนับจริง<span class="sr-only"> ${escapeLoanText(line.name)}</span></label>
            <input id="stockCountItem${id}" data-count="${id}" type="number" inputmode="numeric" min="0" max="2147483647" step="1"
              class="${input}" value="${escapeLoanText(displayCount ?? '')}"></div>`
          : `<p class="text-sm text-gray-700"><span class="block text-gray-600">ยอดนับจริง</span>${displayCount ?? '—'}</p>`}
        <p class="text-sm text-gray-700"><span class="block text-gray-600">ส่วนต่าง</span><output id="stockCountDifference${id}">${difference(displayCount, line.expected_stock)}</output></p>
      </div>
      ${line.state === 'changed' ? `<div class="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-800">
        <span>ยอดหรือความเคลื่อนไหวเปลี่ยนหลังบันทึกยอดอ้างอิง</span>
        <button type="button" data-recount="${id}" class="${button}">เริ่มนับใหม่</button></div>` : ''}
      ${line.state === 'removed' ? '<p class="mt-2 text-sm text-red-800">อุปกรณ์ออกจากคลังแล้ว กรุณายกเลิกรอบนี้และเปิดรอบใหม่</p>' : ''}
    </li>`;
  }

  function filterLines() {
    const query = lineSearch.trim().toLocaleLowerCase('th-TH');
    let anyVisible = false;
    for (const row of content.querySelectorAll('[data-stock-count-line]')) {
      row.hidden = !row.dataset.stockCountLine.includes(query);
      anyVisible ||= !row.hidden;
    }
    document.getElementById('stockCountNoMatch').classList.toggle('hidden', anyVisible);
  }

  function syncRound() {
    const persisted = round.lines.filter(line => line.counted_stock !== null);
    const changes = persisted.filter(line => line.counted_stock !== line.expected_stock).length;
    const blockers = round.lines.filter(line => ['changed', 'removed'].includes(line.state)).length;
    const progress = `บันทึกแล้ว ${persisted.length}/${round.lines.length} รายการ · พบส่วนต่าง ${changes} รายการ`;
    document.getElementById('stockCountProgress').textContent = [
      progress, blockers ? `ต้องตรวจใหม่ ${blockers} รายการ` : '', drafts.size ? `ยังไม่บันทึก ${drafts.size} รายการ` : '',
    ].filter(Boolean).join(' · ');
    if (round.status !== 'open') return;
    content.querySelector('[data-action="save"]').disabled = !drafts.size;
    content.querySelector('[data-action="apply"]').disabled = Boolean(drafts.size || blockers || persisted.length !== round.lines.length);
  }

  async function loadRound(id) {
    view = 'detail';
    if (roundId !== id) {
      round = null;
      lineSearch = '';
    }
    roundId = id;
    renderRound();
    const data = await apiCall('getStockCount', { id }, { silent: true });
    if (!isAdmin) return;
    round = data;
    drafts.clear();
    renderRound();
    if (_activePage === 'stockCount') {
      const heading = document.getElementById('stockCountDetailTitle');
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }

  async function mutate(operation, fields) {
    return apiCall('mutateStockCount', { operation, ...fields }, { silent: true });
  }

  async function updateRound(operation, fields = {}) {
    try {
      const result = await mutate(operation, { id: round.id, revision: round.revision, ...fields });
      if (!isAdmin) return;
      drafts.clear();
      // If reloading fails after a write, require a fresh read before accepting edits.
      round = null;
      if (operation === 'apply') {
        showToast('ปรับยอดและปิดรอบตรวจนับแล้ว', 'success');
        await refreshData('stockCount');
      }
      if (isAdmin) await loadRound(Number(result.id));
      if (operation === 'save') showToast('บันทึกยอดตรวจนับแล้ว', 'success');
    } catch (error) {
      if (isAdmin && !drafts.size && error.statusCode === 409 && roundId) await loadRound(roundId);
      throw error;
    }
  }

  async function discardDrafts() {
    return !drafts.size || await showConfirmationModal('ออกจากยอดที่ยังไม่บันทึก', 'ยอดที่ยังไม่บันทึกจะหายไป ต้องการดำเนินการต่อหรือไม่?');
  }

  content.addEventListener('input', event => {
    const field = event.target;
    if (field.id === 'stockCountSearch') return renderCatalog();
    if (field.id === 'stockCountLineSearch') {
      lineSearch = field.value;
      return filterLines();
    }
    if (!field.dataset.count || !round) return;
    const id = Number(field.dataset.count);
    const line = round.lines.find(item => Number(item.item_id) === id);
    if (field.validity.badInput || field.value !== String(line.counted_stock ?? '')) drafts.set(id, field.value);
    else drafts.delete(id);
    document.getElementById(`stockCountDifference${id}`).textContent = difference(field.value, line.expected_stock);
    syncRound();
  });

  content.addEventListener('change', event => {
    const field = event.target;
    if (field.id !== 'stockCountSelectVisible' && !field.dataset.item) return;
    const ids = field.dataset.item ? [Number(field.dataset.item)] : catalogItems().map(item => Number(item.id));
    ids.forEach(id => field.checked ? selection.add(id) : selection.delete(id));
    if (field.dataset.item) syncSelection();
    else renderCatalog();
  });

  content.addEventListener('click', event => {
    const control = event.target.closest('button');
    if (!control || request || !isAdmin) return;
    if (control.dataset.round) return perform(() => loadRound(Number(control.dataset.round)));
    if (control.dataset.recount) return perform(async () => {
      if (drafts.size) throw new Error('กรุณาบันทึกยอดที่แก้ก่อนเริ่มนับใหม่');
      const confirm = await showConfirmationModal('เริ่มนับอุปกรณ์ใหม่', 'ระบบจะใช้ยอดสต็อกล่าสุดเป็นยอดอ้างอิงและล้างยอดเดิมของรายการนี้ ให้นับของจริงอีกครั้งหลังยืนยัน');
      if (confirm) await updateRound('recount', { itemId: Number(control.dataset.recount) });
    });
    const action = control.dataset.action;
    if (action === 'new') { report(); return renderStart(); }
    if (action === 'more') return perform(() => loadRounds(nextBefore));
    if (action === 'reloadList') return perform(() => loadRounds());
    if (action === 'back' || action === 'reloadRound') return perform(async () => {
      if (!await discardDrafts()) return;
      drafts.clear();
      if (action === 'back') await loadRounds();
      else await loadRound(roundId);
    });
    if (action === 'start') return perform(async () => {
      const title = document.getElementById('stockCountTitle').value.trim();
      if (!title || !selection.size || selection.size > 1000) throw new Error('กรุณาระบุชื่อรอบและเลือกอุปกรณ์ 1 ถึง 1,000 รายการ');
      const result = await mutate('start', { title, itemIds: [...selection].sort((a, b) => a - b) });
      if (isAdmin) await loadRound(Number(result.id));
    });
    if (action === 'save') return perform(async () => {
      const invalid = [...content.querySelectorAll('[data-count]')].find(field =>
        field.validity.badInput || (field.value !== '' && difference(field.value, 0) === '—'));
      if (invalid) {
        throw new Error('กรุณากรอกยอดนับจริงเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
      }
      const counts = [...drafts].sort(([a], [b]) => a - b)
        .map(([item_id, value]) => ({ item_id, counted_stock: value === '' ? null : Number(value) }));
      await updateRound('save', { counts });
    });
    if (action === 'apply' || action === 'cancel') return perform(async () => {
      const applying = action === 'apply';
      const changed = round.lines.filter(line => line.counted_stock !== line.expected_stock).length;
      const reason = await showConfirmationModal(applying ? 'ยืนยันปรับยอดและปิดรอบ' : 'ยกเลิกรอบตรวจนับ',
        applying ? `ระบบจะปรับยอดตามผลตรวจนับ ${changed} รายการและปิดรอบนี้` : 'รอบนี้จะถูกปิดและจะไม่ปรับยอดสต็อก',
        { requestReason: true, reasonLabel: applying ? 'เหตุผลที่ปิดรอบ' : 'เหตุผลที่ยกเลิกรอบ' });
      if (reason) await updateRound(action, { reason });
    });
  });

  window.StockCount = {
    load() {
      if (!view) perform(() => loadRounds());
    },
    reset() {
      if (!view) return;
      view = '';
      round = null;
      roundId = null;
      rounds = [];
      nextBefore = null;
      lineSearch = '';
      request = null;
      selection.clear();
      drafts.clear();
      content.replaceChildren();
      setBusy();
      report();
    },
  };
})();
