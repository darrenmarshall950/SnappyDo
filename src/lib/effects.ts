/**
 * Server-side effects helpers: Split Toning and Grain.
 * Used by the sharp-based render path in edit.ts (POST /api/images/:id/edit).
 */

export interface SplitToningData {
  shadows_hue: number;          // 0-360
  shadows_saturation: number;  // 0-100
  highlights_hue: number;       // 0-360
  highlights_saturation: number; // 0-100
  balance: number;              // -100 to +100
}

export interface GrainData {
  amount: number;   // 0-100
  size: number;     // 0-100
}

export function isSplitToningFlat(st: SplitToningData | undefined | null): boolean {
  if (!st) return true;
  return (
    Math.abs(st.shadows_hue) < 1e-4 &&
    Math.abs(st.shadows_saturation) < 1e-4 &&
    Math.abs(st.highlights_hue) < 1e-4 &&
    Math.abs(st.highlights_saturation) < 1e-4 &&
    Math.abs(st.balance) < 1e-4
  );
}

export function isGrainFlat(g: GrainData | undefined | null): boolean {
  if (!g) return true;
  return Math.abs(g.amount) < 1e-4;
}

/**
 * Apply Lightroom-style split toning to an RGB pixel.
 * Uses luminance-based mask to blend shadow and highlight tints.
 */
export function applySplitToningToRgb(
  r: number, g: number, b: number,
  st: SplitToningData,
): [number, number, number] {
  if (isSplitToningFlat(st)) return [r, g, b];

  // Luminance (Rec.709)
  const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;

  // Balance pivot shifts with balance value (-100..+100)
  // At balance=0: pivot=0.35; at balance=+100: pivot=0.65; at balance=-100: pivot=0.15
  const pivot = 0.35 + (st.balance / 100) * 0.3;

  // Highlight ratio: 0 in deep shadows, 1 in highlights
  const hlRatio = Math.max(0, Math.min(1, (luma - (pivot - 0.1)) / 0.2));

  // Build saturated shadow tint
  const [shR, shG, shB] = _hslToRgb(
    ((st.shadows_hue % 360) + 360) % 360 / 360,
    Math.max(0, Math.min(1, st.shadows_saturation / 100)),
    0.5,
  );

  // Build saturated highlight tint
  const [hiR, hiG, hiB] = _hslToRgb(
    ((st.highlights_hue % 360) + 360) % 360 / 360,
    Math.max(0, Math.min(1, st.highlights_saturation / 100)),
    0.5,
  );

  // Blend tints by highlight ratio
  const tR = shR + (hiR - shR) * hlRatio;
  const tG = shG + (hiG - shG) * hlRatio;
  const tB = shB + (hiB - shB) * hlRatio;

  // Blend by saturation — adds tint contribution
  const avgSat = (st.shadows_saturation + st.highlights_saturation) / 200; // 0..1
  const blend = avgSat * 0.5; // scale so 100% sat = 0.5 tint push

  const rOut = r + (tR - 0.5) * 255 * blend;
  const gOut = g + (tG - 0.5) * 255 * blend;
  const bOut = b + (tB - 0.5) * 255 * blend;

  return [
    Math.max(0, Math.min(255, Math.round(rOut))),
    Math.max(0, Math.min(255, Math.round(gOut))),
    Math.max(0, Math.min(255, Math.round(bOut))),
  ];
}

/**
 * Apply pseudo-random grain to an RGB pixel.
 * Uses a simple hash of pixel coordinates + time for temporal variation.
 */
export function applyGrainToRgb(
  r: number, g: number, b: number,
  grain: GrainData,
  x: number, y: number,
  timeMs: number,
): [number, number, number] {
  if (isGrainFlat(grain)) return [r, g, b];

  const { amount, size } = grain;
  const amountNorm = amount / 100;

  // Pseudo-random via sin hash (deterministic per pixel, varies with time)
  const seed = x * 374761393 + y * 668265263 + timeMs * 2246822519;
  // Simple hash mix
  let n = (seed ^ (seed >> 13)) * 1274126177;
  n = (n ^ (n >> 16));
  const random = ((n & 0x7fffffff) / 0x7fffffff) - 0.5; // -0.5..0.5

  // Luminance-based weight: more grain in highlights, less in shadows
  const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
  const grainWeight = 0.3 + luma * 0.7; // 0.3 in shadows .. 1.0 in highlights

  // Size scale (larger = coarser, more visible grain)
  // size 0 → scale 1.0, size 100 → scale 3.0
  const sizeScale = 1.0 + (size / 100) * 2.0;
  const grainAmount = random * amountNorm * 2.0 * grainWeight * sizeScale;

  return [
    Math.max(0, Math.min(255, r + grainAmount)),
    Math.max(0, Math.min(255, g + grainAmount)),
    Math.max(0, Math.min(255, b + grainAmount)),
  ];
}

// ── Internal HSL helpers ─────────────────────────────────────────────────────

function _hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-5) return [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const norm = (v: number): number => {
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 0.5) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  const r = norm(h + 1 / 3);
  const g = norm(h);
  const b = norm(h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
