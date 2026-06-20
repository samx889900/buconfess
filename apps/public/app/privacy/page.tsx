import { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy | BUConfess',
  description: 'Privacy Policy for BUConfess, detailing our zero-tracking, 100% anonymous approach.',
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen pt-32 pb-24 px-6 md:px-12 max-w-3xl mx-auto font-sans">
      <div className="glass-strong p-8 md:p-12 rounded-[32px] border border-gray-100 shadow-sm relative z-10 bg-white/60">
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 tracking-tight mb-8">Privacy Policy</h1>
        
        <div className="space-y-8 text-gray-700 leading-relaxed text-[15px]">
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">Zero Tracking Promise</h2>
            <p>At BUConfess, your privacy is our absolute priority. We operate on a strict zero-tracking policy. We do not collect, log, or store your IP address, browser fingerprint, or any personally identifiable information (PII) when you visit our website or submit a confession.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">Information We Collect</h2>
            <p>We only store the data necessary for the platform to function:</p>
            <ul className="list-disc pl-5 mt-3 space-y-1.5">
              <li>The text of the confession you submit.</li>
              <li>The timestamp of the submission.</li>
              <li>A randomly assigned avatar and generic pseudonym for display purposes.</li>
            </ul>
            <p className="mt-3">None of this data is linked or linkable to your identity.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">Data Security and Encryption</h2>
            <p>All data transmitted between your browser and our servers is encrypted using industry-standard TLS (HTTPS). Our database is secured and accessible only by authorized services. Because we do not log IP addresses, even in the event of a data breach, no personal identities can be compromised.</p>
          </section>

          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">Cookies and Analytics</h2>
            <p>We do not use tracking cookies or third-party analytics services (like Google Analytics) that track your behavior across the web. Any cookies used are strictly for essential functionality, such as rate limiting, and contain no identifiable data.</p>
          </section>
          
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-3 tracking-tight">Contact</h2>
            <p>If you have any questions or concerns about this privacy policy, please visit our <Link href="/contact" className="text-purple-600 hover:underline">Contact</Link> page.</p>
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
