// ===========================================
// API Configuration
// ===========================================
const API_BASE = "/api/ppe"; // ให้ Vercel รับที่นี่

async function callServerFunction(action, payload = null) {
  showLoading();
  try {
    const response = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    });

    if (!response.ok) {
      throw new Error(`Network response was not ok: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    if (result.success === false) {
      throw new Error(result.message || "API error");
    }
    return result.data ?? result;
  } catch (error) {
    console.error(`API call failed for action "${action}":`, error);
    onFailure(error);
    throw error;
  } finally {
    hideLoading();
  }
}

// ===========================================
// State & Initialization
// ===========================================
let isAdmin = false;
let currentData = { ppeItems: [], issueVouchers: [], receiveTransactions: [], loanTransactions: [], categories: [], dashboardMetrics: {} };
let categoryChartInstance = null;
let topIssuedItemsChartInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  initializeApp(true);
  setupEventListeners();
  showPage('dashboard');

  if (document.getElementById('issueForm')) {
    resetIssueForm();
  }
});

function initializeApp(isFirstLoad = false) {
  if (isFirstLoad) showDashboardSkeleton();
  callServerFunction('getInitialData')
    .then(onDataLoaded)
    .catch(onFailure);
}

function onDataLoaded(data) {
  currentData = data;
  console.log("Data loaded:", currentData);
  updateUI();
  hideLoading();
  hideDashboardSkeleton();
}

function onFailure(error) {
  hideLoading();
  hideDashboardSkeleton();
  showToast('เกิดข้อผิดพลาด: ' + error.message, 'error');
}

function updateUI() {
  if (!currentData || !currentData.ppeItems) return;
  updateDashboard();
  updateAllTablesAndLists();
  populateAllDropdowns();
  updateAdminUI();
  renderCategoryList();
}

function setupEventListeners() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);

  const debouncedFilterStock = debounce(filterStock, 300);
  document.getElementById('stockSearch').addEventListener('input', debouncedFilterStock);
  document.getElementById('categoryFilter').addEventListener('change', filterStock);

  // Theme toggle
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      const html = document.documentElement;
      const isDark = html.classList.toggle('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });
  }

  // ตั้งค่าธีมตอนเปิดหน้า (ย้ายจาก inline)
  (function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const html = document.documentElement;
    if (savedTheme === 'light') html.classList.remove('dark');
    else if (savedTheme === 'dark') html.classList.add('dark');
  })();
}

// ===========================================
// UI Control & Helpers
// ===========================================
function showLoading() { document.getElementById('loadingOverlay').classList.remove('hidden'); }
function hideLoading() { document.getElementById('loadingOverlay').classList.add('hidden'); }
function showDashboardSkeleton() {
  document.getElementById('dashboardContent').classList.add('hidden');
  document.getElementById('dashboardSkeleton').classList.remove('hidden');
}
function hideDashboardSkeleton() {
  document.getElementById('dashboardContent').classList.remove('hidden');
  document.getElementById('dashboardSkeleton').classList.add('hidden');
}
function showToast(message, type = 'success') {
  const toastContainer = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
  const bgColor = type === 'success' ? 'bg-teal-500' : 'bg-red-500';
  toast.className = `toast p-4 rounded-lg shadow-lg text-white ${bgColor} flex items-center space-x-3`;
  toast.innerHTML = `<i class="fas ${icon} text-xl"></i><span>${message}</span>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    toast.addEventListener('transitionend', () => toast.remove());
  }, 3000);
}

function showPage(pageName) {
  document.querySelectorAll('.page-container > .page').forEach(page => page.classList.add('hidden'));
  const pageElement = document.getElementById(`${pageName}Page`);
  if (pageElement) pageElement.classList.remove('hidden');

  document.querySelectorAll('aside .nav-item').forEach(item => {
    item.classList.remove('bg-slate-800', 'text-white', 'font-bold');
  });
  const activeNavItemDesktop = document.querySelector(`aside .nav-item[onclick="showPage('${pageName}')"]`);
  if (activeNavItemDesktop) activeNavItemDesktop.classList.add('bg-slate-800', 'text-white', 'font-bold');

  document.querySelectorAll('.nav-item-mobile').forEach(item => item.classList.remove('text-teal-400'));
  const activeNavItemMobile = document.querySelector(`.nav-item-mobile[onclick="showPage('${pageName}')"]`);
  if (activeNavItemMobile) activeNavItemMobile.classList.add('text-teal-400');

  if (pageName === 'dashboard') updateDashboard();
  if (pageName === 'allHistory') {
    updateHistoryTable();
    updateLoanHistoryTable();
  }
}

function showHistoryTab(tabName) {
  document.querySelectorAll('.history-tab-content').forEach(content => content.classList.add('hidden'));
  document.querySelectorAll('.history-tab').forEach(tab => {
    tab.classList.remove('border-teal-500', 'text-teal-600');
    tab.classList.add('text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300', 'border-transparent');
  });
  document.getElementById(tabName + 'HistoryTab').classList.remove('hidden');
  const activeTab = document.querySelector(`.history-tab[onclick="showHistoryTab('${tabName}')"]`);
  activeTab.classList.add('border-teal-500', 'text-teal-600');
}

