import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(source, /import \{ isFlat, applyToneCurveToRgba \} from "\.\/curve";/, 'legacy editor must import the shared tone-curve applier');
const toneUses = source.match(/applyToneCurveToRgba\(imgData\.data, _cvData\)/g) || [];
assert.ok(toneUses.length >= 2, 'tone curves must run in both iOS and desktop legacy preview branches');
console.log('legacy preview applies tone curves on phone and desktop');
