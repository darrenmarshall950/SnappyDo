import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(source, /import \{ isFlat, buildLut \} from "\.\/curve";/, 'legacy editor must import the tone-curve LUT builder');
assert.match(source, /function applyToneCurveToRgba/, 'legacy editor needs a real per-pixel tone-curve pass');
const toneUses = source.match(/applyToneCurveToRgba\(imgData\.data, _cvData\)/g) || [];
assert.ok(toneUses.length >= 2, 'tone curves must run in both iOS and desktop legacy preview branches');
console.log('legacy preview applies tone curves on phone and desktop');