function createEmptyState(message, iconClass) {
  return `
    <div class="text-center py-10 px-6 text-slate-400">
      <div class="w-14 h-14 mx-auto bg-slate-800 rounded-full flex items-center justify-center mb-3">
        <i class="${iconClass} text-2xl text-slate-400"></i>
      </div>
      <p class="text-sm">${message}</p>
    </div>
  `;
}
function debounce(func, delay) {
  let timeout;
  return (...args) => { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), delay); };
}

// ===========================================
// Authentication
// ===========================================
function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  callServerFunction('checkAdminCredentials', { username, password })
    .then(isValid => {
      if (isValid) {
        isAdmin = true;
        updateAdminUI();
        hideLoginModal();
        showToast('เข้าสู่ระบบสำเร็จ');
      } else {
        showToast('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'error');
      }
    });
}
function logout() {
  isAdmin = false;
  updateAdminUI();
  showPage('dashboard');
  showToast('ออกจากระบบแล้ว');
}
function updateAdminUI() {
  const adminElements = ['adminMenu'];
  const loginElements = ['loginSection', 'loginSectionMobile'];
  const logoutElements = ['logoutSection', 'logoutSectionMobile'];
  if (isAdmin) {
    adminElements.forEach(id => document.getElementById(id).classList.remove('hidden'));
    loginElements.forEach(id => document.getElementById(id).classList.add('hidden'));
    logoutElements.forEach(id => document.getElementById(id).classList.remove('hidden'));
  } else {
    adminElements.forEach(id => document.getElementById(id).classList.add('hidden'));
    loginElements.forEach(id => document.getElementById(id).classList.remove('hidden'));
    logoutElements.forEach(id => document.getElementById(id).classList.add('hidden'));
  }
}
function showLoginModal() { document.getElementById('loginModal').classList.remove('hidden'); }
function hideLoginModal() { document.getElementById('loginModal').classList.add('hidden'); }

// ===========================================
// Data Population & Updates
// ===========================================
function updateAllTablesAndLists() {
  filterStock();
  updateHistoryTable();
  updatePendingTable();
  updateManageItemsList();
  updateOnLoanTable();
  updateLoanHistoryTable();
}
function populateAllDropdowns() {
  const categoryOptions = [...currentData.categories]
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(cat => `<option value="${cat.name}">${cat.name}</option>`).join('');

  document.getElementById('categoryFilter').innerHTML = '<option value="">ทุกหมวดหมู่</option>' + categoryOptions;
  document.getElementById('itemCategory').innerHTML = '<option value="">เลือกหมวดหมู่</option>' + categoryOptions;

  const allItemOptions = currentData.ppeItems
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(item => `<option value="${item.id}">${item.name} (คงเหลือ: ${item.stock})</option>`).join('');

  document.querySelectorAll('.item-select').forEach(select => {
    const selectedValue = select.value;
    select.innerHTML = '<option value="">เลือกอุปกรณ์</option>' + allItemOptions;
    if(selectedValue) select.value = selectedValue;
  });

  document.getElementById('receiveItem').innerHTML = '<option value="">เลือกอุปกรณ์</option>' + allItemOptions;

  const loanableItems = currentData.ppeItems.filter(item => item.stock > 0)
    .sort((a,b) => a.name.localeCompare(b.name));
  document.getElementById('loanItem').innerHTML = '<option value="">-- เลือกอุปกรณ์ --</option>' +
    loanableItems.map(item => `<option value="${item.id}">${item.name} (พร้อมใช้: ${item.stock})</option>`).join('');
}

