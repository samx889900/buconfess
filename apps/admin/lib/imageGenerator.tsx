import { ImageResponse } from 'next/og';

const MAX_CHARS_PER_IMAGE = 585;

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

export function generateConfessionImage(
  text: string,
  confessionNumber: number,
  partIndex: number,
  totalParts: number
) {
  const partLabel = totalParts > 1 ? ` (${partIndex + 1}/${totalParts})` : '';
  
  return new ImageResponse(
    (
      <div
        style={{
          width: '1080px',
          height: '1080px',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(to bottom right, #1a0533, #2d0a4e)',
          padding: '80px',
          fontFamily: 'sans-serif',
          color: '#f0e6ff',
        }}
      >
        {/* Top accent bar */}
        <div style={{ width: '100%', height: '6px', background: 'linear-gradient(to right, #9b59b6, #e91e8c)' }} />
        
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: '50px' }}>
          <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#ffffff' }}>BU Confessions</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#e91e8c', marginTop: '10px' }}>
            #{confessionNumber}{partLabel}
          </div>
        </div>

        {/* Divider */}
        <div style={{ width: '100%', height: '1px', background: 'rgba(255,255,255,0.1)', marginTop: '20px', marginBottom: '30px' }} />

        {/* Text Area */}
        <div style={{ fontSize: '34px', lineHeight: 1.4, flex: 1, display: 'flex' }}>
          {text}
        </div>

        {/* Footer */}
        <div style={{ fontSize: '24px', color: 'rgba(255,255,255,0.4)', marginBottom: '10px' }}>
          @bu.confess
        </div>
        
        {/* Bottom accent bar */}
        <div style={{ width: '100%', height: '4px', background: 'linear-gradient(to right, #9b59b6, #e91e8c)' }} />
      </div>
    ),
    {
      width: 1080,
      height: 1080,
    }
  );
}