import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRenderRecipe } from '../src/lib/render-recipe.ts';

const state = {
  exposure: 12,
  lut_id: 7,
  preset_id: 4,
  crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
  snapshots: [{ name: 'UI-only' }],
  history: [{ label: 'UI-only' }],
  _appliedCrop: { left: 12 },
  _appliedLut: { id: 7 },
};
const curve = { rgb: [[0, 0], [255, 255]] };
const recipe = buildRenderRecipe(state, curve);

assert.equal(recipe.version, 1);
assert.deepEqual(recipe.params, {
  exposure: 12,
  lut_id: 7,
  preset_id: 4,
  crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 },
  curve,
});
assert.notStrictEqual(recipe.params, state, 'recipe must not alias live editor state');
assert.notStrictEqual(recipe.params.crop, state.crop, 'recipe must not alias nested edit state');

const editor = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(editor, /import\s*\{\s*buildRenderRecipe\s*\}\s*from\s*["']\.\/render-recipe["']/);
assert.match(editor, /const recipe = buildRenderRecipe\(state, _cvData\);/);
assert.match(editor, /body:\s*JSON\.stringify\(\{\s*recipe\s*\}\)/, 'preview must send the serialized recipe');
assert.match(editor, /body:\s*JSON\.stringify\(\{\s*recipe,\s*sourceUrl\s*\}\)/, 'save must send the same serialized recipe');

for (const file of [
  '../src/pages/api/images/[id]/preview-edit.ts',
  '../src/pages/api/images/[id]/edit.ts',
]) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /body\?\.recipe\?\.params\s*\?\?\s*body\?\.params/, `${file} must accept the versioned recipe and legacy params`);
}

console.log('render recipe is cloned, normalized, and shared by preview and save');
