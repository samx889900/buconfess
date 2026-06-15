import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";

const inter = Inter({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700", "800"] });

export const metadata: Metadata = {
  title: "BU Confessions | Speak Freely. Stay Anonymous.",
  description: "An immersive, 3D anonymous confession platform for Bennett University students.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen flex flex-col antialiased noise`} suppressHydrationWarning>
        {/* ── Floating Glass Navbar ───────────────────── */}
        <header className="fixed top-0 left-0 right-0 z-50 flex justify-center pt-5 px-4 enter-up">
          <nav className="glass rounded-2xl w-full max-w-3xl px-5 h-[52px] flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#8B5CF6] to-[#6D28D9] flex items-center justify-center shadow-[0_0_20px_rgba(139,92,246,0.4)] group-hover:shadow-[0_0_30px_rgba(139,92,246,0.6)] transition-shadow">
                <span className="text-[10px] font-bold text-white">BU</span>
              </div>
              <span className="font-semibold text-[13px] text-gray-800 tracking-tight hidden sm:block group-hover:text-black transition-colors">
                BU Confessions
              </span>
            </Link>

            <div className="flex items-center gap-0.5">
              {[
                { href: '/', label: 'Home' },
                { href: '/about', label: 'About' },
                { href: '/contact', label: 'Contact' },
              ].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="nav-link px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-900 rounded-lg hover:bg-black/[0.04] transition-all"
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
        <footer className="relative z-10 mt-auto pt-20 pb-10 px-6">
          <div className="divider-glow max-w-md mx-auto mb-10" />
          <div className="max-w-3xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-2.5">
              <div className="w-4 h-4 rounded bg-gradient-to-br from-[#8B5CF6] to-[#6D28D9] flex items-center justify-center">
                <span className="text-[6px] font-bold text-white">BU</span>
              </div>
              <span className="text-[11px] text-gray-500">© {new Date().getFullYear()} BU Confessions</span>
            </div>
            <div className="flex items-center gap-5">
              {['About', 'Contact'].map((l) => (
                <Link key={l} href={`/${l.toLowerCase()}`} className="text-[11px] text-gray-500 hover:text-[#8B5CF6] transition-colors">{l}</Link>
              ))}
              <a href="https://instagram.com/bu.confess" target="_blank" rel="noreferrer" className="text-[11px] text-gray-500 hover:text-[#8B5CF6] transition-colors flex items-center gap-1">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
                Instagram
              </a>
            </div>
          </div>
          <p className="text-center text-[9px] text-gray-400 mt-6 tracking-wider">ZERO TRACKING · END-TO-END ENCRYPTED · 100% ANONYMOUS</p>
        </footer>
      </body>
    </html>
  );
}
