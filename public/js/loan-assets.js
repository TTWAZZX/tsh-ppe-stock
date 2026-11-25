(() => {
  const byId = id => document.getElementById(id);
  const itemSelect = byId('loanAssetItem');
  const managerStatus = byId('loanAssetManagerStatus');
  const list = byId('loanAssetList');
  const scanPanel = byId('scannedLoanAsset');
  const scanStatus = byId('scannedLoanAssetStatus');
  const scanActions = byId('scannedLoanAssetActions');
  const tokenPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const buttonStyle = 'min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold';
  let adminRequest = null;
  let assets = [];
  let nextBefore = null;
  let selected = null;
  let scanRevision = 0;

  function resetAdmin() {
    byId('loanAssetPreview').classList.add('hidden');
    itemSelect.replaceChildren();
    assets = [];
    nextBefore = null;
    list.replaceChildren();
    managerStatus.textContent = '';
    byId('loanAssetMore').classList.add('hidden');
    byId('loanAssetControls').disabled = false;
    byId('loanAssetLabel').value = '';
    adminRequest = null;
  }

  function renderAssets() {
    list.innerHTML = assets.map(asset => `<li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3">
        <span class="min-w-0 break-words text-sm text-gray-800"><strong>${escapeLoanText(asset.label)}</strong>
        <span class="block text-gray-600">${asset.retired_at ? 'เลิกใช้แล้ว' : asset.available ? 'พร้อมยืม' : 'กำลังถูกยืม'}</span></span>
        ${asset.retired_at ? '' : `<div class="flex flex-wrap gap-2">
            <button type="button" data-qr="${Number(asset.id)}" class="${buttonStyle}" aria-label="ดู QR ${escapeLoanText(asset.label)}">ดู QR</button>
            ${asset.available ? `<button type="button" data-retire="${Number(asset.id)}" class="${buttonStyle} text-red-700" aria-label="เลิกใช้ป้าย ${escapeLoanText(asset.label)}">เลิกใช้ป้าย</button>` : ''}
        </div>`}
    </li>`).join('');
    byId('loanAssetMore').classList.toggle('hidden', !nextBefore);
  }

  async function adminTask(task) {
    if (!isAdmin || adminRequest) return;
    const request = {};
    adminRequest = request;
    byId('loanAssetControls').disabled = true;
    managerStatus.textContent = 'กำลังโหลด…';
    try {
      await task();
    } catch (error) {
      if (adminRequest === request && !error.authenticationRedirected) managerStatus.textContent = error.message;
    } finally {
      if (adminRequest === request) {
        adminRequest = null;
        byId('loanAssetControls').disabled = false;
      }
    }
  }

  async function readAssets(before = null) {
    const itemId = Number(itemSelect.value);
    if (!before) {
      assets = [];
      nextBefore = null;
      renderAssets();
    }
    if (!itemId) {
      managerStatus.textContent = 'เลือกอุปกรณ์เพื่อดูหรือสร้างป้าย QR';
      return;
    }
    const result = await apiCall('listLoanAssets', { itemId, ...(before ? { before } : {}) }, { silent: true });
    if (!isAdmin) return;
    assets.push(...result.assets);
    nextBefore = result.nextBefore;
    renderAssets();
    managerStatus.textContent = assets.length ? `แสดง ${assets.length} ป้าย` : 'ยังไม่มีป้ายสำหรับอุปกรณ์นี้';
  }

  function load() {
    if (!isAdmin || adminRequest) return;
    const previous = itemSelect.value;
    const items = currentData.ppeItems || [];
    itemSelect.replaceChildren(new Option('เลือกอุปกรณ์', ''), ...items.map(item =>
      new Option([item.code, item.name].filter(Boolean).join(' · '), item.id)));
    itemSelect.value = items.some(item => String(item.id) === previous) ? previous : '';
    byId('loanAssetRegister').disabled = !itemSelect.value;
    adminTask(() => readAssets());
  }

  async function showQr(id) {
    const data = await apiCall('getLoanAssetQr', { id }, { silent: true });
    if (!isAdmin) return;
    const title = byId('loanAssetPrintTitle');
    title.textContent = data.label;
    byId('loanAssetPrintImage').src = data.image;
    byId('loanAssetDownload').href = data.image;
    byId('loanAssetDownload').download = `ppe-qr-${id}.svg`;
    byId('loanAssetLink').href = data.url;
    byId('loanAssetPreview').classList.remove('hidden');
    managerStatus.textContent = 'เปิดป้าย QR แล้ว';
    if (_activePage === 'loanAssets') title.focus();
  }

  itemSelect.addEventListener('change', () => {
    byId('loanAssetPreview').classList.add('hidden');
    byId('loanAssetRegister').disabled = !itemSelect.value;
    adminTask(() => readAssets());
  });
  byId('loanAssetMore').addEventListener('click', () => adminTask(() => readAssets(nextBefore)));
  byId('loanAssetForm').addEventListener('submit', event => {
    event.preventDefault();
    const input = byId('loanAssetLabel');
    const label = input.value.trim();
    if (!label || !itemSelect.value) return;
    adminTask(async () => {
      const result = await apiCall('mutateLoanAsset', { operation: 'register', itemId: Number(itemSelect.value), label }, { silent: true });
      if (!isAdmin) return;
      input.value = '';
      await readAssets();
      await showQr(result.id);
    });
  });
  list.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.qr) adminTask(() => showQr(Number(target.dataset.qr)));
    if (target.dataset.retire) adminTask(async () => {
      const id = Number(target.dataset.retire);
      const asset = assets.find(row => Number(row.id) === id);
      if (!await showConfirmationModal('เลิกใช้ป้าย QR', `ป้าย ${asset.label} จะเปิดรายการยืมไม่ได้ ต้องการเลิกใช้หรือไม่?`)) {
        managerStatus.textContent = 'ยกเลิกการทำรายการ';
        return;
      }
      await apiCall('mutateLoanAsset', { operation: 'retire', id }, { silent: true });
      if (!isAdmin) return;
      byId('loanAssetPreview').classList.add('hidden');
      await readAssets();
    });
  });
  byId('loanAssetPrint').addEventListener('click', () => {
    const popup = window.open('', '_blank', 'width=420,height=480');
    if (!popup) return showToast('เปิดหน้าพิมพ์ไม่ได้ กดดาวน์โหลด QR เพื่อพิมพ์จากไฟล์ได้', 'warning');
    const label = byId('loanAssetPrintTitle').textContent;
    popup.document.title = label;
    const heading = popup.document.createElement('h1');
    heading.textContent = label;
    const img = popup.document.createElement('img');
    img.width = img.height = 192;
    img.onload = () => { popup.focus(); popup.print(); };
    img.src = byId('loanAssetPrintImage').src;
    popup.document.body.append(heading, img);
  });

  function clearScan() {
    scanRevision++;
    selected = null;
    scanPanel.classList.add('hidden');
    scanStatus.textContent = '';
    scanActions.replaceChildren();
  }

  function addScanAction(text, callback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = buttonStyle;
    button.textContent = text;
    button.addEventListener('click', callback);
    scanActions.append(button);
  }

  async function resolveScan(token, prepare) {
    const revision = ++scanRevision;
    if (prepare) showPage('loan', { restoring: true });
    scanPanel.classList.remove('hidden');
    scanStatus.textContent = 'กำลังตรวจป้าย QR…';
    scanActions.replaceChildren();
    try {
      if (!tokenPattern.test(token)) throw new Error('รหัส QR ของอุปกรณ์ไม่ถูกต้อง');
      const asset = await apiCall('getScannedLoanAsset', { token }, { silent: true });
      if (revision !== scanRevision) return;
      const item = currentData.ppeItems.find(row => Number(row.id) === Number(asset.itemId));
      scanStatus.textContent = [asset.label, item?.name, asset.available ? 'พร้อมยืม' : 'กำลังถูกยืม'].filter(Boolean).join(' · ');
      if (asset.available && item) {
        const choose = () => {
          selected = { token, itemId: asset.itemId, label: asset.label };
          setLoanSelectedItem(item);
        };
        if (prepare && _activePage === 'loan') choose();
        addScanAction('เลือกชิ้นนี้เพื่อยืม', choose);
      } else if (asset.loan?.loanId) {
        const loanId = Number(asset.loan.loanId);
        addScanAction('ดูรายการยืมของชิ้นนี้', () => focusActiveLoan(loanId));
        if (isAdmin) addScanAction('รับคืนชิ้นนี้', () => handleReturnItem(loanId, token));
      }
    } catch (error) {
      if (revision === scanRevision && !error.authenticationRedirected) scanStatus.textContent = error.message;
    }
  }

  window.LoanAssets = {
    load, resetAdmin, clearScan,
    clearSelection() { selected = null; },
    selectionLabel() { return selected?.label || ''; },
    selectionToken(itemId) { return Number(selected?.itemId) === Number(itemId) ? selected.token : null; },
    openScan(token) { return resolveScan(token, true); },
    refreshScan(token) { return resolveScan(token, false); },
  };
})();
