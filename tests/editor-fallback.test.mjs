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
// Subsequent hardening: once WebGL has failed we set useWebGL=false so
// subsequent draws skip the failing GPU path entirely, and we show a
// one-time status message ("WebGL pipeline unavailable, using 2D
// fallback") so the user knows they're on the slower renderer instead of
// wondering why edits "feel slow".

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

// 1. draw() must call drawWebGL() and follow up with drawLegacy() in the
//    rejected / false case. We assert on the structure rather than running
//    the code (editor.ts is browser-only).
assert.match(source,
  /drawWebGL\(\)\.then\(\(ok\)\s*=>\s*\{[\s\S]{0,800}if\s*\(!ok\)\s*\{[\s\S]{0,500}drawLegacy\(\)/,
  'draw() must fall back to drawLegacy() when drawWebGL resolves to false');

// 2. draw() must also have a .catch for the synchronous-throw case so the
//    user still sees something if drawWebGL throws.
assert.match(source,
  /drawWebGL\(\)\.then[\s\S]{0,800}\.catch\(\(err\)\s*=>\s*\{[\s\S]{0,500}drawLegacy\(\)/,
  'draw() must catch drawWebGL throws and fall back to drawLegacy()');

// 3. Once WebGL has failed, draw() must set useWebGL=false permanently so
//    subsequent draws don't waste time retrying the failing GPU path.
assert.match(source,
  /useWebGL = false/,
  'draw() must flip useWebGL=false when WebGL permanently fails');

// 4. The user must get a visible warning (via setStatus) when WebGL fails
//    — not just a console.warn. Without this they'd be stuck wondering why
//    the editor "feels different" / is slower than expected.
assert.match(source,
  /setStatus\([^)]*WebGL[^)]*fallback/i,
  'draw() must call setStatus with a WebGL fallback message');

// 5. The status message must be shown at most once (gated by _webglWarned),
//    not on every slider tick — otherwise the message would overwrite slider
//    status updates and create a noisy UX.
assert.match(source,
  /_webglWarned\s*=\s*true/,
  '_webglWarned flag must be set when the status message is shown');

// 6. The next-draw fast-path must check _webglFailed so we skip the async
//    .then/.catch entirely once we know WebGL is dead.
assert.match(source,
  /useWebGL && !_webglFailed/,
  'draw() fast-path must skip the WebGL branch when _webglFailed is true');

// 7. A local applyDehazeToRgba helper must exist in editor.ts so the
//    legacy 2D pipeline can apply dehaze when WebGL is unavailable.
assert.match(source,
  /function\s+applyDehazeToRgba\s*\(\s*data\s*,\s*dehaze\s*\)\s*\{/,
  'editor.ts must define a local applyDehazeToRgba helper');

// 8. The dehaze algorithm must mirror the WebGL shader.
//    We assert on the constants and structure rather than running code.
assert.match(source,
  /const haze = Math\.min\(r,\s*Math\.min\(g,\s*b\)\)\s*\/\s*255/,
  'dehaze: must compute haze = min(r,g,b) / 255');
assert.match(source,
  /dehaze\s*\*\s*0\.003\s*\*\s*haze/,
  'dehaze: must use the WebGL shader constant 0.003');
assert.match(source,
  /\(\s*r\s*\/\s*255\s*-\s*hazeAmount\s*\)\s*\*\s*255/,
  'dehaze: must compute out = (in/255 - hazeAmount) * 255');

// 9. drawLegacy() must call applyDehazeToRgba when state.dehaze is non-zero.
assert.match(source,
  /hasDehaze[\s\S]{0,80}applyDehazeToRgba\([\s\S]{0,40}state\.dehaze/,
  'drawLegacy() must call applyDehazeToRgba(state.dehaze) when state.dehaze is non-zero');

// 10. The fast path (no sharpen/lut/sliders/dehaze) must still bypass
//     the per-pixel work. Adding hasDehaze to the gating variable must not
//     accidentally force every draw to do pixel work.
assert.match(source,
  /const needsPixelPass = hasSliderWork \|\| hasLut \|\| hasDehaze;/,
  'pixel-pass gate must include hasDehaze alongside hasSliderWork and hasLut');

console.log('editor draw() falls back to legacy when WebGL is unavailable');
