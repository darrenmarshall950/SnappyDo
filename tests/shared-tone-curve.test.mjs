import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDir = mkdtempSync(join(tmpdir(), 'snappydo-curve-'));
const bundle = join(tempDir, 'curve.cjs');
try {
  execFileSync('./node_modules/.bin/esbuild', [
    'src/lib/curve.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`,
  ], { stdio: 'inherit' });
  const curve = await import(pathToFileURL(bundle).href);

  assert.equal(typeof curve.applyToneCurveToRgba, 'function',
    'curve.ts must export a shared RGBA tone-curve applier used by BOTH the browser preview and the server export');

  // Master RGB curve (mirrored into r/g/b by the editor) must be applied
  // exactly ONCE. Applying the master curve and then the per-channel curve
  // again double-grades the pixel and makes the preview disagree with export.
  const rgbCurve = { rgb: [[0, 0], [128, 64], [255, 255]], r: [[0, 0], [128, 64], [255, 255]], g: [[0, 0], [128, 64], [255, 255]], b: [[0, 0], [128, 64], [255, 255]] };
  const data = new Uint8ClampedArray([128, 128, 128, 255]);
  curve.applyToneCurveToRgba(data, rgbCurve);
  const expected = Math.round(curve.buildLut(rgbCurve.rgb)[128] * 255);
  assert.equal(data[0], expected,
    `master rgb curve must be applied once (expected ${expected}, got ${data[0]})`);
  assert.equal(data[0], 64, 'a midtone lifted to 64 must land exactly on 64, not be graded twice');

  // Per-channel curves are used when the master curve is identity.
  const perChannel = {
    rgb: [[0, 0], [255, 255]],
    r: [[0, 0], [255, 255]],
    g: [[0, 255], [255, 0]],
    b: [[0, 0], [255, 255]],
  };
  const d2 = new Uint8ClampedArray([128, 128, 128, 255]);
  curve.applyToneCurveToRgba(d2, perChannel);
  assert.equal(d2[0], 128, 'red channel must stay unaltered when only green is curved');
  assert.equal(d2[1], 127, 'green channel must follow its own inverted curve');
  assert.equal(d2[2], 128, 'blue channel must stay unaltered when only green is curved');

  // Identity curve must be a no-op.
  const d3 = new Uint8ClampedArray([10, 20, 30, 255]);
  curve.applyToneCurveToRgba(d3, { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] });
  assert.deepEqual([...d3], [10, 20, 30, 255], 'identity curve must not change pixels');

  console.log('tone curve application is shared and applied exactly once');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
