/**
 * EXIF extraction using exifr.
 * Server-only — runs on uploaded files before they're saved to disk.
 */
import exifr from 'exifr';

export type ExtractedExif = {
  camera?: string;
  lens?: string;
  iso?: number;
  aperture?: string;
  shutter?: string;
  focalLength?: string;
  takenAt?: string;
};

export async function extractExif(buf: Buffer | Uint8Array): Promise<ExtractedExif> {
  try {
    const data = await exifr.parse(buf, {
      pick: [
        'Make', 'Model', 'LensModel',
        'ISO',
        'FNumber', 'ExposureTime', 'FocalLength',
        'DateTimeOriginal', 'CreateDate',
      ],
    });

    if (!data) return {};

    const out: ExtractedExif = {};

    if (data.Make || data.Model) {
      const make = (data.Make || '').toString().trim();
      const model = (data.Model || '').toString().trim();
      // Model often includes Make, e.g. "Canon EOS R5" — strip duplication
      out.camera = model.startsWith(make) ? model : [make, model].filter(Boolean).join(' ');
    }
    if (data.LensModel) out.lens = String(data.LensModel).trim();
    if (data.ISO) out.iso = Number(data.ISO);
    if (data.FNumber) out.aperture = `f/${Number(data.FNumber).toFixed(1).replace(/\.0$/, '')}`;
    if (data.ExposureTime) {
      const t = Number(data.ExposureTime);
      out.shutter = t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}`;
    }
    if (data.FocalLength) {
      const fl = Number(data.FocalLength);
      out.focalLength = `${Math.round(fl)}mm`;
    }
    const dt = data.DateTimeOriginal || data.CreateDate;
    if (dt) {
      const d = dt instanceof Date ? dt : new Date(dt);
      if (!isNaN(d.getTime())) out.takenAt = d.toISOString();
    }

    return out;
  } catch (err) {
    // EXIF is best-effort — never fail the upload because of it
    console.warn('extractExif failed:', (err as Error).message);
    return {};
  }
}
