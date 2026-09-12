/**
 * POST /api/images/:id/edit — save a non-destructive edit for an image.
 *
 * Body: multipart/form-data with:
 *   - 'file': rendered JPEG blob (canvas.toBlob from the WebGL editor)
 *   - 'params': JSON string of edit parameters (for re-editing later)
 *
 * The original file is preserved. The rendered JPEG is stored at
 *   /uploads/edits/{image-id}/edit-{timestamp}.jpg
 *
 * A row is inserted into image_edits with the params + path.
 *
 * Response: { edit: { id, path, url, params, created_at } }
 *
 * Auth: admin only.
 */
import type { APIRoute } from 'astro';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

function badRequest(msg: string) {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const img = getImage(id);
  if (!img) {
    return new Response(JSON.stringify({ error: 'image not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    return badRequest('expected multipart/form-data');
  }

  const file = form.get('file');
  const paramsRaw = form.get('params');
  if (!file || !(file instanceof File)) return badRequest('file required');
  if (!paramsRaw || typeof paramsRaw !== 'string') return badRequest('params required');

  // Validate params is well-formed JSON
  try {
    JSON.parse(paramsRaw);
  } catch {
    return badRequest('params invalid JSON');
  }

  // Write rendered JPEG to /uploads/edits/{image-id}/edit-{timestamp}.jpg
  const editsDir = join(UPLOAD_DIR, 'edits', String(id));
  if (!existsSync(editsDir)) await mkdir(editsDir, { recursive: true });
  const timestamp = Date.now();
  const filename = `edit-${timestamp}.jpg`;
  const fullPath = join(editsDir, filename);
  const relativePath = join('edits', String(id), filename);

  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(fullPath, buf);

  // Persist in DB
  insertImageEdit({
    image_id: id,
    params_json: paramsRaw,
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

/**
 * GET /api/images/:id/edit — fetch the latest edit + full history.
 * Used to pre-populate the editor with current params.
 */
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

/**
 * DELETE /api/images/:id/edit — discard ALL edits for an image (revert to original).
 * Doesn't touch the original file.
 */
export const DELETE: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return unauthorized();

  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return badRequest('invalid id');

  const removed = deleteAllImageEdits(id);
  const editsDir = join(UPLOAD_DIR, 'edits', String(id));
  try { if (existsSync(editsDir)) rmSync(editsDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return new Response(JSON.stringify({ removed }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
