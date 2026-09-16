/**
 * src/lib/preview-cache.ts — RAW preview render cache.
 *
 * Hash-keyed filesystem cache of darktable-cli renders of a RAW file with
 * a specific set of XMP parameters. Used by /api/images/[id]/preview to
 * avoid re-rendering the same slider state on every editor reload.
 *
 * Cache layout:
 *   <UPLOAD_DIR>/previews/<image_id>/<hash>.jpg
 *
 * Hash is computed from a sorted JSON serialisation of the slider state
 * so it's stable across request ordering.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export interface RawPreviewParams {
  kelvin: number;
  tint: number;
  lens_on: boolean;
  nr_lum: number;
  nr_chroma: number;
}

/** Stable hash for a set of RAW preview params. */
export function hashPreviewParams(p: RawPreviewParams): string {
  // Sort keys explicitly so {kelvin,tint,lens_on,nr_lum,nr_chroma} always
  // hashes the same way regardless of object property ordering.
  const norm = {
    kelvin: Math.round(p.kelvin),
    tint: Math.round(p.tint),
    lens_on: !!p.lens_on,
    nr_lum: Math.round(p.nr_lum),
    nr_chroma: Math.round(p.nr_chroma),
  };
  return createHash('md5').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

/** Absolute path to the cached preview JPEG for a given image + params. */
export function previewCachePath(uploadDir: string, imageId: number, hash: string): string {
  return join(uploadDir, 'previews', String(imageId), `${hash}.jpg`);
}

/** Path stored in the DB/filesystem (relative to UPLOAD_DIR). */
export function previewRelativePath(imageId: number, hash: string): string {
  return join('previews', String(imageId), `${hash}.jpg`);
}