// ===========================================
// Dashboard Rendering
// ===========================================
function updateDashboard() {
  const { ppeItems, issueVouchers, dashboardMetrics } = currentData;
  if (!ppeItems || !issueVouchers || !dashboardMetrics) return;
  document.getElementById('totalItems').textContent = ppeItems.length;
  document.getElementById('lowStockItems').textContent =
    ppeItems.filter(item => Number(item.stock) > 0 && Number(item.stock) <= Number(item.reorderPoint)).length;
  document.getElementById('outOfStockItems').textContent =
    ppeItems.filter(item => Number(item.stock) === 0).length;
  document.getElementById('totalStockValue').textContent =
    `฿${(dashboardMetrics.totalStockValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  updateLowStockList();
  updateOverdueLoansList();
  updateCategoryChart();
  updateTopIssuedItemsChart();
  updateRecentActivityFeed();
}
function updateLowStockList() {
  const container = document.getElementById('lowStockList');
  const attentionItems = currentData.ppeItems
    .filter(item => Number(item.stock) <= Number(item.reorderPoint))
    .sort((a, b) => a.stock - b.stock);

  if (attentionItems.length === 0) {
    container.innerHTML = createEmptyState('ไม่มีรายการที่ต้องสั่งซื้อเพิ่ม', 'fa-solid fa-thumbs-up');
    return;
  }
  container.innerHTML = attentionItems.map(item => {
    const isOutOfStock = Number(item.stock) === 0;
    const statusText = isOutOfStock ? 'ของหมด' : 'ใกล้หมด';
    const bgColor = isOutOfStock ? 'bg-red-50' : 'bg-orange-50';
    const textColor = isOutOfStock ? 'text-red-800' : 'text-orange-800';
    const subTextColor = isOutOfStock ? 'text-red-600' : 'text-orange-600';
    const badgeBgColor = isOutOfStock ? 'bg-red-200' : 'bg-orange-200';

    return `
      <div class="flex justify-between items-center p-2.5 ${bgColor} rounded-lg">
        <div>
          <p class="font-medium text-sm ${textColor}">${item.name}</p>
          <p class="text-xs ${subTextColor}">คงเหลือ: ${item.stock} ${item.unit}</p>
        </div>
        <span class="px-2 py-1 ${badgeBgColor} ${textColor} text-xs rounded-full font-medium">${statusText}</span>
      </div>`;
  }).join('');
}
function updateOverdueLoansList() {
  const container = document.getElementById('overdueLoansList');
  const overdueLoans = currentData.loanTransactions.filter(loan => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return loan.status === 'on_loan' && new Date(loan.dueDate) < today;
  }).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  if (overdueLoans.length === 0) {
    container.innerHTML = createEmptyState('ไม่มีอุปกรณ์ยืมเกินกำหนด', 'fa-solid fa-calendar-check');
    return;
  }
  container.innerHTML = overdueLoans.map(loan => {
    const item = currentData.ppeItems.find(p => p.id == loan.itemId);
    return `
      <div class="flex justify-between items-center p-2.5 bg-red-50 rounded-lg">
        <div>
          <p class="font-medium text-sm text-red-800">${item ? item.name : 'N/A'}</p>
          <p class="text-xs text-red-600">ผู้ยืม: ${loan.borrowerName}</p>
        </div>
        <button onclick="showPage('loan')" class="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 text-xs transition-colors">
          จัดการ
        </button>
      </div>`;
  }).join('');
}
function updateRecentActivityFeed() {
  const container = document.getElementById('recentActivityFeed');
  const activities = currentData.dashboardMetrics.recentActivities;

  if (!activities || activities.length === 0) {
    container.innerHTML = createEmptyState('ไม่มีกิจกรรมล่าสุด', 'fa-solid fa-bell-slash');
    return;
  }
  container.innerHTML = activities.map(activity => {
    const timestamp = new Date(activity.timestamp).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
    let iconClass, textColor = 'text-gray-700';
    switch (activity.type) {
      case 'issue_voucher':
        iconClass = 'fa-solid fa-file-export text-emerald-600';
        if (activity.status === 'pending') textColor = 'text-yellow-700';
        else if (activity.status === 'rejected') textColor = 'text-red-700';
        break;
      case 'loan_transaction': iconClass = 'fa-solid fa-exchange-alt text-teal-600'; break;
      case 'return_transaction': iconClass = 'fa-solid fa-undo text-lime-600'; break;
      case 'receive_transaction': iconClass = 'fa-solid fa-truck text-green-600'; break;
    }
    return `
      <div class="flex items-start space-x-4 p-3 border-b border-gray-100 last:border-b-0">
        <i class="${iconClass} text-lg mt-1 w-5 text-center"></i>
        <div class="flex-1">
          <p class="text-sm font-medium ${textColor}">${activity.description}</p>
          <p class="text-xs text-gray-500">${timestamp}</p>
        </div>
      </div>`;
  }).join('');
}
function updateCategoryChart() {
  const ctx = document.getElementById('categoryChart').getContext('2d');
  const categories = {};
  currentData.ppeItems.forEach(item => {
    if (item.category) categories[item.category] = (categories[item.category] || 0) + Number(item.stock);
  });

  if (categoryChartInstance) categoryChartInstance.destroy();

  categoryChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(categories),
      datasets: [{
        data: Object.values(categories),
        backgroundColor: ['#14b8a6', '#0d9488', '#0f766e', '#047857', '#065f46', '#064e3b'],
        borderColor: '#FFFFFF',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { family: "'Inter', 'Sarabun', sans-serif" } } } },
      onClick: (_, elements) => {
        if (elements.length > 0) {
          const categoryName = Object.keys(categories)[elements[0].index];
          showPage('stock');
          document.getElementById('categoryFilter').value = categoryName;
          filterStock();
        }
      }
    }
  });
}
function updateTopIssuedItemsChart() {
  const ctx = document.getElementById('topIssuedItemsChart').getContext('2d');
  const topItems = currentData.dashboardMetrics.topIssuedItems;
  if (!topItems) return;
  if (topIssuedItemsChartInstance) topIssuedItemsChartInstance.destroy();

  topIssuedItemsChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topItems.map(item => item.itemName),
      datasets: [{
        label: 'จำนวนที่เบิกจ่าย',
        data: topItems.map(item => item.totalQuantity),
        backgroundColor: '#14b8a6',
        borderRadius: 4,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, title: { display: false } },
      scales: {
        y: { ticks: { font: { family: "'Inter', 'Sarabun', sans-serif" } } },
        x: { beginAtZero: true }
      }
    }
  });
}

// ===========================================
// Table Rendering & Filtering
// ===========================================
function filterStock() {
  const tbody = document.getElementById('stockTableBody');
  const emptyState = document.getElementById('stockEmptyState');
  const search = document.getElementById('stockSearch').value.toLowerCase();
  const category = document.getElementById('categoryFilter').value;

  let filteredItems = currentData.ppeItems;
  if (search) filteredItems = filteredItems.filter(item =>
    (item.name && item.name.toLowerCase().includes(search)) ||
    (item.code && item.code.toLowerCase().includes(search))
  );
  if (category) filteredItems = filteredItems.filter(item => item.category === category);

  if (filteredItems.length === 0) {
    tbody.innerHTML = '';
    emptyState.innerHTML = createEmptyState('ไม่พบอุปกรณ์ที่ตรงกับเงื่อนไข', 'fa-solid fa-box-open');
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  tbody.innerHTML = filteredItems.map(item => {
    let statusText, statusColor;
    if (Number(item.stock) === 0) { statusText = 'ของหมด'; statusColor = 'bg-red-100 text-red-800'; }
    else if (Number(item.stock) <= Number(item.reorderPoint)) { statusText = 'ใกล้หมด'; statusColor = 'bg-orange-100 text-orange-800'; }
    else { statusText = 'ปกติ'; statusColor = 'bg-emerald-100 text-emerald-800'; }
    return `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-4 whitespace-nowrap font-medium text-slate-100">${item.code}</td>
        <td class="px-6 py-4 whitespace-nowrap text-slate-100">${item.name}</td>
        <td class="px-6 py-4 whitespace-nowrap text-slate-300">${item.category}</td>
        <td class="px-6 py-4 whitespace-nowrap font-bold text-gray-800">${item.stock} <span class="text-gray-500 font-normal">${item.unit}</span></td>
        <td class="px-6 py-4 whitespace-nowrap text-gray-500">${item.onLoanQuantity || 0}</td>
        <td class="px-6 py-4 whitespace-nowrap">
          <span class="px-2.5 py-0.5 inline-flex text-xs leading-5 font-semibold rounded-full ${statusColor}">${statusText}</span>
        </td>
      </tr>`;
  }).join('');
}
function getStatusInfo(status) {
  switch (String(status).trim()) {
    case 'pending': return { text: 'รออนุมัติ', color: 'bg-yellow-100 text-yellow-800' };
    case 'approved': return { text: 'อนุมัติแล้ว', color: 'bg-emerald-100 text-emerald-800' };
    case 'partially_approved': return { text: 'อนุมัติบางส่วน', color: 'bg-green-100 text-green-800' };
    case 'rejected': return { text: 'ถูกปฏิเสธ', color: 'bg-red-100 text-red-800' };
    case 'completed': return { text: 'สำเร็จ', color: 'bg-purple-100 text-purple-800' };
    case 'on_loan': return { text: 'กำลังยืม', color: 'bg-blue-100 text-blue-800' };
    case 'returned': return { text: 'คืนแล้ว', color: 'bg-gray-200 text-gray-800' };
    default: return { text: 'ไม่ทราบสถานะ', color: 'bg-gray-100 text-gray-800' };
  }
}
function updateHistoryTable() {
  const tbody = document.getElementById('historyTableBody');
  const emptyState = document.getElementById('issueHistoryEmptyState');
  const sortedVouchers = [...currentData.issueVouchers].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (sortedVouchers.length === 0) {
    tbody.innerHTML = '';
    emptyState.innerHTML = createEmptyState('ไม่มีประวัติใบเบิก', 'fa-solid fa-file-invoice');
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  tbody.innerHTML = sortedVouchers.map(v => {
    const status = getStatusInfo(v.status);
    return `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-4 whitespace-nowrap font-medium text-gray-800">#${v.id}</td>
        <td class="px-6 py-4 whitespace-nowrap text-gray-500">${new Date(v.timestamp).toLocaleDateString('th-TH', { dateStyle: 'medium' })}</td>
        <td class="px-6 py-4 whitespace-nowrap text-gray-700">${v.user}</td>
        <td class="px-6 py-4 whitespace-nowrap">
          <span class="px-2.5 py-0.5 inline-flex text-xs leading-5 font-semibold rounded-full ${status.color}">${status.text}</span>
        </td>
        <td class="px-6 py-4 whitespace-nowrap text-right">
          <button onclick="showVoucherDetails(${v.id})" class="text-teal-600 hover:text-teal-800 font-medium">ดูรายละเอียด</button>
        </td>
      </tr>`;
  }).join('');
}
function updatePendingTable() {
  const tbody = document.getElementById('pendingTableBody');
  const emptyState = document.getElementById('pendingEmptyState');
  const pendingVouchers = currentData.issueVouchers
    .filter(v => v.status === 'pending')
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (pendingVouchers.length === 0) {
    tbody.innerHTML = '';
    emptyState.innerHTML = createEmptyState('ไม่มีรายการรออนุมัติ', 'fa-solid fa-inbox');
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  tbody.innerHTML = pendingVouchers.map(voucher => `
    <tr class="hover:bg-gray-50">
      <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">#${voucher.id}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${new Date(voucher.timestamp).toLocaleDateString('th-TH', { dateStyle: 'medium' })}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700">${voucher.user}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${voucher.department}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-center">
        <button onclick="showApprovalModal(${voucher.id})" class="px-4 py-2 bg-yellow-400 text-yellow-900 rounded-lg hover:bg-yellow-500 font-semibold transition-colors">ดำเนินการ</button>
      </td>
    </tr>
  `).join('');
}
function updateManageItemsList() {
  const listContainer = document.getElementById('manageItemsList');
  if (!currentData.ppeItems || currentData.ppeItems.length === 0) {
    listContainer.innerHTML = createEmptyState('ยังไม่มีอุปกรณ์ในระบบ', 'fa-solid fa-box-open');
    return;
  }
  listContainer.innerHTML = [...currentData.ppeItems].sort((a,b) => a.name.localeCompare(b.name)).map(item => `
    <div class="flex justify-between items-center p-3 border border-gray-200 rounded-lg hover:bg-gray-50">
      <div>
        <p class="font-medium text-gray-900">${item.name} (${item.code})</p>
        <p class="text-sm text-gray-600">คงเหลือ: ${item.stock} ${item.unit} | ยืม: ${item.onLoanQuantity || 0}</p>
      </div>
      <button onclick="editItem(${item.id})" class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors">
        <i class="fas fa-edit"></i>
      </button>
    </div>
  `).join('');
}
function updateOnLoanTable() {
  const tbody = document.getElementById('onLoanTableBody');
  const emptyState = document.getElementById('onLoanEmptyState');
  const onLoanItems = currentData.loanTransactions
    .filter(l => l.status === 'on_loan')
    .sort((a, b) => new Date(a.borrowDate) - new Date(b.borrowDate));

  if (onLoanItems.length === 0) {
    tbody.innerHTML = '';
    emptyState.innerHTML = createEmptyState('ไม่มีอุปกรณ์ที่กำลังถูกยืม', 'fa-solid fa-people-carry-box');
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  tbody.innerHTML = onLoanItems.map(loan => {
    const item = currentData.ppeItems.find(p => p.id == loan.itemId);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isOverdue = new Date(loan.dueDate) < today;
    return `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${item ? item.name : 'N/A'}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700">${loan.borrowerName}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${new Date(loan.borrowDate).toLocaleDateString('th-TH')}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm ${isOverdue ? 'text-red-600 font-bold' : 'text-gray-500'}">
          ${new Date(loan.dueDate).toLocaleDateString('th-TH')}
          ${isOverdue ? '<span class="ml-2 text-xs">(เกินกำหนด)</span>' : ''}
        </td>
        <td class="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
          <button onclick="handleReturnItem(${loan.loanId})" class="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors">รับคืน</button>
        </td>
      </tr>`;
  }).join('');
}
function updateLoanHistoryTable() {
  const tbody = document.getElementById('loanHistoryTableBody');
  const emptyState = document.getElementById('loanHistoryEmptyState');
  const sortedLoans = [...currentData.loanTransactions].sort((a, b) => new Date(b.borrowDate) - new Date(a.borrowDate));
  if (sortedLoans.length === 0) {
    tbody.innerHTML = '';
    emptyState.innerHTML = createEmptyState('ไม่มีประวัติการยืม-คืน', 'fa-solid fa-history');
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  tbody.innerHTML = sortedLoans.map(loan => {
    const item = currentData.ppeItems.find(p => p.id == loan.itemId);
    const status = getStatusInfo(loan.status);
    return `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-800">${item ? item.name : 'N/A'}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700">${loan.borrowerName}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${new Date(loan.borrowDate).toLocaleDateString('th-TH')}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${loan.returnDate ? new Date(loan.returnDate).toLocaleDateString('th-TH') : '-'}</td>
        <td class="px-6 py-4 whitespace-nowrap">
          <span class="px-2.5 py-0.5 inline-flex text-xs leading-5 font-semibold rounded-full ${status.color}">${status.text}</span>
        </td>
      </tr>`;
  }).join('');
}

// ===========================================
// Form & Modal Logic
// ===========================================
function addIssueItem() {
  const container = document.getElementById('issueItems');
  const newItemDiv = document.createElement('div');
  newItemDiv.className = "issue-item flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4 border border-gray-200 rounded-lg bg-gray-50";
  newItemDiv.innerHTML = `
    <select class="item-select flex-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" required>
      <option value="">เลือกอุปกรณ์</option>
    </select>
    <input type="number" class="item-quantity w-full sm:w-28 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500" placeholder="จำนวน" min="1" required>
    <button type="button" onclick="removeIssueItem(this)" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors w-full sm:w-auto">
      <i class="fas fa-trash"></i>
    </button>
  `;
  container.appendChild(newItemDiv);
  populateAllDropdowns();
}
function removeIssueItem(button) { button.closest('.issue-item').remove(); }
function resetIssueForm() {
  const form = document.getElementById('issueForm');
  if (!form) return;
  form.reset();
  const container = document.getElementById('issueItems');
  if (container) {
    container.innerHTML = '';
    addIssueItem();
  }
}
function showVoucherDetails(voucherId) {
  const voucher = currentData.issueVouchers.find(v => v.id == voucherId);
  if (!voucher) return;
  const itemsHtml = JSON.parse(voucher.itemsJson).map(item => {
    const ppeItem = currentData.ppeItems.find(p => p.id == item.itemId);
    return `<li class="flex justify-between"><span>${ppeItem ? ppeItem.name : 'N/A'}</span> <span class="font-medium">${item.quantity} ${ppeItem ? ppeItem.unit : ''}</span></li>`;
  }).join('');
  const status = getStatusInfo(voucher.status);
  const modal = document.getElementById('voucherModal');
  modal.innerHTML = `
    <div class="bg-white p-8 rounded-xl shadow-xl w-full max-w-lg m-4 relative">
      <button onclick="hideVoucherModal()" class="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
      <h3 class="text-xl font-semibold mb-2 text-gray-800">รายละเอียดใบเบิก #${voucher.id}</h3>
      <span class="px-2.5 py-0.5 inline-flex text-xs leading-5 font-semibold rounded-full ${status.color}">${status.text}</span>
      <div class="mt-6 space-y-4 text-gray-700">
        <div class="grid grid-cols-2 gap-4">
          <p><strong>ผู้เบิก:</strong> ${voucher.user}</p>
          <p><strong>แผนก:</strong> ${voucher.department}</p>
          <p><strong>วันที่เบิก:</strong> ${new Date(voucher.timestamp).toLocaleDateString('th-TH', { dateStyle: 'medium' })}</p>
        </div>
        <div>
          <p class="font-semibold mb-2">รายการอุปกรณ์:</p>
          <ul class="space-y-1 bg-gray-50 p-4 rounded-lg">${itemsHtml}</ul>
        </div>
      </div>
      <div class="mt-6 text-right">
        <button onclick="hideVoucherModal()" class="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100">ปิด</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
}
function hideVoucherModal() { document.getElementById('voucherModal').classList.add('hidden'); }
function showApprovalModal(voucherId) {
  if (!isAdmin) return showToast('คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้', 'error');
  const voucher = currentData.issueVouchers.find(v => v.id == voucherId);
  if (!voucher) return;
  const items = JSON.parse(voucher.itemsJson);
  const itemsHtml = items.map(item => {
    const ppeItem = currentData.ppeItems.find(p => p.id == item.itemId);
    const maxApprove = Math.min(item.quantity, ppeItem ? ppeItem.stock : 0);
    return `
      <div class="flex items-center space-x-3 p-3 border-b item-approval-row" data-item-id="${item.itemId}" data-item-name="${ppeItem ? ppeItem.name : ''}">
        <div class="flex-1">
          <p class="font-medium text-gray-800">${ppeItem ? ppeItem.name : 'N/A'}</p>
          <p class="text-sm text-gray-600">ขอ: ${item.quantity} | สต็อก: ${ppeItem ? ppeItem.stock : 0}</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-700 mb-1">อนุมัติ:</label>
          <input type="number" value="${maxApprove}" min="0" max="${maxApprove}" class="approved-quantity w-20 px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-teal-500">
        </div>
      </div>`;
  }).join('');
  const modal = document.getElementById('approvalModal');
  modal.innerHTML = `
    <div class="bg-white p-8 rounded-xl shadow-xl w-full max-w-md m-4 relative">
      <button onclick="hideApprovalModal()" class="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
      <h3 class="text-xl font-semibold mb-6 text-gray-800">อนุมัติใบเบิก #${voucher.id}</h3>
      <div class="mb-6 border rounded-lg bg-gray-50 p-4 max-h-60 overflow-y-auto">${itemsHtml}</div>
      <div class="flex justify-end space-x-3 mt-6">
        <button onclick="rejectVoucher(${voucher.id})" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">ปฏิเสธ</button>
        <button onclick="approveVoucher(${voucher.id})" class="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700">อนุมัติทั้งหมด</button>
        <button onclick="handlePartialApprove(${voucher.id})" class="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600">อนุมัติตามจำนวน</button>
      </div>
    </div>`;
  modal.classList.remove('hidden');
}
function hideApprovalModal() { document.getElementById('approvalModal').classList.add('hidden'); }
function editItem(itemId) {
  const item = currentData.ppeItems.find(p => p.id == itemId);
  if (item) {
    document.getElementById('editItemId').value = item.id;
    document.getElementById('itemCode').value = item.code;
    document.getElementById('itemName').value = item.name;
    document.getElementById('itemCategory').value = item.category;
    document.getElementById('itemUnit').value = item.unit;
    document.getElementById('itemReorderPoint').value = item.reorderPoint;
    document.getElementById('itemStock').value = item.stock;
    document.getElementById('onLoanQuantity').value = item.onLoanQuantity || 0;
    showToast('กำลังแก้ไข: ' + item.name);
  }
}
function resetManageForm() {
  document.getElementById('manageForm').reset();
  document.getElementById('editItemId').value = '';
}
function resetReceiveForm() { document.getElementById('receiveForm').reset(); }
function showConfirmationModal(title, message) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirmationModal');
    document.getElementById('confirmationTitle').textContent = title;
    document.getElementById('confirmationMessage').textContent = message;
    modal.classList.remove('hidden');
    const confirmBtn = document.getElementById('confirmProceedBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    const cleanup = () => {
      modal.classList.add('hidden');
      newConfirmBtn.removeEventListener('click', handleConfirm);
      newCancelBtn.removeEventListener('click', handleCancel);
    };
    const handleConfirm = () => { cleanup(); resolve(true); };
    const handleCancel = () => { cleanup(); resolve(false); };
    newConfirmBtn.addEventListener('click', handleConfirm);
    newCancelBtn.addEventListener('click', handleCancel);
  });
}

