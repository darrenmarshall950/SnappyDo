/**
 * POST /api/images/bulk-delete — delete multiple images in one request.
 *   { ids: number[] }
 *
 * Auth: admin only.
 * Cascades to favourites + image_edits via FK. Cleans up files.
 */
import type { APIRoute } from 'astro';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getImage, deleteImage } from '../../../lib/db';
import { readAdminSession } from '../../../lib/auth';

export const prerender = false;

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

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

  const deleted: number[] = [];
  const failed: number[] = [];

  for (const id of ids) {
    const img = getImage(id);
    if (!img) { failed.push(id); continue; }
    try {
      const originalPath = join(UPLOAD_DIR, img.path);
      if (existsSync(originalPath)) rmSync(originalPath, { force: true });
      const editsDir = join(UPLOAD_DIR, 'edits', String(id));
      if (existsSync(editsDir)) rmSync(editsDir, { recursive: true, force: true });
      if (deleteImage(id)) deleted.push(id); else failed.push(id);
    } catch {
      failed.push(id);
    }
  }

  return new Response(JSON.stringify({ deleted, failed }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
