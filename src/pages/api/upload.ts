/**
 * POST /api/upload — accepts multipart/form-data, one or more files.
 *
 * Body fields:
 *   gallery_slug: string (required)
 *   files: File[] (multipart files)
 *
 * Response: { uploaded: ImageRecord[], errors: string[] }
 *
 * v0.8 hardening:
 *   - Removed hard `files: 20` cap (was the cause of "fails after 20 photos").
 *   - Streams each file DIRECTLY to disk via a WriteStream instead of buffering
 *     full bytes in memory (100 × 10MB photos = ~1GB RAM saved).
 *   - EXIF + dimension read happens on just the first ~256KB header chunk so
 *     we never accumulate more than ~256KB per file in JS heap.
 *   - Continues on per-file errors — one bad file doesn't kill the batch.
 *   - 5-min safety timeout guarantees the request always terminates.
 */
import type { APIRoute } from 'astro';
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink, stat, readFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Busboy from 'busboy';
import { Readable, pipeline } from 'node:stream';
import { insertImage, getGalleryBySlug } from '../../lib/db';
import { extractExif } from '../../lib/exif';

const pipelineAsync = promisify(pipeline);
const execFile = promisify(execFileCb);

export const prerender = false;

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB — raise if you shoot RAWs
const MAX_FILES_PER_REQUEST = 500; // soft cap
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min safety net
const HEADER_READ_BYTES = 256 * 1024;

