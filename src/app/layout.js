import './globals.css';

export const metadata = {
  title: 'AcademiaChain — Academic Collaboration Network Explorer',
  description:
    'Find the shortest co-authorship path between any two scholars (your Erdős number, generalized), computed live on the OpenAlex open scholarly graph.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
