/**
 * imgproxy URL builder.
 *
 * Uses "unsafe" mode (no signature) for v0.3 prototype — fine for local-only access.
 * For production with public exposure, switch to signed URLs (set IMGPROXY_KEY + IMGPROXY_SALT
 * and use the signature-based URL pattern).
 *
 * Docs: https://docs.imgproxy.net/
 */

const IMGPROXY_BASE = process.env.IMGPROXY_PUBLIC_URL || process.env.IMGPROXY_URL || 'http://localhost:8080';

export type ImgproxyOptions = {
  width?: number;
  height?: number;
  /** resize mode: 'fit' (preserve aspect, fit in box), 'fill' (cover, crop), 'force' (stretch) */
  resize?: 'fit' | 'fill' | 'force';
  /** for fill mode: gravity for crop. 'sm' = smart, 'ce' = center, 'no' = north */
  gravity?: 'sm' | 'ce' | 'no' | 'so' | 'ea' | 'we';
  format?: 'webp' | 'avif' | 'jpg' | 'png';
  quality?: number;
  /** enlarge if source smaller than requested size */
  enlarge?: boolean;
  /** dpr scaling */
  dpr?: number;
  /** text watermark (proves provenance / discourages download-and-claim) */
  watermark?: {
    text: string;
    /** 0..100 (percent). Converted to imgproxy's 0..1 range. */
    opacity?: number;
    position?: 'north' | 'south' | 'east' | 'west' | 'northeast' | 'northwest' | 'southeast' | 'southwest' | 'center';
    scale?: number; // 0..100, default ~15
  };
};

/**
 * Build an imgproxy URL from a stored upload path (e.g. 'abc-uuid.jpg').
 * The source is treated as a file on imgproxy's local filesystem at /uploads/.
 *
 * URL shape: /<signature>/<processing>/<base64url-encoded source>
 *
 * imgproxy requires the source to be URL-safe-base64 encoded. Plain sources
 * like `local:///path` only work with the `plain` processing option and break
 * once any other option is added — the URL parser mistakes `local` for a
 * processing option name. Encoding the source guarantees correct parsing.
 */
export function imgproxyUrl(uploadPath: string, opts: ImgproxyOptions = {}): string {
  const processing = buildProcessing(opts);
  const safePath = uploadPath.replace(/^\/+/, '');
  const source = `local:///${safePath}`;
  // URL-safe base64 (RFC 4648 §5) — strip padding
  const encoded = Buffer.from(source)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${IMGPROXY_BASE}/unsafe/${processing}/${encoded}`;
}

/**
 * Build a srcset string for responsive images.
 * @param widths sorted ascending list of widths
 */
export function imgproxySrcset(uploadPath: string, widths: number[], opts: Omit<ImgproxyOptions, 'width'> = {}): string {
  return widths.map((w) => `${imgproxyUrl(uploadPath, { ...opts, width: w })} ${w}w`).join(', ');
}

function buildProcessing(opts: ImgproxyOptions): string {
  const parts: string[] = [];

  // resize:fit:W:H / resize:fit:W (width-only) / resize:fit::H (height-only)
  if (opts.width || opts.height) {
    const resize = opts.resize || 'fit';
    const w = opts.width;
    const h = opts.height;
    if (w && h) {
      parts.push(`resize:${resize}:${w}:${h}`);
    } else if (w) {
      parts.push(`resize:${resize}:${w}`);
    } else if (h) {
      parts.push(`resize:${resize}::${h}`);
    }
    if (resize === 'fill' && opts.gravity) {
      parts.push(`gravity:${opts.gravity}`);
    }
  }

  if (opts.enlarge) parts.push('enlarge:1');
  if (opts.dpr) parts.push(`dpr:${opts.dpr}`);
  if (opts.quality) parts.push(`quality:${opts.quality}`);
  if (opts.format) parts.push(`format:${opts.format}`);

  // NOTE: imgproxy open-source v3 only supports image-based watermarks (Pro
  // feature for text). The `watermark:text:` URL option would be ignored
  // and the parser mis-reads it as the basic `watermark:opacity` argument.
  // We use the server-side /api/proof/[id] endpoint instead (see image-adapter).
  // This option is kept here for when imgproxy Pro is added later.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  if (false && opts.watermark) {
    const w = opts.watermark;
    const encoded = Buffer.from(w.text, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    parts.push(`watermark:text:${encoded}`);
    if (w.opacity !== undefined) parts.push(`watermark:opacity:${(w.opacity / 100).toFixed(2)}`);
    if (w.scale !== undefined) parts.push(`watermark:scale:${w.scale}`);
    const posMap: Record<string, string> = {
      north: 'no', south: 'so', east: 'ea', west: 'we',
      northeast: 'noea', northwest: 'nowe', southeast: 'soea', southwest: 'sowe',
      center: 'ce',
    };
    if (w.position) parts.push(`watermark:gravity:${posMap[w.position] || 'soea'}`);
  }

  return parts.length ? parts.join('/') : 'plain';
}

/** Standard widths for gallery thumbnails (matches common device pixel ratios) */
export const DEFAULT_THUMB_WIDTHS = [320, 480, 640, 960, 1280];

/** Standard widths for lightbox full-screen images */
export const DEFAULT_FULL_WIDTHS = [1280, 1920, 2560];
