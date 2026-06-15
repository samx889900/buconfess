'use client';

import { motion } from 'framer-motion';

export default function Contact() {
  return (
    <div className="flex-1 flex items-center justify-center px-4 py-10 relative z-10">
      <motion.div
        initial={{ opacity: 0, y: 40, filter: 'blur(15px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="max-w-2xl w-full"
      >
        {/* Header */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-200 bg-purple-50 mb-6 shadow-sm">
            <div className="dot" />
            <span className="text-[10px] font-semibold text-purple-700 tracking-[0.15em] uppercase">Support</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-gray-900 mb-4">
            <span className="text-grad">Contact Us</span>
          </h1>
          <p className="text-base text-gray-600 leading-relaxed">
            Have a question, suggestion, concern, or feedback?
          </p>
        </div>

        {/* Card */}
        <div className="glass rounded-[32px] p-8 md:p-12 text-center card-hover shadow-lg">
          <p className="text-lg text-gray-800 font-medium mb-8">
            The easiest way to reach us is through Instagram.
          </p>
          
          <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-purple-50 border border-purple-200 flex items-center justify-center">
            <svg className="w-8 h-8 text-purple-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
            </svg>
          </div>
          
          <h3 className="text-xl font-bold text-gray-900 mb-2">Instagram</h3>
          <p className="text-lg font-semibold text-purple-700 mb-6">@bu.confess</p>
          
          <p className="text-sm md:text-base text-gray-600 leading-relaxed mb-8 max-w-md mx-auto">
            Send us a direct message and a member of our team will get back to you as soon as possible.
          </p>

          <a href="https://instagram.com/bu.confess" target="_blank" rel="noreferrer" className="btn-glow inline-flex items-center gap-2 py-4 px-10 text-base font-semibold text-white cursor-pointer shadow-xl mb-10">
            Message @bu.confess
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
          </a>

          <div className="border-t border-gray-100 pt-8 mt-4">
            <p className="text-sm text-gray-500 leading-relaxed max-w-lg mx-auto mb-4">
              We welcome feedback, collaboration requests, content concerns, and suggestions to help improve the BU Confessions community.
            </p>
            <p className="text-sm font-semibold text-purple-600">
              Thank you for supporting BU Confessions.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
