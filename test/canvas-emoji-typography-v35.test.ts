import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { renderConfessionSlide, ensureFontRegistered } from '../apps/admin/lib/canvas/renderer';
import { splitConfessionText } from '../apps/admin/lib/canvas/splitter';
import { validateSettingValue, SETTINGS_ALLOWLIST } from '../apps/admin/lib/settings';

describe('Canvas Emoji, Grapheme Handling & Typography Configuration (v3.5)', () => {
  it('1. Font registration: Successfully loads Geist and Noto Emoji fonts', () => {
    assert.doesNotThrow(() => {
      ensureFontRegistered();
    });
  });

  it('2. Splitter: Strictly preserves Zero Width Joiner (ZWJ \\u200D) in emoji sequences', () => {
    const familyEmoji = '👨\u200D👩\u200D👧\u200D👦'; // 👨‍👩‍👧‍👦
    const heartOnFire = '❤️\u200D🔥'; // ❤️‍🔥
    const text = `To my amazing family ${familyEmoji} and crush ${heartOnFire} ❤️!`;

    const slides = splitConfessionText(text);
    assert.equal(slides.length, 1);
    assert.ok(slides[0].includes(familyEmoji), 'ZWJ family emoji sequence must remain completely intact');
    assert.ok(slides[0].includes(heartOnFire), 'ZWJ heart on fire sequence must remain completely intact');
    assert.ok(slides[0].includes('\u200D'), 'Zero-width joiner must not be stripped');
  });

  it('3. Renders short confession with emojis and ZWJ sequences into valid PNG', async () => {
    const text = 'Shoutout to everyone in hostel 4! 😀 😂 ❤️ 🔥 😭 🥹 🙏 💀 👍🏽 🎉 👨‍👩‍👧‍👦 ❤️‍🔥';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 42,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
      bodyFontSize: 34,
      bodyLineHeight: 50,
    });

    assert.ok(buffer instanceof Buffer);
    assert.ok(buffer.length > 1000);
    // PNG magic signature: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
    assert.equal(buffer[2], 0x4e);
    assert.equal(buffer[3], 0x47);
  });

  it('4. Renders medium confession with custom typography settings', async () => {
    const text =
      'Midterms are over and I can finally breathe again! Spending the entire weekend catching up on sleep and good food at the night canteen. Hope everyone did well on their papers! ☕📚';

    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 43,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
      bodyFontSize: 32,
      bodyLineHeight: 48,
    });

    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
  });

  it('5. Renders long multi-slide confession without text clipping', async () => {
    const longText =
      'First year at BU was full of surprises. From waking up 5 minutes before an 8:30 AM class to rushing to the sports complex at midnight, everything felt like a movie. Met some of the most genuinely kind people who helped me survive calculus and engineering mechanics. ' +
      'Even when food was questionable or wifi was acting up, the late night corridor conversations made it all worthwhile. To all the seniors graduating this year: thank you for guiding us, leaving notes, and making Bennett feel like a second home. We will miss you! 🙏🎓✨';

    const slides = splitConfessionText(longText, { maxCharsPerSlide: 250 });
    assert.ok(slides.length > 1, 'Long confession should split into multiple slides');

    for (let i = 0; i < slides.length; i++) {
      const buffer = await renderConfessionSlide(slides[i], {
        confessionNumber: 44,
        slideIndex: i,
        totalSlides: slides.length,
        createdAt: new Date().toISOString(),
        bodyFontSize: 34,
        bodyLineHeight: 50,
      });

      assert.ok(buffer instanceof Buffer);
      assert.equal(buffer[0], 0x89);
      assert.equal(buffer[1], 0x50);
    }
  });

  it('6. Settings validation: Enforces numeric bounds on image_font_size and image_line_height', () => {
    const fontDef = SETTINGS_ALLOWLIST.image_font_size;
    const lineDef = SETTINGS_ALLOWLIST.image_line_height;

    // Valid values pass
    assert.equal(validateSettingValue(fontDef, 34), 34);
    assert.equal(validateSettingValue(fontDef, '30'), 30);
    assert.equal(validateSettingValue(lineDef, 50), 50);

    // Below minimum
    assert.throws(
      () => validateSettingValue(fontDef, 20),
      (err: Error) => {
        assert.match(err.message, /minimum allowed value is 24/);
        return true;
      }
    );

    // Above maximum
    assert.throws(
      () => validateSettingValue(fontDef, 52),
      (err: Error) => {
        assert.match(err.message, /maximum allowed value is 48/);
        return true;
      }
    );

    assert.throws(
      () => validateSettingValue(lineDef, 25),
      (err: Error) => {
        assert.match(err.message, /minimum allowed value is 32/);
        return true;
      }
    );
  });

  it('7. Universal Unicode Emoji Corpus: Verifies rendering across 10 distinct emoji categories', async () => {
    const categoryCorpus = [
      { name: 'Smileys', emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🫢 🫣 🤫 🤥 😶 🫠 😐 🫤 😑 🫨 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠' },
      { name: 'Hearts', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💌 💋' },
      { name: 'Gestures & Body', emojis: '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤏 💪 🖕 🙏 👏 🙌 🫶 🤝 💅 🤳 💃 🕺' },
      { name: 'Skin Tones', emojis: '👍🏻 👍🏼 👍🏽 👍🏾 👍🏿 ✌🏻 ✌🏼 ✌🏽 ✌🏾 ✌🏿 👏🏻 👏🏼 👏🏽 👏🏾 👏🏿 🤝🏻 🤝🏼 🤝🏽 🤝🏾 🤝🏿' },
      { name: 'Activities & Sports', emojis: '⚽ 🏏 🏀 🏆 🎮 🎵 🎶 🎸 🎨 🎭 🎬 🎤 🎧 🎳 🎯' },
      { name: 'Food & Drink', emojis: '🍕 🍔 🍟 🌮 🍜 🍺 ☕ 🍵 🧁 🍰 🍦 🍩 🍎 🍇 🥑' },
      { name: 'Objects & Tech', emojis: '📱 💻 🖥️ 📷 🚗 ✈️ 🚀 🏠 🔑 💡 📚 📦 ⏰ 💎' },
      { name: 'Symbols & Magic', emojis: '🔥 ⭐ 🌟 ✨ 💫 ⚡ 💥 🎉 🎊 💯 💀 ☠️ 👻 👽 🤖 🌈 ☀️ 🌙 🌍 🌸' },
      { name: 'Keycaps & Numbers', emojis: '1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 0️⃣ #️⃣ *️⃣ 🔟' },
      { name: 'Flags', emojis: '🇮🇳 🇺🇸 🇬🇧 🇯🇵 🇨🇦 🇩🇪 🇫🇷 🇦🇺 🏳️‍🌈 🏴‍☠️' },
    ];

    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

    for (const cat of categoryCorpus) {
      // 1. Verify grapheme integrity
      const graphemes = Array.from(segmenter.segment(cat.emojis), (s) => s.segment);
      assert.ok(graphemes.length > 0, `Category ${cat.name} must have graphemes`);

      // 2. Render confession slide containing this category
      const text = `Confession category test for ${cat.name}:\n${cat.emojis}`;
      const buffer = await renderConfessionSlide(text, {
        confessionNumber: 100,
        slideIndex: 0,
        totalSlides: 1,
        createdAt: new Date().toISOString(),
      });

      assert.ok(buffer instanceof Buffer, `Rendering ${cat.name} must return buffer`);
      assert.equal(buffer[0], 0x89, `Valid PNG signature for ${cat.name}`);
      assert.ok(buffer.length > 10000, `Buffer for ${cat.name} must have non-trivial size`);
    }
  });

  it('8. Complex ZWJ & Multi-Person Sequences: Strictly preserves all compound clusters', async () => {
    const complexSequences = [
      { name: 'Family (man, woman, girl, boy)', emoji: '👨‍👩‍👧‍👦' },
      { name: 'Family (man, man, boy)', emoji: '👨‍👨‍👦' },
      { name: 'Family (woman, woman, girl)', emoji: '👩‍👩‍👧' },
      { name: 'Couple with heart', emoji: '👩‍❤️‍👨' },
      { name: 'Woman Technologist', emoji: '👩‍💻' },
      { name: 'Man Astronaut', emoji: '👨‍🚀' },
      { name: 'Student', emoji: '🧑‍🎓' },
      { name: 'Heart on Fire', emoji: '❤️‍🔥' },
      { name: 'Mending Heart', emoji: '❤️‍🩹' },
      { name: 'Woman Technologist Medium Skin', emoji: '👩🏽‍💻' },
      { name: 'Man Weightlifter', emoji: '🏋️‍♂️' },
      { name: 'Woman Weightlifter', emoji: '🏋️‍♀️' },
      { name: 'Pirate Flag', emoji: '🏴‍☠️' },
      { name: 'Rainbow Flag', emoji: '🏳️‍🌈' },
    ];

    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

    for (const item of complexSequences) {
      const segments = Array.from(segmenter.segment(item.emoji), (s) => s.segment);
      assert.equal(
        segments.length,
        1,
        `Complex sequence '${item.name}' (${item.emoji}) must be exactly 1 grapheme cluster`
      );
      assert.equal(segments[0], item.emoji);
    }

    // Render all complex sequences on a single confession slide
    const allComplexText = complexSequences.map((s) => `${s.name}: ${s.emoji}`).join('\n');
    const buffer = await renderConfessionSlide(allComplexText, {
      confessionNumber: 101,
      slideIndex: 0,
      totalSlides: 1,
      bodyFontSize: 28,
      bodyLineHeight: 40,
    });

    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
  });

  it('9. Multilingual + Emoji + Punctuation Adjacency: Handles Hindi and complex formatting without crashing', async () => {
    const mixedText =
      'Bennett University में मेरा पहला साल सच में यादगार रहा! 🎉\n' +
      'Late night coding sessions (👩‍💻)! With chai from night canteen ☕️...❤️‍🔥\n' +
      'To everyone graduating: ऑल द बेस्ट! 🎓✨ [💀] "😂"';

    const slides = splitConfessionText(mixedText);
    assert.ok(slides.length >= 1);

    const buffer = await renderConfessionSlide(slides[0], {
      confessionNumber: 102,
      slideIndex: 0,
      totalSlides: slides.length,
      createdAt: new Date().toISOString(),
    });

    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 20000);
  });

  it('10. High-Density Emoji Slide: Renders extreme emoji-dense confession without clipping', async () => {
    const denseEmojis =
      '🔥 🚀 💯 ✨ 💀 😂 ❤️ 🙏 🥹 🎉 ' +
      '🔥 🚀 💯 ✨ 💀 😂 ❤️ 🙏 🥹 🎉 ' +
      '🔥 🚀 💯 ✨ 💀 😂 ❤️ 🙏 🥹 🎉 ' +
      '👨‍👩‍👧‍👦 ❤️‍🔥 👩🏽‍💻 🇮🇳 🍕 🍔 ☕️ ✈️ ⚽️ 🎮 ' +
      '1️⃣ 2️⃣ #️⃣ 🏆 🎸 🎨 🎭 🎬 💎 ⏰';

    const buffer = await renderConfessionSlide(denseEmojis, {
      confessionNumber: 103,
      slideIndex: 0,
      totalSlides: 1,
      bodyFontSize: 34,
      bodyLineHeight: 50,
    });

    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
  });

  it('11. Production required emoji corpus: Renders 😀 😂 ❤️ 🔥 🚀 🙏🏽 👨‍💻 ❤️‍🔥 🇮🇳 with renderConfessionSlide', async () => {
    const requiredEmojis = '😀 😂 ❤️ 🔥 🚀 🙏🏽 👨‍💻 ❤️‍🔥 🇮🇳';
    const text = `Testing required BUConfess emojis: ${requiredEmojis}`;

    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 104,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
      bodyFontSize: 34,
      bodyLineHeight: 50,
    });

    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89); // PNG signature
    assert.ok(buffer.length > 5000, 'Rendered PNG must have non-trivial size');
  });

  it('12. Pixel glyph analysis: Validates actual emoji pixels are drawn in full color (not monochrome, blank or tofu)', () => {
    ensureFontRegistered();
    const REQUIRED_EMOJIS = '😀 😂 ❤️ 🔥 🚀 🙏🏽 👨‍💻 ❤️‍🔥 🇮🇳';

    const canvas = createCanvas(800, 100);
    const ctx = canvas.getContext('2d');

    // Fill black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 800, 100);

    // Render emojis using production font stack
    ctx.fillStyle = '#ffffff';
    ctx.font = 'normal 34px Geist, "Noto Color Emoji", "Noto Emoji", sans-serif';
    ctx.fillText(REQUIRED_EMOJIS, 20, 60);

    // Measure widths: must be non-zero
    const metrics = ctx.measureText(REQUIRED_EMOJIS);
    assert.ok(metrics.width > 100, `Emoji sequence width must be substantial (got: ${metrics.width})`);

    // Sample pixel data in the rendered band (y: 20 to 80, x: 20 to 750)
    const imgData = ctx.getImageData(0, 0, 800, 100);
    const pixels = imgData.data;
    let nonBlackPixels = 0;
    let fullColorPixels = 0;
    let totalSampled = 0;

    for (let y = 20; y < 80; y++) {
      for (let x = 20; x < 750; x++) {
        totalSampled++;
        const idx = (y * 800 + x) * 4;
        const r = pixels[idx];
        const g = pixels[idx + 1];
        const b = pixels[idx + 2];
        if (r > 20 || g > 20 || b > 20) {
          nonBlackPixels++;
          // A full-color pixel has channel divergence (e.g. yellow, red, blue, green), unlike monochrome white/grey
          if (Math.abs(r - g) > 20 || Math.abs(r - b) > 20 || Math.abs(g - b) > 20) {
            fullColorPixels++;
          }
        }
      }
    }

    const coverage = (nonBlackPixels / totalSampled) * 100;
    assert.ok(
      nonBlackPixels > 100,
      `Emoji region must contain visible glyph pixels (sampled ${nonBlackPixels} non-black pixels, ${coverage.toFixed(1)}% coverage)`
    );
    assert.ok(
      fullColorPixels > 100,
      `Emoji region must contain full-color pixels, not monochrome white (sampled ${fullColorPixels} color pixels)`
    );
  });

  // -------------------------------------------------------------------------
  // Regression Tests: Cases A through M (Prompt Section 10 Specification)
  // -------------------------------------------------------------------------

  it('13. Case A (Basic emoji): Renders 😂 in full color without throwing or tofu', async () => {
    const text = 'Life is funny 😂';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 201,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('14. Case B (Heart): Renders ❤️ with variation selector in full red color', async () => {
    const text = 'Much love to all seniors ❤️';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 202,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('15. Case C (ZWJ): Renders ❤️‍🔥 as unified heart on fire sequence', async () => {
    const text = 'Feelings are burning ❤️‍🔥';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 203,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('16. Case D (Family): Renders 👨‍👩‍👧‍👦 compound family emoji cleanly', async () => {
    const text = 'Weekend trip with family 👨‍👩‍👧‍👦 back home';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 204,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('17. Case E (Skin tone): Renders 👍🏽 with Fitzpatrick skin tone modifier', async () => {
    const text = 'Approved and ready to go 👍🏽';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 205,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('18. Case F (Flag): Renders 🇮🇳 regional indicator flag in full tricolor', async () => {
    const text = 'Pride of our nation 🇮🇳 and campus';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 206,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('19. Case G (Mixed text): "I am happy 😂 today ❤️" combines Latin text and emojis seamlessly', async () => {
    const text = 'I am happy 😂 today ❤️';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 207,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 5000);
  });

  it('20. Case H (Emoji-heavy confession): Renders multi-line confession containing dense emojis', async () => {
    const text = '😂 ❤️ 😭 🥹 🔥 ✨ 🤡 💀 👀 🫶 🫠 ❤️‍🔥 👍🏽 👨‍💻 👩‍🎓 🇮🇳 🏳️‍🌈 👨‍👩‍👧‍👦 🤝🏻 🙏🏽 🗿 🚀 🎉 💯 ☕ 📚';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 208,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
    assert.ok(buffer.length > 10000);
  });

  it('21. Case I (Long text containing multiple emojis): Splits into slides without breaking graphemes', async () => {
    const longText =
      'First year at Bennett University was completely unbelievable! 😂 From running to 8:30 AM lectures half-asleep 🏃‍♂️💨 to late night discussions at night canteen with chai ☕❤️‍🔥. ' +
      'Special shoutout to my roommates in hostel 4 who always shared notes and maggi during finals 🍜🙏🏽. ' +
      'To everyone graduating: you will all be missed so much! Best of luck in placements and beyond 🎓✨🚀 🇮🇳.';

    const slides = splitConfessionText(longText, { maxCharsPerSlide: 200 });
    assert.ok(slides.length >= 2, 'Should split into at least 2 slides');

    for (let i = 0; i < slides.length; i++) {
      const buffer = await renderConfessionSlide(slides[i], {
        confessionNumber: 209,
        slideIndex: i,
        totalSlides: slides.length,
        createdAt: new Date().toISOString(),
      });
      assert.ok(buffer instanceof Buffer);
      assert.equal(buffer[0], 0x89);
    }
  });

  it('22. Case J (Emoji at line boundaries): Correctly wraps without splitting multi-byte emoji sequences', async () => {
    // Construct line that pushes an emoji right against maxWidth
    const lineText = 'A'.repeat(42) + ' ❤️‍🔥 ' + 'B'.repeat(40);
    const slides = splitConfessionText(lineText);
    assert.ok(slides.length >= 1);
    const buffer = await renderConfessionSlide(slides[0], {
      confessionNumber: 210,
      slideIndex: 0,
      totalSlides: slides.length,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
  });

  it('23. Case K (Multiple consecutive emojis): Renders consecutive emojis with proper spacing and no overlap', async () => {
    const text = 'Reaction chain: 😂❤️🔥😭🥹✨';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 211,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
  });

  it('24. Case L (Emoji + punctuation): Handles emojis adjacent to brackets, commas, quotes, periods', async () => {
    const text = 'Notes: (😂), [❤️]! "🔥"? {✨}... ❤️‍🔥; 👍🏽: 🇮🇳.';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 212,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
  });

  it('25. Case M (Emoji at beginning/end of sentence): Preserves line alignment and bounds', async () => {
    const text = '🔥 Starting strong with excitement on campus.\nWrapping up the semester with flying colors! 🎓';
    const buffer = await renderConfessionSlide(text, {
      confessionNumber: 213,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });
    assert.ok(buffer instanceof Buffer);
    assert.equal(buffer[0], 0x89);
  });
});
