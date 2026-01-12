// pages/api/notify.js
export default async function handler(req, res) {
    // 1. ตรวจสอบว่าเป็น Method POST เท่านั้น
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { message } = req.body;

    // 2. ตรวจสอบว่ามีข้อความส่งมาไหม
    if (!message) {
        return res.status(400).json({ error: 'Missing message' });
    }

    // 3. ดึง Token จาก Environment Variable
    // ⚠️ ต้องตั้งค่าในไฟล์ .env.local ว่า: LINE_NOTIFY_TOKEN=xxx...
    const LINE_NOTIFY_TOKEN = process.env.LINE_NOTIFY_TOKEN;

    if (!LINE_NOTIFY_TOKEN) {
        console.error('❌ Error: ไม่พบ LINE_NOTIFY_TOKEN ในไฟล์ .env');
        return res.status(500).json({ error: 'Server Configuration Error: Missing Token' });
    }

    try {
        // 4. ส่งคำขอไปยัง LINE Notify API
        const response = await fetch('https://notify-api.line.me/api/notify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Bearer ${LINE_NOTIFY_TOKEN}`
            },
            body: new URLSearchParams({ message: message })
        });

        const data = await response.json();

        // 5. ตรวจสอบผลลัพธ์
        if (!response.ok) {
            console.error('❌ LINE Notify Error:', data);
            return res.status(response.status).json({ success: false, error: data });
        }

        return res.status(200).json({ success: true, data });

    } catch (error) {
        console.error('❌ Network/Server Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}