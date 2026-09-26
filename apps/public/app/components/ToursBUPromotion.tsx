'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { TOURSBU_CONFIG } from '../config/toursbu';

// ---------------------------------------------------------------------------
// ToursBU Reusable Promotional Components (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Destinations:
//   - Main site: https://tours.buconfess.in/ (or NEXT_PUBLIC_TOURSBU_URL)
//   - WhatsApp group: NEXT_PUBLIC_TOURSBU_WHATSAPP_URL
//
// Designed to be non-intrusive, responsive, and visually harmonious with
// the BU Confessions aesthetic.
// ---------------------------------------------------------------------------

/**
 * Modern promotional banner with Explore Trips and WhatsApp Group CTAs.
 * Suitable for homepage or feed top/bottom.
 */
export function ToursBUBanner({ className = '' }: { className?: string }) {
  return (
    <motion.aside
      aria-label="ToursBU Student Trips Promotion"
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.3 }}
      className={`w-full max-w-2xl mx-auto rounded-2xl p-4 md:p-5 bg-gradient-to-r from-purple-900/10 via-indigo-900/10 to-pink-900/10 border border-purple-200/60 backdrop-blur-md shadow-[0_4px_20px_rgba(139,92,246,0.06)] ${className}`}
    >
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        {/* Left info */}
        <div className="flex items-center gap-3 text-center sm:text-left">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white text-lg shadow-sm flex-shrink-0">
            ✈️
          </div>
          <div>
            <div className="flex items-center justify-center sm:justify-start gap-2">
              <span className="text-[11px] font-bold text-purple-700 tracking-wider uppercase bg-purple-100/70 px-2 py-0.5 rounded-full">
                ToursBU
              </span>
              <span className="text-[11px] text-gray-500 font-medium">College Trips & Treks</span>
            </div>
            <p className="text-sm font-semibold text-gray-800 mt-0.5">
              Ready for your next weekend escape?
            </p>
          </div>
        </div>

        {/* Right CTAs */}
        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-center flex-shrink-0">
          <a
            href={TOURSBU_CONFIG.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 rounded-xl shadow-sm transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            <span>Explore Trips</span>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </a>

          <a
            href={TOURSBU_CONFIG.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200/70 rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            <span className="text-sm">💬</span>
            <span>WhatsApp Group</span>
          </a>
        </div>
      </div>
    </motion.aside>
  );
}

/**
 * Compact CTA badge for Navbar navigation.
 */
export function ToursBUNavLink() {
  return (
    <a
      href={TOURSBU_CONFIG.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200/60 rounded-lg transition-colors whitespace-nowrap"
      title="Explore college trips on ToursBU"
    >
      <span>🌴</span>
      <span className="hidden sm:inline">Trips</span>
      <span className="sm:hidden">Tours</span>
    </a>
  );
}

/**
 * Promotional footer block with description and dual CTAs.
 */
export function ToursBUFooterCTA({ className = '' }: { className?: string }) {
  return (
    <div className={`w-full max-w-4xl mx-auto rounded-2xl p-6 bg-white/80 border border-gray-100 shadow-sm backdrop-blur-sm ${className}`}>
      <div className="flex flex-col md:flex-row items-center justify-between gap-5">
        <div className="text-center md:text-left">
          <div className="flex items-center justify-center md:justify-start gap-2 mb-1">
            <span className="text-xs font-bold text-purple-700 uppercase tracking-wider">Plan Your Escape</span>
            <span className="text-xs text-gray-400">•</span>
            <span className="text-xs font-semibold text-gray-600">Powered by ToursBU</span>
          </div>
          <h3 className="text-base font-bold text-gray-900">
            Curated student trips, group treks & unforgettable college memories
          </h3>
          <p className="text-xs text-gray-500 mt-1 max-w-md">
            Join hundreds of Bennett students exploring Kasol, Manali, Rishikesh, and beyond with exclusive student pricing.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <a
            href={TOURSBU_CONFIG.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 rounded-xl transition-colors shadow-sm"
          >
            <span>View Trips</span>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>

          <a
            href={TOURSBU_CONFIG.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl transition-colors"
          >
            <span>Join WhatsApp</span>
          </a>
        </div>
      </div>
    </div>
  );
}
