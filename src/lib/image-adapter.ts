/**
 * Adapt DB ImageRow rows into the GalleryImage shape used by gallery components.
 * Generates imgproxy URLs for srcset + lightbox full-size.
 */
import type { ImageRow } from './db';
import { imgproxyUrl, imgproxySrcset, DEFAULT_THUMB_WIDTHS, DEFAULT_FULL_WIDTHS } from './imgproxy';

export type AdaptedImage = {
  id: number;
  src: string;            // full-size (lightbox)
  thumb: string;          // small thumb srcset base
  srcset: string;         // responsive thumb srcset
  width: number;
  height: number;
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

export function adaptImage(row: ImageRow): AdaptedImage {
  const exif = parseExif(row.exif_json);
  const width = row.width || 1600;
  const height = row.height || 1067;
  const srcset = imgproxySrcset(
    row.path,
    DEFAULT_THUMB_WIDTHS,
    { format: 'webp', quality: 80 },
  );
  const thumb = imgproxyUrl(row.path, { width: 600, format: 'webp', quality: 80 });
  const src = imgproxyUrl(row.path, { width: 2000, format: 'webp', quality: 88 });
  return {
    id: row.id,
    src,
    thumb,
    srcset,
    width,
    height,
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
