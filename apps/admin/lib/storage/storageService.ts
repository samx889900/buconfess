import { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase Storage Service (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Manages PNG card assets in the 'confessions' Supabase Storage bucket.
// Features:
//   - Deterministic object paths: confessions/{id}/slide-01.png
//   - Public URL resolution for Instagram Graph API compatibility
//   - Partial carousel recovery (reuses existing valid slide objects)
//   - Server-side only (service-role authentication)
// ---------------------------------------------------------------------------

export const BUCKET_NAME = 'confessions';

export interface StorageUploadResult {
  path: string;
  publicUrl: string;
  alreadyExisted: boolean;
}

/**
 * Ensures the 'confessions' storage bucket exists with public access.
 */
export async function ensureConfessionsBucket(supabase: SupabaseClient): Promise<void> {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    console.error('[STORAGE] Error listing buckets:', listError.message);
    return;
  }

  const exists = buckets?.some((b) => b.name === BUCKET_NAME);
  if (!exists) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: 10485760, // 10MB
      allowedMimeTypes: ['image/png', 'image/jpeg'],
    });
    if (createError && !createError.message.includes('already exists')) {
      console.error('[STORAGE] Error creating confessions bucket:', createError.message);
      throw new Error(`Failed to create storage bucket: ${createError.message}`);
    }
  }
}

/**
 * Generates deterministic storage path for a confession slide.
 * Example: "confessions/42/slide-01.png"
 */
export function getSlideStoragePath(confessionId: number, slideIndex: number): string {
  const slideNum = String(slideIndex + 1).padStart(2, '0');
  return `${confessionId}/slide-${slideNum}.png`;
}

/**
 * Gets the public URL for an uploaded slide object.
 */
export function getPublicSlideUrl(supabase: SupabaseClient, storagePath: string): string {
  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Checks if a slide object already exists in the bucket.
 */
export async function checkExistingSlide(
  supabase: SupabaseClient,
  storagePath: string
): Promise<boolean> {
  try {
    // Split path into directory and filename: confessions/42, slide-01.png
    const parts = storagePath.split('/');
    const fileName = parts.pop();
    const folder = parts.join('/');

    const { data, error } = await supabase.storage.from(BUCKET_NAME).list(folder, {
      search: fileName,
      limit: 1,
    });

    if (error || !data) return false;
    return data.some((file) => file.name === fileName && (file.metadata?.size || 0) > 0);
  } catch {
    return false;
  }
}

/**
 * Uploads a PNG buffer to the deterministic storage path.
 * If object already exists and reuseExisting is true, returns existing URL without re-upload.
 */
export async function uploadSlideImage(
  supabase: SupabaseClient,
  storagePath: string,
  pngBuffer: Buffer,
  reuseExisting: boolean = true
): Promise<StorageUploadResult> {
  // Check if object already exists for partial carousel recovery
  if (reuseExisting) {
    const exists = await checkExistingSlide(supabase, storagePath);
    if (exists) {
      return {
        path: storagePath,
        publicUrl: getPublicSlideUrl(supabase, storagePath),
        alreadyExisted: true,
      };
    }
  }

  const { error } = await supabase.storage.from(BUCKET_NAME).upload(storagePath, pngBuffer, {
    contentType: 'image/png',
    upsert: true,
    cacheControl: '3600',
  });

  if (error) {
    console.error(`[STORAGE] Upload failed for ${storagePath}:`, error.message);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return {
    path: storagePath,
    publicUrl: getPublicSlideUrl(supabase, storagePath),
    alreadyExisted: false,
  };
}

/**
 * Deletes all slide images associated with a confession ID.
 */
export async function deleteConfessionImages(
  supabase: SupabaseClient,
  confessionId: number
): Promise<void> {
  const folder = `${confessionId}`;
  const { data: files } = await supabase.storage.from(BUCKET_NAME).list(folder);

  if (files && files.length > 0) {
    const pathsToDelete = files.map((f) => `${folder}/${f.name}`);
    await supabase.storage.from(BUCKET_NAME).remove(pathsToDelete);
  }
}
