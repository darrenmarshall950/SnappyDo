import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/pages/admin/edit/[id].astro', import.meta.url), 'utf8');

assert.match(page, /<option value="">No preset<\/option>/, 'the initial preset picker must offer No preset');
assert.match(editor, /sel\.innerHTML\s*=\s*'<option value="">No preset<\/option>'/, 'async preset loading must preserve the No preset option');

const handlerStart = editor.indexOf("presetSelect.addEventListener('change'");
assert.ok(handlerStart >= 0, 'preset change handler must exist');
const handler = editor.slice(handlerStart, editor.indexOf('// Detect LUT replacement', handlerStart));
assert.match(handler, /if \(!id\)\s*\{[\s\S]*?preset_id\s*=\s*undefined[\s\S]*?return;/, 'choosing No preset must detach the preset association');
assert.doesNotMatch(handler, /resetAllStateAndUi\(|applyPresetToState\(/, 'choosing No preset must keep the current edit values');

console.log('No preset detaches the selected preset without resetting current edits');
