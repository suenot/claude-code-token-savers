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

---

# Iteration 2 — model-router stage (full task-type routing + OCR)

**Status:** implemented + verified. E2E: background route rewrote
`claude-haiku-4-5 → deepseek/cheap` through the proxy; real tesseract via
`extractText` read "HELLO OCR 42" off a rendered PNG. 10 unit tests pass.

## Motivation

Most "image analysis" in coding is really text extraction (screenshots of
code/errors/logs). OCR does not need an LLM — a local engine is cheaper and
more accurate for that. Only genuinely visual tasks (diagrams, UI, colour) need
a vision model. This is one route in the broader task-type routing taxonomy that
harnesses like claude-code-router expose (`default` / `background` / `think` /
`longContext` / `webSearch` / `image`). shuba already covers `compact`
(compact-router) and `longContext` (context-watchdog) with dedicated stages;
iteration 2 adds the `image` route.

## Stage `model-router` (full task-type routing)

One built-in stage (`defaultPort: 47854`, toggleable) that classifies every
`/v1/messages` request into a task category and rewrites `body.model` (and,
optionally, the upstream endpoint) per a configured route map — the
claude-code-router / hermes pattern, native in shuba. `image-shrink` stays a
separate stage (pixel downscale) and composes ahead of it.

**Categories + detection (first configured match wins, in this precedence):**

| route | detected when | default model |
|---|---|---|
| `longContext` | `estimateTokens(body) > threshold` (default 60k) | (unset) |
| `image` | any message has a base64 `image` block | (see below) |
| `think` | `body.thinking` enabled | (unset) |
| `webSearch` | a `web_search` tool present | (unset) |
| `background` | `body.model` matches `/haiku/i` (Claude Code's small calls) | (unset) |
| `default` | none of the above | (unset) |

A category is only chosen if its route is configured (an unconfigured category
never shadows a lower one). Each route: `{ model?, baseUrl?, envKey? }`;
`longContext` also carries `threshold`. `model` set → rewrite `body.model`;
`baseUrl`+`envKey` set → also forward that one request to a different
Anthropic-messages endpoint. All routes empty ⇒ the stage is a passthrough.

**`image` route** additionally handles pixels via `mode`:

- **`ocr`** (default): run local OCR (tesseract) on each base64 image; inject a
  text block `[shuba-ocr]\n<text>` immediately before the image block. Keep the
  image by default (`dropImage: false` — nothing lost, helps accuracy); set
  `dropImage: true` to remove the pixels after extraction for max savings
  (lossy — drops visual info). Token savings reported only when `dropImage`.
- **`vision-route`**: for image-containing requests, rewrite `body.model` to
  `visionModel` (default `claude-haiku-4-5`) — the hermes `image` route. Optional
  `visionBaseUrl` + `visionEnvKey` send it to a different Anthropic-messages
  endpoint; by default it stays on the same upstream, just a cheaper model.
- **`off`**: passthrough.

Image-route defaults: `mode='ocr'`, `dropImage=false`, `ocrCommand='tesseract'`,
`ocrLang='eng'`. In `vision-route`, `image.model` (default `claude-haiku-4-5`)
is the model image requests are sent to.

## Config

```
Config.modelRouter?: {
  routes?: {
    default?:     { model?; baseUrl?; envKey? };
    background?:  { model?; baseUrl?; envKey? };
    think?:       { model?; baseUrl?; envKey? };
    longContext?: { model?; baseUrl?; envKey?; threshold? };
    webSearch?:   { model?; baseUrl?; envKey? };
    image?:       { model?; baseUrl?; envKey?;
                    mode?: 'ocr'|'vision-route'|'off'; dropImage?; ocrCommand?; ocrLang? };
  }
}
```

The whole `routes` object is passed to the bin as one JSON env var
(`ROUTER_ROUTES`) — nested config does not fit discrete envs.

## Components

- `src/router/classify.ts` — `classifyRequest(body, routes)`: pure; returns the
  winning category by precedence, skipping unconfigured categories.
- `src/image/ocr.ts` — `extractText(buffer, {ocrCommand, ocrLang, spawnImpl})`:
  writes the image to a temp file, runs `<ocrCommand> <file> stdout -l <lang>`,
  returns trimmed text (empty on any failure — never throws).
- `src/router/apply.ts` — `applyRoute(body, category, routes)`: model rewrite,
  or image OCR-inject; returns `{ body, routedModel?, upstream?, stats }`.
- `src/router/server.ts` — proxy; honours a per-route upstream/auth override.
- `bin/shuba-model-router.ts`, registry entry, `KNOWN_STAGES`/`LIVE_STAGES`.

## Testing

`test/model-router.test.ts`: classify precedence (longContext > image > think >
webSearch > background > default; unconfigured skipped); model rewrite per
category; image OCR injection with a stubbed `spawnImpl` (no real tesseract in
CI); `dropImage` removes the image block; `vision-route` rewrites model on image
requests; `off` / all-empty passthrough.
