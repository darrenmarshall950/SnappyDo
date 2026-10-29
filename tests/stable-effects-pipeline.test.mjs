import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(source, /const _gl2 = null;/, 'the editor must use the single tested 2D effects renderer on every device until the WebGL multi-pass path has full behavioural coverage');
console.log('editor uses the shared stable 2D effects pipeline');
