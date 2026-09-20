import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/editor-gl.ts', import.meta.url), 'utf8');
const sharpenBlock = source.match(/if \(lastState\.sharpen > 0[\s\S]*?\n    } else \{/);
assert.ok(sharpenBlock, 'render() must contain the sharpen pass');
const block = sharpenBlock[0];

assert.match(block, /const sw = canvasRef\.width;/,
  'sharpen must use the display canvas width that matches its render targets');
assert.match(block, /const sh = canvasRef\.height;/,
  'sharpen must use the display canvas height that matches its render targets');
assert.doesNotMatch(block, /}, sharpenFbo[AB], sourceW, sourceH\);/,
  'a canvas-sized sharpen target must not be rendered using source dimensions');
assert.match(block, /}, sharpenFboA, sw, sh\);/,
  'horizontal blur and unsharp pass must use the target texture viewport');
assert.match(block, /}, sharpenFboB, sw, sh\);/,
  'vertical blur must use the target texture viewport');

console.log('sharpen viewport dimensions match the target texture');
