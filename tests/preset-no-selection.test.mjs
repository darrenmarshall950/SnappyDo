import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/pages/admin/edit/[id].astro', import.meta.url), 'utf8');

assert.match(page, /<option value="">No preset<\/option>/, 'the initial preset picker must offer No preset');
assert.match(editor, /sel\.innerHTML\s*=\s*'<option value="">No preset<\/option>'/, 'async preset loading must preserve the No preset option');

const handlerStart = editor.indexOf("presetSelect.addEventListener('change'");
assert.ok(handlerStart >= 0, 'preset change handler must exist');
const handler = editor.slice(handlerStart, editor.indexOf('// Delete Preset button', handlerStart));
assert.match(editor, /let presetUndoSnapshot = null/, 'a pre-preset state must be retained');
assert.match(handler, /presetUndoSnapshot\s*=\s*capturePresetUndoSnapshot\(\)/, 'applying a preset must capture the complete prior edits');
assert.match(handler, /restorePresetUndoSnapshot\(presetUndoSnapshot\)/, 'No preset must restore the prior edits and LUT');
assert.match(handler, /presetUndoSnapshot\s*=\s*null/, 'the one-shot undo snapshot must clear after restoration');

console.log('No preset restores the edits that existed before applying the preset');
