import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

assert.match(source, /const MAX_ZOOM_PREVIEW_PIXELS\s*=\s*\d[\d_]*;/,
  'zoom preview must enforce a finite pixel budget instead of rendering every source pixel');
assert.match(source, /Math\.sqrt\(MAX_ZOOM_PREVIEW_PIXELS\s*\/\s*sourcePixels\)/,
  'zoom backing scale must derive from the source pixel count');
assert.match(source, /canvas\.style\.width\s*=\s*sourceImage\.width\s*\+\s*'px'/,
  '100% zoom must preserve source-space visual dimensions while using the capped backing buffer');
assert.match(source, /const visualW = sourceImage\.width \* z;/,
  'pan bounds must use the CSS visual size rather than the capped backing size');
assert.match(source, /const visualH = sourceImage\.height \* z;/,
  'pan bounds must use the CSS visual size rather than the capped backing size');

console.log('zoom preview caps render work while retaining source-space pan geometry');
