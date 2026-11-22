// Regression: RAW batches must never fan out into the JPEG queue.
// An 8-file RAW batch combined with three parallel requests launched up to 24
// darktable-cli renders simultaneously, causing slow uploads and 504s.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/upload.astro', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/pages/api/upload.ts', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

assert.match(
  page,
  /const\s+RAW_BATCH_SIZE\s*=\s*1\s*;/,
  'RAW uploads must be sent one file per request',
);
assert.match(
  page,
  /const\s+RAW_BATCH_CONCURRENCY\s*=\s*1\s*;/,
  'only one RAW request may render at a time',
);
assert.match(
  page,
  /const\s+rawChunks\s*=\s*chunk\(rawFiles,\s*RAW_BATCH_SIZE\)/,
  'RAW files must be split using the dedicated RAW batch size',
);
assert.match(
  page,
  /runParallel\(rawTasks,\s*RAW_BATCH_CONCURRENCY,/,
  'RAW queue must use dedicated single-worker concurrency',
);

const pipelineStart = api.indexOf('const writeCompleted = pipelineAsync(file, out)');
const pipelineAwait = api.indexOf('await writeCompleted');
const rawMove = api.indexOf('await rename(fullPath, join(UPLOAD_DIR, rawPath))');
assert.ok(pipelineStart >= 0, 'the upload write must be represented by a promise');
assert.ok(pipelineAwait > pipelineStart, 'file processing must await the write promise');
assert.ok(pipelineAwait < rawMove, 'the RAW must not move or render before its write has flushed');

assert.match(
  dockerfile,
  /deb\s+http:\/\/deb\.debian\.org\/debian\s+unstable\s+main/,
  'the runtime must install a darktable build recent enough to recognise OM-3 RAW files',
);
assert.match(
  dockerfile,
  /apt-get install -y --no-install-recommends[\s\S]{0,600}darktable/,
  'the runtime must install darktable',
);

console.log('RAW uploads are serialised, wait for disk flush, and use current camera support');
