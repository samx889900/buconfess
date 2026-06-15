import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'BU Confessions', description: 'Anonymous confessions from BU' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='en'>
      <body>{children}</body>
    </html>
  );
}
