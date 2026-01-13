// pages/api/push.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { userId, message, messages } = req.body;

    // ตรวจสอบว่ามี user และ (message หรือ messages)
    if (!userId || (!message && !messages)) {
        return res.status(400).json({ error: 'Missing userId or content' });
    }

    const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!CHANNEL_ACCESS_TOKEN) {
        return res.status(500).json({ error: 'Missing LINE Token' });
    }

    // เตรียม Payload ข้อความ (รองรับทั้ง Text เดิม และ Flex ใหม่)
    let msgPayload = [];
    if (messages) {
        msgPayload = messages; // กรณีส่งมาเป็น Array (เช่น Flex Message)
    } else {
        msgPayload = [{ type: 'text', text: message }]; // กรณีส่งมาแค่ข้อความ (แบบเก่า)
    }

    try {
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

    } catch (error) {
        console.error('❌ Network Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}