'use client';

import { useState, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import ConfessionPortal from './components/ConfessionPortal';

// Dynamically import the 3D scene (client-only, no SSR)
const Scene3D = dynamic(() => import('./components/Scene3D'), { ssr: false });

export default function Home() {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/confessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const d = await res.json();
        setError(d.error || 'Something went wrong');
      }
    } catch {
      setError('Network error, please try again');
    }
    setLoading(false);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 relative min-h-[80vh]">

      {/* ── 3D Scene Background ──────────────── */}
      <div className="absolute inset-0 z-0">
        <Suspense fallback={null}>
          <Scene3D />
        </Suspense>
      </div>


      {/* ── Content ──────────────────────────── */}
      <AnimatePresence mode="wait">
        {submitted ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="z-10 glass-strong rounded-[28px] max-w-sm w-full p-10 text-center"
          >
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-gradient-to-br from-[#8B5CF6] to-[#39FF14] flex items-center justify-center shadow-[0_0_50px_rgba(139,92,246,0.35)]">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Confession Sent</h2>
            <p className="text-sm text-gray-600 leading-relaxed mb-8">
              Your secret is encrypted and queued for review. Watch the Instagram page.
            </p>
            <button
              onClick={() => { setText(''); setSubmitted(false); }}
              className="w-full py-3 px-6 text-sm font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-xl transition-colors cursor-pointer"
            >
              Submit Another
            </button>
          </motion.div>
        ) : (
          <div key="form" className="flex flex-col items-center z-10 w-full pointer-events-none">
            {/* Hero Text */}
            <motion.div
              initial={{ opacity: 0, y: 40, filter: 'blur(20px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
              className="text-center mb-14 pointer-events-auto mt-4"
            >
              {/* Badge */}
              <div className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full border border-purple-200/60 bg-purple-50/80 mb-8 shadow-[0_2px_10px_rgba(139,92,246,0.08)] backdrop-blur-sm">
                <div className="dot" />
                <span className="text-[11px] font-bold text-purple-700 tracking-[0.2em] uppercase">
                  Bennett University
                </span>
              </div>

              <h1 className="text-5xl md:text-6xl lg:text-[5rem] font-extrabold tracking-tight leading-[1.1] mb-6">
                <span className="text-gray-900">Speak </span>
                <span className="text-grad">Freely.</span>
                <br />
                <span className="text-gray-900">Stay </span>
                <span className="text-grad">Anonymous.</span>
              </h1>

              <p className="text-base md:text-lg text-gray-600 max-w-lg mx-auto leading-relaxed font-medium">
                Share your thoughts with the Bennett community without revealing your identity. A safe space for honest conversations, late-night thoughts, and unspoken truths.
              </p>
            </motion.div>

            {/* Confession Card */}
            <div className="pointer-events-auto w-full max-w-2xl flex flex-col items-center">
              <ConfessionPortal
                text={text}
                setText={setText}
                onSubmit={handleSubmit}
                loading={loading}
                error={error}
              />
            </div>

            {/* Trust badges */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4 mt-12 z-10 px-8 py-4"
            >
              {[
                { icon: <svg className="w-4 h-4 text-purple-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>, label: 'End-to-end encrypted' },
                { icon: <svg className="w-4 h-4 text-purple-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clipRule="evenodd" /><path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" /></svg>, label: 'No tracking' },
                { icon: <svg className="w-4 h-4 text-emerald-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>, label: 'Zero data stored' },
              ].map((b) => (
                <div key={b.label} className="flex items-center gap-2 text-[13px] text-gray-600 font-medium tracking-wide">
                  {b.icon} {b.label}
                </div>
              ))}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