// ===========================================
// Category Management Logic
// ===========================================
function showCategoryModal() {
  if (!isAdmin) return showToast('เฉพาะ Admin เท่านั้น', 'error');
  document.getElementById('categoryManagementModal').classList.remove('hidden');
  resetCategoryForm();
  renderCategoryList();
}
function hideCategoryModal() {
  document.getElementById('categoryManagementModal').classList.add('hidden');
}
function renderCategoryList() {
  const container = document.getElementById('categoryListContainer');
  if (!currentData.categories) return;
  const sortedCategories = [...currentData.categories].sort((a, b) => a.name.localeCompare(b.name));
  if (sortedCategories.length === 0) {
    container.innerHTML = createEmptyState('ยังไม่มีหมวดหมู่', 'fa-solid fa-tags');
    return;
  }
  container.innerHTML = sortedCategories.map(cat => `
    <div class="flex justify-between items-center p-3 rounded-lg hover:bg-slate-800/40">
      <span class="text-slate-100">${cat.name}</span>
      <div class="space-x-2">
        <button onclick="editCategory(${cat.id}, &quot;${cat.name}&quot;)" class="text-slate-400 hover:text-teal-400">
          <i class="fas fa-edit"></i>
        </button>
        <button onclick="handleDeleteCategory(${cat.id})" class="text-slate-400 hover:text-red-400">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  `).join('');
}
function editCategory(id, name) {
  document.getElementById('editCategoryId').value = id;
  document.getElementById('categoryNameInput').value = name;
  document.getElementById('categoryNameInput').focus();
}
function resetCategoryForm() {
  document.getElementById('categoryForm').reset();
  document.getElementById('editCategoryId').value = '';
}

