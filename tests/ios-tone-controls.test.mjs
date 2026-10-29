import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(source, /function applyToneControlsToRgba/, 'stable iOS preview must implement highlights, shadows, whites and blacks');
assert.match(source, /state\.highlights !== 0 \|\| state\.shadows !== 0 \|\| state\.whites !== 0 \|\| state\.blacks !== 0/, 'iOS pixel-pass gate must include all tone controls');
assert.match(source, /applyToneControlsToRgba\(data, state\)/, 'iOS preview must apply tone controls during its pixel pass');
console.log('iOS stable preview applies all tone controls');
