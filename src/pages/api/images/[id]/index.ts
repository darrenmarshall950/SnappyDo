/**
 * DELETE /api/images/:id  — remove a single image from a gallery.
 *
 * Auth: admin only (snappydo_admin cookie).
 *
 * Cleanup:
 *   - images row (cascade kills favourites + image_edits)
 *   - original file at uploads/{path}
 *   - edits directory at uploads/edits/{image-id}/
 *
 * Safety: idempotent. Returns 204 on success or 404 if already gone.
 *         Does NOT touch the gallery itself or other images.
 */
import type { APIRoute } from 'astro';
import { existsSync, rmSync } from "node:fs";
import { join } from 'node:path';
import { getImage, deleteImage } from '../../../../lib/db';
import { readAdminSession } from '../../../../lib/auth';

export const prerender = false;

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response(JSON.stringify({ error: 'invalid id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const img = getImage(id);
  if (!img) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Best-effort filesystem cleanup. Don't fail the request if files are already gone —
  // the DB row is the source of truth and we want to avoid zombie rows blocking reuse.
  const originalPath = join(UPLOAD_DIR, img.path);
  try { if (existsSync(originalPath)) rmSync(originalPath, { force: true }); } catch { /* ignore */ }

  const editsDir = join(UPLOAD_DIR, 'edits', String(id));
  try { if (existsSync(editsDir)) rmSync(editsDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Also clean any thumbs cached on the imgproxy side. imgproxy doesn't expose a delete
  // API; the worst case is stale cache entries which will expire naturally.

  // DB delete (cascades to favourites + image_edits via FK if configured)
  const removed = deleteImage(id);
  if (!removed) {
    // Race: someone else deleted between getImage and deleteImage
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
};

/**
 * POST /api/images/:id/delete-bulk — bulk delete via JSON body.
 *   { ids: number[] }
 *
 * Useful for the "select all then delete" UX without one round-trip per image.
 */
export const POST: APIRoute = async ({ request }) => {
  if (!readAdminSession(request)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body: any;
  try { body = await request.json(); } catch { body = null; }
  const ids: number[] = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) {
    return new Response(JSON.stringify({ error: 'ids[] required' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  let deleted = 0;
  const failed: number[] = [];
  for (const id of ids) {
    const img = getImage(id);
    if (!img) { failed.push(id); continue; }
    try {
      const originalPath = join(UPLOAD_DIR, img.path);
      if (existsSync(originalPath)) rmSync(originalPath, { force: true });
      const editsDir = join(UPLOAD_DIR, 'edits', String(id));
      if (existsSync(editsDir)) rmSync(editsDir, { recursive: true, force: true });
      if (deleteImage(id)) deleted++; else failed.push(id);
    } catch {
      failed.push(id);
    }
  }

  return new Response(JSON.stringify({ deleted, failed }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
