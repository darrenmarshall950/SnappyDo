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

// ── Lens Corrections ────────────────────────────────────────────────────────

export interface LensCorrectionsData {
  enabled?: boolean;
  remove_baseline_exposure?: number;  // -5..+5
  chromatic_aberration?: number;       // 0..100
  chromatic_aberration_x?: number;     // -1..1
  chromatic_aberration_y?: number;      // -1..1
}

export function isLensCorrectionsFlat(lc: LensCorrectionsData | undefined | null): boolean {
  if (!lc || !lc.enabled) return true;
  return (
    Math.abs(lc.remove_baseline_exposure || 0) < 1e-4 &&
    Math.abs(lc.chromatic_aberration || 0) < 1e-4
  );
}

/**
 * Apply server-side lens corrections to raw image pixels.
 * Called BEFORE the main pixel loop (on the sharp pipeline directly).
 * Returns updated sharp pipeline.
 *
 * For chromatic aberration: we apply it as a per-channel offset using
 * composite with slight translate. Baseline exposure is a multiply factor.
 */
export async function applyLensCorrectionsPipeline(
  pipeline: sharp.Sharp,
  lc: LensCorrectionsData,
  width: number,
  height: number,
): Promise<sharp.Sharp> {
  // Baseline exposure: multiply factor
  const baseline = Number(lc.remove_baseline_exposure) || 0;
  if (Math.abs(baseline) > 1e-4) {
    // 1 stop = factor 2; so baseline of +1 → multiply by 2
    const factor = Math.pow(2, baseline);
    pipeline = pipeline.linear(factor, 0);
  }

  // Chromatic aberration: offset R and B channels
  const caStrength = Number(lc.chromatic_aberration) || 0;
  if (caStrength > 0) {
    const caX = Number(lc.chromatic_aberration_x) || 0;
    const caY = Number(lc.chromatic_aberration_y) || 0;
    const offsetPixels = caStrength / 100 * 4; // 0..4 pixels max offset
    const dx = Math.round(caX * offsetPixels);
    const dy = Math.round(caY * offsetPixels);

    if (dx !== 0 || dy !== 0) {
      // Extract R, G, B channels separately
      const img = pipeline.clone();
      const [rBuf, gBuf, bBuf] = await Promise.all([
        img.clone().extractChannel(0).toBuffer(),
        pipeline.clone().extractChannel(1).toBuffer(),
        pipeline.clone().extractChannel(2).toBuffer(),
      ]);

      // Shift R channel: composite R at offset (dx, dy)
      // Well use sharps composite with { left, top } to offset
      const rShifted = await sharp(rBuf, {
        raw: { width, height, channels: 1 },
      })
        .extend({
          top: dy > 0 ? 0 : Math.abs(dy),
          bottom: dy < 0 ? 0 : Math.abs(dy),
          left: dx > 0 ? 0 : Math.abs(dx),
          right: dx < 0 ? 0 : Math.abs(dx),
          background: { r: 0, g: 0, b: 0, alpha: 255 },
        })
        .resize(width, height)
        .toBuffer();

      const bShifted = await sharp(bBuf, {
        raw: { width, height, channels: 1 },
      })
        .extend({
          top: dy > 0 ? Math.abs(dy) : 0,
          bottom: dy < 0 ? 0 : Math.abs(dy),
          left: dx > 0 ? Math.abs(dx) : 0,
          right: dx < 0 ? 0 : Math.abs(dx),
          background: { r: 0, g: 0, b: 0, alpha: 255 },
        })
        .resize(width, height)
        .toBuffer();

      // Recombine: use channel shuffle
      pipeline = sharp(gBuf, { raw: { width, height, channels: 1 } })
        .joinChannel(sharp(rShifted, { raw: { width, height, channels: 1 } }).extractChannel(0), { channels: 1 })
        .joinChannel(sharp(bShifted, { raw: { width, height, channels: 1 } }).extractChannel(0), { channels: 1 });
    }
  }

  return pipeline;
}

// ── Calibration (Camera Profile) ────────────────────────────────────────────

export interface CalibrationData {
  shadow_tint?: number;  // -100..+100
  saturation?: number;    // 0..100
}

export function isCalibrationFlat(cal: CalibrationData | undefined | null): boolean {
  if (!cal) return true;
  return Math.abs(cal.shadow_tint || 0) < 1e-4 && Math.abs(cal.saturation || 0) < 1e-4;
}

/**
 * Apply calibration (shadow tint + saturation) to an RGB pixel.
 * This is called inside the main pixel loop after HSL effects.
 */
export function applyCalibrationToRgb(
  r: number, g: number, b: number,
  cal: CalibrationData,
): [number, number, number] {
  if (isCalibrationFlat(cal)) return [r, g, b];

  // Shadow tint: shift hue in shadows only
  const shadowTint = cal.shadow_tint || 0;
  if (Math.abs(shadowTint) > 0.1) {
    const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    const shadowMask = 1.0 - Math.min(1.0, luma / 0.4); // affects darker areas
    const amount = (shadowTint / 100) * shadowMask * 0.5;
    r = r + amount * 0.5 * 255;
    g = g - amount * 0.3 * 255;
    b = b + amount * 0.5 * 255;
  }

  // Calibration saturation: multiplicative on luma
  const calSat = cal.saturation || 0;
  if (calSat > 0) {
    const luma = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    const satFactor = 1.0 + calSat / 100;
    r = luma + (r - luma) * satFactor;
    g = luma + (g - luma) * satFactor;
    b = luma + (b - luma) * satFactor;
  }

  return [
    Math.max(0, Math.min(255, r)),
    Math.max(0, Math.min(255, g)),
    Math.max(0, Math.min(255, b)),
  ];
}

// ── Spot Removal ────────────────────────────────────────────────────────────

export interface SpotRemoval {
  x: number;      // 0..1 UV destination x
  y: number;      // 0..1 UV destination y
  radius: number; // pixels
  mode: clone | heal;
  srcX: number;   // 0..1 UV source x
  srcY: number;   // 0..1 UV source y
}

/**
 * Apply spot removals to a raw RGBA buffer.
 * Modifies the buffer in-place. Operates in pixel space (not UV).
 */
export function applySpotRemovalsToBuffer(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  spots: SpotRemoval[],
): void {
  for (const spot of spots) {
    const cx = Math.round(spot.x * width);
    const cy = Math.round(spot.y * height);
    const radius = Math.max(1, Math.round(spot.radius));
    const srcCx = Math.round(spot.srcX * width);
    const srcCy = Math.round(spot.srcY * height);

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;

        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;

        const srcPx = srcCx + dx;
        const srcPy = srcCy + dy;
        if (srcPx < 0 || srcPx >= width || srcPy < 0 || srcPy >= height) continue;

        const blend = 1.0 - (dist / radius); // 1 at center, 0 at edge
        const idx = (py * width + px) * 4;
        const srcIdx = (srcPy * width + srcPx) * 4;

        if (spot.mode === clone) {
          data[idx] = data[srcIdx];
          data[idx + 1] = data[srcIdx + 1];
          data[idx + 2] = data[srcIdx + 2];
        } else {
          // heal: blend source with destination using a smooth falloff
          data[idx] = data[idx] + (data[srcIdx] - data[idx]) * blend;
          data[idx + 1] = data[idx + 1] + (data[srcIdx + 1] - data[idx + 1]) * blend;
          data[idx + 2] = data[idx + 2] + (data[srcIdx + 2] - data[idx + 2]) * blend;
        }
      }
    }
  }
}