// ===========================================
// >>>>>>>> โค้ดส่วนที่เพิ่มเข้ามา (Handlers) <<<<<<<<<<
// ===========================================
function handleIssueSubmit(e) {
  e.preventDefault();
  const user = document.getElementById('issueUser').value;
  const department = document.getElementById('issueDepartment').value;
  const items = [];
  const itemRows = document.querySelectorAll('#issueItems .issue-item');

  for (let row of itemRows) {
    const itemId = row.querySelector('.item-select').value;
    const quantity = row.querySelector('.item-quantity').value;
    if (itemId && quantity > 0) items.push({ itemId: Number(itemId), quantity: Number(quantity) });
  }
  if (items.length === 0) return showToast('กรุณาเลือกอุปกรณ์อย่างน้อย 1 รายการ', 'error');

  const voucherData = { user, department, items };
  callServerFunction('addNewVoucher', voucherData)
    .then(newVoucher => {
      showToast(`สร้างใบเบิก #${newVoucher.id} สำเร็จ`);
      resetIssueForm();
      initializeApp();
    });
}

function handleManageSubmit(e) {
  e.preventDefault();
  if (!isAdmin) return showToast('คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้', 'error');

  const itemData = {
    id: document.getElementById('editItemId').value || null,
    code: document.getElementById('itemCode').value,
    name: document.getElementById('itemName').value,
    category: document.getElementById('itemCategory').value,
    unit: document.getElementById('itemUnit').value,
    reorderPoint: Number(document.getElementById('itemReorderPoint').value),
    stock: Number(document.getElementById('itemStock').value),
    onLoanQuantity: Number(document.getElementById('onLoanQuantity').value || 0)
  };

  callServerFunction('savePpeItem', itemData)
    .then(result => {
      showToast(`บันทึกข้อมูล "${result.item.name}" สำเร็จ`);
      resetManageForm();
      initializeApp();
    });
}

