'use client';

import { motion } from 'framer-motion';

export default function About() {
  const features = [
    {
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      ),
      title: 'Truly Anonymous',
      desc: 'No IP logging, no tracking cookies, no authentication required. Your identity is never captured.',
    },
    {
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
      title: 'Instant Delivery',
      desc: 'Confessions are encrypted and delivered to the admin queue in real-time for review.',
    },
    {
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
      title: 'Human Review',
      desc: 'Every confession is reviewed by a real person before publishing. Safety first.',
    },
  ];

  const container: any = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } },
  };
  const item: any = {
    hidden: { opacity: 0, y: 30, filter: 'blur(10px)' },
    show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.6, ease: [0.22,1,0.36,1] } },
  };

  return (
    <div className="flex-1 px-4 py-10">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <motion.div initial={{ opacity:0, y:40, filter:'blur(15px)' }} animate={{ opacity:1, y:0, filter:'blur(0px)' }} transition={{ duration:0.7 }} className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[rgba(139,92,246,0.2)] bg-[rgba(139,92,246,0.06)] mb-6">
            <div className="dot" />
            <span className="text-[10px] font-semibold text-[#A78BFA] tracking-[0.15em] uppercase">About Us</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-4 leading-tight">
            The safe space for<br />
            <span className="text-grad">Bennett University.</span>
          </h1>
          <p className="text-sm md:text-base text-white/35 max-w-md leading-relaxed">
            A platform built by students, for students. Say what you can&apos;t say out loud.
          </p>
        </motion.div>

        {/* Feature Cards */}
        <motion.div variants={container} initial="hidden" animate="show" className="grid md:grid-cols-3 gap-4 mb-16">
          {features.map((f) => (
            <motion.div key={f.title} variants={item} className="glass rounded-2xl p-6 card-hover">
              <div className="w-10 h-10 rounded-xl bg-[rgba(139,92,246,0.08)] border border-[rgba(139,92,246,0.12)] flex items-center justify-center text-[#8B5CF6] mb-4">
                {f.icon}
              </div>
              <h3 className="text-sm font-semibold text-white mb-2">{f.title}</h3>
              <p className="text-[12px] text-white/30 leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* How it works */}
        <motion.div initial={{ opacity:0, y:30 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.4, duration:0.7 }} className="glass rounded-[24px] p-8">
          <h2 className="text-lg font-semibold text-white mb-8">How it works</h2>
          <div className="flex flex-col md:flex-row gap-8">
            {[
              { step: '01', label: 'Write', desc: 'Type your anonymous confession.', color: '#8B5CF6' },
              { step: '02', label: 'Encrypt', desc: 'We secure and queue it for review.', color: '#00E5FF' },
              { step: '03', label: 'Publish', desc: 'Approved confessions go live on IG.', color: '#39FF14' },
            ].map((s, i) => (
              <div key={s.step} className="flex-1 flex gap-4">
                <span className="text-3xl font-black" style={{ color: s.color, opacity: 0.15 }}>{s.step}</span>
                <div>
                  <h4 className="text-sm font-semibold text-white mb-1">{s.label}</h4>
                  <p className="text-[12px] text-white/25 leading-relaxed">{s.desc}</p>
                </div>
                {i < 2 && <div className="hidden md:block w-px h-full bg-white/[0.04] ml-auto" />}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
