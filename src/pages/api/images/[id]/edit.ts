/**
 * POST /api/images/:id/edit — save a non-destructive edit for an image.
 *
 * Accepts TWO body formats:
 *
 *   (1) multipart/form-data (legacy WebGL editor flow):
 *       file:    rendered JPEG blob
 *       params:  JSON string of edit params
 *
 *   (2) application/json (Canvas 2D editor + future server-side pipeline):
 *       { params: { exposure, contrast, brightness, ... }, sourceUrl? }
 *       Server reads the original file, applies the same operations via
 *       sharp (.modulate, .linear, .tint, .extract), writes the rendered
 *       JPEG to /uploads/edits/{image-id}/edit-{ts}.jpg, persists row.
 *
 * Original file is preserved either way.
 *
 * Response: { edit: { id, path, url, params, created_at } }
 *
 * Auth: admin only.
 */
import type { APIRoute } from 'astro';
import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from "sharp";
import { promisify } from "node:util";
import { execFile as execFileCb } from 'node:child_process';
const execFile = promisify(execFileCb);
import { getLutById, getLutData, applyLutToRgba } from '../../../../lib/luts';
import { getImage } from '../../../../lib/db';
import {
  insertImageEdit,
  getLatestImageEdit,
  listImageEdits,
  deleteAllImageEdits,
} from '../../../../lib/db-image-edits';
import { readAdminSession } from '../../../../lib/auth';
import { imgproxyUrl } from '../../../../lib/imgproxy';
import { buildDarktableXmp, readCameraWb } from '../../../../lib/darktable-xmp';
import { applyHslToRgb, applyColorGradingToRgb, isHslFlat } from '../../../../lib/hsl';
import {
  applySplitToningToRgb, isSplitToningFlat,
  applyGrainToRgb, isGrainFlat,
  isLensCorrectionsFlat, isCalibrationFlat,
  applyHighlightsShadowsWhitesBlacksToRgb, isHighlightsShadowsWhitesBlacksFlat,
  applyToneCurveToRgb, isToneCurveFlat, buildCurveLut,
} from "../../../../lib/effects";

export const prerender = false;

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

function unauthorized() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });
}
function badRequest(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
}

/**
 * Render the original file with the given params applied via sharp.
 * Returns the rendered JPEG buffer + the crop coordinates in source pixels
 * (so the DB row knows what crop was applied, for re-editing).
 */
