// Local OCR for the image route. Extracts text from a raster image with a
// tesseract-style CLI so image requests that are really "read this text"
// (screenshots of code/errors/logs) never need a vision LLM. Never throws —
// any failure returns '' and the caller leaves the image as-is.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SpawnLike = typeof spawnSync;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

// extractText writes the image to a temp file and runs `<cmd> <file> stdout
// -l <lang>` (tesseract's stdout mode). Returns trimmed text, or '' on any
// error/empty result. spawnImpl is injectable for tests.
export function extractText(
  buffer: Buffer,
  mediaType: string,
  opts: { ocrCommand?: string; ocrLang?: string; spawnImpl?: SpawnLike } = {},
): string {
  const ext = EXT[mediaType];
  if (!ext) return '';
  const cmd = opts.ocrCommand ?? 'tesseract';
  const lang = opts.ocrLang ?? 'eng';
  const spawn = opts.spawnImpl ?? spawnSync;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'shuba-ocr-'));
    const file = join(dir, `img.${ext}`);
    writeFileSync(file, buffer);
    const result = spawn(cmd, [file, 'stdout', '-l', lang], { encoding: 'utf8', timeout: 20_000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return '';
    return result.stdout.trim();
  } catch {
    return '';
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort */
      }
    }
  }
}
