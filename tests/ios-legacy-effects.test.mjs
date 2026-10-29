import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(source, /const _gl2 = null;/, 'iOS must use the shared stable 2D effects pipeline');
assert.match(source, /function applyDehazeToRgba/, 'the stable pipeline must retain dehaze support');
assert.match(source, /applyLutToRgba/, 'the stable pipeline must retain LUT support');
console.log('iOS editor chooses the stable 2D effects pipeline');
