/**
 * Image adapter patch — surface the latest non-destructive edit when present.
 *
 * Behaviour:
 *   - If image has a latest edit (image_edits row), use the rendered_path
 *     instead of the original path for all three URL variants.
 *   - The original is NEVER touched; this is purely a read-side switch.
 *
 * Why we surface edits here and not via a separate field:
 *   - The lightbox hero and contact-sheet thumbs should reflect what the
 *     photographer approved. Showing the original alongside the edit would
 *     confuse clients.
 *   - Galleries consume adaptImage() — they don't need to know about edits.
 *
 * Performance:
 *   - One extra DB query per image (latestEditFor). Cached lazily on
 *     adaptImage() invocation. For 50-photo galleries that's 50 cheap
 *     lookups — fine. If it becomes hot, memoize by image_id within a
 *     request.
 */
import type { ImageRow } from './db';
import { imgproxyUrl, imgproxySrcset, DEFAULT_THUMB_WIDTHS } from './imgproxy';
import type { TemplateConfig } from './gallery-schemas';
import { latestEditFor } from './db-image-edits';

export type AdaptedImage = {
  id: number;
  /** Contact-sheet thumb (responsive srcset base, ~640w default). */
  thumb: string;
  /** Responsive srcset for thumbs. */
  srcset: string;
  /** Mid-size preview (~2000w) for inline display on smaller screens. */
  src: string;
  /** Native-resolution image for the lightbox hero — preserves photographer's craft. */
  full: string;
  width: number;
  height: number;
  aspectRatio: string;
  alt: string;
  exif: {
    camera: string;
    lens: string;
    iso: number;
    aperture: string;
    shutter: string;
    focalLength: string;
    takenAt: string;
  };
  /** True if this image has a saved non-destructive edit applied. */
  hasEdit?: boolean;
};

export function adaptImage(row: ImageRow, config?: TemplateConfig): AdaptedImage {
  const exif = parseExif(row.exif_json);
  const width = row.width || 1600;
  const height = row.height || 1067;
  const watermark = config?.watermark || undefined;

  // Surface latest edit if present (non-destructive).
  const edit = latestEditFor(row.id);
  const servePath = edit?.rendered_path ?? row.path;
  const hasEdit = !!edit;

  // Contact sheet thumbs: small, WebP, 80% quality. No watermark on thumbs.
  const srcset = imgproxySrcset(
    servePath,
    DEFAULT_THUMB_WIDTHS,
    { format: 'webp', quality: 80 },
  );
  const thumb = imgproxyUrl(servePath, { width: 640, format: 'webp', quality: 80 });

  // Mid-size: 2000w WebP @ 88% (for inline preview on retina + small screens)
  const src = imgproxyUrl(servePath, { width: 2000, format: 'webp', quality: 88 });

  // Full / lightbox hero — preserves photographer's edit (if any) or original
  const envWatermark = process.env.WATERMARK_TEXT
    ? {
        text: process.env.WATERMARK_TEXT,
        opacity: process.env.WATERMARK_OPACITY ? Number(process.env.WATERMARK_OPACITY) : 30,
        position: (process.env.WATERMARK_POSITION as 'southeast' | 'northwest' | 'center' | 'south' | 'north' | 'east' | 'west' | 'northeast' | 'southwest') || 'southeast',
      }
    : undefined;
  const fullWatermark = watermark || envWatermark;
  const full = fullWatermark
    ? buildProofUrl(row.id, fullWatermark)
    : imgproxyUrl(servePath, { format: 'jpg', quality: 95, enlarge: true });

  return {
    id: row.id,
    src,
    thumb,
    srcset,
    full,
    width,
    height,
    aspectRatio: `${width} / ${height}`,
    alt: exif.camera ? `${exif.camera} — ${row.original_name}` : row.original_name,
    hasEdit,
    exif: {
      camera: exif.camera || 'Unknown camera',
      lens: exif.lens || '—',
      iso: exif.iso || 0,
      aperture: exif.aperture || '—',
      shutter: exif.shutter || '—',
      focalLength: exif.focalLength || '—',
      takenAt: exif.takenAt || row.created_at,
    },
  };
}

function parseExif(json: string): Record<string, any> {
  try { return JSON.parse(json); } catch { return {}; }
}

function buildProofUrl(imageId: number, w: NonNullable<TemplateConfig['watermark']>): string {
  const base = process.env.PUBLIC_BASE_URL || '';
  const params = new URLSearchParams();
  params.set('t', w.text);
  if (w.opacity !== undefined) params.set('opacity', String(w.opacity));
  if (w.position) params.set('pos', w.position);
  return `${base}/api/proof/${imageId}?${params.toString()}`;
}
