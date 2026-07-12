#!/usr/bin/env bun
import { createImageShrink } from '../src/image/server.ts';

const port = Number(process.env.PORT || 47853);
const upstream = process.env.IMAGE_UPSTREAM || 'https://api.anthropic.com';
const scale = process.env.IMAGE_SCALE || '1/2';
const minBytes = process.env.IMAGE_MIN_BYTES ? Number(process.env.IMAGE_MIN_BYTES) : undefined;

createImageShrink({ port, upstream, scale, minBytes }).listen(port);
process.stderr.write(
  `[image-shrink] listening on 127.0.0.1:${port} → ${upstream} (downscale images, scale=${scale})\n`,
);
