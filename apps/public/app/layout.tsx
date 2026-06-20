import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: "BU Confessions | Speak Freely. Stay Anonymous.",
  description: "An immersive, 3D anonymous confession platform for Bennett University students.",
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen flex flex-col antialiased noise`} suppressHydrationWarning>
        {/* ── Floating Glass Navbar ───────────────────── */}
        <header className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-6 px-4 enter-up">
          <nav className="glass-strong rounded-full w-full max-w-4xl px-6 h-[60px] flex items-center justify-between shadow-sm">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-8 h-8 rounded-xl shadow-[0_4px_12px_rgba(139,92,246,0.15)] group-hover:shadow-[0_4px_20px_rgba(139,92,246,0.25)] group-hover:-translate-y-0.5 transition-all duration-300 overflow-hidden flex items-center justify-center">
                <img src="/logo.png" alt="BU Confessions Logo" className="w-full h-full object-cover" />
              </div>
              <span className="font-semibold text-[14px] text-gray-800 tracking-tight hidden sm:block group-hover:text-black transition-colors">
                BU Confessions
              </span>
            </Link>

            <div className="flex items-center gap-1.5">
              <a
                href="https://roomie.buconfess.in/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 mr-2 px-3 py-1.5 text-[12px] font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors whitespace-nowrap"
              >
                <span className="hidden md:inline">Find a Roommate</span>
                <span className="md:hidden">Roommate</span>
              </a>
              {[
                { href: '/', label: 'Home' },
                { href: '/about', label: 'About' },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="nav-link px-3.5 py-2 text-[13px] font-medium text-gray-500 hover:text-gray-900 rounded-lg hover:bg-black/[0.03] transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </nav>
        </header>

        {/* ── Aurora Background Effects ───────────────── */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-[-1]">
          <div className="aurora-1 absolute top-[-20%] right-[-15%]" />
          <div className="aurora-2 absolute bottom-[-15%] left-[-10%]" />
          <div className="aurora-3 absolute top-[40%] left-[60%]" />
        </div>

        {/* ── Main ───────────────────────────────────── */}
        <main className="flex-1 flex flex-col pt-28 grid-bg">{children}</main>

        {/* ── Footer ─────────────────────────────────── */}
        <footer className="relative z-10 mt-auto pt-24 pb-12 px-6">
          <div className="divider-glow max-w-2xl mx-auto mb-12" />
          <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="flex flex-col items-center md:items-start gap-3">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-lg overflow-hidden flex items-center justify-center shadow-sm">
                  <img src="/logo.png" alt="BU Confessions Logo" className="w-full h-full object-cover" />
                </div>
                <span className="text-[13px] font-medium text-gray-800">BU Confessions</span>
              </div>
              <span className="text-[12px] text-gray-500">© {new Date().getFullYear()} All rights reserved.</span>
            </div>
            
            <div className="flex flex-wrap justify-center items-center gap-6">
              {[
                { label: 'About', href: '/about' },
                { label: 'Terms', href: '/terms' },
                { label: 'Privacy', href: '/privacy' },
                { label: 'Contact', href: '/contact' }
              ].map((l) => (
                <Link key={l.label} href={l.href} className="text-[13px] text-gray-500 hover:text-purple-600 transition-colors">{l.label}</Link>
              ))}
              <a href="https://instagram.com/bu.confess" target="_blank" rel="noreferrer" className="text-[13px] text-gray-500 hover:text-purple-600 transition-colors flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
                Instagram
              </a>
            </div>
          </div>
          <p className="text-center text-[10px] text-gray-400 mt-10 tracking-[0.2em] font-medium uppercase">Zero Tracking · End-to-End Encrypted · 100% Anonymous</p>
        </footer>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
