import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

assert.match(editor, /function beginLocalPreview\(\)/,
  'all non-slider edits need one shared authoritative-overlay invalidation path');

const lutStart = editor.indexOf("lutSelect.addEventListener('change'");
const lutEnd = editor.indexOf('// Show/hide the Delete button', lutStart);
assert.ok(lutStart >= 0 && lutEnd > lutStart, 'LUT change handler must exist');
const lutHandler = editor.slice(lutStart, lutEnd);
assert.match(lutHandler, /beginLocalPreview\(\)/,
  'selecting or clearing a LUT must reveal the new local render rather than a stale authoritative overlay');
assert.match(lutHandler, /scheduleAuthoritativePreview\(\)/,
  'LUT changes must request a matching Sharp preview after the immediate local render');

const presetStart = editor.indexOf("presetSelect.addEventListener('change'");
const presetEnd = editor.indexOf('// Delete Preset button', presetStart);
assert.ok(presetStart >= 0 && presetEnd > presetStart, 'preset change handler must exist');
const presetHandler = editor.slice(presetStart, presetEnd);
assert.match(presetHandler, /presetUndoSnapshot\s*=\s*capturePresetUndoSnapshot\(\)/,
  'applying a preset must save the complete prior edit state');
assert.match(presetHandler, /restorePresetUndoSnapshot\(presetUndoSnapshot\)/,
  'No preset must restore the complete pre-preset edit state');
assert.match(presetHandler, /beginLocalPreview\(\)/,
  'preset changes must reveal their local render immediately');
assert.match(presetHandler, /scheduleAuthoritativePreview\(\)/,
  'preset changes must request a matching Sharp preview');

console.log('LUT and preset changes invalidate stale overlays and No preset restores the pre-preset edit');
