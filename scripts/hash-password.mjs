// scripts/hash-password.mjs
// สร้าง scrypt hash สำหรับ admin password
// รัน: node scripts/hash-password.mjs
// แล้วเอาผลลัพธ์ไปใส่ใน Vercel Environment Variables → ADMIN_PASSWORD_SCRYPT

import { scryptSync, randomBytes } from 'crypto';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question('กรอก Admin Password ที่ต้องการใช้: ', (password) => {
  if (!password || password.length < 8) {
    console.error('❌ Password ต้องมีอย่างน้อย 8 ตัวอักษร');
    process.exit(1);
  }

  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const result = `${salt}:${hash}`;

  console.log('\n✅ สำเร็จ! เอา value ด้านล่างไปใส่ใน Vercel env var:');
  console.log('┌─────────────────────────────────────────');
  console.log('│ Variable name : ADMIN_PASSWORD_SCRYPT');
  console.log(`│ Value         : ${result}`);
  console.log('└─────────────────────────────────────────');
  console.log('\n⚠️  หลังจากตั้งค่าแล้ว ลบ ADMIN_PASSWORD_BASE64 ออกจาก Vercel ได้เลย');
  rl.close();
});
