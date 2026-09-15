/**
 * src/lib/darktable-xmp.ts — Build darktable-cli XMP sidecar from sliders.
 *
 * darktable's CLI tool (`darktable-cli`) accepts an XMP sidecar as its 2nd
 * positional arg. If the XMP contains a `<darktable:history>` block with
 * properly-formed rdf:Seq entries, darktable applies those modules to the
 * RAW during export.
 *
 * STATUS (2026-09-15):
 *   - temperature (WB): ✅ WIRED + verified visually (with cam-baseline).
 *   - colorbalance: ✅ WIRED for |deltaK| > 0.5 — dramatic WB on top of temp.
 *   - lensfun: ✅ WIRED — method=embedded metadata, modify_flags=ALL.
 *   - nlmeans (denoise): ✅ WIRED — separate luma/chroma sliders.
 *   - exiftool WB cache: ✅ WIRED — keyed by path+mtime+size.
 *
 * XMP FORMAT (darktable 4.2.1):
 *   - xmp_version="1" → uses `read_history_v1` (separate rdf:Seq per field).
 *   - xmp_version="2" → uses `read_history_v2` (Exiv2 indexed keys, we don't
 *     use this — fragile to construct).
 *   v1 works and is simpler. We force it via xmp_version="1".
 *
 * MAPPING LOGIC (temperature):
 *   darktable's temperature module REPLACES the camera's as-shot WB
 *   coefficients entirely. So if we write a slider-tuned (1,1,1) on top
 *   of a camera that has WB (2.65, 1, 1.62) (typical Sony daylight),
 *   the result looks GREEN — because (1,1,1) means G=1 normalized
 *   light, while R=2.65x under-amplifies and B=1.62x over-amplifies
 *   relative to G=1.
 *
 *   Fix: read the camera's auto-WB coeffs from the RAW EXIF, then
 *   multiply them by the slider-derived shift factor. So:
 *     final_R = camAutoR * (1 + deltaK * R_K)
 *     final_B = camAutoB * (1 - deltaK * B_K)
 *     final_G2 = 1 + tint * TINT_K  (g2 is a tint/emerald knob, not WB)
 *
 *   For RAW files where we can't read auto-WB (rare, non-DNG with no
 *   matched preset), we fall back to D65 baseline (1, 1, 1) which
 *   produces sensible output for cameras close to daylight.
 *
 * KELVIN → shift multiplier calibration:
 *   1000K of delta from 5500K → R_K = 0.15 multiplier on top of camAuto
 *   (subtle at ±500K, strong at ±2000K).  This is a SLIDER MULTIPLIER;
 *   the resulting XMP coeffs land in the correct range for darktable's
 *   chromatic adaptation transform.
 *
 * MAPPING LOGIC (lens):
 *   darktable-cli does NOT auto-apply lens corrections unless the lens
 *   module is in the XMP history. We use method=embedded metadata (0)
 *   which reads the camera's lens profile from the RAW EXIF (DNG/ARW/CR2
 *   all embed lensfun-style distortion/vignetting/TCA data). The
 *   `cor_dist_ft` and `cor_vig_ft` fine-tune multipliers default to 1.0
 *   (= exactly what EXIF says). Toggle via `lens_on` slider.
 *
 * MAPPING LOGIC (denoise):
 *   darktable's NLMeans module (non-profiled, simpler than denoiseprofile)
 *   has explicit luma and chroma sliders. Our `nr_lum` (0-100) maps to
 *   `luma = lum / 100`, `nr_chroma` (0-100) maps to `chroma = chroma / 100`.
 *   radius and strength use sensible defaults (2.0, 50.0).
 *   modversion = 2, struct = 4 floats (16 bytes).
 */

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
const execFileP = promisify(execFile);

// In-memory cache for exiftool results. Keyed by `${path}:${mtime}:${size}`
// so cache invalidates naturally when the RAW file is replaced.
const wbCache = new Map<string, { r: number; g: number; b: number; source: string }>();

/**
 * Read the camera's auto/daylight WB coefficients from a RAW file's EXIF.
 *
 * CACHED by file fingerprint (path + mtime + size). Repeated calls within
 * the same Node process skip the exiftool shell-out (~50-200ms saved).
 * Cache invalidates automatically when the file changes.
 *
 * (See full docstring at top of file.)
 */
