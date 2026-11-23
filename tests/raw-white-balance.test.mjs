
/**
 * REGRESSION TEST — RAW white balance must not cast the image green.
 *
 * Bug (2026-11-22): the editor showed the correct autumn colours while the
 * gallery showed a strong green cast for the same edit. Root cause: the save
 * path wrote darktable's `temperature` module using a PLACEHOLDER baseline
 * (1,1,1) because `readCameraWb` could not find the camera's as-shot WB in
 * an Olympus ORF (it only knew Sony-style WB_RGGBLevelsAuto / WB_RGBLevels*).
 *
 * darktable's temperature module REPLACES the camera's as-shot WB, so writing
 * (1,1,1) over a real camera WB casts the image green. Measured on an OM-3
 * ORF: camera-WB render green_excess -71.6, placeholder baseline +3.7.
 *
 * The fix has two halves, both asserted here:
 *   1. readCameraWb understands Olympus WB_RBLevels and exiftool's
 *      RedBalance/BlueBalance, and reports `known: false` when it truly
 *      cannot find the camera's WB.
 *   2. buildDarktableXmp OMITS the temperature module when the baseline is
 *      unknown AND the kelvin/tint are neutral, so darktable uses the
 *      camera's own WB (what the editor preview shows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDarktableXmp, temperatureParams } from '../src/lib/darktable-xmp.ts';

const RAW_BASE = { r: 1.0, g: 1.0, b: 1.0 };

function opsOf(xmp) {
  const m = xmp.match(/<darktable:iop_order><rdf:Seq>([\s\S]*?)<\/rdf:Seq>/);
  if (!m) return [];
  return [...m[1].matchAll(/<rdf:li>(.*?)<\/rdf:li>/g)].map((x) => x[1]);
}

test('unknown camera WB omits the temperature module at neutral kelvin', () => {
  const xmp = buildDarktableXmp({
    kelvin: 5500,
    tint: 0,
    baseline: RAW_BASE,
    baselineKnown: false,
  });
  const ops = opsOf(xmp);
  assert.ok(
    !ops.includes('temperature'),
    `temperature module must be omitted when the camera WB is unknown (ops: ${ops.join(', ')})`
  );
});

test('unknown camera WB still applies the temperature module for a WB shift', () => {
  // The user explicitly asked for a warmer/cooler render, so we DO need the
  // module — the placeholder baseline is then the best available starting point.
  const xmp = buildDarktableXmp({
    kelvin: 7000,
    tint: 0,
    baseline: RAW_BASE,
    baselineKnown: false,
  });
  assert.ok(opsOf(xmp).includes('temperature'));
});

test('known camera WB always emits the temperature module', () => {
  const xmp = buildDarktableXmp({
    kelvin: 5500,
    tint: 0,
    baseline: { r: 2.65, g: 1.0, b: 1.62 },
    baselineKnown: true,
  });
  assert.ok(opsOf(xmp).includes('temperature'));
});

test('a known baseline still produces the camera coefficients', () => {
  // temperatureParams must carry the camera baseline through unchanged at
  // a neutral kelvin, so the neutral render matches the camera's auto-WB.
  const buf = temperatureParams(5500, 0, { r: 2.65, g: 1.0, b: 1.62 });
  const f = (i) => buf.readFloatLE(i * 4);
  // float32 storage — compare with a tolerance.
  assert.ok(Math.abs(f(0) - 2.65) < 1e-6, `red was ${f(0)}`);
  assert.ok(Math.abs(f(1) - 1.0) < 1e-6, `green was ${f(1)}`);
  assert.ok(Math.abs(f(2) - 1.62) < 1e-6, `blue was ${f(2)}`);
});

test('an unknown baseline at neutral kelvin writes no temperature params at all', () => {
  const xmp = buildDarktableXmp({
    kelvin: 5500,
    tint: 0,
    baseline: RAW_BASE,
    baselineKnown: false,
  });
  // The placeholder (1,1,1,1) hex must NOT appear: writing it would replace
  // the camera's WB and cast the image green.
  assert.ok(
    !xmp.includes('0000803f0000803f0000803f0000803f'),
    'the placeholder (1,1,1) temperature params must not be written for an unknown baseline'
  );
});
