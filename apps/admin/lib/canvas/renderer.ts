import path from 'path';
import fs from 'fs';
import { createCanvas, GlobalFonts, SKRSContext2D } from '@napi-rs/canvas';
import { CANVAS_CONFIG } from './config';

// ---------------------------------------------------------------------------
// Canvas Confession Card Renderer (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// High-resolution 1080x1350 PNG renderer using @napi-rs/canvas.
// Features:
//   - Self-contained (zero Next.js UI component dependencies)
//   - Bundled font registration (works reliably on Windows & Linux CI)
//   - Deterministic word-wrapping with bounds protection
//   - Distinctive BU Confessions dark luxury branding & accent gradients
//   - Header branding, confession numbering, and carousel slide indicators
// ---------------------------------------------------------------------------

let fontRegistered = false;

/**
 * Registers the bundled Geist and Noto Emoji fonts once at runtime.
 */
export function ensureFontRegistered(): void {
  if (fontRegistered) return;

  // 1. Local admin asset directory for Geist font
  const geistPaths = [
    path.resolve(process.cwd(), 'apps/admin/assets/fonts/Geist-Regular.ttf'),
    path.resolve(process.cwd(), 'assets/fonts/Geist-Regular.ttf'),
    path.resolve(__dirname, '../../assets/fonts/Geist-Regular.ttf'),
    path.resolve(__dirname, '../../../assets/fonts/Geist-Regular.ttf'),
    path.resolve(process.cwd(), 'node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf'),
  ];

  for (const fp of geistPaths) {
    if (fs.existsSync(fp)) {
      try {
        GlobalFonts.registerFromPath(fp, 'Geist');
        break;
      } catch (err) {
        console.warn(`[CANVAS] Could not register Geist font from ${fp}:`, err);
      }
    }
  }

  // 2. Bundled Noto Color Emoji font (SIL Open Font License 1.1)
  const emojiPaths = [
    path.resolve(process.cwd(), 'apps/admin/assets/fonts/NotoColorEmoji.ttf'),
    path.resolve(process.cwd(), 'assets/fonts/NotoColorEmoji.ttf'),
    path.resolve(__dirname, '../../assets/fonts/NotoColorEmoji.ttf'),
    path.resolve(__dirname, '../../../assets/fonts/NotoColorEmoji.ttf'),
    path.resolve(process.cwd(), 'apps/admin/assets/fonts/NotoEmoji-Regular.ttf'),
    path.resolve(process.cwd(), 'assets/fonts/NotoEmoji-Regular.ttf'),
    path.resolve(__dirname, '../../assets/fonts/NotoEmoji-Regular.ttf'),
    path.resolve(__dirname, '../../../assets/fonts/NotoEmoji-Regular.ttf'),
  ];

  for (const fp of emojiPaths) {
    if (fs.existsSync(fp)) {
      try {
        GlobalFonts.registerFromPath(fp, 'Noto Color Emoji');
        GlobalFonts.registerFromPath(fp, 'Noto Emoji');
        break;
      } catch (err) {
        console.warn(`[CANVAS] Could not register Noto Color Emoji font from ${fp}:`, err);
      }
    }
  }

  fontRegistered = true;
}

export interface RenderSlideOptions {
  confessionNumber?: number | null;
  slideIndex: number;
  totalSlides: number;
  createdAt?: string;
  bodyFontSize?: number;
  bodyLineHeight?: number;
}

/**
 * Wraps text into lines that fit within a maximum pixel width.
 * Uses Intl.Segmenter to guarantee that multi-byte emojis and ZWJ sequences
 * are never broken across character splits.
 */
