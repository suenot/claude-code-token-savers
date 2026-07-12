// Scale presets for image-shrink. A preset is a human-friendly label ("1/2")
// mapping to a linear downscale factor applied to width AND height. The config
// also accepts a raw number in (0, 1]; anything unrecognized falls back to the
// default (1/2), so a typo never silently disables downscaling.

export const DEFAULT_SCALE = 0.5;

export const SCALE_PRESETS: Record<string, number> = {
  '1x': 1.0,
  '1/2': 0.5,
  '1/2.5': 0.4,
  '1/3': 1 / 3,
  '1/4': 0.25,
};

// resolveScale turns config's `scale` (preset string | raw number | undefined)
// into a factor in (0, 1]. Out-of-range or garbage → DEFAULT_SCALE.
export function resolveScale(scale: number | string | undefined): number {
  if (typeof scale === 'number') {
    return Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : DEFAULT_SCALE;
  }
  if (typeof scale === 'string') {
    const trimmed = scale.trim();
    if (trimmed in SCALE_PRESETS) return SCALE_PRESETS[trimmed];
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 0 && asNum <= 1) return asNum;
  }
  return DEFAULT_SCALE;
}
