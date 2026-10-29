import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const block = source.match(/async function scheduleAuthoritativePreview\(\)[\s\S]*?\n      }\n\n      document\.querySelectorAll\('\.slider'\)/)?.[0];
assert.ok(block, 'authoritative preview scheduler must exist');
assert.doesNotMatch(block, /sourceImage\.src\s*=\s*url/, 'authoritative result must not replace editable source image');
assert.match(block, /authoritativePreviewImage|authoritativePreviewCanvas|authoritativePreviewUrl/, 'authoritative result must use a separate presentation state');
assert.match(source, /sourceImage\.src\s*=\s*sourceUrl/, 'editable source must remain bound to original source');
console.log('authoritative preview preserves original editable source');
