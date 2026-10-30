import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const cropStart = source.indexOf('// ---- Crop drag (works on the canvas) ----');
assert.ok(cropStart >= 0, 'crop drag implementation must exist');
const crop = source.slice(cropStart, source.indexOf('// Aspect ratio presets', cropStart));
const downStart = crop.indexOf('function onDown(e)');
assert.ok(downStart >= 0, 'crop pointer-down handler must exist');
const down = crop.slice(downStart, crop.indexOf('function onMove(e)', downStart));

const guard = down.indexOf("if (zoomMode !== 'fit') return;");
const position = down.indexOf('const p = getPos(e);');
assert.ok(
  guard >= 0 && guard < position,
  'a zoomed canvas drag must return before it initialises crop state'
);

console.log('zoomed panning cannot activate the crop drag handler');
