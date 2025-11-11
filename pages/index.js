// pages/index.js
export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/index.html', // ชี้ไปไฟล์ใน public
      permanent: false,
    },
  };
}

export default function Home() {
  return null;
}
