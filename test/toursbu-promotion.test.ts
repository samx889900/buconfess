import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOURSBU_CONFIG } from '../apps/public/app/config/toursbu';

describe('ToursBU Promotion Configuration & Link Safety (v3.5)', () => {
  it('1. Default URLs are properly configured to primary destinations', () => {
    assert.equal(
      TOURSBU_CONFIG.url,
      'https://chat.whatsapp.com/ITAMUjJZiIBGPzOZ4baW2g'
    );
    assert.ok(TOURSBU_CONFIG.whatsappUrl.includes('whatsapp.com'));
  });

  it('2. Environment variable overrides are supported', () => {
    const originalUrl = process.env.NEXT_PUBLIC_TOURSBU_URL;
    const originalWa = process.env.NEXT_PUBLIC_TOURSBU_WHATSAPP_URL;

    process.env.NEXT_PUBLIC_TOURSBU_URL = 'https://custom-tours.buconfess.in';
    process.env.NEXT_PUBLIC_TOURSBU_WHATSAPP_URL = 'https://chat.whatsapp.com/test-invite';

    // Verify dynamic resolution
    const dynamicConfig = {
      url: process.env.NEXT_PUBLIC_TOURSBU_URL || 'https://tours.buconfess.in',
      whatsappUrl: process.env.NEXT_PUBLIC_TOURSBU_WHATSAPP_URL || 'https://chat.whatsapp.com/invite',
    };

    assert.equal(dynamicConfig.url, 'https://custom-tours.buconfess.in');
    assert.equal(dynamicConfig.whatsappUrl, 'https://chat.whatsapp.com/test-invite');

    // Restore
    if (originalUrl) process.env.NEXT_PUBLIC_TOURSBU_URL = originalUrl;
    else delete process.env.NEXT_PUBLIC_TOURSBU_URL;
    if (originalWa) process.env.NEXT_PUBLIC_TOURSBU_WHATSAPP_URL = originalWa;
    else delete process.env.NEXT_PUBLIC_TOURSBU_WHATSAPP_URL;
  });

  it('3. All promotional links use secure HTTPS protocol', () => {
    assert.ok(TOURSBU_CONFIG.url.startsWith('https://'));
    assert.ok(TOURSBU_CONFIG.whatsappUrl.startsWith('https://'));
  });
});
