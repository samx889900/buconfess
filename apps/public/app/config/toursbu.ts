// ---------------------------------------------------------------------------
// ToursBU Configuration (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Centralizes destination URLs for ToursBU trip advertisements and WhatsApp group.
// Configurable via environment variables without duplicating across components.
// ---------------------------------------------------------------------------

export const TOURSBU_CONFIG = {
  url:
    process.env.NEXT_PUBLIC_TOURSBU_URL ||
    'https://chat.whatsapp.com/ITAMUjJZiIBGPzOZ4baW2g',
  whatsappUrl:
    process.env.NEXT_PUBLIC_TOURSBU_WHATSAPP_URL ||
    'https://chat.whatsapp.com/ITAMUjJZiIBGPzOZ4baW2g',
} as const;