async function renderWithSharp(originalPath: string, params: any): Promise<{ buf: Buffer; appliedCrop: any | null }> {
  const img = sharp(originalPath, { failOn: 'none' }).rotate(); // honour EXIF orientation
  const meta = await img.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;

  let pipeline = img;

  // ---- Straighten (rotation) BEFORE crop, so crop UVs are in the
  // rotated frame. The WebGL preview applies rotateUv() first, then the
  // crop window. Matching that order on the server keeps the saved image
  // in the same orientation as the preview.
  const straightenAngle = Number(params.straighten) || 0;
  if (Math.abs(straightenAngle) > 0.01) {
    // Sharp's .rotate() takes degrees, positive = clockwise (CCW in image
    // space because Y is flipped). The WebGL rotateUv() rotates UV around
    // (0.5, 0.5) by the angle (CCW for positive angle in screen space).
    // Sharp's rotate() convention: degrees clockwise from the original.
    // Both produce the same image rotation when angle is treated as
    // degrees-of-rotation in the same direction the user sees.
    pipeline = pipeline.rotate(straightenAngle, { background: { r: 0, g: 0, b: 0, alpha: 1 } });
  }

  // ---- Crop first (UV space 0..1, in the straightened frame) ----
  let appliedCrop: any | null = null;
  if (params.crop && W && H) {
    const left = Math.max(0, Math.round(params.crop.x * W));
    const top = Math.max(0, Math.round(params.crop.y * H));
    const width = Math.max(1, Math.min(W - left, Math.round(params.crop.w * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(params.crop.h * H)));
    pipeline = pipeline.extract({ left, top, width, height });
    appliedCrop = { left, top, width, height };
  }

  // ---- Adjustments ----
  // Sliders (exposure, brightness, contrast, saturation, temp, tint) are
  // applied in the per-pixel loop below using the SAME RGB-space math as
  // the WebGL shader in editor-gl.ts. Sharp's .modulate()/.linear()/.tint()
  // operate in HSL-space and produce visibly different output, so we
  // cannot use them — they made the saved image ~40 RGB units darker than
  // the canvas preview on warm/muted brick pixels, which Daz perceived as
  // "saved image turned B&W". The pixel-level RGB math matches the canvas
  // exactly.
  const exposure = Number(params.exposure) || 0;
  const brightness = Number(params.brightness) || 0;
  const saturation = Number(params.saturation) || 0;
  const contrast = Number(params.contrast) || 0;
  const temp = Number(params.temp) || 0;
  const tint = Number(params.tint) || 0;

  // slidersNeedProcessing: true if any slider is non-zero (forces pixel loop)
  const slidersNeedProcessing =
    exposure !== 0 || brightness !== 0 || contrast !== 0 ||
    saturation !== 0 || temp !== 0 || tint !== 0;

  const sharpen = Number(params.sharpen) || 0;       // 0..100
  if (sharpen > 0) {
    // 0 → no-op, 50 → sigma=1 (light), 100 → sigma=3 (strong)
    const sigma = Math.max(0.5, (sharpen / 100) * 3);
    pipeline = pipeline.sharpen({ sigma, m1: 1, m2: 1 });
  }

  // ---- Vignette applied AFTER LUT pass (matches WebGL preview order:
  // sliders → LUT → vignette). Old position darkened the LUT result by
  // multiplying with the mask, which made the saved image noticeably dimmer
  // than the preview when both LUT and heavy vignette were active.

  // ---- HSL Color Mixer + Color Grading (pixel-level) ----
  // Build HSL data from params
  const RANGES = ['red','orange','yellow','green','aqua','blue','purple','magenta'];
  const hslData: Record<string, {h:number; s:number; l:number}> = {};
  for (const range of RANGES) {
    const key = 'hsl_' + range;
    hslData[key] = params[key] ?? { h: 0, s: 0, l: 0 };
  }
  const colorGradingParams = {
    shadows_colour: params.cg_shadows_colour ?? [0, 0, 0],
    midtones_colour: params.cg_midtones_colour ?? [0, 0, 0],
    highlights_colour: params.cg_highlights_colour ?? [0, 0, 0],
    global_colour: params.cg_global_colour ?? [0, 0, 0],
    shadows_intensity: params.cg_shadows_intensity ?? 0,
    midtones_intensity: params.cg_midtones_intensity ?? 0,
    highlights_intensity: params.cg_highlights_intensity ?? 0,
    global_intensity: params.cg_global_intensity ?? 0,
    mode: params.cg_mode ?? 'saturation',
  };

  const hslNeedsProcessing = !isHslFlat(hslData);
  const cgNeedsProcessing =
    (colorGradingParams.shadows_intensity > 0 ||
     colorGradingParams.midtones_intensity > 0 ||
     colorGradingParams.highlights_intensity > 0 ||
     colorGradingParams.global_intensity > 0);

  const splitToningParams = {
    shadows_hue: Number(params.st_shadows_hue) || 0,
    shadows_saturation: Number(params.st_shadows_saturation) || 0,
    highlights_hue: Number(params.st_highlights_hue) || 0,
    highlights_saturation: Number(params.st_highlights_saturation) || 0,
    balance: Number(params.st_balance) || 0,
  };
  const grainParams = {
    amount: Number(params.grain_amount) || 0,
    size: Number(params.grain_size) || 25,
  };
  const dehazeVal = Number(params.dehaze) || 0;

  const stNeedsProcessing = !isSplitToningFlat(splitToningParams);
  const grainNeedsProcessing = !isGrainFlat(grainParams);

  // Highlights / Shadows / Whites / Blacks (basic panel sliders)
  const hswbParams = {
    highlights: Number(params.highlights) || 0,
    shadows: Number(params.shadows) || 0,
    whites: Number(params.whites) || 0,
    blacks: Number(params.blacks) || 0,
  };
  const hswbNeedsProcessing = !isHighlightsShadowsWhitesBlacksFlat(hswbParams);

  // Tone Curve (params.curve = { rgb: [[x,y]...], r: [...], g: [...], b: [...] })
  const curveParams = params.curve || null;
  const curveNeedsProcessing = !isToneCurveFlat(curveParams);
  let lutRgb: Float32Array | null = null;
  let lutR: Float32Array | null = null;
  let lutG: Float32Array | null = null;
  let lutB: Float32Array | null = null;
  if (curveNeedsProcessing) {
    lutRgb = buildCurveLut(curveParams!.rgb);
    lutR   = buildCurveLut(curveParams!.r);
    lutG   = buildCurveLut(curveParams!.g);
    lutB   = buildCurveLut(curveParams!.b);
  }

  // Lens corrections (baseline exposure + CA)
  const lensCorrectionsParams: LensCorrectionsData = params.lens_corrections || {};
  const needsLensCorrectionsPipeline = !isLensCorrectionsFlat(lensCorrectionsParams);

  // Calibration (shadow tint + saturation)
  const calibrationParams: CalibrationData = params.calibration || {};
  const calNeedsProcessing = !isCalibrationFlat(calibrationParams);

  // Spot removals (applied after everything)
  const spotRemovals: SpotRemoval[] = params.spot_removals || [];

  // Sliders MUST go through the per-pixel loop too (RGB-space math,
  // not Sharp's HSL-space modulate). Otherwise the slider values are
  // silently skipped for presets that only adjust sliders + LUT.
  const needsPixelLoop = hslNeedsProcessing || cgNeedsProcessing || stNeedsProcessing || grainNeedsProcessing || dehazeVal !== 0 || calNeedsProcessing || hswbNeedsProcessing || curveNeedsProcessing || slidersNeedProcessing;

  // Apply lens corrections (baseline exposure + CA) before pixel loop
  if (needsLensCorrectionsPipeline) {
    const cropMeta = await pipeline.metadata();
    const lcW = cropMeta.width || 1;
    const lcH = cropMeta.height || 1;
    pipeline = await applyLensCorrectionsPipeline(pipeline, lensCorrectionsParams, lcW, lcH);
  }

  if (needsPixelLoop) {
    const rgba = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = rgba;
    const pxCount = info.width * info.height;
    const timeMs = Date.now();
    for (let i = 0; i < pxCount; i++) {
      const base = i * 4;
      const x = i % info.width;
      const y = Math.floor(i / info.width);
      let r = data[base], g = data[base + 1], b = data[base + 2];

      // ---- Sliders (RGB-space math, matches editor-gl.ts shader exactly) ----
      // Order: exposure → brightness → contrast → saturation → temp → tint.
      // Must come BEFORE HSWB / HSL / CG / dehaze / ST / curve so the
      // downstream passes see the slider-adjusted pixel.
      if (slidersNeedProcessing) {
        // Convert to 0..1
        let cr = r / 255, cg = g / 255, cb = b / 255;
        // Exposure (multiplicative)
        const expF = Math.pow(2, exposure / 100);
        cr *= expF; cg *= expF; cb *= expF;
        // Brightness (multiplicative scale around 1.0)
        const bMul = 1 + brightness / 100;
        cr *= bMul; cg *= bMul; cb *= bMul;
        // Contrast (linear stretch around 0.5)
        const cF = (100 + contrast) / 100;
        cr = (cr - 0.5) * cF + 0.5;
        cg = (cg - 0.5) * cF + 0.5;
        cb = (cb - 0.5) * cF + 0.5;
        cr = Math.max(0, Math.min(1, cr));
        cg = Math.max(0, Math.min(1, cg));
        cb = Math.max(0, Math.min(1, cb));
        // Saturation (mix with luminance grey at satFactor=0)
        const luma = 0.299 * cr + 0.587 * cg + 0.114 * cb;
        const sF = Math.max(0, 1 + saturation / 100);
        cr = luma + (cr - luma) * sF;
        cg = luma + (cg - luma) * sF;
        cb = luma + (cb - luma) * sF;
        // Temp (warm/cool): R opposite B
        const tempShift = temp / 100 * 0.15;
        cr += tempShift;
        cb -= tempShift;
        // Tint (magenta/green): R+G opposite B
        const tintShift = tint / 100 * 0.1;
        cr += tintShift * 0.5;
        cg += tintShift * 0.5;
        cb -= tintShift;
        // Clamp + back to 0..255
        cr = Math.max(0, Math.min(1, cr));
        cg = Math.max(0, Math.min(1, cg));
        cb = Math.max(0, Math.min(1, cb));
        r = Math.round(cr * 255);
        g = Math.round(cg * 255);
        b = Math.round(cb * 255);
      }

      // Highlights / Shadows / Whites / Blacks first — operates on raw
      // luminance from the slider pass. Must come before tone curve so
      // the curve sees the tone-region-adjusted pixel.
      if (hswbNeedsProcessing) {
        [r, g, b] = applyHighlightsShadowsWhitesBlacksToRgb(r, g, b, hswbParams);
      }
      if (hslNeedsProcessing) {
        [r, g, b] = applyHslToRgb(r, g, b, hslData);
      }
      if (cgNeedsProcessing) {
        [r, g, b] = applyColorGradingToRgb(r, g, b, colorGradingParams);
      }
      if (dehazeVal !== 0) {
        const haze = Math.min(r, Math.min(g, b));
        const amount = dehazeVal * 0.003 * haze;
        r = Math.max(0, r - amount);
        g = Math.max(0, g - amount);
        b = Math.max(0, b - amount);
      }
      if (stNeedsProcessing) {
        [r, g, b] = applySplitToningToRgb(r, g, b, splitToningParams);
      }
      // Tone curve — applied after H/S/W/B + colour ops so the curve
      // sees the post-region-adjusted pixel. Matches the WebGL pipeline
      // order (Pass 2 = curve, after Pass 1 sliders).
      if (curveNeedsProcessing) {
        [r, g, b] = applyToneCurveToRgb(r, g, b, curveParams!, lutRgb!, lutR!, lutG!, lutB!);
      }
      if (grainNeedsProcessing) {
        [r, g, b] = applyGrainToRgb(r, g, b, grainParams, x, y, timeMs);
      }
      if (calNeedsProcessing) {
        [r, g, b] = applyCalibrationToRgb(r, g, b, calibrationParams);
      }
      data[base] = r; data[base + 1] = g; data[base + 2] = b;
    }
    // Sample data AFTER modification - distributed across image
    // Apply spot removals after all other pixel processing
    if (spotRemovals.length > 0) {
      applySpotRemovalsToBuffer(data, info.width, info.height, spotRemovals);
    }

    pipeline = sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 },
    });
  }

  // ---- LUT pass (after all colour ops) ----
  // LUTs apply last because they're holistic colour-grading transforms.
  // Trilinear interp gives smooth gradients; nearest is faster but bands.
  // We use trilinear on the server (one-off, full res is fine).
  const lutId = Number(params.lut_id) || 0;
  const lutIntensity = Math.max(0, Math.min(100, Number(params.lut_intensity) || 0));
  let appliedLut: { id: number; name: string; intensity: number } | null = null;
  if (lutId > 0 && lutIntensity > 0) {
    const lutRow = getLutById(lutId);
    if (lutRow && lutRow.enabled_global) {
      const lut = getLutData(lutRow);
      // Pull RGBA at full resolution, apply LUT in place, re-encode.
      const rgba = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      applyLutToRgba(lut.size, lut.data, rgba.data, lutIntensity / 100, false);
      pipeline = sharp(rgba.data, {
        raw: { width: rgba.info.width, height: rgba.info.height, channels: 4 },
      });
      appliedLut = { id: lutRow.id, name: lutRow.name, intensity: lutIntensity };
      const afterLutMeta = await pipeline.metadata();
    }

  // ---- Vignette (applied AFTER LUT, matching WebGL preview order) ----

  const vignette = Number(params.vignette) || 0;     // 0..100
  if (vignette > 0) {
    // Build a radial grayscale mask and composite via `multiply`.
    //
    // Why raw RGB and not SVG: the previous SVG-radialGradient approach went
    // through librsvg and was rendering INVERTED — centre came out solid
    // black and corners barely tinted. Multiplied, that turned the centre of
    // the saved image into a black rectangle ("vignetted box at centre")
    // while leaving the corners alone. Raw RGB pixels are unambiguous.
    //
    // Mask convention: 255 (white) = no darkening at multiply blend;
    // 0 (black) = full darkening. So we draw white at the centre and drop
    // smoothly to dark at the corners.
    const amount = Math.max(0.05, Math.min(0.95, vignette / 100));
    const cropMeta = await pipeline.metadata();
    const W = cropMeta.width || 1;
    const H = cropMeta.height || 1;  // same as after LUT (no resize ops)
    const cx = W / 2;
    const cy = H / 2;
    // Normalised radius in elliptical space — corners land at ~1.0.
    const normX = W / 2;
    const normY = H / 2;
    const innerStop = 0.30 - amount * 0.15;   // 0.15..0.30 of the ellipse
    const cornerDarken = 0.25 + amount * 0.55; // 0.275..0.80 darken at corners
    const mask = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - cx) / normX;
        const dy = (y - cy) / normY;
        const d = Math.sqrt(dx * dx + dy * dy);   // 0 at centre, ~1 at corners
        let v: number;                              // 255 = white (no effect)
        if (d <= innerStop) {
          v = 255;
        } else if (d >= 1.0) {
          v = Math.round(255 * (1 - cornerDarken));
        } else {
          // Smooth ease from innerStop..1.0 — darken ramps from 0 to cornerDarken.
          const t = (d - innerStop) / (1.0 - innerStop);
          // easeInOut for nicer falloff
          const eased = t * t * (3 - 2 * t);
          v = Math.round(255 * (1 - eased * cornerDarken));
        }
        const idx = (y * W + x) * 3;
        mask[idx] = v; mask[idx + 1] = v; mask[idx + 2] = v;
      }
    }
    pipeline = pipeline.composite([{
      input: mask,
      raw: { width: W, height: H, channels: 3 },
      blend: 'multiply',
    }]);
    const afterVigMeta = await pipeline.metadata();
  }


  }

  const buf = await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  // Sample buf
  const meta2 = await sharp(buf).metadata();
  return { buf, appliedCrop, appliedLut };
}
/**
 * Render a RAW file to JPEG via darktable-cli. Default processing only
 * (no XMP sidecar). Resolves on success, rejects on darktable failure
 * or timeout.
 *
 *   darktable-cli <input.RAW> <xmp> <output.jpg> --width 1920 --hq true
 *
 * The XMP arg is required syntactically but its contents are ignored
 * unless we encode a full history — Phase 3.5 work. For now, empty XMP
 * means darktable applies its built-in defaults (sensible demosaic +
 * sRGB output).
 */
