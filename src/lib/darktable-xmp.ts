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
 *   - lensfun: ✅ WIRED — method=embedded metadata, modify_flags=ALL.
 *   - denoiseprofile: ✅ WIRED — strength scaled by lum+chroma.
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
 *   darktable's denoiseprofile module has a `strength` param that controls
 *   overall denoise intensity (1.0 = default = neutral, higher = more
 *   denoise). The user's `nr_lum` (0-100) and `nr_chroma` (0-100) sliders
 *   are both mapped to `strength`:
 *     strength = 1.0 + (nr_lum + nr_chroma) / 100 * 1.5
 *   Range: 1.0 (no sliders) → 4.0 (both at max). At 0 sliders, this
 *   matches darktable's default behaviour exactly.
 */

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

/**
 * Read the camera's auto/daylight WB coefficients from a RAW file's EXIF.
 * (See full docstring at top of file.)
 */
export async function readCameraWb(rawPath: string): Promise<{ r: number; g: number; b: number; source: string }> {
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
 * Compute denoise params (modversion=11, ~412 bytes).
 *
 * Struct layout (dt_iop_denoiseprofile_params_t, darktable 4.2.1):
 *   float radius, nbhood, strength, shadows, bias, scattering,
 *         central_pixel_weight, overshooting         (32 bytes)
 *   float a[3], b[3]                                  (24 bytes)
 *   int mode (dt_iop_denoiseprofile_mode_t)           (4 bytes)
 *   float x[6][7], y[6][7]                            (336 bytes)
 *   int wb_adaptive_anscombe, fix_anscombe_and_nlmeans_norm,
 *       use_new_vst, wavelet_color_mode               (16 bytes)
 *   Total: 412 bytes
 */
export function denoiseParams(opts: {
  nr_lum: number;    // 0-100 slider
  nr_chroma: number; // 0-100 slider
}): Buffer {
  const buf = Buffer.alloc(412);
  let off = 0;
  // radius = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  // nbhood = 7.0
  buf.writeFloatLE(7.0, off); off += 4;
  // strength = 1.0 + (lum+chroma)/100 * 1.5
  const strength = 1.0 + ((opts.nr_lum + opts.nr_chroma) / 100) * 1.5;
  buf.writeFloatLE(clamp(strength, 0.001, 100), off); off += 4;
  // shadows = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  // bias = 0.0
  buf.writeFloatLE(0.0, off); off += 4;
  // scattering = 0.0
  buf.writeFloatLE(0.0, off); off += 4;
  // central_pixel_weight = 0.1
  buf.writeFloatLE(0.1, off); off += 4;
  // overshooting = 1.0
  buf.writeFloatLE(1.0, off); off += 4;
  // a[3] = 1,1,1
  buf.writeFloatLE(1.0, off); off += 4;
  buf.writeFloatLE(1.0, off); off += 4;
  buf.writeFloatLE(1.0, off); off += 4;
  // b[3] = 0,0,0
  buf.writeFloatLE(0, off); off += 4;
  buf.writeFloatLE(0, off); off += 4;
  buf.writeFloatLE(0, off); off += 4;
  // mode = MODE_WAVELETS (1)
  buf.writeInt32LE(1, off); off += 4;
  // x[6][7] = 0 (84 floats)
  for (let i = 0; i < 6 * 7; i++) { buf.writeFloatLE(0, off); off += 4; }
  // y[6][7] = 0.5 (default per struct doc)
  for (let i = 0; i < 6 * 7; i++) { buf.writeFloatLE(0.5, off); off += 4; }
  // wb_adaptive_anscombe = TRUE (1)
  buf.writeInt32LE(1, off); off += 4;
  // fix_anscombe_and_nlmeans_norm = TRUE (1)
  buf.writeInt32LE(1, off); off += 4;
  // use_new_vst = TRUE (1)
  buf.writeInt32LE(1, off); off += 4;
  // wavelet_color_mode = MODE_Y0U0V0 (1)
  buf.writeInt32LE(1, off); off += 4;
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

  // Lens: only if lens_on
  if (lensOn) {
    modules.push({
      op: 'lens',
      modversion: 6,
      params: lensParams({ lens_on: true }),
    });
    iopOrderNames.push('lens');
  }

  // Denoise: only if at least one slider is non-zero
  if (nrLum > 0 || nrChroma > 0) {
    modules.push({
      op: 'denoiseprofile',
      modversion: 11,
      params: denoiseParams({ nr_lum: nrLum, nr_chroma: nrChroma }),
    });
    iopOrderNames.push('denoiseprofile');
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
