import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const branch = source.match(/if \(hasLut\) \{[\s\S]{0,1800}applyLutToRgbaAsync/);
assert.ok(branch, 'LUT branch must exist');
const code = branch[0];
const sourcePixels = code.indexOf('const imgData = ctx.getImageData');
const cachedFrame = code.indexOf('ctx.putImageData(_lastLutPreview');
assert.ok(sourcePixels >= 0 && cachedFrame >= 0 && sourcePixels < cachedFrame,
  'capture the ungraded current adjustment pixels before displaying a retained LUT frame; otherwise each worker pass grades the previous LUT result again');
console.log('desktop LUT worker input is always the ungraded current adjustment frame');