async function renderWithDarktable(rawPath: string, outputPath: string, timeoutMs: number, xmpOpts?: { kelvin: number; tint: number; baseline?: { r: number; g: number; b: number }; lens_on?: boolean; nr_lum?: number; nr_chroma?: number }): Promise<void> {
  await mkdir('/app/.config/darktable', { recursive: true });
  await mkdir('/app/.cache/darktable', { recursive: true });
  const xmpPath = '/tmp/snappydo-raw-sidecar.xmp';
  // Default baseline if caller didn't provide one (uses D65; works for
  // cameras that record as-shot WB close to daylight; for Sony/Canon
  // the caller should pass the auto-WB read from EXIF for best results).
  const baseline = xmpOpts?.baseline ?? { r: 1, g: 1, b: 1 };
  const xmp = buildDarktableXmp({
    kelvin: xmpOpts?.kelvin ?? 5500,
    tint: xmpOpts?.tint ?? 0,
    baseline,
    lens_on: xmpOpts?.lens_on ?? false,
    nr_lum: xmpOpts?.nr_lum ?? 0,
    nr_chroma: xmpOpts?.nr_chroma ?? 0,
  });
  await writeFile(xmpPath, xmp, 'utf8');
  const env = { ...process.env, HOME: '/app' };
  await execFile('darktable-cli', [
    rawPath,
    xmpPath,
    outputPath,
    '--width', '1920',
    '--hq', 'true',
    '--core',
    '--conf', 'plugins/lighttable/export/iccprofile=image',
    '--conf', 'opencl=TRUE',
    '--conf', 'opencl_scheduling_profile=very fast GPU',
  ], { timeout: timeoutMs, env });
}