// RAW camera file extensions. Browsers send these as application/octet-stream
// so we identify by file extension rather than MIME type.
const RAW_EXTENSIONS = new Set([
  'rw2',  // Panasonic Lumix
  'orf',  // Olympus / OM System
  'dng',  // Adobe Digital Negative
  'cr2', 'cr3',  // Canon
  'nef', 'nrw',  // Nikon
  'arw', 'srf', 'sr2',  // Sony
  'raf',  // Fujifilm
  'rw2',  // Panasonic (dup of above, kept for clarity)
  'pef',  // Pentax
  '3fr',  // Hasselblad
  'iiq',  // Phase One
  'x3f',  // Sigma
  'mrw',  // Minolta / Sony (legacy)
  'rwl',  // Leica
]);
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/avif',
  'image/tiff',
]);

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

  const nodeStream = Readable.fromWeb(request.body as unknown as import('stream/web').ReadableStream);

  // busboy expects lowercase header keys (Node IncomingMessage convention)
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  return new Promise<Response>((resolve) => {
    const busboy = Busboy({
      headers,
      limits: {
        fileSize: MAX_FILE_BYTES,
        files: MAX_FILES_PER_REQUEST,
      },
    });

    let gallerySlug: string | null = null;
    const uploaded: UploadedRecord[] = [];
    const errors: string[] = [];
    let pendingFiles = 0;
    let finished = false;
    let totalFilesSeen = 0;
    let resolved = false;

    function safeResolve(body: unknown, status: number) {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimer);
      resolve(json(body, status));
    }

    function maybeResolve() {
      if (resolved) return;
      if (finished && pendingFiles === 0) {
        safeResolve({ uploaded, errors }, errors.length && !uploaded.length ? 400 : 200);
      }
    }

    const safetyTimer = setTimeout(() => {
      errors.push('Server timed out after 5 min — some files may not have been processed. The client should retry any missing files.');
      safeResolve({ uploaded, errors }, 504);
    }, REQUEST_TIMEOUT_MS);

    busboy.on('field', (name, value) => {
      if (name === 'gallery_slug') gallerySlug = String(value).trim();
    });

    busboy.on('filesLimit', () => {
      errors.push(
        `Batch limit reached (${MAX_FILES_PER_REQUEST} files). Client should send smaller batches.`
      );
    });

    busboy.on('file', (_fieldname, file, info) => {
      pendingFiles++;
      totalFilesSeen++;
      const { filename, mimeType } = info;

      // Accept either an allowed MIME OR a known RAW extension. Browsers
      // send RAW as application/octet-stream, so MIME alone won't catch
      // .RW2 / .ORF / .DNG.
      const fileExt = extensionFromName(filename) || '';
      const isRaw = RAW_EXTENSIONS.has(fileExt.toLowerCase());
      if (!isRaw && !ALLOWED_MIME.has(mimeType)) {
        errors.push(`skipped ${filename}: unsupported type ${mimeType}`);
        file.resume();
        pendingFiles--;
        maybeResolve();
        return;
      }

      const ext = isRaw
        ? (fileExt.toLowerCase() || 'raw')
        : (extensionFromMime(mimeType) || extensionFromName(filename) || 'jpg');
      const stored = `${randomUUID()}.${ext}`;
      const fullPath = join(UPLOAD_DIR, stored);
      const out = createWriteStream(fullPath);

      let limitHit = false;
      let bytesWritten = 0;

      // Accumulate first ~256KB for EXIF/dimension parsing only — never the full file.
      const headerChunks: Buffer[] = [];
      let headerBytes = 0;

      file.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (limitHit) return;
        if (headerBytes < HEADER_READ_BYTES) {
          const need = HEADER_READ_BYTES - headerBytes;
          const take = Math.min(need, chunk.length);
          headerChunks.push(chunk.subarray(0, take));
          headerBytes += take;
        }
      });

      file.on('limit', () => {
        limitHit = true;
        errors.push(`skipped ${filename}: exceeds ${MAX_FILE_BYTES} bytes`);
        file.resume();
      });

      pipelineAsync(file, out).catch((err: Error) => {
        errors.push(`write failed for ${filename}: ${err.message}`);
        limitHit = true;
      });

      file.on('end', async () => {
        try {
          if (limitHit) return;
          if (!gallerySlug) {
            errors.push(`skipped ${filename}: missing gallery_slug field`);
            return;
          }

          const gallery = getGalleryBySlug(gallerySlug);
          if (!gallery) {
            errors.push(`skipped ${filename}: gallery "${gallerySlug}" not found`);
            return;
          }

          const headerBuf = Buffer.concat(headerChunks, headerBytes);
          const [exif, dims] = await Promise.all([
            extractExif(headerBuf).catch(() => ({})),
            Promise.resolve(readDimensions(headerBuf, mimeType)),
          ]);

          let previewPath = stored;
          let previewExt = ext;
          let previewMime = mimeType;
          let previewBytes = bytesWritten;
          let previewWidth = dims.width;
          let previewHeight = dims.height;
          let rawPath: string | null = null;

          if (isRaw) {
            // Move the just-written RAW into a `raws/` subdir so it's
            // clearly separated from rendered previews.
            const rawsDir = join(UPLOAD_DIR, 'raws');
            await mkdir(rawsDir, { recursive: true });
            rawPath = `raws/${stored}`;
            try {
              await rename(fullPath, join(UPLOAD_DIR, rawPath));
            } catch (err) {
              errors.push(`failed to move RAW ${filename}: ${(err as Error).message}`);
              return;
            }
            // Render a 1920px JPEG preview via darktable-cli.
            const previewUuid = randomUUID();
            previewPath = `${previewUuid}.jpg`;
            const previewFull = join(UPLOAD_DIR, previewPath);
            const rawFull = join(UPLOAD_DIR, rawPath);
            try {
              const timeoutMs = 60000;
              await runDarktableCli(rawFull, previewFull, timeoutMs);
              const previewStat = await stat(previewFull);
              previewBytes = previewStat.size;
              // Re-read dimensions from the JPEG preview
              const previewBuf = await readFile(previewFull);
              const previewDims = readDimensions(previewBuf, 'image/jpeg');
              previewWidth = previewDims.width;
              previewHeight = previewDims.height;
              previewExt = 'jpg';
              previewMime = 'image/jpeg';
            } catch (err) {
              errors.push(`darktable-cli failed on ${filename}: ${(err as Error).message}`);
              // Clean up the orphan RAW so disk doesn't fill with failed runs.
              try { await unlink(rawFull); } catch {}
              return;
            }
          }

          const id = insertImage({
            gallery_id: gallery.id,
            path: previewPath,
            original_name: filename,
            width: previewWidth,
            height: previewHeight,
            bytes: previewBytes,
            mime: previewMime,
            exif: exif as Record<string, unknown>,
            raw_path: rawPath,
          } as any);

          uploaded.push({
            id,
            path: stored,
            original_name: filename,
            width: dims.width,
            height: dims.height,
            bytes: bytesWritten,
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
      if (!resolved) {
        safeResolve({ error: err.message, uploaded, errors }, 500);
      }
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
    case 'image/tiff': return 'tif';
    default: return null;
  }
}

function extensionFromName(name: string): string | null {
  const m = name.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1]!.toLowerCase() : null;
}

// Minimal image dimension reader — covers JPEG, PNG, WebP. Falls back to null.
function readDimensions(
  buf: Buffer,
  mime: string,
): { width: number | null; height: number | null } {
  try {
    if (mime === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return { width: null, height: null };
        const marker = buf[i + 1]!;
        const segLen = buf.readUInt16BE(i + 2);
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
    } else if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF') {
      if (buf.toString('ascii', 12, 16) === 'VP8 ') {
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
      if (buf.toString('ascii', 12, 16) === 'VP8L') {
        const b0 = buf[21]!; const b1 = buf[22]!; const b2 = buf[23]!; const b3 = buf[24]!;
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width: w, height: h };
      }
    }
  } catch {
    // ignore
  }
  return { width: null, height: null };
}

/**
 * Render a RAW file to a JPEG preview using darktable-cli. Resolves on
 * success, rejects on failure (darktable exits non-zero) or timeout.
 *
 *   darktable-cli <input.RAW> <output.jpg> --width 1920 --quality 90
 *
 * `--width 1920` caps the long edge; original orientation is preserved
 * from the EXIF (darktable applies it by default).
 */
async function runDarktableCli(inputPath: string, outputPath: string, timeoutMs: number): Promise<void> {
  // darktable-cli writes its library DB under $HOME/.config/darktable on
  // first run. Ensure the dir exists so it doesn't bail.
  await mkdir('/app/.config/darktable', { recursive: true });
  const env = { ...process.env, HOME: '/app' };
  await execFile('darktable-cli', [
    inputPath,
    outputPath,
    '--width', '1920',
    '--quality', '90',
    '--core',
    '--conf', 'plugins/lighttable/export/iccprofile=image',
  ], { timeout: timeoutMs, env });
}
