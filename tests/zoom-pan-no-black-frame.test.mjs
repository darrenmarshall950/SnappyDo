import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const panStart = source.indexOf('function applyPanTransform()');
assert.ok(panStart >= 0, 'zoom panning helper must exist');
const panEnd = source.indexOf("window.addEventListener('mousemove'", panStart);
const pan = source.slice(panStart, panEnd);

assert.match(pan, /canvas\.style\.left\s*=\s*panX\s*\+\s*'px'/, 'panning must move the canvas with left positioning');
assert.match(pan, /canvas\.style\.top\s*=\s*panY\s*\+\s*'px'/, 'panning must move the canvas with top positioning');
assert.doesNotMatch(pan, /translate\(/, 'panning must not GPU-translate the canvas because it can black-frame during a drag');

const zoomStart = source.indexOf('function fitCanvasToArea()');
const zoomEnd = source.indexOf('// Apply LUT in pixel space', zoomStart);
const zoom = source.slice(zoomStart, zoomEnd);
assert.match(zoom, /canvas\.style\.transform\s*=\s*z\s*===\s*1\s*\?\s*''\s*:\s*'scale\('/, '100% zoom must avoid a canvas transform while higher zooms retain scale only');

console.log('zoom pan uses stable positioning instead of a transient canvas translation');
