# CLAUDE.md — TSH PPE Stock Management System

## Project Overview

ระบบจัดการอุปกรณ์ความปลอดภัย (PPE) สำหรับ Thai Summit Harness (TSH)
ทำงานร่วมกับ LINE LIFF และส่ง Push Message ผ่าน LINE Messaging API

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js (Serverless) |
| Frontend | Single-page app ใน `public/index.html` (React-style vanilla JS) |
| Database | Supabase (PostgreSQL) |
| Auth | LINE LIFF (users) + HMAC token (admin) |
| LINE | LIFF SDK 2.x, LINE Messaging API (server-managed push) |
| Hosting | Vercel |
| Charts | Chart.js |
| CSS | Tailwind CSS + Font Awesome 6 |

---

## Project Structure

```
├── pages/
│   ├── index.js              ← redirect ไป /index.html
│   └── api/
│       ├── ppe.js            ← API หลัก (20+ actions ใน single endpoint)
│       ├── notifications/
│       │   └── retry.js      ← worker retry ที่ยืนยันด้วย CRON_SECRET
│       ├── push.js           ← ปิด public relay (HTTP 410)
│       └── notify.js         ← tombstone ของ LINE Notify (HTTP 410)
├── lib/
│   └── notification-service.js ← durable LINE outbox, log และ retry
├── public/
│   ├── index.html            ← SPA หลัก (~6,400 lines)
│   └── js/
│       ├── api-client.js     ← wrapper fetch + LoadingManager
│       ├── loading-manager.js← จัดการ splash/overlay/skeleton
│       └── skeleton-registry.js
├── scripts/
│   └── hash-password.mjs     ← สร้าง scrypt hash สำหรับ admin password
├── supabase/
│   └── migrations.sql        ← schema: login_attempts, audit_log, notification_log
└── vercel.json
```

---

## Environment Variables

```env
# Frontend (public)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co

# Backend (server-side only)
SUPABASE_SERVICE_ROLE_KEY=eyJxx...
ADMIN_USERNAME=admin
ADMIN_PASSWORD_SCRYPT=salt:hash        # สร้างด้วย scripts/hash-password.mjs
SESSION_SECRET=<random-32-char-string>
ADMIN_LINE_USER_ID=Uxxxx...            # LINE userId ของ admin สำหรับรับ alert
LINE_CHANNEL_ACCESS_TOKEN=xxx...
LINE_LOGIN_CHANNEL_ID=2007053300       # optional ถ้าใช้ LIFF channel เดิม
CRON_SECRET=<random-32-char-string>     # ป้องกัน notification retry worker
NOTIFICATION_MAX_ATTEMPTS=5            # optional
NOTIFICATION_INLINE_ATTEMPTS=3         # optional
LINE_PUSH_TIMEOUT_MS=7000              # optional
```

---

## Local Development

```bash
npm install
# สร้าง .env.local แล้วใส่ค่า env ด้านบน
node scripts/hash-password.mjs   # สร้าง ADMIN_PASSWORD_SCRYPT
npm run dev
# เปิด http://localhost:3000/index.html
```

> หมายเหตุ: ต้องรัน `supabase/migrations.sql` ใน Supabase SQL Editor ก่อน

---

## Deploy

- Push ไป `main` → GitHub Actions build + deploy to Vercel production อัตโนมัติ
- PR → deploy preview อัตโนมัติ

---

## API Design (`/api/ppe`)

Single POST endpoint รับ `{ action, payload }` ทุก request

| Action | Admin? | คำอธิบาย |
|--------|--------|----------|
| `getInitialData` | Scoped | Public ได้เฉพาะ catalog, LINE ได้ข้อมูลตนเอง, Admin ได้ข้อมูลทั้งหมด |
| `addNewVoucher` | LINE/Admin | พนักงานขอเบิก PPE |
| `approveVoucher` | Yes | อนุมัติเต็ม + ตัดสต็อก |
| `approvePartialVoucher` | Yes | อนุมัติบางรายการ |
| `rejectVoucher` | Yes | ปฏิเสธ |
| `confirmReceive` | LINE/Admin | เจ้าของใบเบิกยืนยันรับของ หรือ Admin รับแทน |
| `borrowItem` | LINE/Admin | ยืม PPE |
| `returnItem` | Yes | คืน PPE |
| `addReceiveTransaction` | Yes | รับสต็อกเข้า |
| `savePpeItem` | Yes | สร้าง/แก้ไข PPE item |
| `deletePpeItem` | Yes | soft delete |
| `saveCategory` | Yes | สร้าง/แก้ไข category |
| `deleteCategory` | Yes | ลบ category |
| `checkAdminCredentials` | No | login → คืน HMAC token |
| `saveFeedback` | LINE/Admin | ให้คะแนน PPE (1-5 ดาว) เฉพาะรายการที่มีสิทธิ์ |
| `checkLineStatus` | Yes | ตรวจ Messaging API token, bot และ quota แบบ read-only |
| `getNotificationLogs` | Yes | ดูผลส่งล่าสุด โดยปิดบัง LINE userId |
| `retryNotification` | Yes | ลองส่ง Notification Log ที่ระบุอีกครั้ง |
| `retryDueNotifications` | Yes | ประมวลผลรายการ retry ที่ถึงเวลาแล้ว |
| `saveMatrixRule` | Yes | กำหนด PPE matrix ตาม job function |
| `deleteMatrixRule` | Yes | ลบ rule |
| `uploadDocument` | Yes | อัปโหลดเอกสาร |
| `deleteDocument` | Yes | ลบเอกสาร |

