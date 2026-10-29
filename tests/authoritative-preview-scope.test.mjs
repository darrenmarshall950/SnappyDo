import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');

// The authoritative-preview scheduler must live in the shared editor scope,
// NOT inside resetAllStateAndUi(). When nested, every call site outside that
// function throws "scheduleAuthoritativePreview is not defined" and the
// server-rendered preview never replaces the canvas image.
const resetIdx = source.indexOf('function resetAllStateAndUi');
assert.ok(resetIdx >= 0, 'resetAllStateAndUi must exist');
const resetBody = source.slice(resetIdx);
const resetEnd = resetBody.indexOf('\n      }\n');
const resetSlice = resetBody.slice(0, resetEnd > 0 ? resetEnd : 4000);

const defIdx = source.indexOf('function scheduleAuthoritativePreview');
assert.ok(defIdx >= 0, 'scheduleAuthoritativePreview must exist');
assert.ok(!resetSlice.includes('function scheduleAuthoritativePreview'),
  'scheduleAuthoritativePreview must not be nested inside resetAllStateAndUi');

// The timer and url state must also be declared at editor scope, otherwise
// the scheduler can never actually be reached.
const timerIdx = source.indexOf('let authoritativePreviewTimer');
assert.ok(timerIdx >= 0, 'authoritativePreviewTimer must exist');
assert.ok(timerIdx < resetIdx, 'authoritativePreviewTimer must be declared at editor scope');
const urlIdx = source.indexOf('let authoritativePreviewUrl');
assert.ok(urlIdx >= 0, 'authoritativePreviewUrl must exist');
assert.ok(urlIdx < resetIdx, 'authoritativePreviewUrl must be declared at editor scope');

// The scheduler must be declared BEFORE every call site can run.
const callIdx = source.indexOf('scheduleAuthoritativePreview()');
assert.ok(callIdx > 0, 'scheduleAuthoritativePreview must be called');
assert.ok(defIdx < callIdx || source.indexOf('function scheduleAuthoritativePreview', defIdx + 1) >= 0,
  'scheduleAuthoritativePreview must be declared before its first call site');

console.log('authoritative preview scheduler is reachable at editor scope');
