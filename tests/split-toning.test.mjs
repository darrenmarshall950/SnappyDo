import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDir = mkdtempSync(join(tmpdir(), 'snappydo-effects-'));
const bundle = join(tempDir, 'effects.cjs');
try {
  execFileSync('./node_modules/.bin/esbuild', [
    'src/lib/effects.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`,
  ], { stdio: 'inherit' });
  const { applySplitToningToRgb } = await import(pathToFileURL(bundle).href);
  const result = applySplitToningToRgb(80, 70, 60, {
    shadows_hue: 306.51,
    shadows_saturation: 96.21,
    highlights_hue: 91.77,
    highlights_saturation: 24.69,
    balance: 0,
  });

  assert.ok(result.some((channel) => channel < 245),
    `split toning must preserve image detail rather than clip a normal pixel to white: ${result}`);
  assert.ok(result.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255));
  console.log('split toning preserves non-white image detail');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
