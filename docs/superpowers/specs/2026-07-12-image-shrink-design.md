# image-shrink stage — design

**Date:** 2026-07-12
**Status:** implemented (iteration 1 = downscale only). E2E verified: 600×600 PNG
forwarded through the stage as 300×300, request 8059→2843 bytes.

## Goal

Add a native shuba stage that downscales base64 images inside outgoing
`/v1/messages` requests, cutting image token cost before the request reaches
Anthropic. Toggleable like any other module. Also surface **tokens saved per
model** in the console.

## Non-goals (this iteration)

- Vision-model routing (send image requests to a cheap vision model instead of
  Anthropic) — iteration 2.
- OCR-first pipeline — iteration 2. (Note: OCR does **not** need an LLM; most
  code-screenshot "analysis" is really text extraction. A dedicated OCR engine
  is cheaper/more accurate than a vision LLM. Captured here as the direction
  for iteration 2, with separate default models for (a) vision analysis and
  (b) OCR — where (b) is likely not an LLM at all.)

## Architecture

New built-in stage `image-shrink`, mirroring `dedup`:

- `bin/shuba-image-shrink.ts` — entrypoint; reads env, starts the server.
- `src/image/server.ts` — `createImageShrink({port, upstream, scale, minBytes})`,
  a passthrough HTTP proxy. On `POST /v1/messages` (not `count_tokens`) it
  parses the body, runs the transform, forwards the rewritten body; everything
  else is proxied byte-for-byte. Never throws on the response path — any resize
  error falls back to forwarding the raw body.
- `src/image/shrink.ts` — pure async transform `shrinkBody(body, {scale, minBytes})`.
- `src/image/presets.ts` — scale-preset table + `resolveScale()`.
- Registry entry `image-shrink`, `defaultPort: 47853`, `builtin: true`,
  `dialect: 'anthropic'`.

## Transform: `shrinkBody(body, {scale, minBytes})`

Walk `body.messages[].content[]`. For each block with `type === 'image'` and
`source.type === 'base64'` and a raster `media_type` (`image/png|jpeg|webp`):

1. Decode base64 → Buffer.
2. Skip if `buffer.length < minBytes` (tiny icons not worth it).
3. `sharp(buf).metadata()` → `{width, height}`. Target width = `round(width * scale)`.
   Downscale only — if `scale >= 1` or target ≥ width, leave untouched.
4. `sharp(buf).resize({ width: targetWidth }).toFormat(sameFormat).toBuffer()`.
5. If the re-encoded buffer is not smaller, keep the original (some already-tiny
   PNGs grow on re-encode).
6. Re-base64, replace `source.data`, keep `media_type`.

Skipped, left as-is: `source.type === 'url'` (no bytes to resize), `gif`,
non-image blocks.

Returns `{ body, stats: { images, savedBytes, tokensBefore, tokensAfter } }`.
Image token estimate per image ≈ `round(width * height / 750)` (Anthropic's
documented ~750 px/token), summed across resized images.

## Scale presets

| preset | factor |
|---|---|
| `1x` | 1.0 |
| `1/2` (default) | 0.5 |
| `1/2.5` | 0.4 |
| `1/3` | 0.3333 |
| `1/4` | 0.25 |

`resolveScale(scale)` accepts a preset string, a raw number `0 < n <= 1`, or
`undefined` → default `0.5`. Out-of-range/garbage → default.

## Config + toggle

- `Config.imageShrink?: { scale?: number | string; minBytes?: number }`
  (`types.ts`). Defaults: `scale = 0.5`, `minBytes = 4096`.
- Registry `build()` passes `IMAGE_SCALE`, `IMAGE_MIN_BYTES` env.
- Add `image-shrink` to `KNOWN_STAGES` and `LIVE_STAGES` in `http.ts` (honors
  the toggle live, next request — no restart). `isStageEnabled('image-shrink')`
  gate in the server, same as dedup.
- Enable by listing `image-shrink` in `config.compressors`; the console toggle
  flips it at runtime.

## Telemetry + per-model savings

The server writes a reqlog entry (stage `image-shrink`) including `model`
(from `summarizeBody`) and `tokensIn = tokensBefore`, `tokensOut = tokensAfter`,
`tokensSaved`. Unlike dedup (which omits token fields), image-shrink emits them
so `readSavings()` counts it.

Extend `SavingsSummary` with `byModel: Record<string, {in, out, saved, requests}>`
and populate it in `readSavings()` keyed by `entry.model ?? 'unknown'`. Expose
via the existing `GET /api/savings`. In the console `SavingsView`, add a
"Saved per model" section rendered from `getSavings().byModel`, alongside the
existing per-stage bars.

## Testing

`test/image-shrink.test.ts` (bun test):

- `resolveScale`: presets, raw numbers, out-of-range, undefined → 0.5.
- `shrinkBody`: generate a 400×400 PNG via sharp; scale 0.5 → resized image
  width 200, `stats.images === 1`, `savedBytes > 0`.
- non-image + text blocks untouched.
- `source.type: 'url'` block untouched.
- `scale >= 1` → passthrough (no change).
- buffer `< minBytes` → untouched.
- `readSavings` byModel: two entries, different `model`, aggregate correctly.

## Dependency

Add `sharp` (native libvips) to `orchestrator/package.json`.
