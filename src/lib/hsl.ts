/**
 * Server-side HSL Color Mixer + Color Grading helpers.
 * Used by the sharp-based render path in edit.ts.
 */

export interface HslRange { h: number; s: number; l: number; }

export interface ColorGradingData {
  shadows_colour: number[];
  midtones_colour: number[];
  highlights_colour: number[];
  global_colour: number[];
  shadows_intensity: number;
  midtones_intensity: number;
  highlights_intensity: number;
  global_intensity: number;
  mode: 'saturation' | 'luminance';
}

export type HslData = Record<string, HslRange>;

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn);
  const mn = Math.min(rn, gn, bn);
  const l = (mx + mn) / 2;
  let s = 0, h = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (mx === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return [h, s, l];
}

function hueDist(h1: number, h2: number): number {
  const d = Math.abs(h2 - h1);
  return d > 0.5 ? 1 - d : d;
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-5) return [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const norm = (v: number) => {
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 0.5) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  const r = norm(h + 1 / 3);
  const g = norm(h);
  const b = norm(h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const RANGE_CENTERS: [string, number][] = [
  ['red', 0 / 8], ['orange', 1 / 8], ['yellow', 2 / 8], ['green', 3 / 8],
  ['aqua', 4 / 8], ['blue', 5 / 8], ['purple', 6 / 8], ['magenta', 7 / 8],
];

export function isHslFlat(hslData: HslData | undefined): boolean {
  if (!hslData) return true;
  for (const key of Object.keys(hslData)) {
    const r = hslData[key];
    if (Math.abs(r.h) > 1e-4 || Math.abs(r.s) > 1e-4 || Math.abs(r.l) > 1e-4) return false;
  }
  return true;
}

/**
 * Apply HSL Color Mixer to an RGB pixel.
 * @param r,g,b Input 0..255
 * @param hslData Record of hsl_<name> → {h,s,l} each in -100..100
 */
export function applyHslToRgb(
  r: number, g: number, b: number,
  hslData: HslData,
): [number, number, number] {
  if (isHslFlat(hslData)) return [r, g, b];
  const rn = r / 255, gn = g / 255, bn = b / 255;
  let [h, s, l] = rgb2hsl(rn, gn, bn);
  const RANGE = 0.125;
  for (const [name, centerH] of RANGE_CENTERS) {
    const key = 'hsl_' + name;
    const range = hslData[key];
    if (!range) continue;
    const dH = range.h / 100;
    const dS = range.s / 100;
    const dL = range.l / 100;
    if (Math.abs(dH) < 1e-5 && Math.abs(dS) < 1e-5 && Math.abs(dL) < 1e-5) continue;
    const d = hueDist(h, centerH);
    const w = 1 - Math.max(0, Math.min(1, (d - 0) / RANGE));
    h = (h + dH * w) % 1;
    if (h < 0) h += 1;
    s = Math.max(0, Math.min(1, s + dS * w));
    l = Math.max(0, Math.min(1, l + dL * w));
  }
  return hsl2rgb(h, s, l);
}

function luminance(r: number, g: number, b: number): number {
  return (r * 2126 + g * 7152 + b * 722) / 10000 / 255;
}

/**
 * Apply Lightroom-style color grading to an RGB pixel.
 */
export function applyColorGradingToRgb(
  r: number, g: number, b: number,
  cg: ColorGradingData,
): [number, number, number] {
  const lum = luminance(r, g, b);
  const shI = cg.shadows_intensity / 100;
  const miI = cg.midtones_intensity / 100;
  const hiI = cg.highlights_intensity / 100;
  const glI = cg.global_intensity / 100;

  if (shI <= 0 && miI <= 0 && hiI <= 0 && glI <= 0) return [r, g, b];

  const shadowsMask = 1 - Math.max(0, Math.min(1, lum / 0.35));
  const highlightsMask = Math.max(0, Math.min(1, (lum - 0.65) / 0.35));
  const midtonesMask = Math.max(0, Math.min(1, 1 - shadowsMask - highlightsMask));

  const sc = cg.shadows_colour;
  const mc = cg.midtones_colour;
  const hc = cg.highlights_colour;
  const gc = cg.global_colour;

  let rOut = r, gOut = g, bOut = b;

  const applyTint = (mask: number, intensity: number, colour: number[], amount: number) => {
    if (intensity <= 0 || amount <= 0) return;
    const dr = (colour[0] ?? 0) / 255 - 0.5;
    const dg = (colour[1] ?? 0) / 255 - 0.5;
    const db = (colour[2] ?? 0) / 255 - 0.5;
    rOut += dr * mask * intensity * amount;
    gOut += dg * mask * intensity * amount;
    bOut += db * mask * intensity * amount;
  };

  applyTint(shadowsMask, shI, sc, 1);
  applyTint(midtonesMask, miI, mc, 1);
  applyTint(highlightsMask, hiI, hc, 1);

  if (glI > 0 && gc) {
    rOut += ((gc[0] ?? 0) / 255) * glI * 127.5;
    gOut += ((gc[1] ?? 0) / 255) * glI * 127.5;
    bOut += ((gc[2] ?? 0) / 255) * glI * 127.5;
  }

  return [
    Math.max(0, Math.min(255, Math.round(rOut))),
    Math.max(0, Math.min(255, Math.round(gOut))),
    Math.max(0, Math.min(255, Math.round(bOut))),
  ];
}
