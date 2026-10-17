// pages/api/ppe.js
// API เวอร์ชัน Supabase ที่เลียนแบบ Code.gs และรับ text/plain แบบเดิมจาก index.html

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// สร้าง client ไปยัง Supabase ของคุณ
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ตั้งค่า admin จาก env (แทน ScriptProperties)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_BASE64 = process.env.ADMIN_PASSWORD_BASE64 || null;
const ADMIN_PASSWORD_SCRYPT = process.env.ADMIN_PASSWORD_SCRYPT || null; // ใหม่: scrypt hash
// SESSION_SECRET ต้องตั้งค่าใน Vercel Environment Variables ด้วย (สุ่ม string ยาวๆ)
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 นาที
const MAX_LOGIN_FAILURES = 5;

// Actions ที่ต้องเป็น Admin เท่านั้น
const ADMIN_ONLY_ACTIONS = new Set([
  'saveCategory', 'deleteCategory', 'savePpeItem', 'deletePpeItem',
  'approveVoucher', 'approvePartialVoucher', 'rejectVoucher',
  'addReceiveTransaction', 'saveMatrixRule', 'deleteMatrixRule',
  'uploadDocument', 'deleteDocument', 'deleteVoucher', 'returnItem',
]);

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

    // ตรวจสอบ admin token สำหรับ actions ที่ต้องการสิทธิ์ admin
    if (ADMIN_ONLY_ACTIONS.has(action)) {
      if (!verifyAdminToken(payload?.adminToken)) {
        return res.status(403).json({ status: 'error', message: 'Unauthorized' });
      }
    }

    // ดึง actor สำหรับ audit log
    const actor = ADMIN_ONLY_ACTIONS.has(action)
      ? extractUsernameFromToken(payload?.adminToken)
      : (payload?.userId || payload?.user || 'anonymous');

    let result;

    switch (action) {
      case 'getInitialData':
        result = await getInitialData();
        break;

      case 'saveCategory':
        result = await saveCategory(payload);
        await writeAuditLog(actor, 'saveCategory', 'categories', result?.id, { name: payload.name });
        break;

      case 'deleteCategory':
        result = await deleteCategory(payload.categoryId);
        await writeAuditLog(actor, 'deleteCategory', 'categories', payload.categoryId);
        break;

      case 'savePpeItem':
        result = await savePpeItem(payload);
        await writeAuditLog(actor, 'savePpeItem', 'ppe_items', result?.item?.id, { name: payload.name, isNew: result?.isNew });
        break;

      case 'addNewVoucher':
        result = await addNewVoucher(payload);
        await writeAuditLog(actor, 'addNewVoucher', 'issue_vouchers', result?.id, { department: payload.department, itemCount: payload.items?.length });
        break;

      case 'approveVoucher':
        result = await approveVoucher(payload);
        await writeAuditLog(actor, 'approveVoucher', 'issue_vouchers', payload.voucherId);
        break;

      case 'approvePartialVoucher':
        result = await approvePartialVoucher(payload);
        await writeAuditLog(actor, 'approvePartialVoucher', 'issue_vouchers', payload.voucherId, { items: payload.items });
        break;

      case 'rejectVoucher':
        result = await rejectVoucher(payload);
        await writeAuditLog(actor, 'rejectVoucher', 'issue_vouchers', payload.voucherId);
        break;

      case 'confirmReceive':
        result = await confirmReceive(payload);
        await writeAuditLog(actor, 'confirmReceive', 'issue_vouchers', payload.voucherId, { receivedBy: payload.userName });
        break;

      case 'borrowItem':
        result = await borrowItem(payload);
        await writeAuditLog(actor, 'borrowItem', 'loan_transactions', result?.newLoan?.loanId, { itemId: payload.itemId, department: payload.department });
        break;

      case 'returnItem':
        result = await returnItem(payload.loanId);
        await writeAuditLog(actor, 'returnItem', 'loan_transactions', payload.loanId);
        break;

      case 'addReceiveTransaction':
        result = await addReceiveTransactionAndUpdateStock(payload);
        await writeAuditLog(actor, 'addReceiveTransaction', 'receive_transactions', result?.transaction?.id, {
          itemId: payload.itemId,
          quantity: payload.quantity,
          type: payload.type,
          department: payload.department,
          receiver: payload.user,
        });
        break;

      case 'checkAdminCredentials': {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
        result = await handleLoginWithLockout(payload.username, payload.password, ip);
        break;
      }

      case 'deletePpeItem':
        result = await deletePpeItem(payload);
        await writeAuditLog(actor, 'deletePpeItem', 'ppe_items', payload.id);
        break;

      case 'saveFeedback':
        result = await saveFeedback(payload);
        break;

      case 'saveMatrixRule':
        result = await saveMatrixRule(payload);
        await writeAuditLog(actor, 'saveMatrixRule', 'ppe_matrix', result?.id, { jobFunction: payload.jobFunction });
        break;

      case 'deleteMatrixRule':
        result = await deleteMatrixRule(payload);
        await writeAuditLog(actor, 'deleteMatrixRule', 'ppe_matrix', payload.id);
        break;

      case 'uploadDocument':
        result = await uploadDocument(payload);
        await writeAuditLog(actor, 'uploadDocument', 'ppe_documents', result?.id, { title: payload.title });
        break;

      case 'deleteDocument':
        result = await deleteDocument(payload);
        await writeAuditLog(actor, 'deleteDocument', 'ppe_documents', payload.id);
        break;

      case 'deleteVoucher':
        result = await deleteVoucher(payload.voucherId);
        await writeAuditLog(actor, 'deleteVoucher', 'issue_vouchers', payload.voucherId);
        break;

      default:
        return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }

    return res.status(200).json({ status: 'success', data: result, version: '2.0-enterprise' });
  } catch (err) {
    console.error('API Error:', err);
    // ส่งเฉพาะ error message ที่เป็น Thai (business logic) กลับไป frontend
    // ป้องกัน Supabase internals / schema info หลุดออกไป
    const isSafeMessage = !/supabase|postgres|connection|ECONN|ETIMED|permission denied|relation|column|syntax/i.test(err.message);
    const clientMessage = isSafeMessage ? err.message : 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง';
    return res.status(500).json({ status: 'error', message: clientMessage });
  }
}

