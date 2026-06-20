import { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service | BUConfess',
  description: 'Terms of Service for BUConfess, the anonymous confession platform for Bennett University.',
};

export default function TermsPage() {
  return (
    <div className="min-h-screen pt-32 pb-24 px-6 md:px-12 max-w-3xl mx-auto font-sans">
      <div className="glass-strong p-6 md:p-10 rounded-3xl border border-gray-100 shadow-sm relative z-10 bg-white/60">
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 tracking-tight mb-8">Terms of Service</h1>
        
        <div className="space-y-8 text-gray-700 leading-relaxed text-[15px]">
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">1. Acceptance of Terms</h2>
            <p>By accessing and using BUConfess, you accept and agree to be bound by the terms and provision of this agreement. This platform is designed for Bennett University students to share thoughts freely and anonymously.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">2. Anonymity and Privacy</h2>
            <p>We do not track, log, or store IP addresses or any personally identifiable information (PII). While we provide anonymity, you are fully responsible for the content you submit. We cannot identify you, but we encourage responsible use of the platform.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">3. Prohibited Content</h2>
            <p>You agree not to post content that:</p>
            <ul className="list-disc pl-5 mt-3 space-y-1.5">
              <li>Contains hate speech, harassment, or threats.</li>
              <li>Reveals personal or sensitive information about others (doxxing).</li>
              <li>Violates any local or international laws.</li>
              <li>Contains explicit or inappropriate material.</li>
            </ul>
            <p className="mt-3">We reserve the right to remove any confession that violates these guidelines to maintain a safe community.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">4. Disclaimer of Warranties</h2>
            <p>The platform is provided "as is" without any warranties. We do not guarantee continuous, uninterrupted, or secure access to the platform. We are not responsible for the opinions or confessions posted by users.</p>
          </section>
          
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">5. Modifications</h2>
            <p>We reserve the right to modify or replace these Terms at any time. Your continued use of the platform after any changes constitutes acceptance of the new Terms.</p>
          </section>
        </div>
        
        <div className="mt-12 pt-8 border-t border-gray-200/60">
          <Link href="/" className="text-purple-600 font-semibold hover:text-purple-700 transition-colors tracking-wide text-sm">
            ← Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
