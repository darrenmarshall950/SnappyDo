import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const init = source.match(/function _cvInit\(\) \{[\s\S]{0,4200}?\n  \}/);
assert.ok(init, 'tone-curve interaction setup must exist');
assert.match(init[0], /svg\.addEventListener\('mousedown'/, 'tone curve must start its established drag handler');
assert.match(init[0], /window\.addEventListener\('mousemove'/, 'tone curve must keep receiving drag motion outside the SVG');
console.log('tone curve retains its established cross-device drag events');
