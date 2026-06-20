'use client';

import { useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';

interface Props {
  text: string;
  setText: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string;
}

export default function ConfessionPortal({ text, setText, onSubmit, loading, error }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const MAX = 2000;

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: y * -8, y: x * 8 });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTilt({ x: 0, y: 0 });
    setIsHovered(false);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || loading) return;
    onSubmit();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 60, filter: 'blur(20px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 1, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="w-full max-w-xl z-10"
    >
      <form onSubmit={handleSubmit}>
        <div
          ref={cardRef}
          onMouseMove={handleMouseMove}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={handleMouseLeave}
          className="confession-card bg-white rounded-[32px] p-8 md:p-10 relative overflow-hidden border border-gray-100 shadow-[0_8px_40px_rgba(0,0,0,0.06),0_2px_10px_rgba(139,92,246,0.05)]"
          style={{
            transform: `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          }}
        >

          {/* Label */}
          <div className="flex items-center gap-2 mb-5 relative z-10">
            <div className="dot" />
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-[0.15em]">
              New Confession
            </span>
          </div>

          {/* Textarea */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's on your mind?..."
            maxLength={MAX}
            rows={7}
            className="w-full bg-gray-50/60 border border-gray-200 rounded-2xl p-6 text-gray-900 text-[15px] md:text-base resize-none outline-none placeholder:text-gray-400 leading-relaxed transition-all duration-400 ease-[cubic-bezier(0.22,1,0.36,1)] focus:border-purple-400 focus:shadow-[0_0_0_4px_rgba(139,92,246,0.1)] focus:bg-white relative z-10"
            autoFocus
          />

          {/* Bottom bar */}
          <div className="flex items-center justify-between mt-5 relative z-10">
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className={`text-[11px] font-semibold tabular-nums transition-colors ${text.length / MAX > 0.9 ? 'text-red-500' : 'text-gray-500'}`}>
                  {text.length}
                </span>
                <span className="text-gray-300 text-[11px]">/</span>
                <span className="text-gray-400 text-[11px]">{MAX}</span>
              </div>
              {error && (
                <motion.span
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-red-400 text-xs mt-1"
                >
                  {error}
                </motion.span>
              )}
            </div>

            <button
              type="submit"
              disabled={loading || !text.trim()}
              className={`py-3 px-8 text-sm font-bold tracking-wide cursor-pointer flex items-center gap-2 transition-all duration-300 ${
                loading || !text.trim()
                  ? 'bg-gray-100 text-gray-400 rounded-xl cursor-not-allowed'
                  : 'btn-glow text-white rounded-xl'
              }`}
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Encrypting...
                </>
              ) : (
                <>
                  Submit
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </motion.div>
  );
}
