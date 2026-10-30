import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const schedulerStart = source.indexOf('function scheduleAuthoritativePreview');
const drawStart = source.indexOf('function drawLegacy');
assert.ok(schedulerStart >= 0, 'authoritative-preview scheduler must exist');
assert.ok(drawStart >= 0, 'legacy draw path must exist');

const scheduler = source.slice(schedulerStart, drawStart);
assert.doesNotMatch(
  scheduler,
  /authoritativePreviewReady\s*=\s*false/,
  'a slider update must retain the last completed server preview while the replacement is rendering'
);

const draw = source.slice(drawStart, source.indexOf('// For RAW images', drawStart));
assert.match(draw, /authoritativePreviewReady/, 'draw path must use the retained authoritative frame');
assert.doesNotMatch(
  draw,
  /authoritativePreviewKey\s*===\s*renderStateKey\(\)/,
  'draw path must not hide the last edited frame merely because a slider has a newer value'
);
assert.match(draw, /!state\.crop/, 'retained overlay must still be skipped for crop geometry');
assert.match(draw, /!\(state as any\)\.straighten/, 'retained overlay must still be skipped for straighten geometry');
assert.match(draw, /!comparing/, 'Compare must still show the untouched original');

console.log('authoritative preview remains visible while a newer slider render is pending');
