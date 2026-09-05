/**
 * Adapt DB ImageRow rows into the GalleryImage shape used by gallery components.
 *
 * Three URL variants per image, all served by imgproxy:
 *   thumb  - small responsive srcset for contact-sheet browsing (320–1280w)
 *   src    - mid-size preview (2000w max) for inline display in lightbox
 *   full   - native-resolution original for the lightbox hero view
 *
 * Why three:
 *   - Contact sheets need tiny WebP so 50-photo galleries scroll smoothly.
 *   - Lightbox hero must show the photographer's full-resolution work
 *     untouched (or near-untouched). Auto-resizing a 6000px shot to 2000px
 *     destroys the craft. We resize the *container* but never the *image*
 *     below the original pixel count.
 *
 * Optional watermark (from template config) is applied to the `full` URL so
 * the high-res download can't be claimed as uncredited. Watermark is NOT
 * applied to contact-sheet thumbs to keep file sizes small and browsing
 * uncluttered.
 */
import type { ImageRow } from './db';
import { imgproxyUrl, imgproxySrcset, DEFAULT_THUMB_WIDTHS } from './imgproxy';
import type { TemplateConfig } from './gallery-schemas';

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
  aspectRatio: string; // "1.5" form for CSS aspect-ratio
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
};

export function adaptImage(row: ImageRow, config?: TemplateConfig): AdaptedImage {
  const exif = parseExif(row.exif_json);
  const width = row.width || 1600;
  const height = row.height || 1067;
  const watermark = config?.watermark || undefined;

  // Contact sheet thumbs: small, WebP, 80% quality. No watermark on thumbs.
  const srcset = imgproxySrcset(
    row.path,
    DEFAULT_THUMB_WIDTHS,
    { format: 'webp', quality: 80 },
  );
  const thumb = imgproxyUrl(row.path, { width: 640, format: 'webp', quality: 80 });

  // Mid-size: 2000w WebP @ 88% (for inline preview on retina + small screens)
  const src = imgproxyUrl(row.path, { width: 2000, format: 'webp', quality: 88 });

  // Full / lightbox hero: native resolution, JPEG @ 95% (preserves the photographer's edit)
  // No `width` is set so imgproxy passes the original through.
  // Watermark: per-gallery config wins, otherwise fall back to env-based default.
  // Rendered server-side via /api/proof/:id (imgproxy open-source doesn't support text watermarks).
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
    : imgproxyUrl(row.path, { format: 'jpg', quality: 95, enlarge: true });

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

/**
 * Build a URL to the server-side watermark endpoint.
 * Public URL uses the configured ORIGIN so imgproxy/img tags can hit us
 * directly without going through a proxy. Falls back to relative path.
 */
function buildProofUrl(imageId: number, w: NonNullable<TemplateConfig['watermark']>): string {
  const base = process.env.PUBLIC_BASE_URL || '';
  const params = new URLSearchParams();
  params.set('t', w.text);
  if (w.opacity !== undefined) params.set('opacity', String(w.opacity));
  if (w.position) params.set('pos', w.position);
  return `${base}/api/proof/${imageId}?${params.toString()}`;
}
