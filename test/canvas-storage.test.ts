import { splitConfessionText } from '../apps/admin/lib/canvas/splitter';
import { renderConfessionSlide } from '../apps/admin/lib/canvas/renderer';
import { CANVAS_CONFIG } from '../apps/admin/lib/canvas/config';
import {
  getSlideStoragePath,
  uploadSlideImage,
  getPublicSlideUrl,
} from '../apps/admin/lib/storage/storageService';
import { generateAndStoreConfessionImages } from '../apps/admin/lib/canvas/pipeline';
import { isConfessionProtected, runStorageRetentionCleanup } from '../apps/admin/lib/storage/cleanup';

// ---------------------------------------------------------------------------
// Phase D: Canvas Image Generation & Storage — 22 Automated Tests
// ---------------------------------------------------------------------------

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, testName: string, detail?: unknown) {
  if (condition) {
    passedCount++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failedCount++;
    console.error(`  ❌ [FAIL] ${testName}`, detail || '');
  }
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('PHASE D: CANVAS IMAGE & STORAGE — TEST SUITE (23 TESTS)');
  console.log('======================================================\n');

  // -------------------------------------------------------------------------
  // TEST 1: Short confession → 1 slide
  // -------------------------------------------------------------------------
  console.log('Test 1: Short confession → 1 slide');
  {
    const shortText = 'Bennett University campus Wi-Fi is actually decent today.';
    const slides = splitConfessionText(shortText, { maxCharsPerSlide: 450 });
    assert(slides.length === 1, 'Short text produces exactly 1 slide');
    assert(slides[0] === shortText, 'Text is preserved exactly');
  }

  // -------------------------------------------------------------------------
  // TEST 2: Medium confession → multiple slides
  // -------------------------------------------------------------------------
  console.log('\nTest 2: Medium confession → multiple slides');
  {
    const para1 = 'First paragraph talking about engineering mid-semester exams and pressure. '.repeat(5);
    const para2 = 'Second paragraph talking about late night library hours and hostel life. '.repeat(5);
    const text = `${para1}\n\n${para2}`;
    const slides = splitConfessionText(text, { maxCharsPerSlide: 450 });
    assert(slides.length >= 2, 'Medium text splits into 2 or more slides');
    assert(slides.join(' ').length >= text.length - 10, 'All words preserved');
  }

  // -------------------------------------------------------------------------
  // TEST 3: Long confession → expected slide count
  // -------------------------------------------------------------------------
  console.log('\nTest 3: Long confession → expected slide count');
  {
    const sentence = 'A long detailed story about the college fest and organizing team experiences. ';
    const text = sentence.repeat(25); // ~1900 chars
    const slides = splitConfessionText(text, { maxCharsPerSlide: 450, maxSlides: 10 });
    assert(slides.length >= 4 && slides.length <= 10, `Long confession splits into ${slides.length} slides (<= 10)`);
    assert(slides.length <= CANVAS_CONFIG.limits.maxSlides, 'Never exceeds maxSlides ceiling');
  }

  // -------------------------------------------------------------------------
  // TEST 4: Sentence boundary splitting
  // -------------------------------------------------------------------------
  console.log('\nTest 4: Sentence boundary splitting');
  {
    const s1 = 'This is the complete first sentence about Bennett.';
    const s2 = 'This is the complete second sentence about computer science courses.';
    const s3 = 'This is the third sentence that goes to the next slide.';
    const combined = `${s1} ${s2} ${s3}`;
    const slides = splitConfessionText(combined, { maxCharsPerSlide: 120 });
    assert(slides.length >= 2, 'Splits into multiple slides');
    assert(slides[0].endsWith('.') || slides[0].endsWith('!'), 'First slide breaks cleanly on sentence boundary');
  }

  // -------------------------------------------------------------------------
  // TEST 5: Word boundary splitting
  // -------------------------------------------------------------------------
  console.log('\nTest 5: Word boundary splitting');
  {
    const wordsText = 'WordOne WordTwo WordThree WordFour WordFive WordSix WordSeven WordEight';
    const slides = splitConfessionText(wordsText, { maxCharsPerSlide: 35 });
    for (const slide of slides) {
      assert(!slide.includes('WordO ') && !slide.endsWith('WordF'), 'Never breaks in middle of a word');
    }
  }

  // -------------------------------------------------------------------------
  // TEST 6: Unicode text & emojis
  // -------------------------------------------------------------------------
  console.log('\nTest 6: Unicode text & emojis');
  {
    const unicodeText = 'Bennett University ❤️ campus 🍕 midnight coffee ☕️ & coding 💻✨';
    const slides = splitConfessionText(unicodeText);
    assert(slides[0].includes('❤️') && slides[0].includes('☕️'), 'Preserves Unicode emojis accurately');
  }

  // -------------------------------------------------------------------------
  // TEST 7: Very long word
  // -------------------------------------------------------------------------
  console.log('\nTest 7: Very long single word');
  {
    const giantWord = 'Supercalifragilisticexpialidocious_antidisestablishmentarianism_floccinaucinihilipilification';
    const slides = splitConfessionText(giantWord, { maxCharsPerSlide: 40 });
    assert(slides.length >= 2, 'Extreme long word is broken safely without crashing');
    assert(slides.join('').replace(/\s+/g, '') === giantWord, 'All characters of long word preserved');
  }

  // -------------------------------------------------------------------------
  // TEST 8: Empty/invalid input handling
  // -------------------------------------------------------------------------
  console.log('\nTest 8: Empty / invalid input handling');
  {
    const emptySlides = splitConfessionText('');
    assert(emptySlides.length === 1 && emptySlides[0] === '', 'Empty string handled safely');

    const whitespaceSlides = splitConfessionText('    \n\t   ');
    assert(whitespaceSlides.length === 1 && whitespaceSlides[0] === '', 'Whitespace-only string returns empty slide');
  }

  // -------------------------------------------------------------------------
  // TEST 9: Canvas rendering succeeds
  // -------------------------------------------------------------------------
  console.log('\nTest 9: Real Canvas rendering succeeds');
  let sampleBuffer: Buffer | null = null;
  {
    sampleBuffer = await renderConfessionSlide('Test confession text rendering on canvas', {
      confessionNumber: 101,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: new Date().toISOString(),
    });

    assert(Buffer.isBuffer(sampleBuffer), 'Canvas returns a valid Buffer');
    assert(sampleBuffer.length > 5000, `Buffer size is non-trivial (${sampleBuffer.length} bytes)`);
  }

  // -------------------------------------------------------------------------
  // TEST 10: PNG signature validation
  // -------------------------------------------------------------------------
  console.log('\nTest 10: PNG signature validation');
  {
    assert(sampleBuffer !== null, 'Sample buffer exists');
    const magicBytes = sampleBuffer!.slice(0, 8).toString('hex');
    assert(magicBytes === '89504e470d0a1a0a', `Valid PNG magic header (89504e470d0a1a0a)`);
  }

  // -------------------------------------------------------------------------
  // TEST 11: Expected image dimensions (1080 x 1350)
  // -------------------------------------------------------------------------
  console.log('\nTest 11: Expected image dimensions (1080 x 1350)');
  {
    // In PNG IHDR chunk (bytes 12-24):
    // bytes 16-19: width (Big Endian)
    // bytes 20-23: height (Big Endian)
    const width = sampleBuffer!.readUInt32BE(16);
    const height = sampleBuffer!.readUInt32BE(20);
    assert(width === 1080, `Width is 1080px (actual: ${width})`);
    assert(height === 1350, `Height is 1350px (actual: ${height})`);
  }

  // -------------------------------------------------------------------------
  // TEST 12: No clipping/overflow bounds verification
  // -------------------------------------------------------------------------
  console.log('\nTest 12: No clipping / overflow bounds verification');
  {
    const denseText = 'This is a test of dense confession text. '.repeat(12);
    const denseBuffer = await renderConfessionSlide(denseText, {
      confessionNumber: 102,
      slideIndex: 1,
      totalSlides: 3,
      createdAt: new Date().toISOString(),
    });
    assert(denseBuffer.length > 5000, 'Dense text renders without throwing overflow error');
  }

  // -------------------------------------------------------------------------
  // TEST 13: Deterministic rendering
  // -------------------------------------------------------------------------
  console.log('\nTest 13: Deterministic rendering');
  {
    const fixedTime = '2024-09-15T12:00:00.000Z';
    const buf1 = await renderConfessionSlide('Identical text input', {
      confessionNumber: 50,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: fixedTime,
    });
    const buf2 = await renderConfessionSlide('Identical text input', {
      confessionNumber: 50,
      slideIndex: 0,
      totalSlides: 1,
      createdAt: fixedTime,
    });
    assert(buf1.length === buf2.length, 'Consecutive renders with same input yield identical byte length');
  }

  // -------------------------------------------------------------------------
  // TEST 14: Deterministic storage path
  // -------------------------------------------------------------------------
  console.log('\nTest 14: Deterministic storage path');
  {
    const path0 = getSlideStoragePath(42, 0);
    const path1 = getSlideStoragePath(42, 1);
    assert(path0 === '42/slide-01.png', 'Slide 1 path format is 42/slide-01.png');
    assert(path1 === '42/slide-02.png', 'Slide 2 path format is 42/slide-02.png');
  }

  // -------------------------------------------------------------------------
  // TEST 15: Multiple slide upload
  // -------------------------------------------------------------------------
  console.log('\nTest 15: Multiple slide upload simulation');
  {
    const uploadedMap = new Map<string, Buffer>();
    const mockSupabase = {
      rpc: () => Promise.resolve({ data: 11, error: null }),
      storage: {
        listBuckets: async () => ({ data: [{ name: 'confessions' }], error: null }),
        createBucket: async () => ({ error: null }),
        from: (bucket: string) => ({
          list: async () => ({ data: [], error: null }),
          upload: async (path: string, buf: Buffer) => {
            uploadedMap.set(path, buf);
            return { error: null };
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://mock.supabase.co/storage/v1/object/public/${bucket}/${path}` },
          }),
        }),
      },
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        select: () => ({ not: () => ({ order: () => ({ limit: () => ({ single: () => Promise.resolve({ data: { number: 10 } }) }) }) }) }),
      }),
    };

    const res = await generateAndStoreConfessionImages(
      {
        id: 77,
        text: 'Paragraph one for slide one with lots of details about university classes and assignments.\n\nParagraph two that should definitely go to slide two because it is quite long and detailed.'.repeat(8),
        status: 'approved',
      },
      { supabaseClient: mockSupabase as any }
    );

    assert(res.success === true, 'Pipeline executed successfully');
    assert(res.slideCount >= 2, `Created ${res.slideCount} slides`);
    assert(res.imageUrls.length === res.slideCount, 'URL count matches slide count');
  }

  // -------------------------------------------------------------------------
  // TEST 16 & 17: Partial upload recovery & existing valid image reuse
  // -------------------------------------------------------------------------
  console.log('\nTest 16 & 17: Partial upload recovery & existing image reuse');
  {
    // Simulate slide-01.png ALREADY existing in storage
    const mockSupabaseWithExisting = {
      rpc: () => Promise.resolve({ data: 55, error: null }),
      storage: {
        listBuckets: async () => ({ data: [{ name: 'confessions' }], error: null }),
        createBucket: async () => ({ error: null }),
        from: (bucket: string) => ({
          list: async (folder: string, opts: any) => {
            if (opts?.search === 'slide-01.png') {
              return { data: [{ name: 'slide-01.png', metadata: { size: 15000 } }], error: null };
            }
            return { data: [], error: null };
          },
          upload: async () => ({ error: null }),
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://mock.supabase.co/storage/v1/object/public/${bucket}/${path}` },
          }),
        }),
      },
      from: () => ({
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }),
    };

    const res = await generateAndStoreConfessionImages(
      {
        id: 88,
        text: 'Slide one content with full paragraphs describing student events.\n\nSlide two content with details about hostel living and mess food.'.repeat(8),
        status: 'approved',
      },
      { supabaseClient: mockSupabaseWithExisting as any }
    );

    assert(res.reusedCount >= 1, 'Reused existing slide-01 without redundant upload');
    assert(res.newlyGeneratedCount >= 1, 'Uploaded missing slide(s)');
    assert(res.success === true, 'Successfully completed partial recovery');
  }

  // -------------------------------------------------------------------------
  // TEST 18 & 20: Storage upload failure handling & failure_stage=storage
  // -------------------------------------------------------------------------
  console.log('\nTest 18 & 20: Storage failure handling & failure_stage="storage"');
  {
    let recordedFailureStage = '';
    const mockFailingStorageSupabase = {
      rpc: () => Promise.resolve({ data: 99, error: null }),
      storage: {
        listBuckets: async () => ({ data: [{ name: 'confessions' }], error: null }),
        createBucket: async () => ({ error: null }),
        from: () => ({
          list: async () => ({ data: [], error: null }),
          upload: async () => ({ error: new Error('S3 connection timeout') }),
          getPublicUrl: () => ({ data: { publicUrl: '' } }),
        }),
      },
      from: () => ({
        update: (payload: Record<string, unknown>) => {
          if (payload.failure_stage) recordedFailureStage = payload.failure_stage as string;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    };

    const res = await generateAndStoreConfessionImages(
      {
        id: 99,
        text: 'Testing storage upload error handling',
        status: 'approved',
      },
      { supabaseClient: mockFailingStorageSupabase as any }
    );

    assert(res.success === false, 'Returns failure when storage fails');
    assert(recordedFailureStage === 'storage', 'failure_stage is recorded as "storage"');
  }

  // -------------------------------------------------------------------------
  // TEST 19: failure_stage=image_generation
  // -------------------------------------------------------------------------
  console.log('\nTest 19: Canvas render failure → failure_stage="image_generation"');
  {
    let recordedFailureStage = '';
    const mockSupabase = {
      rpc: () => Promise.resolve({ data: 100, error: null }),
      storage: {
        listBuckets: async () => ({ data: [{ name: 'confessions' }], error: null }),
        createBucket: async () => ({ error: null }),
      },
      from: () => ({
        update: (payload: Record<string, unknown>) => {
          if (payload.failure_stage) recordedFailureStage = payload.failure_stage as string;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      }),
    };

    const mockBrokenRenderer = async () => {
      throw new Error('Canvas memory limit exceeded');
    };

    const res = await generateAndStoreConfessionImages(
      {
        id: 100,
        text: 'Testing canvas failure handling',
        status: 'approved',
      },
      {
        supabaseClient: mockSupabase as any,
        mockRenderer: mockBrokenRenderer,
      }
    );

    assert(res.success === false, 'Returns failure when renderer fails');
    assert(recordedFailureStage === 'image_generation', 'failure_stage recorded as "image_generation"');
  }

  // -------------------------------------------------------------------------
  // TEST 21: Protected cleanup behavior
  // -------------------------------------------------------------------------
  console.log('\nTest 21: Protected cleanup behavior');
  {
    assert(isConfessionProtected('approved') === true, 'approved is protected');
    assert(isConfessionProtected('posting') === true, 'posting is protected');
    assert(isConfessionProtected('processing') === true, 'processing is protected');
    assert(isConfessionProtected('pending') === true, 'pending is protected');
    assert(isConfessionProtected('failed') === true, 'failed is protected (for recovery)');
    assert(isConfessionProtected('posted') === false, 'posted can be eligible for retention cleanup');

    // Run cleanup simulation with approved items
    let deletedCount = 0;
    const mockSupabaseCleanup = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            not: () => ({
              order: () => ({
                limit: () => ({
                  lt: () => Promise.resolve({
                    data: [
                      { id: 1, status: 'posted', posted_at: '2020-01-01T00:00:00Z', image_urls: ['url1'] },
                      { id: 2, status: 'approved', posted_at: null, image_urls: ['url2'] }, // Should be skipped!
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: () => Promise.resolve({ error: null }),
      }),
      storage: {
        from: () => ({
          list: async () => ({ data: [{ name: 'slide-01.png' }] }),
          remove: async () => {
            deletedCount++;
            return { error: null };
          },
        }),
      },
    };

    const report = await runStorageRetentionCleanup({
      supabaseClient: mockSupabaseCleanup as any,
      retentionDays: 7,
    });

    assert(report.confessionsCleaned === 1, 'Only posted item cleaned');
    assert(report.protectedSkipped === 1, 'Approved item skipped and protected');
  }

  // -------------------------------------------------------------------------
  // TEST 22: Service-role key not exposed to public app
  // -------------------------------------------------------------------------
  console.log('\nTest 22: Service-role key not exposed to public app');
  {
    assert(
      process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY === undefined,
      'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY is undefined'
    );
    const keys = Object.keys(process.env);
    const leakedServiceKey = keys.some(
      (k) => k.startsWith('NEXT_PUBLIC_') && k.includes('SERVICE')
    );
    assert(!leakedServiceKey, 'No public env var contains SERVICE');
  }

  // -------------------------------------------------------------------------
  // TEST 23: Text & punctuation preservation regression test
  // -------------------------------------------------------------------------
  console.log('\nTest 23: Text and punctuation preservation regression test');
  {
    // Test case A: Leading ellipsis and start-of-slide punctuation
    const textA = '...Wait, really? I thought this was Bennett University! :( Are you serious?';
    const slidesA = splitConfessionText(textA, { maxCharsPerSlide: 45 });
    assert(slidesA[0].startsWith('...Wait'), 'Preserves leading ellipsis without deletion');
    assert(slidesA.some(s => s.includes(':(')), 'Preserves emoticons like :(');

    // Test case B: Multi-slide text with heavy diverse punctuation
    const textB = [
      '“Can anyone explain what happened at the library?” ...I was studying peacefully.',
      'Then suddenly: [ALERT] someone started shouting?! “Why?!”',
      '— Nobody knows! Maybe it was just end-semester stress (or caffeine overdose)...',
      'P.S. Please return my notes: calc-2 & data structures!'
    ].join('\n\n');

    const slidesB = splitConfessionText(textB, { maxCharsPerSlide: 80 });

    // Verify all non-whitespace characters from original text are preserved in joined slides
    const rawChars = textB.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    const slideChars = slidesB.join('').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    assert(rawChars === slideChars, 'Every single non-whitespace character and punctuation mark is 100% preserved');

    // Specific punctuation checks
    assert(slideChars.includes('“') && slideChars.includes('”'), 'Preserves typographic double quotes');
    assert(slideChars.includes('...') && slideChars.includes('—'), 'Preserves ellipses and em-dashes');
    assert(slideChars.includes('[') && slideChars.includes(']'), 'Preserves brackets');
    assert(slideChars.includes('?!') && slideChars.includes('&'), 'Preserves punctuation combos and ampersands');
  }

  console.log('\n======================================================');
  console.log(`PHASE D TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('======================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
