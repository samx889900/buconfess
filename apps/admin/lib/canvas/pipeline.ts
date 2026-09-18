import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../supabase';
import { splitConfessionText } from './splitter';
import { renderConfessionSlide } from './renderer';
import {
  ensureConfessionsBucket,
  getSlideStoragePath,
  uploadSlideImage,
} from '../storage/storageService';

// ---------------------------------------------------------------------------
// Image Generation Pipeline & Carousel Orchestrator (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Takes an approved confession and:
//   1. Assigns idempotent confession number if not already present
//   2. Splits text into deterministic carousel slides
//   3. Renders high-res 1080x1350 PNG cards
//   4. Uploads to Supabase Storage with partial carousel recovery
//   5. Persists parts, image_urls, and progress timestamps in DB
// ---------------------------------------------------------------------------

export interface ImageGenerationOptions {
  supabaseClient?: SupabaseClient;
  /** Mock renderer for unit testing without native canvas */
  mockRenderer?: (
    text: string,
    options: {
      confessionNumber?: number | null;
      slideIndex: number;
      totalSlides: number;
      createdAt?: string;
    }
  ) => Promise<Buffer>;
  /** Force re-rendering and re-uploading even if existing objects exist */
  forceRegenerate?: boolean;
  /** Maximum number of carousel slides (clamped to 1-10, default: 10) */
  maxSlides?: number;
}