// ------------------------- Enterprise Helper Functions -------------------------

// Audit Log: บันทึกทุก action — fire-and-forget ไม่ throw ไม่กระทบ main flow
async function writeAuditLog(actor, action, entityType, entityId, details = {}) {
  try {
    await supabase.from('audit_log').insert({
      actor: String(actor || 'anonymous'),
      action,
      entity_type: entityType,
      entity_id: String(entityId ?? ''),
      details,
    });
  } catch (e) {
    console.error('[audit_log] write failed:', e.message);
  }
}

// ดึง username จาก HMAC token
function extractUsernameFromToken(token) {
  if (!token) return 'unknown';
  const lastColon = token.lastIndexOf(':');
  const secondLast = token.lastIndexOf(':', lastColon - 1);
  return token.substring(0, secondLast) || 'unknown';
}

// Account Lockout: ตรวจ + บันทึก login attempts
async function handleLoginWithLockout(username, password, ip) {
  const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();

  const { count } = await supabase
    .from('login_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('username', username)
    .eq('success', false)
    .gte('attempted_at', windowStart);

  if ((count ?? 0) >= MAX_LOGIN_FAILURES) {
    await supabase.from('login_attempts').insert({ username, ip, success: false });
    throw new Error('บัญชีถูกล็อกชั่วคราว กรุณารอ 15 นาทีแล้วลองใหม่');
  }

  const token = await checkAdminCredentials(username, password);
  await supabase.from('login_attempts').insert({ username, ip, success: !!token });
  return token;
}

// Auto Stock Alert: แจ้ง LINE admin เมื่อ stock ต่ำกว่า reorder point
async function checkAndAlertLowStock(updatedItems) {
  const ADMIN_LINE_USER_ID = process.env.ADMIN_LINE_USER_ID;
  const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!ADMIN_LINE_USER_ID || !LINE_TOKEN || !updatedItems?.length) return;

  const ids = updatedItems.map(i => Number(i.id));
  const { data: items } = await supabase
    .from('ppe_items')
    .select('id, name, stock, reorderPoint')
    .in('id', ids)
    .is('deleted_at', null);

  const lowItems = (items || []).filter(
    i => Number(i.reorderPoint) > 0 && Number(i.stock) <= Number(i.reorderPoint)
  );
  if (!lowItems.length) return;

  const lines = lowItems.map(i =>
    `• ${i.name}: เหลือ ${i.stock} ชิ้น (จุดสั่งซื้อ: ${i.reorderPoint})`
  ).join('\n');

  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({
        to: ADMIN_LINE_USER_ID,
        messages: [{ type: 'text', text: `⚠️ แจ้งเตือนสต็อกต่ำ\n\n${lines}\n\nกรุณาสั่งซื้อเพิ่มเติม` }],
      }),
    });
  } catch (e) {
    console.error('[stock-alert] LINE push failed:', e.message);
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

// ... (ฟังก์ชัน getInitialData และอื่นๆ ให้คงเดิมไว้) ...
// เพื่อความกระชับ ผมจะใส่เฉพาะฟังก์ชัน saveFeedback ที่เพิ่มมาใหม่นะครับ
// คุณสามารถ Copy ฟังก์ชัน saveFeedback นี้ไปวางต่อท้ายไฟล์ หรือวางก่อน getInitialData ก็ได้ครับ

// ⭐⭐⭐ ฟังก์ชันบันทึก Feedback ลง Supabase ⭐⭐⭐
async function saveFeedback(payload) {
  const { transactionId, itemId, itemName, type, rating, comment, user } = payload;

  if (!rating) {
    throw new Error('Rating is required');
  }

  // Insert ลงตาราง feedback
  const { data, error } = await supabase
    .from('feedback')
    .insert([
      {
        transaction_id: transactionId,
        item_id: itemId,
        item_name: itemName,
        feedback_type: type,
        rating: parseInt(rating),
        comment: comment,
        user_name: user
      }
    ])
    .select();

  if (error) {
    console.error('Supabase Feedback Error:', error);
    throw new Error(error.message);
  }

  return { status: 'success', data };
}

// ------------------------- ฟังก์ชันเดิมของคุณ (ไม่ต้องแก้) -------------------------

async function getInitialData() {
  const [
    ppeItemsRes,
    issueVouchersRes,
    receiveTransactionsRes,
    loanTransactionsRes,
    categoriesRes,
    departmentsRes,
    feedbackRes,
    matrixRes,
    docsRes // ⭐ เพิ่มตัวรับ
  ] = await Promise.all([
    supabase.from('ppe_items').select('*').is('deleted_at', null),
    supabase.from('issue_vouchers').select('*'),
    supabase.from('receive_transactions').select('*'),
    supabase.from('loan_transactions').select('*'),
    supabase.from('categories').select('*'),
    supabase.from('departments').select('*').order('name'),
    supabase.from('feedback').select('*').order('created_at', { ascending: false }),
    supabase.from('ppe_matrix').select('*'),
    supabase.from('ppe_documents').select('*').order('created_at', { ascending: false }) // ⭐ ดึงเอกสาร
  ]);

  const ppeItems = ppeItemsRes.data || [];
  const issueVouchers = issueVouchersRes.data || [];
  const receiveTransactions = receiveTransactionsRes.data || [];
  const loanTransactions = loanTransactionsRes.data || [];
  const categories = categoriesRes.data || [];
  const feedback = feedbackRes.data || [];
  const ppeMatrix = matrixRes.data || []; // ⭐ 3. ดึง data
  const ppeDocuments = docsRes.data || []; // ⭐ ดึง data

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
    departments: departmentsRes.data || [],
    feedbackData: feedback, 
    ppeMatrix,
    ppeDocuments, // ⭐ ส่งกลับหน้าบ้าน
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
  const normalizedId = Number(categoryId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('รหัสหมวดหมู่ไม่ถูกต้อง');
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('id, name')
    .eq('id', normalizedId)
    .maybeSingle();
  if (categoryError) throw categoryError;
  if (!category) throw new Error('ไม่พบหมวดหมู่ที่ต้องการลบ');

  const { count, error: countError } = await supabase
    .from('ppe_items')
    .select('*', { count: 'exact', head: true })
    .eq('category', category.name)
    .is('deleted_at', null);
  if (countError) throw countError;
  if ((count || 0) > 0) throw new Error(`ยังลบหมวดหมู่ “${category.name}” ไม่ได้ เนื่องจากมีอุปกรณ์ใช้งานอยู่ ${count} รายการ`);

  const { error } = await supabase.from('categories').delete().eq('id', normalizedId);
  if (error) throw error;
  return normalizedId;
}

async function savePpeItem(itemData) {
  if (!itemData) throw new Error('Missing item data');

  const id = itemData.id ? Number(itemData.id) : null;
  const code = String(itemData.code || '').trim().toUpperCase();
  const name = String(itemData.name || '').trim();
  const category = String(itemData.category || '').trim();
  const unit = String(itemData.unit || '').trim();
  const stock = Number(itemData.stock);
  const reorderPoint = Number(itemData.reorderPoint);
  const price = Number(itemData.price || 0);
  const imageUrl = String(itemData.imageUrl || '').trim();

  if (id !== null && (!Number.isInteger(id) || id <= 0)) throw new Error('รหัสอุปกรณ์ไม่ถูกต้อง');
  if (!code || code.length > 50) throw new Error('กรุณาระบุรหัสอุปกรณ์ไม่เกิน 50 ตัวอักษร');
  if (!name || name.length > 150) throw new Error('กรุณาระบุชื่ออุปกรณ์ไม่เกิน 150 ตัวอักษร');
  if (!category || category.length > 100) throw new Error('กรุณาเลือกหมวดหมู่ให้ถูกต้อง');
  if (!unit || unit.length > 30) throw new Error('กรุณาระบุหน่วยนับไม่เกิน 30 ตัวอักษร');
  if (!Number.isInteger(stock) || stock < 0) throw new Error('จำนวนคงเหลือต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) throw new Error('จุดสั่งซื้อต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  if (!Number.isFinite(price) || price < 0 || price > 999999999) throw new Error('ราคาต่อหน่วยไม่ถูกต้อง');
  if (imageUrl) {
    try {
      const parsedUrl = new URL(imageUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('invalid protocol');
    } catch {
      throw new Error('ลิงก์รูปภาพต้องเป็น HTTPS ที่ถูกต้อง');
    }
  }

  const [{ data: validCategory, error: categoryError }, { data: duplicateCodes, error: duplicateError }] = await Promise.all([
    supabase.from('categories').select('id').eq('name', category).limit(1).maybeSingle(),
    supabase.from('ppe_items').select('id, name').ilike('code', code).is('deleted_at', null),
  ]);
  if (categoryError) throw categoryError;
  if (duplicateError) throw duplicateError;
  if (!validCategory) throw new Error('ไม่พบหมวดหมู่ที่เลือก กรุณารีเฟรชข้อมูลแล้วลองใหม่');
  const duplicate = (duplicateCodes || []).find(item => Number(item.id) !== id);
  if (duplicate) throw new Error(`รหัส ${code} ถูกใช้กับอุปกรณ์ “${duplicate.name}” แล้ว`);

  let existingItem = null;
  if (id !== null) {
    const { data, error } = await supabase
      .from('ppe_items')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ไม่พบอุปกรณ์ที่ต้องการแก้ไข กรุณารีเฟรชข้อมูล');
    existingItem = data;
  }

  const payload = {
    code,
    name,
    category,
    unit,
    reorderPoint,
    stock,
    onLoanQuantity: existingItem ? Math.max(0, Number(existingItem.onLoanQuantity) || 0) : 0,
    price,
    image_url: imageUrl,
  };

  if (id !== null) {
    const { data, error } = await supabase
      .from('ppe_items')
      .update(payload)
      .eq('id', id)
      .eq('stock', Number(existingItem.stock) || 0)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ข้อมูลสต็อกถูกเปลี่ยนโดยรายการอื่น กรุณารีเฟรชแล้วตรวจสอบอีกครั้ง');
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

async function claimPendingVoucher(voucherId) {
  const normalizedId = Number(voucherId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('รหัสใบเบิกไม่ถูกต้อง');
  const { data: voucher, error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'processing' })
    .eq('id', normalizedId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!voucher) throw new Error('ใบเบิกนี้ถูกจัดการไปแล้ว กรุณารีเฟรชข้อมูล');
  return voucher;
}

async function releaseVoucherClaim(voucherId) {
  const { error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'pending' })
    .eq('id', Number(voucherId))
    .eq('status', 'processing');
  if (error) console.error('Voucher claim rollback failed:', error);
}

function normalizeAdminNote(value) {
  return String(value || '').trim().slice(0, 500);
}

async function approveVoucher(approvalData) {
  const voucherId = Number(approvalData?.voucherId);
  const adminNote = normalizeAdminNote(approvalData?.adminNote);
  const voucher = await claimPendingVoucher(voucherId);

  const itemsToUpdate = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');
  let updatedStockItems = [];
  try {
    updatedStockItems = await updateStockLevels(itemsToUpdate, 'decrease');
    const { data: updatedVoucher, error: upErr } = await supabase
      .from('issue_vouchers')
      .update({ status: 'approved', adminNotes: adminNote || 'อนุมัติโดย Admin' })
      .eq('id', voucherId)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle();
    if (upErr) throw upErr;
    if (!updatedVoucher) throw new Error('ไม่สามารถยืนยันสถานะใบเบิกได้ กรุณาลองใหม่');
  } catch (error) {
    if (updatedStockItems.length) {
      await updateStockLevels(itemsToUpdate, 'increase').catch(rollbackError => console.error('Approval stock rollback failed:', rollbackError));
    }
    await releaseVoucherClaim(voucherId);
    throw error;
  }

  checkAndAlertLowStock(updatedStockItems).catch((e) => console.error('Stock alert error:', e));

  return { updatedVoucherId: voucherId, status: 'approved', updatedStockItems };
}

async function approvePartialVoucher(approvalData) {
  const voucherId = Number(approvalData?.voucherId);
  const adminNote = normalizeAdminNote(approvalData?.adminNote);
  const voucher = await claimPendingVoucher(voucherId);

  const originalItems = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');

  const approvedItems = Array.isArray(approvalData?.items) ? approvalData.items : [];
  const seenIds = new Set();
  let allApprovedFully = true;
  const notes = ['อนุมัติบางส่วน:'];
  const itemsToUpdateInStock = [];
  try {
    for (const approved of approvedItems) {
      const itemId = Number(approved?.itemId);
      const quantity = Number(approved?.quantity);
      const original = originalItems.find((item) => Number(item.itemId) === itemId);
      if (!Number.isInteger(itemId) || itemId <= 0 || seenIds.has(itemId) || !original) throw new Error('รายการอนุมัติไม่ถูกต้องหรือซ้ำกัน');
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > Number(original.quantity)) throw new Error('จำนวนอนุมัติเกินจำนวนที่ผู้ใช้ขอ');
      seenIds.add(itemId);
      if (quantity > 0) {
        itemsToUpdateInStock.push({ itemId, quantity });
        notes.push(`- ${String(approved.itemName || `อุปกรณ์ #${itemId}`).slice(0, 160)}: ${quantity}/${Number(original.quantity)}`);
      }
      if (quantity < Number(original.quantity)) allApprovedFully = false;
    }
    if (seenIds.size !== originalItems.length) throw new Error('กรุณาตรวจสอบจำนวนอนุมัติให้ครบทุกรายการ');
  } catch (error) {
    await releaseVoucherClaim(voucherId);
    throw error;
  }

  if (itemsToUpdateInStock.length === 0) {
    await releaseVoucherClaim(voucherId);
    throw new Error('ไม่สามารถอนุมัติโดยไม่มีรายการสินค้าได้ กรุณาปฏิเสธใบเบิกแทน');
  }
  let updatedStockItems = [];
  const newStatus = allApprovedFully ? 'approved' : 'partially_approved';
  const finalNote = [notes.join(' '), adminNote].filter(Boolean).join(' | ').slice(0, 1000);
  try {
    updatedStockItems = await updateStockLevels(itemsToUpdateInStock, 'decrease');
    const { data: updatedVoucher, error: upErr } = await supabase
      .from('issue_vouchers')
      .update({ status: newStatus, adminNotes: finalNote })
      .eq('id', voucherId)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle();
    if (upErr) throw upErr;
    if (!updatedVoucher) throw new Error('ไม่สามารถยืนยันสถานะใบเบิกได้ กรุณาลองใหม่');
  } catch (error) {
    if (updatedStockItems.length) {
      await updateStockLevels(itemsToUpdateInStock, 'increase').catch(rollbackError => console.error('Partial approval stock rollback failed:', rollbackError));
    }
    await releaseVoucherClaim(voucherId);
    throw error;
  }

  checkAndAlertLowStock(updatedStockItems).catch((e) => console.error('Stock alert error:', e));

  return { updatedVoucherId: voucherId, status: newStatus, updatedStockItems };
}

async function rejectVoucher(approvalData) {
  const voucherId = Number(approvalData?.voucherId);
  const adminNote = normalizeAdminNote(approvalData?.adminNote);
  if (!Number.isInteger(voucherId) || voucherId <= 0) throw new Error('รหัสใบเบิกไม่ถูกต้อง');
  if (!adminNote) throw new Error('กรุณาระบุเหตุผลที่ปฏิเสธ');
  const { data, error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'rejected', adminNotes: adminNote })
    .eq('id', voucherId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('ใบเบิกนี้ถูกจัดการไปแล้ว กรุณารีเฟรชข้อมูล');
  return { updatedVoucherId: voucherId, status: 'rejected' };
}

async function addReceiveTransactionAndUpdateStock(tx) {
  const itemId = Number(tx?.itemId);
  const quantity = Number(tx?.quantity);
  const type = String(tx?.type || '').trim();
  const user = String(tx?.user || '').trim();
  const department = String(tx?.department || '').trim();
  const allowedTypes = new Set(['purchase', 'return', 'adjustment']);

  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('กรุณาเลือกอุปกรณ์');
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999999) throw new Error('จำนวนที่รับต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 999,999');
  if (!allowedTypes.has(type)) throw new Error('ประเภทการรับไม่ถูกต้อง');
  if (!user || user.length > 150) throw new Error('กรุณาระบุชื่อผู้รับของให้ถูกต้อง');
  if (!department || department.length > 150) throw new Error('กรุณาเลือกแผนก');

  const [{ data: item, error: itemError }, { data: masterDepartment, error: departmentError }] = await Promise.all([
    supabase.from('ppe_items').select('id, name').eq('id', itemId).is('deleted_at', null).maybeSingle(),
    supabase.from('departments').select('id, name').eq('name', department).limit(1).maybeSingle(),
  ]);
  if (itemError) throw itemError;
  if (departmentError) throw departmentError;
  if (!item) throw new Error('ไม่พบอุปกรณ์ที่เลือก กรุณารีเฟรชข้อมูล');
  if (!masterDepartment) throw new Error('ไม่พบแผนกในข้อมูลมาสเตอร์ กรุณาเลือกแผนกใหม่');

  const updatedStockItems = await updateStockLevels([{ itemId, quantity }], 'increase');
  let transaction = null;

  try {
    const nextId = await getNextId('receive_transactions', 'id');

    const { data, error: rErr } = await supabase
      .from('receive_transactions')
      .insert({
        id: nextId,
        timestamp: new Date().toISOString(),
        itemName: item.name,
        type,
        quantity,
        user,
        department: masterDepartment.name,
        status: 'completed',
      })
      .select()
      .single();
    if (rErr) throw rErr;
    transaction = data;
  } catch (transactionError) {
    try {
      await updateStockLevels([{ itemId, quantity }], 'decrease');
    } catch (rollbackError) {
      console.error('[receive] stock rollback failed:', rollbackError.message);
    }
    throw transactionError;
  }

  return { updatedStockItems, transaction };
}

// ในไฟล์ ppe.js ค้นหาฟังก์ชัน borrowItem แล้วแก้เป็นแบบนี้
async function borrowItem(borrowData) {
  const itemId = Number(borrowData?.itemId);
  const borrowerName = String(borrowData?.borrowerName || '').trim();
  const employeeId = String(borrowData?.employeeId || '').trim();
  const department = String(borrowData?.department || '').trim();
  const dueDate = String(borrowData?.dueDate || '');
  const notes = String(borrowData?.notes || '').trim().slice(0, 500);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('กรุณาเลือกอุปกรณ์ที่ต้องการยืม');
  if (!borrowerName || borrowerName.length > 150) throw new Error('กรุณาระบุชื่อผู้ยืมให้ถูกต้อง');
  if (!employeeId || employeeId.length > 50) throw new Error('กรุณาระบุรหัสพนักงานให้ถูกต้อง');
  if (!department || department.length > 150) throw new Error('กรุณาเลือกแผนก');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) {
    throw new Error('กรุณาระบุกำหนดคืนให้ถูกต้อง');
  }
  if (dueDate < today) throw new Error('กำหนดคืนต้องไม่เป็นวันที่ย้อนหลัง');

  const nextId = await getNextId('loan_transactions', 'loanId');
  const updatedItem = await updateLoanableStock(itemId, 'borrow');

  const { data, error } = await supabase
    .from('loan_transactions')
    .insert({
      loanId: nextId,
      itemId,
      borrowerName,
      
      // ✅ แก้ตรงนี้: ฝั่งซ้ายคือชื่อคอลัมน์ใน DB (ตัวเล็ก) = ฝั่งขวาคือค่าจาก Frontend (CamelCase)
      employeeid: employeeId,
      userid: borrowData.userId || '', 
      
      department,
      
      borrowDate: new Date().toISOString(),
      dueDate,
      returnDate: null,
      status: 'on_loan',
      notes,
    })
    .select()
    .single();

  if (error) {
      console.error("Database Insert Error:", error);
      // คืนจำนวนสต็อกหากบันทึกรายการยืมไม่สำเร็จ
      try {
        await updateLoanableStock(itemId, 'return');
      } catch (rollbackError) {
        console.error('Loan stock rollback failed:', rollbackError);
      }
      throw error;
  }

  return { newLoan: data, updatedItem };
}

async function returnItem(loanId) {
  const normalizedLoanId = Number(loanId);
  if (!Number.isInteger(normalizedLoanId) || normalizedLoanId <= 0) throw new Error('รหัสรายการยืมไม่ถูกต้อง');
  const { data: loan, error } = await supabase
    .from('loan_transactions')
    .select('*')
    .eq('loanId', normalizedLoanId)
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
    .eq('loanId', normalizedLoanId);
  if (upErr) {
    // ย้อนจำนวนสต็อกกลับหากอัปเดตสถานะรับคืนไม่สำเร็จ
    try {
      await updateLoanableStock(loan.itemId, 'borrow');
    } catch (rollbackError) {
      console.error('Return stock rollback failed:', rollbackError);
    }
    throw upErr;
  }

  return { returnedLoanId: normalizedLoanId, updatedItem };
}

// สร้าง HMAC session token อายุ 24 ชั่วโมง
function generateAdminToken(username) {
  const expiry = Date.now() + 24 * 60 * 60 * 1000;
  const tokenPayload = `${username}:${expiry}`;
  const secret = SESSION_SECRET || 'no-secret-set';
  if (!SESSION_SECRET) console.warn('⚠️ SESSION_SECRET ไม่ได้ตั้งค่า กรุณาเพิ่มใน Vercel Environment Variables');
  const signature = crypto.createHmac('sha256', secret).update(tokenPayload).digest('hex');
  return `${tokenPayload}:${signature}`;
}

// ตรวจสอบ HMAC token
function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const lastColon = token.lastIndexOf(':');
  const secondLastColon = token.lastIndexOf(':', lastColon - 1);
  if (lastColon === -1 || secondLastColon === -1 || lastColon === secondLastColon) return false;
  const username = token.substring(0, secondLastColon);
  const expiry = token.substring(secondLastColon + 1, lastColon);
  const signature = token.substring(lastColon + 1);
  if (Date.now() > Number(expiry)) return false;
  const tokenPayload = `${username}:${expiry}`;
  const secret = SESSION_SECRET || 'no-secret-set';
  const expectedSig = crypto.createHmac('sha256', secret).update(tokenPayload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

async function checkAdminCredentials(username, password) {
  if (username !== ADMIN_USERNAME) return false;

  // เส้นทางหลัก: scrypt (ปลอดภัยกว่า)
  if (ADMIN_PASSWORD_SCRYPT) {
    const [salt, storedHash] = ADMIN_PASSWORD_SCRYPT.split(':');
    try {
      const derived = crypto.scryptSync(password, salt, 64).toString('hex');
      const match = crypto.timingSafeEqual(
        Buffer.from(derived, 'hex'),
        Buffer.from(storedHash, 'hex')
      );
      return match ? generateAdminToken(username) : false;
    } catch {
      return false;
    }
  }

  // fallback: Base64 (ใช้ได้จนกว่าจะ set ADMIN_PASSWORD_SCRYPT)
  if (ADMIN_PASSWORD_BASE64) {
    const provided = Buffer.from(password, 'utf8').toString('base64');
    if (provided === ADMIN_PASSWORD_BASE64) return generateAdminToken(username);
  }

  console.warn('⚠️ ไม่มี admin credentials ตั้งค่าใน environment variables');
  return false;
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

  const normalizedItems = items.map(item => ({
    itemId: Number(item?.itemId),
    quantity: Number(item?.quantity),
  }));
  if (normalizedItems.some(item => !Number.isInteger(item.itemId) || item.itemId <= 0 || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error('รายการหรือจำนวนอุปกรณ์ไม่ถูกต้อง');
  }
  if (new Set(normalizedItems.map(item => item.itemId)).size !== normalizedItems.length) {
    throw new Error('พบรายการอุปกรณ์ซ้ำ');
  }

  const ids = normalizedItems.map((item) => item.itemId);
  const { data: ppeRows, error } = await supabase
    .from('ppe_items')
    .select('*')
    .in('id', ids)
    .is('deleted_at', null);
  if (error) throw error;
  if ((ppeRows || []).length !== ids.length) throw new Error('มีอุปกรณ์บางรายการไม่อยู่ในคลังแล้ว');

  const updatedItems = [];
  const plannedUpdates = normalizedItems.map(item => {
    const target = ppeRows.find((p) => Number(p.id) === Number(item.itemId));
    const currentStock = Number(target.stock || 0);
    const qty = item.quantity;
    const newStock = operation === 'decrease' ? currentStock - qty : currentStock + qty;
    if (newStock < 0) throw new Error(`สต็อก "${target.name}" ไม่เพียงพอ (คงเหลือ: ${currentStock}, ต้องการ: ${qty})`);
    return { target, currentStock, newStock, quantity: qty };
  });

  try {
    for (const plan of plannedUpdates) {
      const { data: updated, error: upErr } = await supabase
        .from('ppe_items')
        .update({ stock: plan.newStock })
        .eq('id', plan.target.id)
        .eq('stock', plan.currentStock)
        .select('id, stock')
        .maybeSingle();
      if (upErr) throw upErr;
      if (!updated) throw new Error(`สต็อก "${plan.target.name}" มีการเปลี่ยนแปลง กรุณารีเฟรชและตรวจสอบใหม่`);
      updatedItems.push({ id: plan.target.id, stock: plan.newStock, previousStock: plan.currentStock, quantity: plan.quantity });
    }
  } catch (updateError) {
    for (const updated of [...updatedItems].reverse()) {
      const { error: rollbackError } = await supabase
        .from('ppe_items')
        .update({ stock: updated.previousStock })
        .eq('id', updated.id)
        .eq('stock', updated.stock);
      if (rollbackError) console.error('Stock rollback failed:', rollbackError);
    }
    throw updateError;
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
    onLoan = Math.max(0, onLoan - 1);
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

  if (!['approved', 'partially_approved'].includes(voucher.status)) {
    throw new Error('ใบเบิกนี้ยังไม่ได้รับการอนุมัติ');
  }

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

// ✅ ฟังก์ชันลบอุปกรณ์ (เวอร์ชัน Supabase)
async function deletePpeItem(payload) {
  const itemId = Number(payload?.id);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('รหัสอุปกรณ์ไม่ถูกต้อง');

  const [{ data: item, error: itemError }, { data: activeLoans, error: loanError }, { data: activeVouchers, error: voucherError }] = await Promise.all([
    supabase.from('ppe_items').select('id, name').eq('id', itemId).is('deleted_at', null).maybeSingle(),
    supabase.from('loan_transactions').select('loanId').eq('itemId', itemId).eq('status', 'on_loan').limit(1),
    supabase.from('issue_vouchers').select('id, items').in('status', ['pending', 'processing']),
  ]);
  if (itemError) throw itemError;
  if (loanError) throw loanError;
  if (voucherError) throw voucherError;
  if (!item) throw new Error('ไม่พบอุปกรณ์ที่ต้องการนำออก');
  if ((activeLoans || []).length > 0) throw new Error(`ยังนำ “${item.name}” ออกจากรายการไม่ได้ เนื่องจากมีรายการยืมที่ยังไม่คืน`);
  const pendingReference = (activeVouchers || []).find(voucher => (Array.isArray(voucher.items) ? voucher.items : []).some(entry => Number(entry.itemId) === itemId));
  if (pendingReference) throw new Error(`ยังนำ “${item.name}” ออกจากรายการไม่ได้ เนื่องจากอยู่ในคำขอ #${pendingReference.id} ที่กำลังดำเนินการ`);

  // Soft delete — ตั้ง deleted_at แทนการลบจริง (กู้คืนได้จาก Supabase dashboard)
  const { data, error } = await supabase
    .from('ppe_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', itemId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('อุปกรณ์ถูกนำออกจากรายการไปแล้ว กรุณารีเฟรชข้อมูล');
  return { status: 'success', message: 'Soft deleted successfully' };
}

async function deleteVoucher(voucherId) {
  if (!voucherId) throw new Error('Missing voucherId');

  const { error } = await supabase
    .from('issue_vouchers')
    .delete()
    .eq('id', voucherId);

  if (error) throw error;
  return { status: 'success' };
}

// ⭐⭐⭐ แก้ไขฟังก์ชันนี้ใน api/ppe.js ⭐⭐⭐
async function saveMatrixRule(payload) {
  const id = payload?.id ? Number(payload.id) : null;
  const jobFunction = String(payload?.jobFunction || '').trim();
  const department = String(payload?.department || '').trim();
  const remark = String(payload?.remark || '').trim();
  const itemsJson = Array.isArray(payload?.itemsJson) ? payload.itemsJson : [];

  if (!jobFunction) throw new Error('กรุณาระบุชื่องานหรือพื้นที่');
  if (jobFunction.length > 160) throw new Error('ชื่องานยาวเกิน 160 ตัวอักษร');
  if (department.length > 100) throw new Error('ชื่อแผนกยาวเกิน 100 ตัวอักษร');
  if (remark.length > 1000) throw new Error('รายละเอียดงานยาวเกิน 1,000 ตัวอักษร');
  if (itemsJson.length < 1 || itemsJson.length > 50) throw new Error('กรุณาเลือกอุปกรณ์ 1-50 รายการ');

  const normalizedItems = itemsJson.map(item => ({
    id: Number(item?.id),
    name: String(item?.name || '').trim().slice(0, 160),
    props: String(item?.props || '').trim().slice(0, 500),
    lifespan: String(item?.lifespan || '').trim().slice(0, 200),
  }));
  if (normalizedItems.some(item => !Number.isInteger(item.id) || item.id <= 0 || !item.name)) {
    throw new Error('กรุณาเลือกอุปกรณ์จากรายการในคลังให้ครบถ้วน');
  }
  if (new Set(normalizedItems.map(item => item.id)).size !== normalizedItems.length) {
    throw new Error('พบอุปกรณ์ซ้ำในมาตรฐาน');
  }

  const itemIds = normalizedItems.map(item => item.id);
  const { data: linkedItems, error: linkedItemsError } = await supabase
    .from('ppe_items')
    .select('id, name')
    .in('id', itemIds)
    .is('deleted_at', null);
  if (linkedItemsError) throw linkedItemsError;
  if ((linkedItems || []).length !== itemIds.length) {
    throw new Error('มีอุปกรณ์บางรายการไม่อยู่ในคลังแล้ว กรุณาเลือกใหม่');
  }
  const linkedById = new Map(linkedItems.map(item => [Number(item.id), item]));
  normalizedItems.forEach(item => { item.name = linkedById.get(item.id)?.name || item.name; });
  
  const dbPayload = {
    job_function: jobFunction,
    items_json: normalizedItems,
    lifespan: '',
    remark,
    properties: '',
    department
  };

  if (id) {
    // Update
    const { data, error } = await supabase
      .from('ppe_matrix')
      .update(dbPayload)
      .eq('id', id).select().single();
    if (error) throw error;
    return data;
  } else {
    // Insert
    const { data, error } = await supabase
      .from('ppe_matrix')
      .insert(dbPayload)
      .select().single();
    if (error) throw error;
    return data;
  }
}

async function deleteMatrixRule(payload) {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('รหัสมาตรฐานไม่ถูกต้อง');
  const { error } = await supabase.from('ppe_matrix').delete().eq('id', id);
  if (error) throw error;
  return { status: 'success' };
}

async function uploadDocument(payload) {
  const title = String(payload?.title || '').trim();
  const fileName = String(payload?.fileName || '').trim();
  const fileBase64 = String(payload?.fileBase64 || '');
  const user = String(payload?.user || 'Admin').trim().slice(0, 100);

  if (!title || !fileName || !fileBase64) throw new Error('ข้อมูลไม่ครบ กรุณาระบุชื่อและไฟล์');
  if (title.length > 200) throw new Error('ชื่อเอกสารยาวเกิน 200 ตัวอักษร');
  if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error('รองรับเฉพาะไฟล์ PDF เท่านั้น');

  // 1. แปลง Base64 กลับเป็น Buffer
  const buffer = Buffer.from(fileBase64, 'base64');

  // ตรวจสอบขนาดไฟล์ (สูงสุด 10 MB)
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (buffer.length > MAX_FILE_SIZE) throw new Error('ไฟล์ขนาดใหญ่เกินไป (สูงสุด 10 MB)');

  // ตรวจสอบว่าเป็น PDF จริง (magic bytes: %PDF)
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
    throw new Error('รองรับเฉพาะไฟล์ PDF เท่านั้น');
  }

  // Sanitize ชื่อไฟล์ ป้องกัน path traversal
  const safeFileName = fileName.replace(/[^a-zA-Z0-9ก-๙._-]/g, '_');

  // 2. ตั้งชื่อไฟล์ใหม่กันซ้ำ (timestamp_filename)
  const filePath = `${Date.now()}_${safeFileName}`;

  // 3. Upload ขึ้น Storage Bucket ชื่อ 'documents'
  const { data: uploadData, error: uploadError } = await supabase
    .storage
    .from('documents')
    .upload(filePath, buffer, {
      contentType: 'application/pdf',
      upsert: false
    });

  if (uploadError) throw uploadError;

  // 4. ขอ Public URL
  const { data: publicUrlData } = supabase
    .storage
    .from('documents')
    .getPublicUrl(filePath);

  const finalUrl = publicUrlData.publicUrl;

  // 5. บันทึกลง Database
  const { data: doc, error: dbError } = await supabase
    .from('ppe_documents')
    .insert({
      title: title,
      file_url: finalUrl,
      file_type: 'pdf',
      uploaded_by: user
    })
    .select()
    .single();

  if (dbError) throw dbError;

  return doc;
}

async function deleteDocument(payload) {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('รหัสเอกสารไม่ถูกต้อง');

  const { data: existingDoc, error: readError } = await supabase
    .from('ppe_documents')
    .select('file_url')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw readError;

  // 1. ลบจาก Database
  const { error: dbError } = await supabase.from('ppe_documents').delete().eq('id', id);
  if (dbError) throw dbError;

  // 2. ลบไฟล์จาก Storage เพื่อไม่ให้เปลืองพื้นที่
  if (existingDoc?.file_url) {
    try {
      const parsedUrl = new URL(existingDoc.file_url);
      const storageFileName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '');
      if (storageFileName) {
        await supabase.storage.from('documents').remove([storageFileName]);
      }
    } catch (storageErr) {
      // ไม่ throw เพื่อไม่ให้ blocking — DB ลบแล้ว storage ไม่ blocking
      console.error('Storage delete error (non-critical):', storageErr);
    }
  }

  return { status: 'success' };
}
