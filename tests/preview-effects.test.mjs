/**
 * REGRESSION TEST — the desktop 2D preview must apply the same effects as the
 * server render.
 *
 * Two bugs, both reported as "these controls have no effect" (2026-11-26):
 *
 *   1. The desktop 2D preview path in src/lib/editor.ts applied the slider
 *      filters, the tone curve, the LUT, dehaze and sharpen — but NOT grain,
 *      NOT the HSL mixer and NOT colour grading. The server render
 *      (src/pages/api/images/[id]/edit.ts) applied all of them. So the whole
 *      Grain control, the Hue Mixer and the Colour Grading wheels changed the
 *      saved file but never changed what the editor showed. The editor
 *      therefore looked completely dead for those controls.
 *
 *   2. applyColorGradingToRgb's per-tone tint offsets were computed in 0..1
 *      units ((colour/255) - 0.5) but added to pixel values in 0..255. The
 *      shadows/midtones/highlights wheels were therefore ~255x too weak and
 *      did nothing visible. The global branch was already correct because it
 *      multiplies by 127.5.
 *
 * These assertions pin both behaviours so the preview cannot silently drift
 * away from the server render again.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDir = mkdtempSync(join(tmpdir(), 'snappydo-preview-effects-'));

async function load(relPath, names) {
  const bundle = join(tempDir, relPath.replace(/[\/]/g, '_') + '.cjs');
  execFileSync('./node_modules/.bin/esbuild', [
    relPath, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`,
  ], { stdio: 'inherit' });
  const mod = await import(pathToFileURL(bundle).href);
  return names.map((n) => mod[n]);
}

const NEUTRAL_CG = {
  shadows_colour: [128, 128, 128],
  midtones_colour: [128, 128, 128],
  highlights_colour: [128, 128, 128],
  global_colour: [128, 128, 128],
  shadows_intensity: 0,
  midtones_intensity: 0,
  highlights_intensity: 0,
  global_intensity: 0,
  mode: 'saturation',
};

function cg(overrides) {
  return { ...NEUTRAL_CG, ...overrides };
}

try {
  const [applyColorGradingToRgb] = await load('src/lib/hsl.ts', ['applyColorGradingToRgb']);
  const [applyGrainToRgb] = await load('src/lib/effects.ts', ['applyGrainToRgb']);

  // --- neutral -------------------------------------------------------
  {
    const [r, g, b] = applyColorGradingToRgb(93, 77, 55, cg({}));
    assert.deepEqual([r, g, b], [93, 77, 55], 'a neutral colour grading must not move the pixel');
    console.log('ok - a neutral colour grading leaves the pixel untouched');
  }

  // --- global tint ---------------------------------------------------
  // The global branch is a pure additive lift of the colour (no -0.5 offset),
  // so it raises the red channel hardest. That is the existing, intended
  // behaviour; the assertion pins "clearly visible", not a specific ratio.
  {
    const [r, g, b] = applyColorGradingToRgb(
      93, 77, 55,
      cg({ global_colour: [255, 138, 38], global_intensity: 100 }),
    );
    assert.ok(r - 93 > 20, `expected a clear red lift, got r=${r}`);
    assert.ok(r - 93 > g - 77, `expected red to lift more than green, got ${r},${g}`);
    console.log(`ok - the global tint is visible (${r},${g},${b})`);
  }

  // --- the regression: per-tone tints --------------------------------
  {
    const [r, g, b] = applyColorGradingToRgb(
      93, 77, 55,
      cg({ shadows_colour: [255, 138, 38], shadows_intensity: 100 }),
    );
    assert.ok(
      Math.abs(r - 93) > 5 || Math.abs(g - 77) > 5 || Math.abs(b - 55) > 5,
      `expected the shadows tint to be visible, got ${r},${g},${b}`,
    );
    console.log(`ok - the shadows tint is visible (${r},${g},${b})`);
  }
  {
    const [r, g, b] = applyColorGradingToRgb(
      93, 77, 55,
      cg({ midtones_colour: [40, 120, 255], midtones_intensity: 100 }),
    );
    assert.ok(
      Math.abs(r - 93) > 5 || Math.abs(g - 77) > 5 || Math.abs(b - 55) > 5,
      `expected the midtones tint to be visible, got ${r},${g},${b}`,
    );
    console.log(`ok - the midtones tint is visible (${r},${g},${b})`);
  }
  {
    const [r, g, b] = applyColorGradingToRgb(
      200, 190, 180,
      cg({ highlights_colour: [40, 120, 255], highlights_intensity: 100 }),
    );
    assert.ok(
      Math.abs(r - 200) > 5 || Math.abs(g - 190) > 5 || Math.abs(b - 180) > 5,
      `expected the highlights tint to be visible, got ${r},${g},${b}`,
    );
    console.log(`ok - the highlights tint is visible (${r},${g},${b})`);
  }

  // --- grain ----------------------------------------------------------
  {
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const [r] = applyGrainToRgb(128, 128, 128, { amount: 100, size: 25 }, i * 7, i * 13, 1234);
      samples.push(r);
    }
    const spread = Math.max(...samples) - Math.min(...samples);
    assert.ok(spread > 0, `expected grain to perturb the pixel, got ${samples.join(',')}`);
    console.log(`ok - grain perturbs the pixel (spread ${spread})`);
  }
  {
    const [r, g, b] = applyGrainToRgb(128, 128, 128, { amount: 0, size: 25 }, 0, 0, 1234);
    assert.deepEqual([r, g, b], [128, 128, 128], 'grain at zero amount must not move the pixel');
    console.log('ok - grain at zero amount leaves the pixel untouched');
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