function handleReceiveSubmit(e) {
  e.preventDefault();
  if (!isAdmin) return showToast('คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้', 'error');

  const transactionData = {
    itemId: Number(document.getElementById('receiveItem').value),
    quantity: Number(document.getElementById('receiveQuantity').value),
    type: document.getElementById('receiveType').value,
    user: document.getElementById('receiveUser').value,
    department: document.getElementById('receiveDepartment').value,
  };

  callServerFunction('addReceiveTransaction', transactionData)
    .then(() => {
      showToast('รับของเข้าสต็อกสำเร็จ');
      resetReceiveForm();
      initializeApp();
    });
}

function handleBorrowSubmit(e) {
  e.preventDefault();
  const borrowData = {
    itemId: Number(document.getElementById('loanItem').value),
    borrowerName: document.getElementById('borrowerName').value,
    dueDate: document.getElementById('loanDueDate').value,
    notes: document.getElementById('loanNotes').value,
  };

  callServerFunction('borrowItem', borrowData)
    .then(() => {
      showToast('บันทึกการยืมสำเร็จ');
      document.getElementById('loanForm').reset();
      initializeApp();
    });
}

function handleSaveCategory(e) {
  e.preventDefault();
  if (!isAdmin) return showToast('คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้', 'error');

  const categoryData = {
    id: document.getElementById('editCategoryId').value || null,
    name: document.getElementById('categoryNameInput').value,
  };

  callServerFunction('saveCategory', categoryData)
    .then(() => {
      showToast('บันทึกหมวดหมู่สำเร็จ');
      resetCategoryForm();
      initializeApp();
    });
}

