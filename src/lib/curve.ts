// curve.ts — Pure-JS tone curve engine.
//
// Model:
//   CurveChannel = [x: 0..255, y: 0..255][]
//   CurveData    = { rgb?, r?, g?, b?: CurveChannel }
//
// Pipeline position: after exposure/contrast/brightness, before saturation.
// This matches Lightroom's linear-light application order.
//
export interface CurvePoint { 0: number; 1: number; }
export type CurveChannel = CurvePoint[];
export interface CurveData {
  rgb?: CurveChannel; r?: CurveChannel; g?: CurveChannel; b?: CurveChannel;
}

// Identity LUT (shared, lazily built once)
let _identityLut: Float32Array | null = null;
function _getIdentityLut(): Float32Array {
  if (_identityLut) return _identityLut;
  _identityLut = new Float32Array(256);
  for (let i = 0; i < 256; i++) _identityLut[i] = i / 255;
  return _identityLut;
}

/** Build a 256-point float LUT from control points. Piecewise-linear interpolation. */
export function buildLut(ch: CurveChannel | undefined): Float32Array {
  if (!ch || ch.length === 0) return new Float32Array(_getIdentityLut());
  const pts = [...ch].sort((a, b) => a[0] - b[0]) as CurveChannel;
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const lut = new Float32Array(256);
  for (let x = 0; x < 256; x++) {
    if (x <= x0) { lut[x] = pts[0][1] / 255; continue; }
    if (x >= x1) { lut[x] = pts[pts.length - 1][1] / 255; continue; }
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] <= x) lo = mid; else hi = mid;
    }
    const xLo = pts[lo][0], yLo = pts[lo][1];
    const xHi = pts[hi][0], yHi = pts[hi][1];
    const t = (xHi === xLo) ? 0 : (x - xLo) / (xHi - xLo);
    lut[x] = (yLo + t * (yHi - yLo)) / 255;
  }
  return lut;
}

/** True if this channel has no user-adjustable curve (identity). */
export function isIdentity(ch: CurveChannel | undefined): boolean {
  if (!ch || ch.length === 0) return true;
  if (ch.length === 2 && ch[0][0] === 0 && ch[0][1] === 0 &&
      ch[1][0] === 255 && ch[1][1] === 255) return true;
  return false;
}

/** True if all four channels are identity — skip GPU curve pass. */
export function isFlat(curve: CurveData): boolean {
  return isIdentity(curve?.rgb) && isIdentity(curve?.r) &&
         isIdentity(curve?.g) && isIdentity(curve?.b);
}

export function validate(curve: unknown): { ok: boolean; error?: string } {
  if (curve === null || curve === undefined) return { ok: true };
  if (typeof curve !== 'object') return { ok: false, error: 'must be null or object' };
  const c = curve as Record<string, unknown>;
  for (const ch of ['rgb', 'r', 'g', 'b'] as const) {
    const v = c[ch];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return { ok: false, error: `${ch} must be array` };
    for (const pt of v) {
      if (!Array.isArray(pt) || pt.length !== 2)
        return { ok: false, error: `${ch} points must be [x,y]` };
      const [x, y] = pt as [number, number];
      if (typeof x !== 'number' || typeof y !== 'number')
        return { ok: false, error: `${ch} coords must be numbers` };
      if (x < 0 || x > 255 || y < 0 || y > 255)
        return { ok: false, error: `${ch} coords must be 0..255` };
    }
  }
  return { ok: true };
}

export function toDisplayable(curve: CurveData): string {
  if (isFlat(curve)) return 'Linear';
  const parts: string[] = [];
  if (!isIdentity(curve?.rgb)) parts.push('RGB');
  if (!isIdentity(curve?.r)) parts.push('R');
  if (!isIdentity(curve?.g)) parts.push('G');
  if (!isIdentity(curve?.b)) parts.push('B');
  return parts.join('+') + ' curve';
}
