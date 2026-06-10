import { createCanvas } from '@napi-rs/canvas';

const CANVAS_SIZE = 1080;
const PADDING = 80;
const MAX_CHARS_PER_IMAGE = 450;
const FONT_SIZE = 36;
const LINE_HEIGHT = 52;

export function splitTextIntoParts(text: string): string[] {
  if (text.length <= MAX_CHARS_PER_IMAGE) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHARS_PER_IMAGE) {
      parts.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf(' ', MAX_CHARS_PER_IMAGE);
    if (splitAt <= 0) splitAt = MAX_CHARS_PER_IMAGE;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return parts;
}

function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Returns a Buffer - no file system, no DB storage needed
export async function generateConfessionImage(
  text: string,
  confessionNumber: number,
  partIndex: number,
  totalParts: number
): Promise<Buffer> {
  const canvas = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const ctx = canvas.getContext('2d');

  // Background gradient: dark purple
  const grad = ctx.createLinearGradient(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  grad.addColorStop(0, '#1a0533');
  grad.addColorStop(1, '#2d0a4e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Subtle grid pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let i = 0; i < CANVAS_SIZE; i += 60) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_SIZE); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_SIZE, i); ctx.stroke();
  }

  // Top accent bar
  const accentGrad = ctx.createLinearGradient(0, 0, CANVAS_SIZE, 0);
  accentGrad.addColorStop(0, '#9b59b6');
  accentGrad.addColorStop(1, '#e91e8c');
  ctx.fillStyle = accentGrad;
  ctx.fillRect(PADDING, PADDING, CANVAS_SIZE - PADDING * 2, 6);

  // Header: BU Confessions
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px DejaVu Sans';
  ctx.fillText('BU Confessions', PADDING, PADDING + 50);

  // Confession number
  ctx.fillStyle = '#e91e8c';
  ctx.font = 'bold 22px DejaVu Sans';
  const partLabel = totalParts > 1 ? ` (${partIndex + 1}/${totalParts})` : '';
  ctx.fillText(`#${confessionNumber}${partLabel}`, PADDING, PADDING + 80);

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, PADDING + 100);
  ctx.lineTo(CANVAS_SIZE - PADDING, PADDING + 100);
  ctx.stroke();

  // Confession text
  ctx.fillStyle = '#f0e6ff';
  ctx.font = `${FONT_SIZE}px DejaVu Sans`;
  const maxTextWidth = CANVAS_SIZE - PADDING * 2;
  const lines = wrapText(ctx, text, maxTextWidth);
  let y = PADDING + 150;
  for (const line of lines) {
    if (y + LINE_HEIGHT > CANVAS_SIZE - PADDING - 60) {
      ctx.fillStyle = 'rgba(240,230,255,0.5)';
      ctx.font = '28px DejaVu Sans';
      ctx.fillText('...', PADDING, y);
      break;
    }
    ctx.fillStyle = '#f0e6ff';
    ctx.font = `${FONT_SIZE}px DejaVu Sans`;
    ctx.fillText(line, PADDING, y);
    y += LINE_HEIGHT;
  }

  // Bottom: @bu.confess handle
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '24px DejaVu Sans';
  ctx.fillText('@bu.confess', PADDING, CANVAS_SIZE - PADDING);

  // Bottom accent bar
  ctx.fillStyle = accentGrad;
  ctx.fillRect(PADDING, CANVAS_SIZE - PADDING - 10, CANVAS_SIZE - PADDING * 2, 4);

  return Buffer.from(canvas.toBuffer('image/jpeg'));
}