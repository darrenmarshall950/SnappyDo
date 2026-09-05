/**
 * POST /api/upload — accepts multipart/form-data, one or more files.
 *
 * Body fields:
 *   gallery_slug: string (required)
 *   files: File[] (multipart files)
 *
 * Response: { uploaded: ImageRecord[], errors: string[] }
 */
import type { APIRoute } from 'astro';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import { Readable } from 'node:stream';
import { insertImage, getGalleryBySlug } from '../../lib/db';
import { extractExif } from '../../lib/exif';

export const prerender = false;

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/avif']);

type UploadedRecord = {
  id: number;
  path: string;
  original_name: string;
  width: number | null;
  height: number | null;
  bytes: number;
  mime: string;
  exif: Record<string, unknown>;
};

export const POST: APIRoute = async ({ request }) => {
  const ct = request.headers.get('content-type') || '';
  if (!ct.startsWith('multipart/form-data')) {
    return json({ error: 'expected multipart/form-data' }, 400);
  }

  await mkdir(UPLOAD_DIR, { recursive: true });

  // busboy needs a Node stream — web Request body is a WHATWG stream
  const nodeStream = Readable.fromWeb(request.body as unknown as import('stream/web').ReadableStream);

  // busboy expects lowercase header keys (Node IncomingMessage convention)
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return new Promise<Response>((resolve) => {
    const busboy = Busboy({
      headers,
      limits: { fileSize: MAX_FILE_BYTES, files: 20 },
    });

    let gallerySlug: string | null = null;
    const uploaded: UploadedRecord[] = [];
    const errors: string[] = [];
    let pendingFiles = 0;
    let finished = false;

    function maybeResolve() {
      if (finished && pendingFiles === 0) {
        resolve(json({ uploaded, errors }, errors.length && !uploaded.length ? 400 : 200));
      }
    }

    busboy.on('field', (name, value) => {
      if (name === 'gallery_slug') gallerySlug = String(value).trim();
    });

    busboy.on('file', async (_fieldname, file, info) => {
      pendingFiles++;
      const { filename, mimeType } = info;

      // Reject early on type
      if (!ALLOWED_MIME.has(mimeType)) {
        errors.push(`skipped ${filename}: unsupported type ${mimeType}`);
        file.resume(); // drain
        pendingFiles--;
        return;
      }

      // Buffer the file in memory — better-sqlite3 + EXIF parsing want bytes
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let limitHit = false;

      file.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FILE_BYTES) {
          limitHit = true;
          return;
        }
        chunks.push(chunk);
      });

      file.on('limit', () => {
        limitHit = true;
      });

      file.on('end', async () => {
        try {
          if (limitHit) {
            errors.push(`skipped ${filename}: exceeds ${MAX_FILE_BYTES} bytes`);
            return;
          }
          if (!gallerySlug) {
            errors.push(`skipped ${filename}: missing gallery_slug field`);
            return;
          }

          const gallery = getGalleryBySlug(gallerySlug);
          if (!gallery) {
            errors.push(`skipped ${filename}: gallery "${gallerySlug}" not found`);
            return;
          }

          const buf = Buffer.concat(chunks);
          const ext = extensionFromMime(mimeType) || extensionFromName(filename) || 'jpg';
          const stored = `${randomUUID()}.${ext}`;
          const fullPath = join(UPLOAD_DIR, stored);

          await writeFile(fullPath, buf);

          // EXIF + dimensions (best-effort, never fails upload)
          const [exif, dims] = await Promise.all([
            extractExif(buf),
            readDimensions(buf, mimeType),
          ]);

          const id = insertImage({
            gallery_id: gallery.id,
            path: stored,
            original_name: filename,
            width: dims.width,
            height: dims.height,
            bytes: buf.length,
            mime: mimeType,
            exif: exif as Record<string, unknown>,
          });
          uploaded.push({
            id,
            path: stored,
            original_name: filename,
            width: dims.width,
            height: dims.height,
            bytes: buf.length,
            mime: mimeType,
            exif: exif as Record<string, unknown>,
          });
        } catch (err) {
          errors.push(`${filename}: ${(err as Error).message}`);
        } finally {
          pendingFiles--;
          maybeResolve();
        }
      });
    });

    busboy.on('finish', () => {
      finished = true;
      maybeResolve();
    });

    busboy.on('error', (err) => {
      finished = true;
      resolve(json({ error: err.message, uploaded, errors }, 500));
    });

    nodeStream.pipe(busboy);
  });
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function extensionFromMime(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/heic': return 'heic';
    case 'image/avif': return 'avif';
    default: return null;
  }
}

function extensionFromName(name: string): string | null {
  const m = name.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1]!.toLowerCase() : null;
}

// Minimal image dimension reader — covers JPEG, PNG. Falls back to null for others.
async function readDimensions(
  buf: Buffer,
  mime: string,
): Promise<{ width: number | null; height: number | null }> {
  try {
    if (mime === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return { width: null, height: null };
        const marker = buf[i + 1]!;
        const segLen = buf.readUInt16BE(i + 2);
        // SOFn markers: 0xC0..0xCF except C4, C8, CC
        if (
          (marker >= 0xc0 && marker <= 0xcf) &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return { width: w, height: h };
        }
        i += 2 + segLen;
      }
    } else if (mime === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      return { width: w, height: h };
    }
  } catch {
    // ignore
  }
  return { width: null, height: null };
}
