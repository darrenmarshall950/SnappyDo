// Regression test: the editor's draw() dispatcher must fall back to the
// legacy 2D pipeline when the WebGL pipeline cannot render (no WebGL2
// context, shader compile error, init returned false, etc.).
//
// Bug history: Daz reported presets/sharpen/dehaze "no longer have effect"
// on the image. The cause was that draw() called drawWebGL() and then
// returned unconditionally — if drawWebGL returned false (which it does
// silently when the pipeline init fails), the canvas was never updated
// and the user saw no visible change from sliders/presets.
//
// Fix:
//   1. draw() now awaits drawWebGL().then((ok) => { if (!ok) drawLegacy(); ... })
//   2. drawLegacy() must accept dehaze as a slider (the WebGL shader does
//      haze = min(r,g,b); out = (in/255 - dehaze * 0.003 * haze) * 255).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

// 1. draw() must call drawWebGL() and follow up with drawLegacy() in the
//    rejected / false case. We assert on the structure rather than running
//    the code (editor.ts is browser-only).
assert.match(source,
  /drawWebGL\(\)\.then\(\(ok\)\s*=>\s*\{[\s\S]{0,200}if\s*\(!ok\)\s*\{[\s\S]{0,80}drawLegacy\(\)/,
  'draw() must fall back to drawLegacy() when drawWebGL resolves to false');

// 2. draw() must also have a .catch for the synchronous-throw case so the
//    user still sees something if drawWebGL throws.
assert.match(source,
  /drawWebGL\(\)\.then[\s\S]{0,500}\.catch\(\(err\)\s*=>\s*\{[\s\S]{0,200}drawLegacy\(\)/,
  'draw() must catch drawWebGL throws and fall back to drawLegacy()');

// 3. A local applyDehazeToRgba helper must exist in editor.ts so the
//    legacy 2D pipeline can apply dehaze when WebGL is unavailable.
assert.match(source,
  /function\s+applyDehazeToRgba\s*\(\s*data\s*,\s*dehaze\s*\)\s*\{/,
  'editor.ts must define a local applyDehazeToRgba helper');

// 4. The dehaze algorithm must mirror the WebGL shader:
//      haze = min(r,g,b) / 255
//      hazeAmount = dehaze * 0.003 * haze
//      out = (in/255 - hazeAmount) * 255
// We assert on the constants and the structure rather than running code.
const dehazeBlock = source.match(/function\s+applyDehazeToRgba\s*\(\s*data\s*,\s*dehaze\s*\)\s*\{[\s\S]*?\n\s{6}\}/);
assert.ok(dehazeBlock, 'applyDehazeToRgba body must be findable');
const dh = dehazeBlock[0];
assert.match(dh, /0\.003/, 'dehaze constant must be 0.003 (matches WebGL shader)');
assert.match(dh, /Math\.min\(r,\s*Math\.min\(g,\s*b\)\)/, 'haze must be min(r,g,b)');
assert.match(dh, /255/, 'pixel values must be normalised against 255');

// 5. drawLegacy() must call applyDehazeToRgba when state.dehaze is non-zero
//    — otherwise the slider does nothing in legacy mode.
assert.match(source,
  /hasDehaze[\s\S]{0,80}applyDehazeToRgba\([\s\S]{0,40}state\.dehaze/,
  'drawLegacy() must call applyDehazeToRgba(state.dehaze) when state.dehaze is non-zero');

// 6. The fast path (no sharpen/lut/sliders/dehaze) must still bypass
//    the per-pixel work. Adding hasDehaze to the gating variable must not
//    accidentally force every draw to do pixel work.
assert.match(source,
  /const needsPixelPass = hasSliderWork \|\| hasLut \|\| hasDehaze;/,
  'pixel-pass gate must include hasDehaze alongside hasSliderWork and hasLut');

console.log('editor draw() falls back to legacy when WebGL is unavailable');
