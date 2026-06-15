'use client';

import { motion, Variants } from 'framer-motion';

export default function Developer() {
  const stack = [
    { label: 'Framework', value: 'Next.js 15', icon: '▲', color: '#fff' },
    { label: 'UI Library', value: 'React 19', icon: '⚛', color: '#61DAFB' },
    { label: 'Styling', value: 'Tailwind CSS v4', icon: '🎨', color: '#38BDF8' },
    { label: '3D Engine', value: 'Three.js + R3F', icon: '🔮', color: '#8B5CF6' },
    { label: 'Animation', value: 'Framer Motion + GSAP', icon: '✨', color: '#39FF14' },
    { label: 'Storage', value: 'Google Sheets API', icon: '📊', color: '#34A853' },
    { label: 'Social', value: 'Instagram Graph API', icon: '📸', color: '#E4405F' },
    { label: 'Deploy', value: 'Vercel Edge', icon: '🌐', color: '#00E5FF' },
  ];

  const container: Variants = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.3 } },
  };
  const item: Variants = {
    hidden: { opacity: 0, y: 20, filter: 'blur(8px)' },
    show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.5 } },
  };

  return (
    <div className="flex-1 px-4 py-10">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 40, filter: 'blur(15px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.7 }} className="mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[rgba(139,92,246,0.2)] bg-[rgba(139,92,246,0.06)] mb-6">
            <div className="dot" />
            <span className="text-[10px] font-semibold text-[#A78BFA] tracking-[0.15em] uppercase">Engineering</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-4 leading-tight">
            Built for the<br />
            <span className="text-grad">modern web.</span>
          </h1>
          <p className="text-sm text-white/35 max-w-lg leading-relaxed">
            A monorepo architecture with 3D rendering, isolated frontends, edge deployment, and zero-knowledge anonymity.
          </p>
        </motion.div>

        {/* Architecture */}
        <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.7 }} className="glass rounded-[24px] p-8 mb-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#8B5CF6] to-[#6D28D9] flex items-center justify-center shadow-[0_0_25px_rgba(139,92,246,0.3)]">
              <span className="text-xs font-mono text-white font-bold">{'</>'}</span>
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">System Architecture</h2>
              <p className="text-[11px] text-white/20">Turborepo Monorepo · Two isolated apps</p>
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="glass rounded-xl p-5 card-hover">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-[#39FF14] shadow-[0_0_10px_rgba(57,255,20,0.6)]" />
                <span className="text-xs font-semibold text-white">Public Frontend</span>
              </div>
              <p className="text-[11px] text-white/20 leading-relaxed">3D confession portal. Anonymous submission. No auth.</p>
            </div>
            <div className="glass rounded-xl p-5 card-hover">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-[#8B5CF6] shadow-[0_0_10px_rgba(139,92,246,0.6)]" />
                <span className="text-xs font-semibold text-white">Admin Dashboard</span>
              </div>
              <p className="text-[11px] text-white/20 leading-relaxed">Review, generate images, auto-post to Instagram.</p>
            </div>
          </div>
        </motion.div>

        {/* Tech Stack Grid */}
        <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stack.map((s) => (
            <motion.div key={s.label} variants={item} className="glass rounded-xl p-4 card-hover group">
              <span className="text-xl mb-3 block">{s.icon}</span>
              <h3 className="text-[11px] font-semibold text-white mb-0.5">{s.label}</h3>
              <p className="text-[10px] text-white/20">{s.value}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="mt-12 text-center">
          <p className="text-[11px] text-white/15">Engineered with precision · Powered by <span className="text-[#8B5CF6]">Antigravity AI</span></p>
        </motion.div>
      </div>
    </div>
  );
}
