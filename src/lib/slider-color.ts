/**
 * src/lib/slider-color.ts — Pure JS port of the WebGL slider math.
 *
 * Mirrors the applySliders() shader in src/lib/editor-gl.ts (lines ~89-103)
 * so that the same slider values produce the same colour when applied to
 * an RGBA pixel in JS. Used by the LUT synthesiser to bake slider ops
 * into a 3D LUT cube. Safe to call from server code (no DOM / no GL).
 *
 * Inputs are 0..255 integers (or 0..1 floats — auto-detected by range).
 * Output is 0..255 floats (clamped, rounded by caller if needed).
 *
 * Slider ranges (kept in sync with the editor):
 *   exposure:    -200..200   (multiplicative stops; 100 = 1 stop)
 *   brightness:  -100..100   (multiplicative scale; 0 = neutral)
 *   contrast:    -100..100   (linear stretch around 0.5)
 *   saturation:  -100..100   (lerp toward luma; -100 = grayscale)
 *   temp:        -100..100   (R opposite B; +warm)
 *   tint:        -100..100   (R+G opposite B; +magenta/-green)
 *
 * Not included (require spatial context — not per-pixel):
 *   sharpen, vignette, highlights/shadows/whites/blacks tone curve
 */

export interface SliderParams {
  exposure?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temp?: number;
  tint?: number;
}

const DEFAULTS = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temp: 0,
  tint: 0,
};

/**
 * Apply slider ops to a single RGB triplet.
 * Accepts 0..255 ints or 0..1 floats (auto-detected by max value).
 * Returns 0..255 float (caller rounds if integer needed).
 */
export function applySlidersToRgb(
  r: number, g: number, b: number,
  p: SliderParams,
): [number, number, number] {
  const exposure = p.exposure ?? DEFAULTS.exposure;
  const brightness = p.brightness ?? DEFAULTS.brightness;
  const contrast = p.contrast ?? DEFAULTS.contrast;
  const saturation = p.saturation ?? DEFAULTS.saturation;
  const temp = p.temp ?? DEFAULTS.temp;
  const tint = p.tint ?? DEFAULTS.tint;

  // Auto-detect range: input max > 1.5 means it's 0..255 (8-bit).
  // Normalise to 0..1 for math, return 0..255.
  const maxIn = Math.max(r, g, b);
  const scale = maxIn > 1.5 ? 1 / 255 : 1;
  let cr = r * scale;
  let cg = g * scale;
  let cb = b * scale;

  // Exposure (multiplicative stops).
  cr *= Math.pow(2, exposure / 100);
  cg *= Math.pow(2, exposure / 100);
  cb *= Math.pow(2, exposure / 100);
  // Brightness (multiplicative scale around 1.0).
  const bMul = 1 + brightness / 100;
  cr *= bMul;
  cg *= bMul;
  cb *= bMul;
  // Contrast (linear stretch around 0.5).
  const cFactor = (100 + contrast) / 100;
  cr = (cr - 0.5) * cFactor + 0.5;
  cg = (cg - 0.5) * cFactor + 0.5;
  cb = (cb - 0.5) * cFactor + 0.5;
  cr = clamp01(cr); cg = clamp01(cg); cb = clamp01(cb);
  // Saturation (luma-weighted mix toward grayscale).
  const luma = 0.299 * cr + 0.587 * cg + 0.114 * cb;
  const satFactor = Math.max(0, 1 + saturation / 100); // -100 → 0, +100 → 2
  cr = lerp(luma, cr, satFactor);
  cg = lerp(luma, cg, satFactor);
  cb = lerp(luma, cb, satFactor);
  // Temp (warm/cool): shift R opposite B.
  const tempShift = (temp / 100) * 0.15;
  cr += tempShift;
  cb -= tempShift;
  // Tint (magenta/green): shift R+G opposite B.
  const tintShift = (tint / 100) * 0.1;
  cr += tintShift * 0.5;
  cg += tintShift * 0.5;
  cb -= tintShift;
  // Final clamp.
  cr = clamp01(cr); cg = clamp01(cg); cb = clamp01(cb);

  return [cr * 255, cg * 255, cb * 255];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Format a 33³ LUT cube as a .cube file (Adobe spec).
 * `size` is the cube edge (e.g. 33).
 * `lookup(r, g, b)` returns the output [r, g, b] for the input triplet
 * (both in 0..255). Caller pre-applies any base LUT, then calls lookup.
 */
export function formatCubeFile(
  size: number,
  lookup: (r: number, g: number, b: number) => [number, number, number],
  title = 'SnappyDo synthesised LUT',
): string {
  const lines: string[] = [];
  lines.push(`TITLE "${title}"`);
  lines.push(`LUT_3D_SIZE ${size}`);
  lines.push('DOMAIN_MIN 0.0 0.0 0.0');
  lines.push('DOMAIN_MAX 1.0 1.0 1.0');
  // .cube order: r fastest, then g, then b slowest.
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const rIn = (ri / (size - 1)) * 255;
        const gIn = (gi / (size - 1)) * 255;
        const bIn = (bi / (size - 1)) * 255;
        const [ro, go, bo] = lookup(rIn, gIn, bIn);
        const rStr = (ro / 255).toFixed(6);
        const gStr = (go / 255).toFixed(6);
        const bStr = (bo / 255).toFixed(6);
        lines.push(`${rStr} ${gStr} ${bStr}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
