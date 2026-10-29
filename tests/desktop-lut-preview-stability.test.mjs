import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(source, /let _lastLutPreview/, 'desktop LUT preview needs a retained frame while the worker computes');
const desktopLut = source.match(/if \(hasLut\) \{[\s\S]{0,1000}applyLutToRgbaAsync/);
assert.ok(desktopLut, 'desktop async LUT branch must exist');
assert.match(desktopLut[0], /_lastLutPreview/, 'desktop LUT branch must draw the previous LUT frame instead of flashing the ungraded source');
console.log('desktop LUT preview retains its graded frame during async updates');
