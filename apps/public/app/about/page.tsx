'use client';

import { motion, Variants } from 'framer-motion';

export default function About() {
  const container: Variants = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } },
  };
  const item: Variants = {
    hidden: { opacity: 0, y: 30, filter: 'blur(10px)' },
    show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.6, ease: "easeOut" } },
  };

  return (
    <div className="flex-1 px-4 py-10 relative z-10">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <motion.div initial={{ opacity:0, y:40, filter:'blur(15px)' }} animate={{ opacity:1, y:0, filter:'blur(0px)' }} transition={{ duration:0.7 }} className="mb-16 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-200 bg-purple-50 mb-6 shadow-sm">
            <div className="dot" />
            <span className="text-[10px] font-semibold text-purple-700 tracking-[0.15em] uppercase">About Us</span>
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight text-gray-900 mb-6 leading-tight">
            About <span className="text-grad">BU Confessions</span>
          </h1>
          <p className="text-base md:text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
            Welcome to BU Confessions a student-driven platform created for the Bennett University community.
          </p>
        </motion.div>

        <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
          {/* Main Intro */}
          <motion.div variants={item} className="glass rounded-[24px] p-8 md:p-10 card-hover">
            <p className="text-gray-700 leading-relaxed mb-6">
              BU Confessions is a space where students can anonymously share their thoughts, experiences, opinions, stories, and confessions without revealing their identity. Whether it's a funny campus moment, a heartfelt message, an unpopular opinion, or something you've always wanted to say, this platform gives every voice a place to be heard.
            </p>
            <p className="text-gray-700 leading-relaxed">
              Beyond confessions, we also share memes, student experiences, campus trends, relatable content, and general updates that reflect everyday life at Bennett University. Our goal is to create a fun, engaging, and inclusive community where students can connect through shared experiences.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Our Mission */}
            <motion.div variants={item} className="glass rounded-[24px] p-8 md:p-10 card-hover">
              <div className="w-12 h-12 rounded-xl bg-purple-100 border border-purple-200 flex items-center justify-center text-purple-600 mb-6">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Our Mission</h2>
              <p className="text-gray-700 mb-4">We believe that every student has a story worth sharing. BU Confessions aims to:</p>
              <ul className="space-y-3">
                {[
                  'Provide a safe and anonymous space for expression.',
                  'Encourage healthy discussions within the student community.',
                  'Share relatable and entertaining content.',
                  'Bring students together through humor, experiences, and campus culture.',
                  'Create a platform where everyone feels heard.'
                ].map((point, i) => (
                  <li key={i} className="flex items-start gap-3 text-gray-700 text-sm md:text-base">
                    <span className="text-purple-500 mt-1">✦</span>
                    {point}
                  </li>
                ))}
              </ul>
            </motion.div>

            {/* Content Moderation & Safety */}
            <motion.div variants={item} className="glass rounded-[24px] p-8 md:p-10 card-hover">
              <div className="w-12 h-12 rounded-xl bg-green-50 border border-green-200 flex items-center justify-center text-green-600 mb-6">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Content Moderation & Safety</h2>
              <p className="text-gray-700 leading-relaxed mb-4">
                BU Confessions is managed by a dedicated team of <strong className="text-purple-700">5+ members</strong> who review submissions before they are published.
              </p>
              <p className="text-gray-700 leading-relaxed mb-4">
                We are committed to maintaining a respectful and welcoming environment for everyone. Content that promotes harassment, hate speech, threats, personal attacks, misinformation, or violates community standards will not be published.
              </p>
              <p className="text-gray-700 leading-relaxed">
                Our moderation process helps ensure that the platform remains enjoyable, safe, and inclusive for all members of the Bennett University community.
              </p>
            </motion.div>
          </div>

          {/* Community First */}
          <motion.div variants={item} className="glass rounded-[24px] p-8 md:p-10 text-center card-hover">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Community First</h2>
            <p className="text-gray-700 leading-relaxed mb-6 max-w-2xl mx-auto">
              BU Confessions is built by students, for students. Every confession, meme, and story contributes to the unique culture of our campus. We appreciate every member of our community who helps make this platform engaging, entertaining, and meaningful.
            </p>
            <p className="text-purple-700 font-semibold text-lg">
              Thank you for being part of BU Confessions.
            </p>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