export interface ImageGenerationPipelineResult {
  confessionId: number;
  confessionNumber: number;
  slideCount: number;
  parts: string[];
  imageUrls: string[];
  storagePaths: string[];
  reusedCount: number;
  newlyGeneratedCount: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export class ConfessionAlreadyNumberedError extends Error {
  readonly code = 'P1001';
  readonly confessionId: number;
  readonly existingNumber?: number;

  constructor(confessionId: number, existingNumber?: number, message?: string) {
    super(
      message ||
        `CONFESSION_ALREADY_NUMBERED: Confession #${confessionId} already has number ${existingNumber ?? 'unknown'}`
    );
    this.name = 'ConfessionAlreadyNumberedError';
    this.confessionId = confessionId;
    this.existingNumber = existingNumber;
  }
}

/**
 * Assigns an idempotent confession number using the Postgres sequence
 * if one is not already assigned to the confession.
 *
 * Invariants:
 * 1. Numbers are unique (enforced by DB unique constraint and sequence).
 * 2. Monotonic allocation: Successful sequence allocations draw strictly increasing values from confession_number_seq.
 *    Sequence allocation order is monotonic, but transaction commit order is not guaranteed to match sequence allocation order.
 * 3. PostgreSQL sequence is non-transactional: gaps from aborted transactions are natural and safe.
 * 4. Zero phantom numbers & persisted vs. consumed sequence values: Sequence values consumed
 *    by aborted transactions are discarded as permanent gaps and do not constitute valid confession numbers.
 *    A confession number is only valid and returned if successfully persisted to confessions.number in the DB;
 *    no fallback to confession.id, in-memory state, or uncommitted sequence values is ever permitted.
 * 5. Concurrency safety: allocate_confession_number locks target row FOR UPDATE.
 * 6. Verified fast path: if caller passes existingNumber, it is verified against DB before trusting.
 */
export async function ensureConfessionNumber(
  supabase: SupabaseClient,
  confessionId: number,
  existingNumber?: number | null
): Promise<number> {
  // 1. Verified fast path: if existingNumber is provided, verify it against DB authority
  if (existingNumber && typeof existingNumber === 'number' && existingNumber > 0) {
    const { data: current, error: fetchErr } = await supabase
      .from('confessions')
      .select('number')
      .eq('id', confessionId)
      .single();

    if (!fetchErr && current && current.number === existingNumber) {
      return existingNumber;
    }
    // If DB has a different number or is null, do NOT trust unverified existingNumber!
  }

  // 2. Call server-only atomic allocator function
  const { data, error } = await supabase.rpc('allocate_confession_number', {
    p_confession_id: confessionId,
  });

  if (error) {
    // Check if error is CONFESSION_ALREADY_NUMBERED (application-defined SQLSTATE P1001)
    const isAlreadyNumbered =
      error.code === 'P1001' ||
      (error.message && error.message.includes('CONFESSION_ALREADY_NUMBERED'));

    if (isAlreadyNumbered) {
      // Fetch the assigned number from DB authority (handles concurrent same-confession race)
      const { data: row, error: fetchErr } = await supabase
        .from('confessions')
        .select('number')
        .eq('id', confessionId)
        .single();

      if (!fetchErr && row && typeof row.number === 'number' && row.number > 0) {
        return row.number;
      }

      throw new ConfessionAlreadyNumberedError(confessionId, row?.number, error.message);
    }

    // Fail immediately on any other error (e.g. P0002 CONFESSION_NOT_FOUND, or DB connection failure)
    throw new Error(error.message || `Failed to allocate confession number for #${confessionId}`);
  }

  if (data === null || data === undefined) {
    throw new Error(`allocate_confession_number returned empty result for confession #${confessionId}`);
  }

  const assigned = typeof data === 'number' ? data : parseInt(String(data), 10);
  if (isNaN(assigned) || assigned <= 0) {
    throw new Error(`Invalid confession number received from sequence: ${data}`);
  }

  return assigned;
}

/**
 * Executes the Phase D image generation and storage pipeline for a confession.
 */
export async function generateAndStoreConfessionImages(
  confession: {
    id: number;
    text: string;
    number?: number | null;
    status: string;
    parts?: string[] | null;
    image_urls?: string[] | null;
    created_at?: string;
  },
  options: ImageGenerationOptions = {}
): Promise<ImageGenerationPipelineResult> {
  const startTime = Date.now();
  const supabase = options.supabaseClient || getSupabaseAdmin();
  const { mockRenderer, forceRegenerate = false } = options;

  await ensureConfessionsBucket(supabase);

  // 1. Ensure confession number is assigned atomically
  let confNumber: number;
  try {
    confNumber = await ensureConfessionNumber(supabase, confession.id, confession.number);
  } catch (numErr) {
    const msg = numErr instanceof Error ? numErr.message : String(numErr);
    console.error(`[PIPELINE] Failed to allocate confession number for #${confession.id}:`, msg);

    await supabase
      .from('confessions')
      .update({
        failure_stage: 'image_generation',
        last_error: `Number allocation failed: ${msg}`,
        last_progress_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', confession.id);

    return {
      confessionId: confession.id,
      confessionNumber: 0,
      slideCount: 0,
      parts: [],
      imageUrls: [],
      storagePaths: [],
      reusedCount: 0,
      newlyGeneratedCount: 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: `Number allocation failed: ${msg}`,
    };
  }

  // 2. Split text into deterministic slides (clamped to 1-10)
  const clampedMaxSlides = Math.min(10, Math.max(1, options.maxSlides ?? 10));
  const slides = splitConfessionText(confession.text, { maxSlides: clampedMaxSlides });
  const totalSlides = slides.length;

  // Persist parts array early
  await supabase
    .from('confessions')
    .update({
      parts: slides,
      number: confNumber,
      last_progress_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', confession.id);

  const publicUrls: string[] = [];
  const storagePaths: string[] = [];
  let reusedCount = 0;
  let newlyGeneratedCount = 0;

  // 3. Process each slide with partial recovery
  for (let i = 0; i < totalSlides; i++) {
    const slideText = slides[i];
    const storagePath = getSlideStoragePath(confession.id, i);
    storagePaths.push(storagePath);

    try {
      // ── Step 3a: Render PNG ──
      let pngBuffer: Buffer;
      try {
        if (mockRenderer) {
          pngBuffer = await mockRenderer(slideText, {
            confessionNumber: confNumber,
            slideIndex: i,
            totalSlides,
            createdAt: confession.created_at,
          });
        } else {
          pngBuffer = await renderConfessionSlide(slideText, {
            confessionNumber: confNumber,
            slideIndex: i,
            totalSlides,
            createdAt: confession.created_at,
          });
        }
      } catch (renderError) {
        const msg = renderError instanceof Error ? renderError.message : String(renderError);
        console.error(`[PIPELINE] Canvas render error on slide ${i + 1}/${totalSlides}:`, msg);

        // Persist failure stage = image_generation
        await supabase
          .from('confessions')
          .update({
            failure_stage: 'image_generation',
            last_error: `Render failed on slide ${i + 1}: ${msg}`,
            last_progress_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', confession.id);

        return {
          confessionId: confession.id,
          confessionNumber: confNumber,
          slideCount: totalSlides,
          parts: slides,
          imageUrls: publicUrls,
          storagePaths,
          reusedCount,
          newlyGeneratedCount,
          durationMs: Date.now() - startTime,
          success: false,
          error: msg,
        };
      }

      // ── Step 3b: Upload to Supabase Storage ──
      try {
        const uploadResult = await uploadSlideImage(
          supabase,
          storagePath,
          pngBuffer,
          !forceRegenerate // reuse existing valid objects for partial recovery
        );

        publicUrls.push(uploadResult.publicUrl);
        if (uploadResult.alreadyExisted) {
          reusedCount++;
        } else {
          newlyGeneratedCount++;
        }
      } catch (uploadError) {
        const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
        console.error(`[PIPELINE] Storage upload error on slide ${i + 1}/${totalSlides}:`, msg);

        // Persist failure stage = storage
        await supabase
          .from('confessions')
          .update({
            failure_stage: 'storage',
            last_error: `Upload failed on slide ${i + 1}: ${msg}`,
            // Save partial progress so retry continues seamlessly
            image_urls: publicUrls,
            last_progress_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', confession.id);

        return {
          confessionId: confession.id,
          confessionNumber: confNumber,
          slideCount: totalSlides,
          parts: slides,
          imageUrls: publicUrls,
          storagePaths,
          reusedCount,
          newlyGeneratedCount,
          durationMs: Date.now() - startTime,
          success: false,
          error: msg,
        };
      }
    } catch (slideErr) {
      const msg = slideErr instanceof Error ? slideErr.message : String(slideErr);
      return {
        confessionId: confession.id,
        confessionNumber: confNumber,
        slideCount: totalSlides,
        parts: slides,
        imageUrls: publicUrls,
        storagePaths,
        reusedCount,
        newlyGeneratedCount,
        durationMs: Date.now() - startTime,
        success: false,
        error: msg,
      };
    }
  }

  // 4. Update Confession Record with Completed Image URLs
  const now = new Date().toISOString();
  await supabase
    .from('confessions')
    .update({
      parts: slides,
      image_urls: publicUrls,
      number: confNumber,
      failure_stage: null,
      last_error: null,
      last_progress_at: now,
      updated_at: now,
    })
    .eq('id', confession.id);

  return {
    confessionId: confession.id,
    confessionNumber: confNumber,
    slideCount: totalSlides,
    parts: slides,
    imageUrls: publicUrls,
    storagePaths,
    reusedCount,
    newlyGeneratedCount,
    durationMs: Date.now() - startTime,
    success: true,
  };
}
