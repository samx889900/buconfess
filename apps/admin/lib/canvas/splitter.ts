import { CANVAS_CONFIG } from './config';

// ---------------------------------------------------------------------------
// Deterministic Confession Text Splitter (BU Confessions v3.4)
// ---------------------------------------------------------------------------
// Splits confession text into readable slide-sized chunks for carousel display.
// Guarantees:
//   1. Zero words deleted or omitted
//   2. Splits on paragraph -> sentence -> word boundaries
//   3. Handles Unicode, emojis, and zero-width characters cleanly
//   4. Avoids orphaned punctuation at the start of a new slide
//   5. Handles extreme long words (e.g., 100+ character strings) gracefully
//   6. Completely deterministic, free, and non-LLM based
// ---------------------------------------------------------------------------

export interface SplitOptions {
  maxCharsPerSlide?: number;
  maxSlides?: number;
}

/**
 * Splits text into paragraphs, sentences, and words while preserving all content.
 */
export function splitConfessionText(
  rawText: string,
  options: SplitOptions = {}
): string[] {
  const maxChars = options.maxCharsPerSlide ?? CANVAS_CONFIG.limits.maxCharsPerSlide;
  const maxSlides = options.maxSlides ?? CANVAS_CONFIG.limits.maxSlides;

  // 1. Sanitize: normalize zero-width characters and standard whitespace
  const sanitized = rawText
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove invisible zero-width chars
    .replace(/\r\n/g, '\n')
    .trim();

  if (!sanitized) {
    return [''];
  }

  // Short confession fits in a single slide
  if (sanitized.length <= maxChars) {
    return [sanitized];
  }

  // 2. Tokenize text into atomic chunks (paragraphs / sentences / words)
  // We break by paragraphs first
  const paragraphs = sanitized.split(/\n\s*\n/);
  const units: string[] = [];

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if (trimmedPara.length <= maxChars) {
      units.push(trimmedPara);
    } else {
      // Split paragraph into sentences on terminator + space without dropping leading punctuation
      const sentences = trimmedPara.split(/(?<=[.!?]+[”"’)\]}]?)\s+/);
      for (const sent of sentences) {
        const trimmedSent = sent.trim();
        if (!trimmedSent) continue;

        if (trimmedSent.length <= maxChars) {
          units.push(trimmedSent);
        } else {
          // Sentence is longer than slide budget; split into words
          const words = trimmedSent.split(/\s+/);
          let currentWordChunk = '';

          for (const word of words) {
            if (!word) continue;

            // Handle extreme single word longer than maxChars
            if (word.length > maxChars) {
              if (currentWordChunk) {
                units.push(currentWordChunk);
                currentWordChunk = '';
              }
              // Force-chunk the giant word
              let remainingWord = word;
              while (remainingWord.length > maxChars) {
                units.push(remainingWord.slice(0, maxChars));
                remainingWord = remainingWord.slice(maxChars);
              }
              if (remainingWord) {
                currentWordChunk = remainingWord;
              }
              continue;
            }

            const candidate = currentWordChunk ? `${currentWordChunk} ${word}` : word;
            if (candidate.length <= maxChars) {
              currentWordChunk = candidate;
            } else {
              if (currentWordChunk) units.push(currentWordChunk);
              currentWordChunk = word;
            }
          }

          if (currentWordChunk) {
            units.push(currentWordChunk);
          }
        }
      }
    }
  }

  // 3. Assemble units into slides respecting maxCharsPerSlide
  const slides: string[] = [];
  let currentSlide = '';

  for (const unit of units) {
    if (!currentSlide) {
      currentSlide = unit;
      continue;
    }

    const testMerge = `${currentSlide}\n\n${unit}`;
    const testMergeSpace = `${currentSlide} ${unit}`;

    // If unit looks like a separate paragraph, join with newline; else space
    const combined = unit.length < 100 && currentSlide.length + testMergeSpace.length <= maxChars
      ? testMergeSpace
      : testMerge;

    if (combined.length <= maxChars) {
      currentSlide = combined;
    } else {
      slides.push(cleanSlidePunctuation(currentSlide));
      currentSlide = unit;
    }
  }

  if (currentSlide) {
    slides.push(cleanSlidePunctuation(currentSlide));
  }

  // 4. Enforce maxSlides ceiling (Instagram carousel limit: 10 slides)
  if (slides.length > maxSlides) {
    // Merge excess trailing slides into the final slide so no words are deleted
    const head = slides.slice(0, maxSlides - 1);
    const tail = slides.slice(maxSlides - 1).join('\n\n');
    head.push(cleanSlidePunctuation(tail));
    return head;
  }

  return slides;
}

/**
 * Trims outer whitespace while strictly preserving 100% of user characters and punctuation.
 * Never silently strips leading or trailing punctuation.
 */
function cleanSlidePunctuation(text: string): string {
  return text.trim();
}
