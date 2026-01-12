// pages/api/push.js
export default async function handler(req, res) {
    // 1. ตรวจสอบว่าเป็น Method POST เท่านั้น
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { userId, message } = req.body;

    // 2. ตรวจสอบว่าส่งข้อมูลมาครบไหม
    if (!userId || !message) {
        return res.status(400).json({ error: 'Missing userId or message' });
    }

    // 3. ดึง Token จาก Environment Variable (เพื่อความปลอดภัย ห้ามฝังในโค้ด)
    // ⚠️ ต้องตั้งค่าในไฟล์ .env.local ว่า: LINE_CHANNEL_ACCESS_TOKEN=xxx...
    const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

    if (!CHANNEL_ACCESS_TOKEN) {
        console.error('❌ Error: ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ในไฟล์ .env');
        return res.status(500).json({ error: 'Server Configuration Error: Missing Token' });
    }

    try {
        // 4. ส่งคำขอไปยัง LINE Messaging API
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                to: userId,
                messages: [{ type: 'text', text: message }]
            })
        });

        // 5. ตรวจสอบผลลัพธ์จาก LINE
        if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ LINE API Error:', errorData);
            return res.status(response.status).json({ success: false, error: errorData });
        }

        // สำเร็จ
        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('❌ Network/Server Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}