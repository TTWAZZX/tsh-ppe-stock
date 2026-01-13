// pages/api/ppe.js
// API เวอร์ชัน Supabase ที่เลียนแบบ Code.gs และรับ text/plain แบบเดิมจาก index.html

import { createClient } from '@supabase/supabase-js';

// สร้าง client ไปยัง Supabase ของคุณ
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ตั้งค่า admin จาก env (แทน ScriptProperties)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_BASE64 = process.env.ADMIN_PASSWORD_BASE64 || null;

// ปิด bodyParser เดิมของ Next.js เพื่อให้เราอ่าน text/plain เอง
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // CORS เบื้องต้น
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const rawBody = await getRawBody(req);
    const { action, payload } = JSON.parse(rawBody || '{}');

    let result;

    switch (action) {
      case 'getInitialData':
        result = await getInitialData();
        break;

      case 'saveCategory':
        result = await saveCategory(payload);
        break;

      case 'deleteCategory':
        result = await deleteCategory(payload.categoryId);
        break;

      case 'savePpeItem':
        result = await savePpeItem(payload);
        break;

      case 'addNewVoucher':
        result = await addNewVoucher(payload);
        break;

      case 'approveVoucher':
        result = await approveVoucher(payload.voucherId);
        break;

      case 'approvePartialVoucher':
        result = await approvePartialVoucher(payload);
        break;

      case 'rejectVoucher':
        result = await rejectVoucher(payload.voucherId);
        break;

      case 'confirmReceive':
        result = await confirmReceive(payload);
        break;  

      case 'borrowItem':
        result = await borrowItem(payload);
        break;

      case 'returnItem':
        result = await returnItem(payload.loanId);
        break;

      case 'addReceiveTransaction':
        result = await addReceiveTransactionAndUpdateStock(payload);
        break;

      case 'checkAdminCredentials':
        result = await checkAdminCredentials(payload.username, payload.password);
        break;

      default:
        return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }

    // ส่ง version กลับไปเพื่อเช็คว่า Server อัปเดตโค้ดแล้ว
    return res.status(200).json({ status: 'success', data: result, version: '1.3-fix-lowercase' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

// ------------------------- utils: อ่าน raw body -------------------------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

// ------------------------- ฟังก์ชันหลักแปลงจาก Code.gs -------------------------

async function getInitialData() {
  const [
    ppeItemsRes,
    issueVouchersRes,
    receiveTransactionsRes,
    loanTransactionsRes,
    categoriesRes,
    departmentsRes
  ] = await Promise.all([
    supabase.from('ppe_items').select('*'),
    supabase.from('issue_vouchers').select('*'),
    supabase.from('receive_transactions').select('*'),
    supabase.from('loan_transactions').select('*'),
    supabase.from('categories').select('*'),
    supabase.from('departments').select('*').order('name')
  ]);

  const ppeItems = ppeItemsRes.data || [];
  const issueVouchers = issueVouchersRes.data || [];
  const receiveTransactions = receiveTransactionsRes.data || [];
  const loanTransactions = loanTransactionsRes.data || [];
  const categories = categoriesRes.data || [];

  const totalStockValue = calculateTotalStockValue(ppeItems);
  const topIssuedItems = getTopIssuedItems(issueVouchers, ppeItems, 5);
  const loanStatusSummary = getLoanStatusSummary(loanTransactions);
  const recentActivities = getRecentActivities(
    issueVouchers,
    loanTransactions,
    receiveTransactions,
    ppeItems,
    10
  );

  return {
    ppeItems,
    issueVouchers,
    receiveTransactions,
    loanTransactions,
    categories,
    departments: departmentsRes.data || [],   // ⭐ เพิ่มบรรทัดนี้
    dashboardMetrics: {
      totalStockValue,
      topIssuedItems,
      loanStatusSummary,
      recentActivities,
    },
  };
}

async function saveCategory(categoryData) {
  if (!categoryData || !categoryData.name || categoryData.name.trim() === '') {
    throw new Error('Category name cannot be empty.');
  }
  const name = categoryData.name.trim();

  if (categoryData.id) {
    const { data, error } = await supabase
      .from('categories')
      .update({ name })
      .eq('id', categoryData.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const nextId = await getNextId('categories', 'id');
    const { data, error } = await supabase
      .from('categories')
      .insert({ id: nextId, name })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

async function deleteCategory(categoryId) {
  const { error } = await supabase.from('categories').delete().eq('id', categoryId);
  if (error) throw error;
  return categoryId;
}

async function savePpeItem(itemData) {
  if (!itemData) throw new Error('Missing item data');

  const payload = {
    code: itemData.code,
    name: itemData.name,
    category: itemData.category,
    unit: itemData.unit,
    reorderPoint: itemData.reorderPoint || 0,
    stock: itemData.stock || 0,
    onLoanQuantity: itemData.onLoanQuantity || 0,
    price: itemData.price || 0,
    image_url: itemData.imageUrl || '',
  };

  if (itemData.id) {
    const { data, error } = await supabase
      .from('ppe_items')
      .update(payload)
      .eq('id', itemData.id)
      .select()
      .single();
    if (error) throw error;
    return { item: data, isNew: false };
  } else {
    const nextId = await getNextId('ppe_items', 'id');
    const { data, error } = await supabase
      .from('ppe_items')
      .insert({
        id: nextId,
        ...payload
      })
      .select()
      .single();
    if (error) throw error;
    return { item: data, isNew: true };
  }
}

// ✅ แก้ไข: ใช้ชื่อคอลัมน์ตัวพิมพ์เล็ก (userid, employeeid)
async function addNewVoucher(voucherData) {
  // Debug Log
  console.log("🔥 [addNewVoucher] Payload:", JSON.stringify(voucherData));

  const nextId = await getNextId('issue_vouchers', 'id');
  const { data, error } = await supabase
    .from('issue_vouchers')
    .insert({
      id: nextId,
      timestamp: new Date().toISOString(),
      user: voucherData.user,
      department: voucherData.department, // แผนก
      
      // *** เปลี่ยนเป็นตัวพิมพ์เล็กให้ตรงกับ Supabase ***
      employeeid: voucherData.employeeId || '', 
      userid: voucherData.userId || '',         
      
      status: 'pending',
      adminNotes: '',
      itemsJson: voucherData.items,
    })
    .select()
    .single();
  if (error) {
      console.error("🔥 [addNewVoucher] Error:", error);
      throw error;
  }
  return data;
}

async function approveVoucher(voucherId) {
  const { data: voucher, error } = await supabase
    .from('issue_vouchers')
    .select('*')
    .eq('id', voucherId)
    .single();
  if (error) throw error;
  if (!voucher) throw new Error('ไม่พบใบเบิก');
  if (voucher.status !== 'pending') throw new Error('ใบเบิกนี้ถูกจัดการไปแล้ว');

  const itemsToUpdate = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');

  const updatedStockItems = await updateStockLevels(itemsToUpdate, 'decrease');

  const { error: upErr } = await supabase
    .from('issue_vouchers')
    .update({ status: 'approved', adminNotes: 'อนุมัติโดย Admin' })
    .eq('id', voucherId);
  if (upErr) throw upErr;

  return { updatedVoucherId: voucherId, status: 'approved', updatedStockItems };
}

async function approvePartialVoucher(approvalData) {
  const voucherId = approvalData.voucherId;

  const { data: voucher, error } = await supabase
    .from('issue_vouchers')
    .select('*')
    .eq('id', voucherId)
    .single();
  if (error) throw error;
  if (!voucher) throw new Error('ไม่พบใบเบิก');
  if (voucher.status !== 'pending') throw new Error('ใบเบิกนี้ถูกจัดการไปแล้ว');

  const originalItems = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');

  const approvedItems = approvalData.items || [];
  let allApprovedFully = true;
  const notes = ['อนุมัติบางส่วน:'];
  const itemsToUpdateInStock = [];

  approvedItems.forEach((approved) => {
    const original = originalItems.find((o) => Number(o.itemId) === Number(approved.itemId));
    if (Number(approved.quantity) > 0) {
      itemsToUpdateInStock.push({ itemId: approved.itemId, quantity: approved.quantity });
      notes.push(
        `- ${approved.itemName}: ${approved.quantity}/${original ? original.quantity : '?'}`
      );
    }
    if (original && Number(approved.quantity) < Number(original.quantity)) {
      allApprovedFully = false;
    }
  });

  if (itemsToUpdateInStock.length === 0) {
    throw new Error('ไม่สามารถอนุมัติโดยไม่มีรายการสินค้าได้ กรุณาปฏิเสธใบเบิกแทน');
  }

  const updatedStockItems = await updateStockLevels(itemsToUpdateInStock, 'decrease');

  const newStatus = allApprovedFully ? 'approved' : 'partially_approved';
  const finalNote = notes.join(' ');

  const { error: upErr } = await supabase
    .from('issue_vouchers')
    .update({
      status: newStatus,
      adminNotes: finalNote,
    })
    .eq('id', voucherId);
  if (upErr) throw upErr;

  return { updatedVoucherId: voucherId, status: newStatus, updatedStockItems };
}

async function rejectVoucher(voucherId) {
  const { error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'rejected', adminNotes: 'ปฏิเสธโดย Admin' })
    .eq('id', voucherId);
  if (error) throw error;
  return { updatedVoucherId: voucherId, status: 'rejected' };
}

async function addReceiveTransactionAndUpdateStock(tx) {
  const nextId = await getNextId('receive_transactions', 'id');

  const { error: rErr } = await supabase
    .from('receive_transactions')
    .insert({
      id: nextId,
      timestamp: new Date().toISOString(),
      itemName: tx.itemName,
      type: tx.type,
      quantity: tx.quantity,
      user: tx.user,
      department: tx.department,
      status: 'completed',
    });
  if (rErr) throw rErr;

  const updatedStockItems = await updateStockLevels(
    [{ itemId: tx.itemId, quantity: tx.quantity }],
    'increase'
  );

  return { updatedStockItems };
}

// ในไฟล์ ppe.js ค้นหาฟังก์ชัน borrowItem แล้วแก้เป็นแบบนี้
async function borrowItem(borrowData) {
  // Debug Log
  console.log("🔥 [borrowItem] Payload:", JSON.stringify(borrowData));

  // เช็คชื่อคอลัมน์ ID ใน DB ดีๆ ว่าเป็น loanId หรือ loan_id (ส่วนใหญ่ Supabase จะใช้ id หรือ loan_id)
  // แต่ถ้าคุณตั้งไว้เป็น loanId แล้วก็ใช้ตามเดิมได้ครับ
  const nextId = await getNextId('loan_transactions', 'loanId'); 
  const updatedItem = await updateLoanableStock(borrowData.itemId, 'borrow');

  const { data, error } = await supabase
    .from('loan_transactions')
    .insert({
      loanId: nextId,
      itemId: borrowData.itemId,
      borrowerName: borrowData.borrowerName,
      
      // ✅ แก้ตรงนี้: ฝั่งซ้ายคือชื่อคอลัมน์ใน DB (ตัวเล็ก) = ฝั่งขวาคือค่าจาก Frontend (CamelCase)
      employeeid: borrowData.employeeId || '', 
      userid: borrowData.userId || '', 
      
      department: borrowData.department || '',
      
      borrowDate: new Date().toISOString(),
      dueDate: borrowData.dueDate || null,
      returnDate: null,
      status: 'on_loan',
      notes: borrowData.notes || '',
    })
    .select()
    .single();

  if (error) {
      console.error("Database Insert Error:", error); // เพิ่ม Log ให้เห็นชัดๆ ใน Vercel Logs
      throw error;
  }

  return { newLoan: data, updatedItem };
}

async function returnItem(loanId) {
  const { data: loan, error } = await supabase
    .from('loan_transactions')
    .select('*')
    .eq('loanId', loanId)
    .single();
  if (error) throw error;
  if (!loan) throw new Error('ไม่พบรายการยืม');
  if (loan.status !== 'on_loan') throw new Error('รายการนี้ถูกคืนหรือจัดการไปแล้ว');

  const updatedItem = await updateLoanableStock(loan.itemId, 'return');

  const { error: upErr } = await supabase
    .from('loan_transactions')
    .update({
      status: 'returned',
      returnDate: new Date().toISOString(),
    })
    .eq('loanId', loanId);
  if (upErr) throw upErr;

  return { returnedLoanId: loanId, updatedItem };
}

async function checkAdminCredentials(username, password) {
  if (!ADMIN_PASSWORD_BASE64) {
    console.warn('Admin credentials are not set in environment variables.');
    return false;
  }
  const providedBase64 = Buffer.from(password, 'utf8').toString('base64');
  return username === ADMIN_USERNAME && providedBase64 === ADMIN_PASSWORD_BASE64;
}

// ------------------------- helpers -------------------------
async function getNextId(tableName, colName = 'id') {
  const { data, error } = await supabase
    .from(tableName)
    .select(colName)
    .order(colName, { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0 || data[0][colName] == null) return 1;
  return Number(data[0][colName]) + 1;
}

async function updateStockLevels(items, operation = 'decrease') {
  if (!items || items.length === 0) return [];

  const ids = items.map((i) => Number(i.itemId));
  const { data: ppeRows, error } = await supabase
    .from('ppe_items')
    .select('*')
    .in('id', ids);
  if (error) throw error;

  const updatedItems = [];

  for (const item of items) {
    const target = ppeRows.find((p) => Number(p.id) === Number(item.itemId));
    if (!target) continue;

    const currentStock = Number(target.stock || 0);
    const qty = Number(item.quantity || 0);
    const newStock = operation === 'decrease' ? currentStock - qty : currentStock + qty;

    const { error: upErr } = await supabase
      .from('ppe_items')
      .update({ stock: newStock })
      .eq('id', target.id);
    if (upErr) throw upErr;

    updatedItems.push({ id: target.id, stock: newStock });
  }

  return updatedItems;
}

async function updateLoanableStock(itemId, direction) {
  const { data: item, error } = await supabase
    .from('ppe_items')
    .select('*')
    .eq('id', itemId)
    .single();
  if (error) throw error;
  if (!item) throw new Error(`ไม่พบอุปกรณ์ ID: ${itemId}`);

  let stock = Number(item.stock || 0);
  let onLoan = Number(item.onLoanQuantity || 0);

  if (direction === 'borrow') {
    if (stock < 1) throw new Error('อุปกรณ์หมดสต็อก');
    stock -= 1;
    onLoan += 1;
  } else {
    stock += 1;
    onLoan -= 1;
  }

  const { error: upErr } = await supabase
    .from('ppe_items')
    .update({
      stock,
      onLoanQuantity: onLoan,
    })
    .eq('id', itemId);
  if (upErr) throw upErr;

  return { id: itemId, stock, onLoanQuantity: onLoan };
}

// ----- dashboard helpers -----
function calculateTotalStockValue(ppeItems) {
  return ppeItems.reduce((total, item) => {
    const stock = Number(item.stock || 0);
    const price = Number(item.price || 0);
    return total + stock * price;
  }, 0);
}

function getTopIssuedItems(issueVouchers, ppeItems, n) {
  const counts = {};
  issueVouchers.forEach((v) => {
    if (v.status === 'approved' || v.status === 'partially_approved') {
      let items = v.itemsJson;
      if (!Array.isArray(items)) {
        try {
          items = JSON.parse(items || '[]');
        } catch (e) {
          items = [];
        }
      }
      items.forEach((it) => {
        const qty = Number(it.quantity || 0);
        counts[it.itemId] = (counts[it.itemId] || 0) + qty;
      });
    }
  });

  return Object.entries(counts)
    .map(([itemId, totalQuantity]) => {
      const p = ppeItems.find((i) => Number(i.id) === Number(itemId));
      return {
        itemId: Number(itemId),
        itemName: p ? p.name : 'Unknown',
        totalQuantity,
      };
    })
    .sort((a, b) => b.totalQuantity - a.totalQuantity)
    .slice(0, n);
}

function getLoanStatusSummary(loanTransactions) {
  return loanTransactions.reduce(
    (acc, loan) => {
      const st = String(loan.status || '').trim();
      if (st === 'on_loan') acc.onLoan++;
      else if (st === 'returned') acc.returned++;
      return acc;
    },
    { onLoan: 0, returned: 0 }
  );
}

function getRecentActivities(issueVouchers, loanTransactions, receiveTransactions, ppeItems, limit) {
  const list = [];

  issueVouchers.forEach((v) =>
    list.push({
      type: 'issue_voucher',
      id: v.id,
      timestamp: v.timestamp,
      description: `ใบเบิก #${v.id} โดย ${v.user} (${getStatusTextServer(v.status)})`,
      status: v.status,
    })
  );

  loanTransactions.forEach((l) => {
    const itemName = ppeItems.find((i) => Number(i.id) === Number(l.itemId))?.name || 'Unknown';
    list.push({
      type: 'loan_transaction',
      id: l.loanId,
      timestamp: l.borrowDate,
      description: `ยืม: ${itemName} โดย ${l.borrowerName}`,
      status: l.status,
    });
    if (l.returnDate) {
      list.push({
        type: 'return_transaction',
        id: l.loanId,
        timestamp: l.returnDate,
        description: `คืน: ${itemName} โดย ${l.borrowerName}`,
        status: 'returned',
      });
    }
  });

  receiveTransactions.forEach((r) =>
    list.push({
      type: 'receive_transaction',
      id: r.id,
      timestamp: r.timestamp,
      description: `รับของ: ${r.itemName} x${r.quantity}`,
      status: 'completed',
    })
  );

  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
}

function getStatusTextServer(status) {
  const map = {
    pending: 'รออนุมัติ',
    approved: 'อนุมัติแล้ว',
    partially_approved: 'อนุมัติบางส่วน',
    rejected: 'ถูกปฏิเสธ',
    completed: 'สำเร็จ',
    on_loan: 'กำลังยืม',
    returned: 'คืนแล้ว',
  };
  return map[status] || 'ไม่ทราบ';
}

async function confirmReceive(payload) {
  const { voucherId, userId, userName } = payload;

  if (!voucherId || !userId) {
    throw new Error('ข้อมูลไม่ครบ');
  }

  const { data: voucher, error: findErr } = await supabase
    .from('issue_vouchers')
    .select('*')
    .eq('id', voucherId)
    .single();

  if (findErr) throw findErr;
  if (!voucher) throw new Error('ไม่พบใบเบิก');

  if (voucher.status_received === 'received') {
    return { status: 'already_received' };
  }

  // ✅ อัปเดตสถานะรับของ
  const { error: upErr } = await supabase
    .from('issue_vouchers')
    .update({
      status_received: 'received',
      received_at: new Date().toISOString(),
      received_by: userName || userId
    })
    .eq('id', voucherId);

  if (upErr) throw upErr;

  // 🔔 STEP 5: แจ้ง Admin หลังรับของ (ตรงนี้แหละ)
  try {
    const ADMIN_LINE_USER_ID = process.env.ADMIN_LINE_USER_ID;

    if (ADMIN_LINE_USER_ID) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: ADMIN_LINE_USER_ID,
          messages: [
            {
              type: 'text',
              text: `📦 ยืนยันรับของแล้ว\n\nใบเบิก #${voucher.id}\nผู้รับ: ${userName || userId}\nเวลา: ${new Date().toLocaleString('th-TH')}`
            }
          ]
        })
      });
    }
  } catch (notifyErr) {
    // ❗ ไม่ throw เพื่อไม่ให้ process หลักพัง
    console.error('แจ้ง Admin ไม่สำเร็จ:', notifyErr);
  }

  return { status: 'received', voucherId };
}