// Pure(ish) transform for the image-shrink stage: downscale base64 raster
// images embedded in an Anthropic /v1/messages body so they cost fewer image
// tokens. Downscale only — never upscales. Any per-image failure leaves that
// image untouched (the whole request must still go through), so a corrupt or
// exotic image can never break the response path.

import sharp from 'sharp';
import { resolveScale } from './presets.ts';

// Anthropic bills images at roughly (width * height) / 750 tokens. Used only
// for savings telemetry, not for any request decision.
const PX_PER_TOKEN = 750;

// media_type -> the sharp output format used to re-encode. gif is intentionally
// absent: sharp would flatten animation, so we skip gifs entirely.
const FORMAT: Record<string, 'png' | 'jpeg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

export type ShrinkStats = { images: number; savedBytes: number; tokensBefore: number; tokensAfter: number };

function estTokens(width: number, height: number): number {
  return Math.round((width * height) / PX_PER_TOKEN);
}

// shrinkOne returns the rewritten image block plus its stats, or null when the
// block should be left exactly as-is (not a resizable image, too small, or the
// resize did not actually help).
async function shrinkOne(
  block: any,
  scale: number,
  minBytes: number,
): Promise<{ block: any; savedBytes: number; tokensBefore: number; tokensAfter: number } | null> {
  if (!block || block.type !== 'image') return null;
  const source = block.source;
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') return null;
  const format = FORMAT[source.media_type];
  if (!format) return null;
  if (scale >= 1) return null;

  const inputBytes = Buffer.byteLength(source.data, 'base64');
  if (inputBytes < minBytes) return null;

  const buf = Buffer.from(source.data, 'base64');
  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return null;

  const targetWidth = Math.round(width * scale);
  if (targetWidth < 1 || targetWidth >= width) return null;

  const resized = await sharp(buf).resize({ width: targetWidth }).toFormat(format).toBuffer();
  // Some already-small PNGs get bigger on re-encode; only keep a real win.
  if (resized.length >= buf.length) return null;

  const outMeta = await sharp(resized).metadata();
  const outWidth = outMeta.width ?? targetWidth;
  const outHeight = outMeta.height ?? Math.round(height * scale);

  return {
    block: { ...block, source: { ...source, data: resized.toString('base64') } },
    savedBytes: buf.length - resized.length,
    tokensBefore: estTokens(width, height),
    tokensAfter: estTokens(outWidth, outHeight),
  };
}

// shrinkBody downscales every eligible image in the body and reports aggregate
// stats. Returns the original body object untouched when there is nothing to do.
export async function shrinkBody(
  body: any,
  opts: { scale?: number | string; minBytes?: number },
): Promise<{ body: any; stats: ShrinkStats }> {
  const stats: ShrinkStats = { images: 0, savedBytes: 0, tokensBefore: 0, tokensAfter: 0 };
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return { body, stats };
  }
  const scale = resolveScale(opts.scale);
  const minBytes = opts.minBytes ?? 4096;
  if (scale >= 1) return { body, stats };

  const messages = await Promise.all(
    body.messages.map(async (message: any) => {
      if (!message || !Array.isArray(message.content)) return message;
      const content = await Promise.all(
        message.content.map(async (block: any) => {
          try {
            const result = await shrinkOne(block, scale, minBytes);
            if (!result) return block;
            stats.images += 1;
            stats.savedBytes += result.savedBytes;
            stats.tokensBefore += result.tokensBefore;
            stats.tokensAfter += result.tokensAfter;
            return result.block;
          } catch {
            // Leave this image untouched on any decode/resize error.
            return block;
          }
        }),
      );
      return { ...message, content };
    }),
  );

  if (stats.images === 0) return { body, stats };
  return { body: { ...body, messages }, stats };
}
