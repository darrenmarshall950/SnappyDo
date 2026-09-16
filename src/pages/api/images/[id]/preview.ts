/**
 * POST /api/images/:id/preview
 *
 * Render a darktable-cli preview of a RAW file with the supplied XMP
 * parameters and return a cacheable imgproxy URL. Hash-keyed by the
 * (sorted) param set so revisits are instant.
 *
 * Gated by `SNAPPYDO_RAW_PREVIEW_RENDER=1` so the existing WebGL-only
 * preview behaviour is the default. With the env unset, returns 404
 * and the client treats the feature as off.
 *
 * Non-RAW images: returns 400 — the existing JPEG preview already
 * matches save output for those.
 */
import type { APIRoute } from 'astro';
import { getImage } from '../../../../lib/db';
import { readCameraWb, buildDarktableXmp } from '../../../../lib/darktable-xmp';
import { hashPreviewParams, previewCachePath, previewRelativePath } from '../../../../lib/preview-cache';
import { readAdminSession } from '../../../../lib/auth';
import { imgproxyUrl } from '../../../../lib/imgproxy';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
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
 * Run darktable-cli to render the RAW with the given XMP and return the
 * bytes (or null on failure). This duplicates the logic in
 * edit.ts/renderWithDarktable but without a hard dependency on that
 * module so the preview endpoint stays standalone.
 */
async function renderPreview(
  rawPath: string,
  xmpPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<void> {
  await mkdir('/app/.config/darktable', { recursive: true });
  await mkdir('/app/.cache/darktable', { recursive: true });
  const env = { ...process.env, HOME: '/app' };
  await execFileP('darktable-cli', [
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
  // Feature gate — env var must be set to "1" (or any truthy) for this
  // endpoint to do anything. Without it, 404.
  if (process.env.SNAPPYDO_RAW_PREVIEW_RENDER !== '1') {
    return new Response(JSON.stringify({ error: 'raw preview render disabled' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    });
  }

  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const img = getImage(id);
  if (!img) return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  });
  if (!img.raw_path) return badRequest('image is not RAW');

  // Parse body
  let body: any;
  try { body = await request.json(); } catch { return badRequest('expected JSON body'); }

  const p2 = {
    kelvin: Number(body.kelvin ?? 5500),
    tint: Number(body.tint ?? 0),
    lens_on: !!body.lens_on,
    nr_lum: Number(body.nr_lum ?? 0),
    nr_chroma: Number(body.nr_chroma ?? 0),
  };
  // Clamp to slider ranges
  if (p2.kelvin < 2000 || p2.kelvin > 10000) return badRequest('kelvin out of range');
  if (p2.tint < -100 || p2.tint > 100) return badRequest('tint out of range');
  if (p2.nr_lum < 0 || p2.nr_lum > 100) return badRequest('nr_lum out of range');
  if (p2.nr_chroma < 0 || p2.nr_chroma > 100) return badRequest('nr_chroma out of range');

  const hash = hashPreviewParams(p2);
  const outAbs = previewCachePath(UPLOAD_DIR, id, hash);
  const outRel = previewRelativePath(id, hash);

  // Cache hit
  if (existsSync(outAbs)) {
    return new Response(JSON.stringify({
      url: imgproxyUrl(outRel, { format: 'jpg', quality: 95 }),
      cached: true,
      hash,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // Cache miss — render via darktable-cli
  const rawFull = join(UPLOAD_DIR, img.raw_path);
  const xmpPath = '/tmp/snappydo-preview-sidecar.xmp';
  try {
    const baseline = await readCameraWb(rawFull);
    const xmp = buildDarktableXmp({
      kelvin: p2.kelvin,
      tint: p2.tint,
      baseline,
      lens_on: p2.lens_on,
      nr_lum: p2.nr_lum,
      nr_chroma: p2.nr_chroma,
    });
    // Write XMP to a temp file. mkdir pre-creates the cache dir so the
    // darktable output goes where we expect.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(xmpPath, xmp, 'utf8');
    await mkdir(join(UPLOAD_DIR, 'previews', String(id)), { recursive: true });

    await renderPreview(rawFull, xmpPath, outAbs, 90000);
  } catch (e: any) {
    return new Response(JSON.stringify({
      error: 'darktable-cli failed: ' + (e?.message ?? String(e)),
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    url: imgproxyUrl(outRel, { format: 'jpg', quality: 95 }),
    cached: false,
    hash,
  }), { status: 201, headers: { 'content-type': 'application/json' } });
};
