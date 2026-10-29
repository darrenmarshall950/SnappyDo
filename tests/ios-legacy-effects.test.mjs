import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
const iosAt = source.indexOf('const isIOS =');
const webglAt = source.indexOf("canvas.getContext('webgl2'");
assert.ok(iosAt >= 0 && webglAt >= 0 && iosAt < webglAt, 'iOS detection must happen before a rendering context is chosen');
assert.match(source, /const _gl2 = isIOS \? null : canvas\.getContext\('webgl2'/, 'iOS must choose the tested 2D preview path rather than the unstable WebGL effects path');
console.log('iOS editor chooses the stable 2D effects pipeline');
