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
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { getImage } from '../../../../lib/db';
import {
  insertImageEdit,
  getLatestImageEdit,
  listImageEdits,
  deleteAllImageEdits,
} from '../../../../lib/db-image-edits';
import { readAdminSession } from '../../../../lib/auth';
import { imgproxyUrl } from '../../../../lib/imgproxy';

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

  // ---- Crop first (UV space 0..1) ----
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
  // Exposure (-200..200 stops): factor = 2^(exposure/100)
  const exposure = Number(params.exposure) || 0;
  const brightness = Number(params.brightness) || 0;
  const saturation = Number(params.saturation) || 0;
  const contrast = Number(params.contrast) || 0;
  const temp = Number(params.temp) || 0;
  const tint = Number(params.tint) || 0;

  const expFactor = Math.pow(2, exposure / 100);            // 0.25..4
  const brightFactor = 1 + brightness / 100;                 // 0..2 (additive)
  const brightnessFactor = expFactor * brightFactor;         // combined
  const saturationFactor = Math.max(0, 1 + saturation / 100); // 0..2

  if (brightnessFactor !== 1 || saturationFactor !== 1) {
    pipeline = pipeline.modulate({
      brightness: brightnessFactor,
      saturation: saturationFactor,
    });
  }

  // Contrast: a * in + b; for contrast +/-100 -> a=2 (or 0); b=(1-a)/2
  if (contrast !== 0) {
    const a = 1 + contrast / 100;
    const b = (1 - a) / 2;
    pipeline = pipeline.linear(a, b);
  }

  // WB temp/tint via .tint(). Sharp expects {r,g,b} in 0..255.
  // temp > 0 = warmer (push red, pull blue). temp < 0 = cooler.
  // tint > 0 = push green, tint < 0 = push magenta.
  if (temp !== 0 || tint !== 0) {
    const t = Math.max(-100, Math.min(100, temp));
    const u = Math.max(-100, Math.min(100, tint));
    const rDelta = t * 0.6;        // +/-60 per max temp
    const bDelta = -t * 0.6;
    const gDelta = u * 0.5;
    const base = 240;              // near-white tint base
    const tintR = Math.max(180, Math.min(255, base + rDelta));
    const tintG = Math.max(180, Math.min(255, base + gDelta));
    const tintB = Math.max(180, Math.min(255, base + bDelta));
    // Mix amount — how strongly to apply the tint (rough approximation)
    const tintMix = (Math.abs(t) + Math.abs(u)) / 100 * 0.25;  // 0..0.5
    if (tintMix > 0) {
      pipeline = pipeline.tint({ r: tintR, g: tintG, b: tintB }).linear(1, 0);
    }
  }

  const buf = await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  return { buf, appliedCrop };
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

    const originalPath = join(UPLOAD_DIR, img.path);
    try {
      const r = await renderWithSharp(originalPath, paramsObj);
      renderedBuf = r.buf;
      cropApplied = r.appliedCrop;
    } catch (e: any) {
      return new Response(JSON.stringify({ error: 'render failed: ' + e.message }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
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
  const persistedParams = { ...paramsObj, _appliedCrop: cropApplied };
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
