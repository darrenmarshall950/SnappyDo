/**
 * GET /api/images/:id/source
 *
 * Streams the original (or latest edit) image bytes with permissive CORS so
 * the admin editor's <canvas> stays un-tainted and `canvas.toBlob()` works
 * on Save. Imgproxy doesn't ship CORS headers, so we serve from SnappyDo
 * directly when the editor needs an un-tainted source.
 */
import type { APIRoute } from 'astro';
import { getImage } from '../../../../lib/db';
import { latestEditFor } from '../../../../lib/db-image-edits';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic',
};

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i + 1).toLowerCase() : 'jpg';
}

export const GET: APIRoute = async ({ params, request }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return new Response(JSON.stringify({ error: 'bad id' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const row = getImage(id);
  if (!row) {
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }
  const edit = latestEditFor(id);
  const servePath = edit?.rendered_path ?? row.path;
  const absPath = join(UPLOAD_DIR, servePath);

  let total: number;
  try {
    const s = await stat(absPath);
    total = s.size;
  } catch {
    return new Response(JSON.stringify({ error: 'file missing', path: absPath }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }

  const mime = MIME_BY_EXT[extOf(servePath)] || 'image/jpeg';
  const range = request.headers.get('range');
  const headersBase: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'private, max-age=300',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Accept-Ranges': 'bytes',
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
    const end = m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]));
    if (start > end || start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    const len = end - start + 1;
    const buf = await readFile(absPath, { flag: 'r' });
    return new Response(buf.subarray(start, end + 1), {
      status: 206,
      headers: { ...headersBase, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(len) },
    });
  }

  const buf = await readFile(absPath, { flag: 'r' });
  return new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
    status: 200,
    headers: { ...headersBase, 'Content-Length': String(total) },
  });
};

export const OPTIONS: APIRoute = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Max-Age': '86400',
    },
  });
};