export async function readCameraWb(rawPath: string): Promise<{ r: number; g: number; b: number; source: string }> {
  // Check cache first
  try {
    const st = await stat(rawPath);
    const key = `${rawPath}:${st.mtimeMs}:${st.size}`;
    const cached = wbCache.get(key);
    if (cached) return cached;
    // Compute and store under this key
    const result = await computeWb(rawPath);
    wbCache.set(key, result);
    return result;
  } catch (e) {
    // stat failed — fall through to uncached compute
    return computeWb(rawPath);
  }
}

async function computeWb(rawPath: string): Promise<{ r: number; g: number; b: number; source: string }> {
  try {
    const { stdout } = await execFileP('exiftool', [
      '-j', '-n', rawPath,
      '-WB_RGGBLevelsAuto', '-WB_RGGBLevels',
      '-WB_RGBLevelsAuto',
      '-WB_RGBLevelsDaylight', '-WB_RGBLevels6',
      '-WB_RGBLevels1',
      '-WhiteBalance',
    ], { timeout: 10000 });
    const data = JSON.parse(stdout);
    const tags = data[0] || {};

    const parseNums = (s: string | number[] | undefined): number[] => {
      if (!s) return [];
      if (Array.isArray(s)) return s;
      return String(s).trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    };

    // 1. RGGB auto (R G G B)
    const rggbAuto = parseNums(tags.WB_RGGBLevelsAuto || tags.WB_RGGBLevels);
    if (rggbAuto.length === 4 && rggbAuto.every(n => n > 0)) {
      const [r, g, , b] = rggbAuto;
      return { r: r / g, g: 1.0, b: b / g, source: 'RGGBLevelsAuto' };
    }

    // 2. RGB triplet
    const rgbCandidates: Array<[string, string]> = [
      ['WB_RGBLevelsAuto', 'WB_RGBLevelsAuto'],
      ['WB_RGBLevelsDaylight', 'WB_RGBLevelsDaylight'],
      ['WB_RGBLevels6', 'WB_RGBLevels6 (D55)'],
      ['WB_RGBLevels1', 'WB_RGBLevels1 (FineWeather)'],
    ];
    for (const [key, label] of rgbCandidates) {
      const v = parseNums(tags[key]);
      if (v.length >= 3 && v.every(n => n > 0)) {
        const [r, g, b] = v;
        return { r: r / g, g: 1.0, b: b / g, source: label };
      }
    }

    return { r: 1.0, g: 1.0, b: 1.0, source: 'fallback D65' };
  } catch (e) {
    return { r: 1.0, g: 1.0, b: 1.0, source: 'fallback D65 (err)' };
  }
}

// Calibration constants
const R_K = 0.15;
const B_K = 0.15;
const TINT_K = 0.005;