export const POST: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const img = getImage(id);
  if (!img) {
    return new Response(JSON.stringify({ error: 'image not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }

  const contentType = request.headers.get('content-type') || '';

  let paramsObj: any;
  let renderedBuf: Buffer;
  let cropApplied: any | null = null;
  let lutApplied: { id: number; name: string; intensity: number } | null = null;

  if (contentType.includes('application/json')) {
    // JSON mode — server-side render
    let body: any;
    try {
      body = await request.json();
    } catch {
      return badRequest('invalid JSON');
    }
    paramsObj = body?.params;
    if (!paramsObj || typeof paramsObj !== 'object') return badRequest('params required');

    let originalPath = join(UPLOAD_DIR, img.path);
    let rawRenderedPath: string | null = null;
    let rawAppliedLut: { id: number; name: string; intensity: number } | null = null;
    // ---- RAW path: re-render the original sensor data via darktable-cli
    // first so sharp gets a fresh, full-quality base instead of working on
    // the JPEG preview (which is already compressed). ----
    if (img.raw_path) {
      const rawFull = join(UPLOAD_DIR, img.raw_path);
      rawRenderedPath = join('/tmp', `snappydo-raw-${id}-${Date.now()}.jpg`);
      // Pick up WB values from the request (defaults: 5500K, 0 tint).
      const kelvin = Number(paramsObj.raw_wb_kelvin) || 5500;
      const tintForDt = Number(paramsObj.raw_wb_tint) || 0;
      // Read camera's as-shot WB from the RAW's EXIF so we can shift
      // ON TOP OF the camera's actual coefficients (writing 1,1,1 as
      // temperature params on a camera with WB=2.65,1,1.62 produces a
      // green tint — must multiply, not override).
      const baseline = await readCameraWb(rawFull);
      const lensOn = !!Number(paramsObj.raw_lens_on);
      const nrLum = Number(paramsObj.raw_nr_lum) || 0;
      const nrChroma = Number(paramsObj.raw_nr_chroma) || 0;
      try {
        await renderWithDarktable(rawFull, rawRenderedPath, 90000, {
          kelvin,
          tint: tintForDt,
          baseline,
          lens_on: lensOn,
          nr_lum: nrLum,
          nr_chroma: nrChroma,
        });
        originalPath = rawRenderedPath;
      } catch (e: any) {
        return new Response(JSON.stringify({ error: 'darktable-cli failed: ' + e.message }), {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
    }
    // For RAW images the WB has now been applied at the sensor level via
    // darktable-cli's XMP sidecar (temperature module in darktable-xmp.ts).
    // Reset temp/tint to neutral so the post-render sharp pass does not
    // double-cast the colour. ALWAYS reset for RAW (the darktable render
    // either used the user's K value or fell back to auto-WB, but in both
    // cases the WB is final — applying temp/tint again would shift again).
    if (img.raw_path) {
      paramsObj = { ...paramsObj, temp: 0, tint: 0 };
    }
    try {
      const r = await renderWithSharp(originalPath, paramsObj);
      renderedBuf = r.buf;
      cropApplied = r.appliedCrop;
      lutApplied = r.appliedLut;
      rawAppliedLut = lutApplied;
    } catch (e: any) {
      // Clean up the temp RAW render on failure
      if (rawRenderedPath) { try { await unlink(rawRenderedPath); } catch {} }
      return new Response(JSON.stringify({ error: 'render failed: ' + e.message }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
    // Clean up the temp RAW render now that sharp has consumed it
    if (rawRenderedPath) { try { await unlink(rawRenderedPath); } catch {} }
  } else {
    // Multipart mode (legacy)
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return badRequest('expected multipart/form-data');
    }
    const file = form.get('file');
    const paramsRaw = form.get('params');
    if (!file || !(file instanceof File)) return badRequest('file required');
    if (!paramsRaw || typeof paramsRaw !== 'string') return badRequest('params required');
    try {
      paramsObj = JSON.parse(paramsRaw);
    } catch {
      return badRequest('params invalid JSON');
    }
    renderedBuf = Buffer.from(await file.arrayBuffer());
  }

  // Persist
  const editsDir = join(UPLOAD_DIR, 'edits', String(id));
  if (!existsSync(editsDir)) await mkdir(editsDir, { recursive: true });
  const timestamp = Date.now();
  const filename = `edit-${timestamp}.jpg`;
  const fullPath = join(editsDir, filename);
  const relativePath = join('edits', String(id), filename);

  await writeFile(fullPath, renderedBuf);

  // Persist with crop info merged in (so re-edit knows the exact crop px)
  const persistedParams = {
    ...paramsObj,
    _appliedCrop: cropApplied,
    _appliedLut: lutApplied,
  };
  insertImageEdit({
    image_id: id,
    params_json: JSON.stringify(persistedParams),
    rendered_path: relativePath,
  });

  const edit = getLatestImageEdit(id);
  return new Response(
    JSON.stringify({
      edit: edit
        ? {
            id: edit.id,
            image_id: edit.image_id,
            path: edit.rendered_path,
            url: imgproxyUrl(edit.rendered_path, { format: 'jpg', quality: 95 }),
            params: JSON.parse(edit.params_json),
            created_at: edit.created_at,
          }
        : null,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
};

export const GET: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const latest = getLatestImageEdit(id);
  const history = listImageEdits(id).map((e) => ({
    id: e.id,
    path: e.rendered_path,
    url: imgproxyUrl(e.rendered_path, { format: 'jpg', quality: 95 }),
    params: JSON.parse(e.params_json),
    created_at: e.created_at,
  }));

  return new Response(
    JSON.stringify({
      latest: latest
        ? {
            id: latest.id,
            path: latest.rendered_path,
            url: imgproxyUrl(latest.rendered_path, { format: 'jpg', quality: 95 }),
            params: JSON.parse(latest.params_json),
            created_at: latest.created_at,
          }
        : null,
      history,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const removed = deleteAllImageEdits(id);
  const editsDir = join(UPLOAD_DIR, 'edits', String(id));
  try { if (existsSync(editsDir)) rmSync(editsDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return new Response(JSON.stringify({ removed }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