async function handleDeleteCategory(categoryId) {
  if (!isAdmin) return showToast('คุณไม่มีสิทธิ์เข้าถึงฟังก์ชันนี้', 'error');
  const confirmed = await showConfirmationModal('ยืนยันการลบ', 'คุณแน่ใจหรือไม่ที่จะลบหมวดหมู่นี้? การกระทำนี้ไม่สามารถย้อนกลับได้');
  if (confirmed) {
    callServerFunction('deleteCategory', { categoryId })
      .then(() => {
        showToast('ลบหมวดหมู่สำเร็จ');
        initializeApp();
      });
  }
}

async function handleReturnItem(loanId) {
  const confirmed = await showConfirmationModal('ยืนยันการรับคืน', 'คุณต้องการบันทึกการรับคืนอุปกรณ์นี้ใช่หรือไม่?');
  if (confirmed) {
    callServerFunction('returnItem', { loanId })
      .then(() => {
        showToast('รับคืนอุปกรณ์สำเร็จ');
        initializeApp();
      });
  }
}

// ===========================================
// Voucher Approval Handlers
// ===========================================
async function approveVoucher(voucherId) {
  const confirmed = await showConfirmationModal('ยืนยันการอนุมัติ', 'คุณต้องการอนุมัติใบเบิกนี้ทั้งหมดใช่หรือไม่? สต็อกจะถูกตัดทันที');
  if (confirmed) {
    callServerFunction('approveVoucher', { voucherId })
      .then(() => {
        showToast(`อนุมัติใบเบิก #${voucherId} สำเร็จ`);
        hideApprovalModal();
        initializeApp();
      });
  }
}
async function rejectVoucher(voucherId) {
  const confirmed = await showConfirmationModal('ยืนยันการปฏิเสธ', 'คุณต้องการปฏิเสธใบเบิกนี้ใช่หรือไม่?');
  if (confirmed) {
    callServerFunction('rejectVoucher', { voucherId })
      .then(() => {
        showToast(`ปฏิเสธใบเบิก #${voucherId} แล้ว`);
        hideApprovalModal();
        initializeApp();
      });
  }
}
function handlePartialApprove(voucherId) {
  const items = [];
  document.querySelectorAll('#approvalModal .item-approval-row').forEach(row => {
    items.push({
      itemId: Number(row.dataset.itemId),
      itemName: row.dataset.itemName,
      quantity: Number(row.querySelector('.approved-quantity').value)
    });
  });

  const approvalData = { voucherId, items };
  callServerFunction('approvePartialVoucher', approvalData)
    .then(() => {
      showToast(`อนุมัติใบเบิก #${voucherId} บางส่วนสำเร็จ`);
      hideApprovalModal();
      initializeApp();
    });
}
