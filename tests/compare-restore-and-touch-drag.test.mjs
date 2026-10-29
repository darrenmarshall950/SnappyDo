import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

// Compare (hold-to-see-original) must restore the EDITED preview on release.
// If the release path just redraws whatever is on the canvas, the edited
// image "disappears" the moment the user lets go.
const compare = source.match(/function setComparing\(v[\s\S]{0,900}?\n      \}/);
assert.ok(compare, 'setComparing must exist');
assert.match(compare[0], /_sharpenCacheKey = -1/, 'releasing compare must invalidate the cached source so the graded image is rebuilt');

// Phone: a finger drag on the curve must move the curve. iOS does not deliver
// mousemove during a touch drag, so touch handlers are required.
assert.match(source, /svg\.addEventListener\('touchstart'/, 'the curve must accept touchstart for phone drags');
assert.match(source, /svg\.addEventListener\('touchmove'/, 'the curve must track touchmove for phone drags');
assert.match(source, /svg\.addEventListener\('touchend'/, 'the curve must end a touch drag');

console.log('compare restores the edited preview and the curve accepts touch drags');
