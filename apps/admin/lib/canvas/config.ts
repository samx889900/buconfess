// ---------------------------------------------------------------------------
// Canvas & Image Generation Configuration (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Centralizes all canvas dimensions, typography, layout bounds, and slide
// limits. Optimized for Instagram portrait carousel (4:5 ratio, 1080x1350).
// ---------------------------------------------------------------------------

export const CANVAS_CONFIG = {
  // Dimensions (Instagram Portrait 4:5 Aspect Ratio)
  dimensions: {
    width: 1080,
    height: 1350,
  },

  // Slide & Content Limits
  limits: {
    maxSlides: 10,              // Hard ceiling imposed by Instagram Graph API carousel
    maxCharsPerSlide: 450,       // Conservative budget ensuring zero vertical text clipping
    maxLinesPerSlide: 14,       // Maximum physical rendered lines per slide
    minWordBreakLength: 35,     // Threshold to force-hyphenate an extreme single word
  },

  // Layout & Spacing
  layout: {
    paddingX: 90,               // Left and right canvas margins
    paddingY: 90,               // Top and bottom canvas margins
    headerHeight: 120,          // Reserved vertical space for branding/badge
    footerHeight: 100,          // Reserved vertical space for slide indicator & date
    accentBarHeight: 6,         // Top aesthetic accent gradient stripe
  },

  // Typography
  typography: {
    fontFamily: 'Geist, sans-serif',
    bodyFontSize: 38,
    bodyLineHeight: 56,
    headerTitleSize: 28,
    headerBadgeSize: 18,
    footerMetaSize: 22,
    footerIndicatorSize: 22,
  },

  // Branding Colors & Styling
  colors: {
    backgroundStart: '#0B0418',
    backgroundEnd: '#1E0836',
    accentStart: '#8B5CF6',     // Violet 500
    accentEnd: '#EC4899',       // Pink 500
    textPrimary: '#FFFFFF',
    textSecondary: '#DDD6FE',   // Light purple tint
    textMuted: '#9CA3AF',       // Gray 400
    divider: 'rgba(255, 255, 255, 0.12)',
    badgeBg: 'rgba(139, 92, 246, 0.2)',
    badgeBorder: 'rgba(139, 92, 246, 0.5)',
    badgeText: '#C4B5FD',
  },
} as const;

export type CanvasConfig = typeof CANVAS_CONFIG;
