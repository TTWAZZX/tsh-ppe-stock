// pages/api/push.js
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { userId, message } = req.body;

    // ⚠️ ใส่ Channel Access Token (แบบ Long-lived) จาก LINE Developers
    const CHANNEL_ACCESS_TOKEN = 'C6KcTxzglAJNBgmfwLu6PnjVJSZbxSE09O3pk81FZVxWuHOv0BLvHN44pRA81EikZUDf+omi6mKoq+12sVg2aqKpbhryNMvSBnTWawXgmwA1u+kHrA7DmtqaAvUQP/gKbVKJ2a4Hggwe8Un2Rd0CIQdB04t89/1O/w1cDnyilFU='; 

    try {
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                to: userId, // ส่งหา User ID คนนั้นโดยเฉพาะ
                messages: [{ type: 'text', text: message }]
            })
        });

        if (!response.ok) {
            const error = await response.json();
            return res.status(response.status).json(error);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}