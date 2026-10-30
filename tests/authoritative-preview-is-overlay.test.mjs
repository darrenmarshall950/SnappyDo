import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

// The authoritative (server-rendered) preview must NOT replace the editor's
// source image. The server render already contains every edit — curve, LUT,
// sliders, dehaze. If it replaces the source, the local renderer applies the
// same edits a SECOND time on top of the already-graded pixels, so the curve
// lands twice (measured: server 104.82 -> canvas 81.34).
//
// It also breaks Compare, which must show the untouched original: once the
// source is the graded blob, "compare" shows the graded image instead.
//
// The authoritative preview therefore has to be a DISPLAY overlay.

assert.match(
  source,
  /authoritativePreviewImage/,
  'the authoritative preview must be kept in a separate display image'
);

// The scheduler itself must never assign to sourceImage.src.
const schedStart = source.indexOf('function scheduleAuthoritativePreview');
assert.ok(schedStart >= 0, 'scheduleAuthoritativePreview must exist');
const schedEnd = source.indexOf('\n      }\n', schedStart);
const sched = source.slice(schedStart, schedEnd > 0 ? schedEnd : schedStart + 3000);
assert.ok(
  !/sourceImage\.src\s*=/.test(sched),
  'the authoritative preview scheduler must never assign to sourceImage.src'
);
assert.match(
  sched,
  /authoritativePreviewImage\.src\s*=\s*url/,
  'the authoritative preview must be assigned to the display overlay image'
);

// The last completed overlay stays visible while a replacement is rendering,
// so a slider cannot flash the original image between server renders.
const scheduler = source.slice(schedStart, source.indexOf('\n      }\n', schedStart) + '\n      }\n'.length);
assert.doesNotMatch(
  scheduler,
  /authoritativePreviewReady\s*=\s*false/,
  'scheduling a replacement preview must retain the completed overlay'
);

// The draw path must show the overlay verbatim rather than re-grading it.
assert.match(
  source,
  /authoritativePreviewImage\.complete\s*&&\s*!!authoritativePreviewImage\.naturalWidth/,
  'the draw path must detect a ready authoritative preview'
);
assert.match(
  source,
  /ctx\.drawImage\(authoritativePreviewImage/,
  'the draw path must display the authoritative preview verbatim'
);

console.log('authoritative preview is a display overlay and never overwrites the source');
