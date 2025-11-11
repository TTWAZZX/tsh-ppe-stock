// pages/index.js
export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/index.html', // ไฟล์ที่อยู่ใน public/
      permanent: false,
    },
  };
}

export default function Home() {
  return null;
}
