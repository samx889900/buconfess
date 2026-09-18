import { INSTAGRAM_LIMITS } from './config';

// ---------------------------------------------------------------------------
// Instagram Image & Container Validation (BU Confessions v3.4 — Phase E)
// ---------------------------------------------------------------------------
// Enforces Instagram Graph API compatibility:
//   - Slide count within [1, 10]
//   - Public HTTPS image URLs
//   - Supported formats (PNG / JPEG)
//   - Aspect ratio within [0.8, 1.91]
//   - Width within [320, 1440] px
// Does NOT rigidly enforce exactly 1080x1350, preserving flexibility.
// ---------------------------------------------------------------------------

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates that an array of image URLs satisfies Instagram Carousel constraints.
 */
export function validateInstagramImageUrls(imageUrls: string[]): ImageValidationResult {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { valid: false, error: 'No image URLs provided for Instagram publication.' };
  }

  if (imageUrls.length < INSTAGRAM_LIMITS.minSlides || imageUrls.length > INSTAGRAM_LIMITS.maxSlides) {
    return {
      valid: false,
      error: `Slide count ${imageUrls.length} exceeds Instagram limits (${INSTAGRAM_LIMITS.minSlides}-${INSTAGRAM_LIMITS.maxSlides} slides).`,
    };
  }

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (typeof url !== 'string' || !url.trim()) {
      return { valid: false, error: `Slide #${i + 1} URL is empty or invalid.` };
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return {
          valid: false,
          error: `Slide #${i + 1} URL must use HTTPS for Instagram compatibility (got ${parsed.protocol}).`,
        };
      }
    } catch {
      return { valid: false, error: `Slide #${i + 1} URL is not a valid URL: ${url}` };
    }
  }

  return { valid: true };
}

/**
 * Validates an image buffer's signature, dimensions, and aspect ratio for Instagram.
 */
export function validateImageBuffer(buffer: Buffer): ImageValidationResult {
  if (!buffer || buffer.length === 0) {
    return { valid: false, error: 'Image buffer is empty.' };
  }

  // Check PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;

  // Check JPEG signature: FF D8 FF
  const isJpeg =
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;

  if (!isPng && !isJpeg) {
    return { valid: false, error: 'Unsupported image format: must be PNG or JPEG.' };
  }

  // If PNG, extract width and height from IHDR chunk (bytes 16-23)
  if (isPng && buffer.length >= 24) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);

    if (width < INSTAGRAM_LIMITS.minWidth || width > INSTAGRAM_LIMITS.maxWidth) {
      return {
        valid: false,
        error: `Image width ${width}px is outside Instagram supported range (${INSTAGRAM_LIMITS.minWidth}-${INSTAGRAM_LIMITS.maxWidth}px).`,
      };
    }

    if (height <= 0) {
      return { valid: false, error: `Invalid image height: ${height}px.` };
    }

    const aspectRatio = width / height;
    // Allow slight tolerance (0.02) on aspect ratio bounds
    if (aspectRatio < INSTAGRAM_LIMITS.minAspectRatio - 0.02 || aspectRatio > INSTAGRAM_LIMITS.maxAspectRatio + 0.02) {
      return {
        valid: false,
        error: `Aspect ratio ${aspectRatio.toFixed(2)} (${width}x${height}) is outside Instagram limits (${INSTAGRAM_LIMITS.minAspectRatio}-${INSTAGRAM_LIMITS.maxAspectRatio}).`,
      };
    }
  }

  return { valid: true };
}