Admin actions ต้องส่ง `adminToken` ใน payload ซึ่งเป็น HMAC format:
`username:timestamp:hmacSignature`

---

## Key Patterns

### Loading States
ใช้ `LoadingManager` (ไม่ใช่ `showLoading()`/`hideLoading()` โดยตรง)
- Key format: `"scope.action"` เช่น `"page.dashboard"`, `"action.approveVoucher"`
- Splash screen (`splashScreen`) ต้องซ่อนด้วย `hideSplash()` แยกต่างหาก — ไม่ผ่าน LoadingManager

### Soft Delete
```javascript
// ไม่ใช้ DELETE — ใช้ update deleted_at แทน
.update({ deleted_at: new Date().toISOString() }).eq('id', id)
// query ต้อง filter: .is('deleted_at', null)
```

### Audit Logging
```javascript
// fire-and-forget — ไม่ต้อง await
writeAuditLog(actor, action, table, recordId, details);
```

### Error Messages
กรองข้อความ error ที่อาจเปิดเผย schema Supabase:
```javascript
const isSafe = !/supabase|postgres|connection|permission/i.test(err.message);
const msg = isSafe ? err.message : 'เกิดข้อผิดพลาดภายในระบบ';
```

### LIFF Deep Link (confirmReceive)
URL format: `https://liff.line.me/2007053300-JTSerFbF?mode=confirmReceive&voucherId=X`
- `handleLiffConfirmReceive()` ถูกเรียกใน `initializeApp()` ก่อน `getInitialData()`
- ต้องเรียก `hideSplash()` ก่อน show confirmation modal ไม่งั้น modal จะซ่อนอยู่หลัง splash

---

## Database Tables (Supabase)

- `ppe_items` — รายการ PPE (soft delete via `deleted_at`)
- `ppe_categories` — หมวดหมู่
- `departments` — แผนก
- `issue_vouchers` + `issue_voucher_items` — ใบเบิก
- `receive_transactions` — รับสต็อกเข้า
- `loan_transactions` — การยืม
- `feedback` — คะแนน PPE
- `ppe_matrix` — กฎ PPE ตาม job function
- `documents` — เอกสาร
- `login_attempts` — ป้องกัน brute-force (lockout หลัง 5 ครั้ง / 15 นาที)
- `audit_log` — immutable log ทุก mutation
- `notification_log` — durable outbox, provider response, request ID และประวัติ retry

---

## Important Notes

- ภาษาในโค้ด: ชื่อตัวแปร/ฟังก์ชันเป็น English, comment เป็น Thai
- Locale: `th-TH` สำหรับ date/number formatting ทั้งหมด
- LIFF ID: `2007053300-JTSerFbF` (hardcoded ใน index.html)
- Server ตรวจ LIFF access token กับ LINE และไม่เชื่อ `userId` จาก browser
- LINE Push ส่งผ่าน `lib/notification-service.js` จาก backend เท่านั้น; `/api/push` และ LINE Notify ถูกปิด
- ทุก push ต้องสร้าง `notification_log` ก่อนส่ง, ใช้ event key กันส่งซ้ำ และแยก `sent`, `duplicate`, `retry_scheduled`, `failed`, `skipped`
- LINE `200` หมายถึง provider รับคำขอแล้ว ไม่ใช่หลักฐานว่าผู้ใช้เปิดอ่านข้อความ; เก็บ `x-line-request-id` ไว้ตรวจสอบย้อนหลัง
- Vercel Cron เรียก `/api/notifications/retry` วันละครั้งเพื่อรองรับ Hobby plan; Admin สั่ง retry ได้ทันทีผ่าน API
- Admin lock: ล็อก account หลัง login ผิด 5 ครั้ง ภายใน 15 นาที
- Stock alert: LINE push ถึง `ADMIN_LINE_USER_ID` อัตโนมัติเมื่อสต็อก < reorder point
