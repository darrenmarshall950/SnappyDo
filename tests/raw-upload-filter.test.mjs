// Regression test: the upload page must accept RAW camera files (Panasonic
// .rw2, Olympus .orf, etc.) in its frontend filter.
//
// Bug history: the filter was `f.type.startsWith('image/')`, but browsers
// report RAW files with `type === ''` (or sometimes
// 'application/octet-stream') because the OS doesn't assign a real MIME.
// Result: the user dropped .rw2 files into the upload box, the filter
// silently dropped them, and they saw "no images to upload" even though
// the server already supports RAW via darktable-cli.
//
// Fix: include `isRawFile(f)` (the existing helper that mirrors the
// server-side RAW_EXTENSIONS set) in the filter, and extend the file
// picker's `accept` attribute so RAW extensions are visible in the
// system dialog.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pages/upload.astro', import.meta.url), 'utf8');

// 1. The file input accept attribute must include the RAW extensions.
assert.match(source,
  /accept="image\/\*,\.rw2,\.orf,\.dng,\.cr2,\.cr3,\.nef,\.nrw,\.arw,\.srf,\.sr2,\.raf,\.pef,\.3fr,\.iiq,\.x3f,\.mrw,\.rwl"/,
  'file input accept attribute must list every RAW extension the server accepts');

// 2. The main filter must accept RAW files even when their MIME type is empty.
assert.match(source,
  /f\.type\.startsWith\(['"]image\/['"]\)\s*\|\|\s*isRawFile\(f\)/,
  'main filter must accept files whose type is empty but extension is a known RAW');

// 3. The isRawFile helper must still be defined locally so we don't depend on
//    the server's RAW_EXTENSIONS being exported.
assert.match(source,
  /function\s+isRawFile\s*\(\s*f\s*\)\s*\{[\s\S]{0,500}rw2/,
  'isRawFile helper must still exist and list rw2 (Panasonic Lumix)');

// 4. The helper must cover all the RAW formats the server supports (rw2,
//    orf, dng, cr2, cr3, nef, nrw, arw, srf, sr2, raf, pef, 3fr, iiq, x3f,
//    mrw, rwl). Missing one would mean a user with that camera silently
//    gets dropped again.
const helperMatch = source.match(/function\s+isRawFile\s*\(\s*f\s*\)\s*\{([\s\S]*?)\n\s{12}\}/);
assert.ok(helperMatch, 'isRawFile body must be findable');
const helperBody = helperMatch[1];
const requiredExts = [
  'rw2', 'orf', 'dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw',
  'srf', 'sr2', 'raf', 'pef', '3fr', 'iiq', 'x3f', 'mrw', 'rwl',
];
for (const ext of requiredExts) {
  assert.ok(
    new RegExp(`['"]${ext}['"]`).test(helperBody),
    `isRawFile must recognise .${ext} (RAW extension list)`,
  );
}

console.log('upload filter accepts RAW camera files');
