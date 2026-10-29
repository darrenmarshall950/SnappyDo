import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

// Changing the curve outside a drag (Reset / add point / remove point) must
// repaint the image, otherwise the canvas keeps showing the previously graded
// pixels even though the curve has been cleared.
const reset = source.match(/function _cvReset\(\) \{[\s\S]{0,900}?\n  \}/);
assert.ok(reset, '_cvReset must exist');
assert.match(reset[0], /scheduleDraw\(\)/, 'resetting the curve must redraw the image preview');

const addPt = source.match(/function _cvAddPt\([\s\S]{0,900}?\n  \}/);
assert.ok(addPt, '_cvAddPt must exist');
assert.match(addPt[0], /scheduleDraw\(\)/, 'adding a curve point must redraw the image preview');

const rmPt = source.match(/function _cvRmPt\([\s\S]{0,700}?\n  \}/);
assert.ok(rmPt, '_cvRmPt must exist');
assert.match(rmPt[0], /scheduleDraw\(\)/, 'removing a curve point must redraw the image preview');

console.log('curve reset, add and remove all repaint the image preview');
