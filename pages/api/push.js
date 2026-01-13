// pages/api/push.js
import { createClient } from '@supabase/supabase-js';

// 🔧 สร้าง Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==================
// Helper: format วันที่ไทย
// ==================
function formatThaiDateTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ==================
// Helper: สร้าง Flex "รับของแล้ว"
// ==================
function createReceivedFlex({ voucher, items }) {
  return {
    type: "flex",
    altText: `รับของเรียบร้อยแล้ว (#${voucher.id})`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "horizontal",
        backgroundColor: "#10B981",
        contents: [
          { type: "text", text: "🟢", size: "lg" },
          {
            type: "text",
            text: "รับของเรียบร้อยแล้ว",
            weight: "bold",
            color: "#FFFFFF",
            margin: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: `ใบเบิกเลขที่ #${voucher.id}`, weight: "bold" },
          { type: "text", text: `ผู้เบิก: ${voucher.user}`, size: "sm" },
          { type: "text", text: `แผนก: ${voucher.department}`, size: "sm" },

          { type: "separator", margin: "sm" },

          {
            type: "text",
            text: `ผู้รับ: ${voucher.received_by || '-'}`,
            size: "sm"
          },
          {
            type: "text",
            text: `เวลา: ${formatThaiDateTime(voucher.received_at)}`,
            size: "xs",
            color: "#6B7280"
          },

          { type: "separator", margin: "sm" },

          {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: items.map(it => ({
              type: "text",
              text: `• ${it.itemName || 'สินค้า'} x ${it.quantity}`,
              size: "xs"
            }))
          }
        ]
      }
    }
  };
}

// ==================
// API Handler
// ==================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const {
    userId,
    message,
    messages,
    type,
    voucherId
  } = req.body;

  const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!CHANNEL_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Missing LINE_CHANNEL_ACCESS_TOKEN' });
  }

  let msgPayload = [];

  try {
    // ==========================
    // ✅ CASE: รับของเรียบร้อยแล้ว
    // ==========================
    if (type === 'received') {
      if (!voucherId || !userId) {
        return res.status(400).json({ error: 'Missing voucherId or userId' });
      }

      const { data: voucher, error } = await supabase
        .from('issue_vouchers')
        .select('*')
        .eq('id', voucherId)
        .single();

      if (error || !voucher) {
        return res.status(404).json({ error: 'Voucher not found' });
      }

      const items = Array.isArray(voucher.itemsJson)
        ? voucher.itemsJson
        : JSON.parse(voucher.itemsJson || '[]');

      const flex = createReceivedFlex({ voucher, items });
      msgPayload = [flex];

    } else {
      // ==========================
      // 🟢 CASE ปกติ (ข้อความ / Flex เดิม)
      // ==========================
      if (!userId || (!message && !messages)) {
        return res.status(400).json({ error: 'Missing userId or content' });
      }

      msgPayload = messages
        ? messages
        : [{ type: 'text', text: message }];
    }

    // ==========================
    // 🚀 ส่งไป LINE
    // ==========================
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        to: userId,
        messages: msgPayload
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ LINE API Error:', errorData);
      return res.status(response.status).json({ success: false, error: errorData });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('❌ push.js error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