/** Compute 16-byte temperature params (LE: red, green, blue, g2). modversion=3. */
export function temperatureParams(
  kelvin: number,
  tint: number,
  baseline: { r: number; g: number; b: number }
): Buffer {
  const deltaK = (kelvin - 5500) / 1000;
  const red = clamp(baseline.r * (1 + deltaK * R_K), 0.1, 12);
  const blue = clamp(baseline.b * (1 - deltaK * B_K), 0.1, 12);
  const green = baseline.g;
  const g2 = clamp(1.0 + tint * TINT_K, 0.4, 4);

  const buf = Buffer.alloc(16);
  buf.writeFloatLE(red, 0);
  buf.writeFloatLE(green, 4);
  buf.writeFloatLE(blue, 8);
  buf.writeFloatLE(g2, 12);
  return buf;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Empty-combo blendop_params (full-opacity, no mask). Default for new modules.
const EMPTY_BLENDOP = 'gz12eJxjYGBgkGAAgRNODESDBnsIHll8ANNSGQM=';

function v1HistoryItem(opts: {
  op: string;
  modversion: number;
  params: Buffer;
}): { op: string; modversion: number; paramsHex: string } {
  return {
    op: opts.op,
    modversion: opts.modversion,
    paramsHex: opts.params.toString('hex'),
  };
}

/**
 * Render the per-row history fields as ONE block per field with N lis
 * (v1 XMP requires single-element-per-field, with N lis matching N modules).
 */
function renderV1HistoryBlocks(items: Array<{ op: string; modversion: number; paramsHex: string }>): string {
  const mods = items.map(i => `<rdf:li>${i.modversion}</rdf:li>`).join('');
  const ops = items.map(i => `<rdf:li>${i.op}</rdf:li>`).join('');
  const params = items.map(i => `<rdf:li>${i.paramsHex}</rdf:li>`).join('');
  const enabled = items.map(() => '<rdf:li>1</rdf:li>').join('');
  const blendop = items.map(() => `<rdf:li>${EMPTY_BLENDOP}</rdf:li>`).join('');
  const blendVer = items.map(() => '<rdf:li>9</rdf:li>').join('');
  const prio = items.map(() => '<rdf:li>0</rdf:li>').join('');
  const name = items.map(() => '<rdf:li></rdf:li>').join('');

  return `<darktable:history_modversion><rdf:Seq>${mods}</rdf:Seq></darktable:history_modversion>
      <darktable:history_operation><rdf:Seq>${ops}</rdf:Seq></darktable:history_operation>
      <darktable:history_params><rdf:Seq>${params}</rdf:Seq></darktable:history_params>
      <darktable:history_enabled><rdf:Seq>${enabled}</rdf:Seq></darktable:history_enabled>
      <darktable:blendop_params><rdf:Seq>${blendop}</rdf:Seq></darktable:blendop_params>
      <darktable:blendop_version><rdf:Seq>${blendVer}</rdf:Seq></darktable:blendop_version>
      <darktable:multi_priority><rdf:Seq>${prio}</rdf:Seq></darktable:multi_priority>
      <darktable:multi_name><rdf:Seq>${name}</rdf:Seq></darktable:multi_name>`;
}

/**
 * Compute lens params (modversion=6).
 *
 * Struct layout (dt_iop_lens_params_t, darktable 4.2.1):
 *   int method, modify_flags, inverse, target_geom      (16 bytes)
 *   float scale, crop, focal, aperture, distance         (20 bytes)
 *   char camera[128]                                     (128 bytes)
 *   char lens[128]                                       (128 bytes)
 *   int tca_override, modified                           (8 bytes)
 *   float tca_r, tca_b                                   (8 bytes)
 *   float cor_dist_ft, cor_vig_ft                        (8 bytes)
 *   Total: 316 bytes
 *
 * For method=embedded metadata, we just need method=0 and the fine-tune
 * floats (cor_dist_ft, cor_vig_ft) at 1.0 (no modification). modify_flags
 * tells darktable which corrections to apply from the EXIF (distortion +
 * vignetting + TCA = 7 = ALL).
 */
export function lensParams(opts: {
  lens_on: boolean;
}): Buffer {
  const buf = Buffer.alloc(316);
  let off = 0;
  // method = 0 (embedded metadata)
  buf.writeInt32LE(0, off); off += 4;
  // modify_flags = 7 (DISTORTION|VIGNETTING|TCA = all from EXIF)
  const modifyFlags = opts.lens_on ? 7 : 0;
  buf.writeInt32LE(modifyFlags, off); off += 4;
  // inverse = 0
  buf.writeInt32LE(0, off); off += 4;
  // scale = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  // crop = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  // focal = 0 (use EXIF)
  buf.writeFloatLE(0, off); off += 4;
  // aperture = 0
  buf.writeFloatLE(0, off); off += 4;
  // distance = 0
  buf.writeFloatLE(0, off); off += 4;
  // target_geom = 1 (RECTILINEAR)
  buf.writeInt32LE(1, off); off += 4;
  // camera[128] — leave as NULs (empty)
  off += 128;
  // lens[128] — leave as NULs
  off += 128;
  // tca_override = 0 (FALSE)
  buf.writeInt32LE(0, off); off += 4;
  // tca_r = 1.0, tca_b = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  buf.writeFloatLE(1.0, off); off += 4;
  // cor_dist_ft = 1.0 (no fine-tune)
  buf.writeFloatLE(1.0, off); off += 4;
  // cor_vig_ft = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  // modified = 1 (user explicitly set this — needed to override auto-detect)
  buf.writeInt32LE(1, off); off += 4;
  return buf;
}

/**
 * Compute NLMeans (non-profiled denoise) params (modversion=2, 16 bytes).
 *
 * Struct layout (dt_iop_nlmeans_params_t, darktable 4.2.1):
 *   float radius     // patch size, default 2.0
 *   float strength   // overall strength, default 50.0
 *   float luma       // 0..1, default 0.5
 *   float chroma     // 0..1, default 1.0
 *
 * Mapping:
 *   luma = clamp(lum / 100, 0, 1)   (user 0..100 slider)
 *   chroma = clamp(chroma / 100, 0, 1)
 */
export function nlmeansParams(opts: {
  nr_lum: number;    // 0-100 slider
  nr_chroma: number; // 0-100 slider
}): Buffer {
  const buf = Buffer.alloc(16);
  // radius = 2.0 (default)
  buf.writeFloatLE(2.0, 0);
  // strength = 50.0 (default)
  buf.writeFloatLE(50.0, 4);
  // luma = slider / 100
  buf.writeFloatLE(clamp(opts.nr_lum / 100, 0, 1), 8);
  // chroma = slider / 100
  buf.writeFloatLE(clamp(opts.nr_chroma / 100, 0, 1), 12);
  return buf;
}

/**
 * Compute colorbalance params (modversion=3, 68 bytes).
 *
 * Struct layout (dt_iop_colorbalance_params_t, darktable 4.2.1):
 *   dt_iop_colorbalance_mode_t mode (int, 4 bytes) — default SLOPE_OFFSET_POWER=1
 *   float lift[4]   (16 bytes) — CHANNEL_SIZE = {FACTOR, RED, GREEN, BLUE}
 *   float gamma[4]  (16 bytes)
 *   float gain[4]   (16 bytes)
 *   float saturation, contrast, grey, saturation_out (4×4 = 16 bytes)
 *   Total: 68 bytes
 *
 * Used to add dramatic WB shifts ON TOP of the temperature module.
 * Temperature's chromatic adaptation dampens extreme shifts; colorbalance
 * in SLOPE_OFFSET_POWER mode provides pure multiplicative gain per channel
 * (no chromatic adaptation) — the right tool for dramatic creative shifts.
 *
 * Mapping (additive on top of temperature):
 *   gain[R] = 1 + deltaK * 0.30  (warm boosts red, cool reduces red)
 *   gain[B] = 1 - deltaK * 0.30  (warm reduces blue, cool boosts blue)
 *   gain[G] = gain[FACTOR] = 1.0 (neutral)
 *   lift, gamma, saturation, contrast, grey, saturation_out = defaults
 */
export function colorbalanceParams(opts: {
  kelvin: number;
}): Buffer {
  const buf = Buffer.alloc(68);
  const deltaK = (opts.kelvin - 5500) / 1000;
  // mode = SLOPE_OFFSET_POWER (1)
  buf.writeInt32LE(1, 0);
  // lift[4] = FACTOR=1, RED=1, GREEN=1, BLUE=1
  buf.writeFloatLE(1.0, 4);
  buf.writeFloatLE(1.0, 8);
  buf.writeFloatLE(1.0, 12);
  buf.writeFloatLE(1.0, 16);
  // gamma[4] = 1, 1, 1, 1
  buf.writeFloatLE(1.0, 20);
  buf.writeFloatLE(1.0, 24);
  buf.writeFloatLE(1.0, 28);
  buf.writeFloatLE(1.0, 32);
  // gain[4]: FACTOR=1, RED = 1 + deltaK*0.30, GREEN = 1, BLUE = 1 - deltaK*0.30
  buf.writeFloatLE(1.0, 36);
  buf.writeFloatLE(clamp(1 + deltaK * 0.30, 0.1, 4), 40);
  buf.writeFloatLE(1.0, 44);
  buf.writeFloatLE(clamp(1 - deltaK * 0.30, 0.1, 4), 48);
  // saturation = 1.0
  buf.writeFloatLE(1.0, 52);
  // contrast = 1.0
  buf.writeFloatLE(1.0, 56);
  // grey = 18.0 (default)
  buf.writeFloatLE(18.0, 60);
  // saturation_out = 1.0
  buf.writeFloatLE(1.0, 64);
  return buf;
}

export interface DarktableXmpOptions {
  kelvin?: number;        // colour temperature (default 5500 = neutral)
  tint?: number;          // ±100 slider (default 0)
  baseline: { r: number; g: number; b: number };  // camera WB from EXIF
  lens_on?: boolean;      // 1 = enable embedded-metadata lens correction
  nr_lum?: number;        // 0-100 denoise luminance
  nr_chroma?: number;     // 0-100 denoise chroma
}

/**
 * Build a darktable 4.2.1 XMP sidecar string in v1 format.
 *
 * Modules in pipeline order:
 *   1. temperature (ALWAYS — its params include the baseline coeffs so
 *      the neutral-state render matches auto-WB; without it darktable
 *      does NOT apply any WB and the image is unprocessed greenish raw).
 *   2. lens (CONDITIONAL — only when lens_on=true; emitting it with
 *      modify_flags=0 has no effect, but we skip it to keep XMP clean).
 *   3. denoiseprofile (CONDITIONAL — only when nr_lum+nr_chroma > 0;
 *      at strength=1.0 without a noise profile it produces a noticeable
 *      blur, so the neutral-state should NOT include it).
 */
export function buildDarktableXmp(opts: DarktableXmpOptions): string {
  const kelvin = opts.kelvin ?? 5500;
  const tint = opts.tint ?? 0;
  const lensOn = opts.lens_on ?? false;
  const nrLum = opts.nr_lum ?? 0;
  const nrChroma = opts.nr_chroma ?? 0;

  // Build modules list (in iop_order)
  const modules: Array<{ op: string; modversion: number; params: Buffer }> = [];
  const iopOrderNames: string[] = [];

  // Temperature: ALWAYS
  modules.push({
    op: 'temperature',
    modversion: 3,
    params: temperatureParams(kelvin, tint, opts.baseline),
  });
  iopOrderNames.push('temperature');

  // Colorbalance: only when WB shift is dramatic (|deltaK| > 0.5)
  // — adds multiplicative gain on top of temperature's chromatic
  // adaptation. Provides the "extra drama" for users wanting bold
  // sunset/sunrise looks that the temperature module alone can't
  // deliver due to its white-point preservation.
  const deltaK = (kelvin - 5500) / 1000;
  if (Math.abs(deltaK) > 0.5) {
    modules.push({
      op: 'colorbalance',
      modversion: 3,
      params: colorbalanceParams({ kelvin }),
    });
    iopOrderNames.push('colorbalance');
  }

  // Lens: only if lens_on
  if (lensOn) {
    modules.push({
      op: 'lens',
      modversion: 6,
      params: lensParams({ lens_on: true }),
    });
    iopOrderNames.push('lens');
  }

  // Denoise (NLMeans): only if at least one slider is non-zero
  if (nrLum > 0 || nrChroma > 0) {
    modules.push({
      op: 'nlmeans',
      modversion: 2,
      params: nlmeansParams({ nr_lum: nrLum, nr_chroma: nrChroma }),
    });
    iopOrderNames.push('nlmeans');
  }

  const items = modules.map(m => v1HistoryItem(m));
  const historyBlocks = renderV1HistoryBlocks(items);
  const historyEnd = modules.length;
  const historyLis = modules.map(m => `<rdf:li>${m.op}</rdf:li>`).join('');
  const iopLis = iopOrderNames.map(n => `<rdf:li>${n}</rdf:li>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns/meta/" xmlns:darktable="http://darktable.sf.net/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" x:xmptk="XMP Core 4.4.0-Exiv2">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmp:Rating="0" darktable:xmp_version="1" darktable:auto_presets_applied="1" darktable:history_end="${historyEnd}">
      <darktable:history><rdf:Seq>${historyLis}</rdf:Seq></darktable:history>
      ${historyBlocks}
      <darktable:iop_order><rdf:Seq>${iopLis}</rdf:Seq></darktable:iop_order>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
`;
}

// ----- quick verification helper -----
if (process.argv[1] && process.argv[1].endsWith('darktable-xmp.ts')) {
  const out = buildDarktableXmp({
    kelvin: 5500,
    tint: 0,
    baseline: { r: 2.65, g: 1.0, b: 1.62 },
    lens_on: true,
    nr_lum: 50,
    nr_chroma: 30,
  });
  process.stdout.write(out);
}
