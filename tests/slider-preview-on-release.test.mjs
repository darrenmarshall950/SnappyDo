import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const sliderStart = source.indexOf("document.querySelectorAll('.slider').forEach");
const sliderEnd = source.indexOf('function resetKeys', sliderStart);
assert.ok(sliderStart >= 0 && sliderEnd > sliderStart, 'slider event wiring must exist');
const slider = source.slice(sliderStart, sliderEnd);

const inputStart = slider.indexOf("input.addEventListener('input'");
const inputEnd = slider.indexOf("input.addEventListener('change'", inputStart);
assert.ok(inputStart >= 0 && inputEnd > inputStart, 'input and change handlers must both exist');
const input = slider.slice(inputStart, inputEnd);
assert.match(input, /beginLocalPreview\(\)/, 'slider input must reveal the immediate local preview');
assert.doesNotMatch(input, /scheduleAuthoritativePreview\(\)/, 'slider input must not wait for an authoritative server render');
assert.match(slider.slice(inputEnd), /input\.addEventListener\('change',[\s\S]*?scheduleAuthoritativePreview\(\)/, 'slider release must request the authoritative parity render');

console.log('slider drag uses immediate local preview and renders authoritatively on release');
