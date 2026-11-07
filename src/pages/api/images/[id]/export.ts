/**
 * GET/POST /api/images/:id/export — download the EDITED photo.
 *
 *   GET  → streams the latest SAVED edit (already rendered, instant).
 *   POST → renders the supplied recipe (the editor's live state, including
 *          unsaved changes) at full resolution and streams it.
 *
 * The download is the edited image — the original file on disk is never
 * touched. The render path is the same one "Save edit" uses
 * (renderWithSharp), so what you download is what you saw in the editor.
 *
 * For RAW files the base image is re-rendered from the sensor data with
 * darktable-cli at NATIVE resolution (the save path renders a 1920 px
 * working copy), so the export is a real full-resolution file rather
 * than an upscale of the preview-sized render.
 *
 * Auth: admin only.
 */
import type { APIRoute } from 'astro';
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { getImage } from '../../../../lib/db';
import { readAdminSession } from '../../../../lib/auth';
import { getLatestImageEdit } from '../../../../lib/db-image-edits';
import { buildDarktableXmp, readCameraWb } from '../../../../lib/darktable-xmp';
import { renderWithSharp } from './edit';

const execFile = promisify(execFileCb);

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
function serverError(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });
}

/** "DSC_0042.ARW" → "DSC_0042-edited.jpg" (safe for a Content-Disposition header). */
function exportFilename(originalName: string): string {
  const base = (originalName || 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'image';
  return `${base}-edited.jpg`;
}

function attachmentHeaders(filename: string, length?: number): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'image/jpeg',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-render-authority': 'sharp',
  };
  if (typeof length === 'number') headers['content-length'] = String(length);
  return headers;
}

/**
 * Render a RAW file to JPEG at native resolution via darktable-cli.
 * No --width flag, so the export is full size (the save path uses
 * --width 1920 for a working copy).
 */
async function renderRawFull(
  rawPath: string,
  outputPath: string,
  params: any,
  timeoutMs = 300000,
): Promise<void> {
  await mkdir('/app/.config/darktable', { recursive: true });
  await mkdir('/app/.cache/darktable', { recursive: true });
  const xmpPath = '/tmp/snappydo-export-sidecar.xmp';
  const baseline = await readCameraWb(rawPath);
  const xmp = buildDarktableXmp({
    kelvin: Number(params?.raw_wb_kelvin) || 5500,
    tint: Number(params?.raw_wb_tint) || 0,
    baseline,
    lens_on: !!Number(params?.raw_lens_on),
    nr_lum: Number(params?.raw_nr_lum) || 0,
    nr_chroma: Number(params?.raw_nr_chroma) || 0,
  });
  await writeFile(xmpPath, xmp, 'utf8');
  const env = { ...process.env, HOME: '/app' };
  await execFile(
    'darktable-cli',
    [
      rawPath,
      xmpPath,
      outputPath,
      '--hq',
      'true',
      '--core',
      '--conf',
      'plugins/lighttable/export/iccprofile=image',
      '--conf',
      'opencl=TRUE',
      '--conf',
      'opencl_scheduling_profile=very fast GPU',
    ],
    { timeout: timeoutMs, env },
  );
}

/** Download the latest saved edit — already rendered, so this is instant. */
export const GET: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const img = getImage(id);
  if (!img) return new Response(JSON.stringify({ error: 'image not found' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });

  const latest = getLatestImageEdit(id);
  if (!latest) {
    return new Response(JSON.stringify({ error: 'no saved edit for this image' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }

  const absPath = join(UPLOAD_DIR, latest.rendered_path);
  let size: number;
  try {
    size = (await stat(absPath)).size;
  } catch {
    return new Response(JSON.stringify({ error: 'saved edit file missing' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }

  const buf = await readFile(absPath);
  return new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
    status: 200,
    headers: attachmentHeaders(exportFilename(img.original_name), size),
  });
};

/**
 * Render the supplied recipe and stream it as a download. This is the
 * "what is on my screen right now" export — it does not need the edit
 * to have been saved first.
 */
export const POST: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const img = getImage(id);
  if (!img) return new Response(JSON.stringify({ error: 'image not found' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });

  let body: any = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return badRequest('invalid JSON');
  }

  let recipeParams = body?.recipe?.params ?? body?.params;
  if (!recipeParams || typeof recipeParams !== 'object') recipeParams = {};

  let originalPath = join(UPLOAD_DIR, img.path);
  let rawRenderedPath: string | null = null;

  if (img.raw_path) {
    const rawFull = join(UPLOAD_DIR, img.raw_path);
    rawRenderedPath = join('/tmp', `snappydo-export-raw-${id}-${Date.now()}.jpg`);
    try {
      await renderRawFull(rawFull, rawRenderedPath, recipeParams);
      originalPath = rawRenderedPath;
      // The white balance is already baked in by darktable — applying the
      // temp/tint sliders again would shift the colour twice.
      recipeParams = { ...recipeParams, temp: 0, tint: 0 };
    } catch (e: any) {
      if (rawRenderedPath) {
        try { await unlink(rawRenderedPath); } catch { /* ignore */ }
      }
      return serverError('darktable-cli failed: ' + (e?.message ?? String(e)));
    }
  }

  try {
    const { buf } = await renderWithSharp(originalPath, recipeParams);
    return new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
      status: 200,
      headers: attachmentHeaders(exportFilename(img.original_name), buf.length),
    });
  } catch (e: any) {
    return serverError('render failed: ' + (e?.message ?? String(e)));
  } finally {
    if (rawRenderedPath) {
      try { await unlink(rawRenderedPath); } catch { /* ignore */ }
    }
  }
};
