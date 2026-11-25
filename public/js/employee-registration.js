(() => {
  const byId = id => document.getElementById(id);
  const form = byId('employeeRegistrationForm');
  const registrationButton = byId('registrationSubmit');
  const refreshButton = byId('registrationRefresh');
  const approvalsList = byId('employeeApprovalsList');
  const approvalsStatus = byId('employeeApprovalsStatus');
  const selectAll = byId('employeeApprovalSelectAll');
  const approve = byId('employeeApprove');
  const reject = byId('employeeReject');
  const reload = byId('employeeApprovalsRefresh');
  let formStatus;
  let approving = false;
  let loading = false;
  let revision = 0;

  function registerError(message = '') {
    const error = byId('registrationFormError');
    error.textContent = message;
    error.classList.toggle('hidden', !message);
  }

  function render(registration = {}) {
    const { status, reason, departments = [] } = registration;
    const editable = ['unregistered', 'rejected'].includes(status);
    byId('employeeRegistrationMessage').textContent = ({
      unregistered: 'กรอกข้อมูลพนักงานและเลือกแผนกเพื่อส่งคำขอ หลังได้รับอนุมัติจึงจะใช้คลัง เบิก และยืมอุปกรณ์ได้',
      pending: 'ส่งคำขอแล้ว กำลังรอผู้ดูแลตรวจสอบ กลับมากดตรวจสถานะได้ทุกเมื่อ',
      rejected: 'คำขอไม่ผ่านการอนุมัติ แก้ข้อมูลแล้วส่งใหม่ได้',
      disabled: 'สิทธิ์พนักงานของบัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ',
      approved: 'มีการพิจารณาคำขอแล้ว หากยังเข้าใช้งานไม่ได้ กรุณาติดต่อผู้ดูแลระบบ',
    })[status] || 'กำลังตรวจสอบสถานะพนักงาน';
    const reasonNode = byId('employeeRegistrationReason');
    reasonNode.textContent = status === 'rejected' && reason ? 'เหตุผล ' + reason : '';
    reasonNode.classList.toggle('hidden', !reasonNode.textContent);
    form.classList.toggle('hidden', !editable);
    if (editable) {
      const departmentInput = byId('registrationDepartment');
      const selected = departmentInput.value;
      departmentInput.replaceChildren(new Option('เลือกแผนก', ''), ...departments.map(dep => new Option(dep.name, dep.id)));
      departmentInput.value = status === formStatus
        ? selected
        : String(departments.find(dep => dep.name === registration.department)?.id || '');
      if (status !== formStatus) {
        byId('registrationEmployeeId').value = registration.employeeId || '';
        byId('registrationName').value = registration.name || '';
      }
    }
    formStatus = status;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (registrationButton.disabled || !form.reportValidity()) return;
    registerError();
    registrationButton.disabled = true;
    refreshButton.disabled = true;
    try {
      const result = await apiCall('submitEmployeeRegistration', {
        employeeId: byId('registrationEmployeeId').value,
        name: byId('registrationName').value,
        departmentId: byId('registrationDepartment').value,
      }, { silent: true });
      if (result?.status === 'pending') render(result);
    } catch (error) {
      if (!error.authenticationRedirected) registerError(error.message);
    } finally {
      registrationButton.disabled = false;
      refreshButton.disabled = false;
    }
  });

  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    registrationButton.disabled = true;
    registerError();
    try {
      if (!await refreshData('employeeRegistration')) registerError('ตรวจสถานะไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      refreshButton.disabled = false;
      registrationButton.disabled = false;
    }
  });

  function checkboxNodes() {
    return [...approvalsList.querySelectorAll('input[type="checkbox"]')];
  }

  function syncSelection() {
    const items = checkboxNodes();
    const count = items.filter(item => item.checked).length;
    const busy = approving || loading;
    approve.disabled = reject.disabled = busy || !count;
    selectAll.disabled = busy || !items.length;
    selectAll.checked = Boolean(items.length && count === items.length);
    selectAll.indeterminate = count > 0 && count < items.length;
    reload.disabled = busy;
    items.forEach(item => { item.disabled = busy; });
    approve.textContent = count ? 'อนุมัติ ' + count + ' รายการ' : 'อนุมัติที่เลือก';
    reject.textContent = count ? 'ปฏิเสธ ' + count + ' รายการ' : 'ปฏิเสธที่เลือก';
  }

  function buildRequest(row) {
    const label = document.createElement('label');
    label.className = 'flex items-start gap-3 rounded-xl border border-gray-200 p-4';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'mt-1';
    checkbox.value = String(row.id);
    checkbox.dataset.revision = String(row.revision);
    const details = document.createElement('span');
    details.className = 'min-w-0 break-words';
    const name = document.createElement('strong');
    name.className = 'block text-gray-900';
    name.textContent = row.employee_name;
    const meta = document.createElement('span');
    meta.className = 'text-sm text-gray-600';
    meta.textContent = [row.employee_id, row.department].join(' · ');
    details.append(name, meta);
    label.append(checkbox, details);
    return label;
  }

  async function loadApprovals() {
    if (!isAdmin || loading || approving) return;
    const sequence = ++revision;
    loading = true;
    approvalsList.replaceChildren();
    approvalsStatus.textContent = 'กำลังโหลดคำขอ';
    syncSelection();
    try {
      const requests = await apiCall('listEmployeeRegistrations', null, { silent: true });
      if (sequence !== revision || !isAdmin) return;
      approvalsList.replaceChildren(...requests.map(buildRequest));
      approvalsStatus.textContent = requests.length
        ? 'รออนุมัติในรายการนี้ ' + requests.length + ' รายการ'
        : 'ไม่มีคำขอรออนุมัติ';
    } catch (error) {
      if (sequence === revision && !error.authenticationRedirected) approvalsStatus.textContent = error.message;
    } finally {
      if (sequence === revision) {
        loading = false;
        syncSelection();
      }
    }
  }

  async function review(decision) {
    if (!isAdmin || approving || loading) return;
    const requests = checkboxNodes().filter(item => item.checked)
      .map(item => ({ id: Number(item.value), revision: Number(item.dataset.revision) }));
    if (!requests.length) return;
    approving = true;
    syncSelection();
    let reloadAfterReview = false;
    try {
      const approved = decision === 'approved';
      const confirmation = await showConfirmationModal(approved ? 'ยืนยันเปิดสิทธิ์พนักงาน' : 'ปฏิเสธคำขอลงทะเบียน',
        (approved ? 'เปิดสิทธิ์ให้พนักงาน ' : 'ปฏิเสธคำขอ ') + requests.length + ' รายการ',
        approved ? {} : { requestReason: true, reasonLabel: 'เหตุผลที่ปฏิเสธ' });
      if (!confirmation) return;
      const result = await apiCall('reviewEmployeeRegistrations', { requests, decision, reason: approved ? '' : confirmation }, { silent: true });
      showToast('บันทึกผลแล้ว ' + result.reviewed + ' รายการ', 'success');
      reloadAfterReview = true;
    } catch (error) {
      if (!error.authenticationRedirected) showToast(error.message, 'error');
      reloadAfterReview = error.statusCode === 409;
    } finally {
      approving = false;
      syncSelection();
      if (reloadAfterReview) {
        refreshAdminNotificationCounts(true);
        await loadApprovals();
      }
    }
  }

  function clearApprovals() {
    revision++;
    loading = false;
    approvalsList.replaceChildren();
    approvalsStatus.textContent = '';
    syncSelection();
  }

  selectAll.addEventListener('change', () => {
    checkboxNodes().forEach(item => { item.checked = selectAll.checked; });
    syncSelection();
  });
  approvalsList.addEventListener('change', syncSelection);
  approve.addEventListener('click', () => review('approved'));
  reject.addEventListener('click', () => review('rejected'));
  reload.addEventListener('click', () => {
    refreshAdminNotificationCounts(true);
    loadApprovals();
  });
  window.EmployeeRegistration = { render, loadApprovals, clearApprovals };
})();