function wrapTextToLines(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  for (const para of paragraphs) {
    if (para.trim().length === 0) {
      lines.push('');
      continue;
    }

    const words = para.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      if (!word) continue;
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          // Single word/cluster is wider than maxWidth; break using Intl.Segmenter graphemes!
          let graphemeChunk = '';
          const graphemes = Array.from(segmenter.segment(word), (s) => s.segment);
          for (const g of graphemes) {
            if (ctx.measureText(graphemeChunk + g).width <= maxWidth) {
              graphemeChunk += g;
            } else {
              lines.push(graphemeChunk);
              graphemeChunk = g;
            }
          }
          currentLine = graphemeChunk;
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Formats ISO date string into human-friendly format e.g. "15 Sep 2024".
 */
function formatCardDate(isoString?: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

/**
 * Renders a single slide of a confession into a high-resolution PNG Buffer.
 */
export async function renderConfessionSlide(
  slideText: string,
  options: RenderSlideOptions
): Promise<Buffer> {
  ensureFontRegistered();

  const { width, height } = CANVAS_CONFIG.dimensions;
  const { colors, layout, typography } = CANVAS_CONFIG;
  const { confessionNumber, slideIndex, totalSlides, createdAt } = options;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ── 1. Background Gradient ──
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, colors.backgroundStart);
  bgGrad.addColorStop(1, colors.backgroundEnd);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle ambient glow behind card center
  const glow = ctx.createRadialGradient(width / 2, height / 2, 80, width / 2, height / 2, width * 0.7);
  glow.addColorStop(0, 'rgba(139, 92, 246, 0.08)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // ── 2. Top Accent Stripe ──
  const stripeGrad = ctx.createLinearGradient(0, 0, width, 0);
  stripeGrad.addColorStop(0, colors.accentStart);
  stripeGrad.addColorStop(1, colors.accentEnd);
  ctx.fillStyle = stripeGrad;
  ctx.fillRect(0, 0, width, layout.accentBarHeight);

  // ── 3. Header Section ──
  const headerY = layout.paddingY + 30;

  // Dot indicator
  ctx.beginPath();
  ctx.arc(layout.paddingX + 8, headerY + 12, 6, 0, Math.PI * 2);
  ctx.fillStyle = colors.accentStart;
  ctx.fill();

  // Branding Title
  ctx.fillStyle = colors.textPrimary;
  ctx.font = `bold ${typography.headerTitleSize}px ${typography.fontFamily}`;
  ctx.fillText('BU CONFESSIONS', layout.paddingX + 26, headerY + 20);

  // Sub-badge / University Tag
  ctx.fillStyle = colors.badgeText;
  ctx.font = `normal ${typography.headerBadgeSize}px ${typography.fontFamily}`;
  ctx.fillText('BENNETT UNIVERSITY', layout.paddingX + 26, headerY + 44);

  // Confession Number Badge (Right Aligned)
  const numberText = confessionNumber ? `#${confessionNumber}` : 'ANONYMOUS';
  ctx.font = `bold ${typography.headerTitleSize}px ${typography.fontFamily}`;
  const numWidth = ctx.measureText(numberText).width;
  const badgeX = width - layout.paddingX - numWidth - 30;

  // Badge background pill
  ctx.fillStyle = colors.badgeBg;
  ctx.strokeStyle = colors.badgeBorder;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const pillHeight = 44;
  const pillY = headerY - 6;
  ctx.roundRect(badgeX, pillY, numWidth + 30, pillHeight, 22);
  ctx.fill();
  ctx.stroke();

  // Badge text
  ctx.fillStyle = colors.accentStart;
  ctx.fillText(numberText, badgeX + 15, headerY + 24);

  // ── 4. Horizontal Divider ──
  const dividerY = headerY + 70;
  ctx.strokeStyle = colors.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(layout.paddingX, dividerY);
  ctx.lineTo(width - layout.paddingX, dividerY);
  ctx.stroke();

  // ── 5. Body Text Rendering ──
  const maxContentWidth = width - layout.paddingX * 2;
  const contentStartY = dividerY + 60;
  const contentEndY = height - layout.paddingY - layout.footerHeight;
  const availableContentHeight = contentEndY - contentStartY;

  const bodyFontSize = options.bodyFontSize ?? typography.bodyFontSize;
  const bodyLineHeight = options.bodyLineHeight ?? typography.bodyLineHeight;

  ctx.fillStyle = colors.textPrimary;
  ctx.font = `normal ${bodyFontSize}px ${typography.fontFamily}`;

  const lines = wrapTextToLines(ctx, slideText, maxContentWidth);
  const totalTextHeight = lines.length * bodyLineHeight;

  // Vertically balance text within available content space
  let textY = contentStartY;
  if (totalTextHeight < availableContentHeight) {
    const extraSpace = availableContentHeight - totalTextHeight;
    textY += Math.min(extraSpace * 0.35, 120); // Gentle top vertical offset
  }

  for (const line of lines) {
    if (textY + bodyFontSize > contentEndY + 20) {
      // Safety guard against any vertical overflow
      break;
    }
    ctx.fillText(line, layout.paddingX, textY + bodyFontSize);
    textY += bodyLineHeight;
  }

  // ── 6. Footer Section ──
  const footerY = height - layout.paddingY;

  // Bottom Divider
  ctx.strokeStyle = colors.divider;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(layout.paddingX, footerY - 40);
  ctx.lineTo(width - layout.paddingX, footerY - 40);
  ctx.stroke();

  // Left Footer: Instagram handle & Date
  const dateStr = formatCardDate(createdAt);
  ctx.fillStyle = colors.textMuted;
  ctx.font = `normal ${typography.footerMetaSize}px ${typography.fontFamily}`;
  const handleText = dateStr ? `@bu.confess  •  ${dateStr}` : '@bu.confess';
  ctx.fillText(handleText, layout.paddingX, footerY);

  // Right Footer: Slide Indicator (e.g. "1/3 • Swipe ➔")
  if (totalSlides > 1) {
    const isLast = slideIndex === totalSlides - 1;
    const slideIndicator = isLast
      ? `${slideIndex + 1} / ${totalSlides}`
      : `${slideIndex + 1} / ${totalSlides}  Swipe ➔`;

    ctx.fillStyle = isLast ? colors.textMuted : colors.accentStart;
    ctx.font = `bold ${typography.footerIndicatorSize}px ${typography.fontFamily}`;
    const indWidth = ctx.measureText(slideIndicator).width;
    ctx.fillText(slideIndicator, width - layout.paddingX - indWidth, footerY);
  }

  // ── 7. Output PNG Buffer & Validation ──
  const pngBuffer = canvas.toBuffer('image/png');

  // Verify PNG signature (first 8 bytes must be: 89 50 4E 47 0D 0A 1A 0A)
  if (
    pngBuffer.length < 8 ||
    pngBuffer[0] !== 0x89 ||
    pngBuffer[1] !== 0x50 ||
    pngBuffer[2] !== 0x4e ||
    pngBuffer[3] !== 0x47 ||
    pngBuffer[4] !== 0x0d ||
    pngBuffer[5] !== 0x0a ||
    pngBuffer[6] !== 0x1a ||
    pngBuffer[7] !== 0x0a
  ) {
    throw new Error('Canvas render produced invalid PNG signature.');
  }

  return pngBuffer;
}
