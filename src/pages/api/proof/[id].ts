/**
 * Server-side watermarked image endpoint (proofing galleries).
 *
 * imgproxy open-source v3 does NOT support text watermarks — that requires
 * imgproxy Pro. So we apply the watermark ourselves via sharp (SVG overlay
 * composited onto the original at native resolution).
 *
 *   GET /api/proof/:id              — uses env defaults (WATERMARK_TEXT etc.)
 *   GET /api/proof/:id?t=Custom+Text — overrides per-request
 *   GET /api/proof/:id?opacity=40   — opacity 0..100
 *   GET /api/proof/:id?pos=soea     — position (no/so/ea/we/noea/nowe/soea/sowe/ce)
 *
 * Response: native-resolution JPEG (q95), with the watermark baked in.
 * Caching: long-lived (immutable per image) — photographer can change the
 *           watermark per request, so we cache by hash of the watermark
 *           params to allow varying watermarks.
 */
import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getImage } from '../../../lib/db';

export const prerender = false;

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';

// Position uses imgproxy's gravity short codes (soea=south-east, noea=north-east, etc.)
// Accepts both forms via the long-name alias map.
const POSITION_MAP: Record<string, string> = {
  no: 'no', north: 'no',
  so: 'so', south: 'so',
  ea: 'ea', east: 'ea',
  we: 'we', west: 'we',
  noea: 'noea', 'north-east': 'noea', northeast: 'noea',
  nowe: 'nowe', 'north-west': 'nowe', northwest: 'nowe',
  soea: 'soea', 'south-east': 'soea', southeast: 'soea',
  sowe: 'sowe', 'south-west': 'sowe', southwest: 'sowe',
  ce: 'ce', center: 'ce',
};

/** Compose an SVG string that overlays a watermark at the given position. */
function watermarkSvg(
  text: string,
  width: number,
  height: number,
  position: string,
  opacity: number, // 0..100
): string {
  // Font scales with image size; capped so it's not silly big on hero shots
  const fontSize = Math.max(14, Math.min(72, Math.round(width / 32)));
  const padX = Math.round(width * 0.025);
  const padY = Math.round(height * 0.025);
  const alpha = Math.max(0.05, Math.min(1, opacity / 100));

  // Build text-shadow stroke for visibility on light/dark backgrounds
  const escText = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let anchorX = width / 2;
  let anchorY = height / 2;
  let textAnchor: 'start' | 'middle' | 'end' = 'middle';

  switch (position) {
    case 'no':  anchorX = width / 2; anchorY = padY + fontSize; textAnchor = 'middle'; break;
    case 'so':  anchorX = width / 2; anchorY = height - padY; textAnchor = 'middle'; break;
    case 'ea':  anchorX = width - padX; anchorY = height / 2; textAnchor = 'end'; break;
    case 'we':  anchorX = padX; anchorY = height / 2; textAnchor = 'start'; break;
    case 'noea': anchorX = width - padX; anchorY = padY + fontSize; textAnchor = 'end'; break;
    case 'nowe': anchorX = padX; anchorY = padY + fontSize; textAnchor = 'start'; break;
    case 'soea': anchorX = width - padX; anchorY = height - padY; textAnchor = 'end'; break;
    case 'sowe': anchorX = padX; anchorY = height - padY; textAnchor = 'start'; break;
    case 'ce':  anchorX = width / 2; anchorY = height / 2; textAnchor = 'middle'; break;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700;">
    <text x="${anchorX}" y="${anchorY}"
          font-size="${fontSize}"
          fill="rgba(255,255,255,${alpha})"
          stroke="rgba(0,0,0,${alpha * 0.6})"
          stroke-width="0.5"
          paint-order="stroke fill"
          text-anchor="${textAnchor}"
          dominant-baseline="alphabetic"
          letter-spacing="2">${escText}</text>
  </g>
</svg>`;
}

/** Resolve which watermark to use, with priority: query > env > none. */
function resolveWatermark(url: URL) {
  const text = url.searchParams.get('t') || process.env.WATERMARK_TEXT || '';
  if (!text) return null;
  const opacityRaw = url.searchParams.get('opacity') ?? process.env.WATERMARK_OPACITY;
  const opacity = opacityRaw ? Math.max(0, Math.min(100, Number(opacityRaw))) : 30;
  const positionRaw = (url.searchParams.get('pos') || process.env.WATERMARK_POSITION || 'soea').toLowerCase();
  const position = POSITION_MAP[positionRaw] || 'soea';
  return { text, opacity, position };
}

export const GET: APIRoute = async ({ params, url }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response('Bad image id', { status: 400 });
  }

  const row = getImage(id);
  if (!row) return new Response('Image not found', { status: 404 });

  const wm = resolveWatermark(url);
  if (!wm) {
    // No watermark configured — just stream the original through.
    const filePath = path.join(UPLOAD_DIR, row.path);
    if (!existsSync(filePath)) return new Response('File missing on disk', { status: 404 });
    const buf = await readFile(filePath);
    return new Response(buf, {
      headers: {
        'Content-Type': row.mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  }

  const filePath = path.join(UPLOAD_DIR, row.path);
  if (!existsSync(filePath)) return new Response('File missing on disk', { status: 404 });

  // Get original dimensions, then compose watermark at full size
  const meta = await sharp(filePath).metadata();
  const width = meta.width || row.width || 1600;
  const height = meta.height || row.height || 1067;

  const svg = watermarkSvg(wm.text, width, height, wm.position, wm.opacity);

  // Native-resolution JPEG @ 95% with watermark composited on top
  // Preserve the photographer's full-resolution image — no downscaling.
  const out = await sharp(filePath)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();

  return new Response(out, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': `public, max-age=31536000, immutable`,
      'X-Watermark': `${wm.text} @ ${wm.opacity}% ${wm.position}`,
    },
  });
};
