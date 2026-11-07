import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('../src/pages/api/images/[id]/export.ts', import.meta.url), 'utf8');

// ---- The export endpoint exists and is admin-only -------------------------
assert.match(route, /export const GET: APIRoute/, 'export route must expose GET (saved edit)');
assert.match(route, /export const POST: APIRoute/, 'export route must expose POST (live recipe)');
assert.match(
  route,
  /if \(!readAdminSession\(request\)\) return unauthorized\(\);/,
  'export must require an admin session',
);
assert.match(route, /status:\s*401/, 'unauthenticated export requests must be rejected with 401');

// ---- It renders through the same path as Save -----------------------------
assert.match(
  route,
  /import \{ renderWithSharp \} from '\.\/edit';/,
  'export must reuse the save render path so the download matches the editor',
);
assert.match(
  route,
  /body\?\.recipe\?\.params\s*\?\?\s*body\?\.params/,
  'export must accept the versioned recipe and legacy params',
);

// ---- The response is a file download -------------------------------------
assert.match(
  route,
  /content-disposition['"]:\s*`attachment; filename=/,
  'export must return an attachment, not an inline image',
);
assert.match(route, /'content-type':\s*'image\/jpeg'/, 'export must return a JPEG');
assert.match(route, /-edited\.jpg/, 'export filename must be marked as edited');

// ---- RAW files export at native resolution --------------------------------
assert.match(
  route,
  /raw_path/,
  'export must handle RAW originals',
);
assert.doesNotMatch(
  route.match(/const execFile[\s\S]*?\n}\n/)?.[0] ?? '',
  /--width/,
  'the RAW export render must not be width-limited (it should be native resolution)',
);

// ---- The editor exposes a Download button -------------------------------
const editorPage = readFileSync(new URL('../src/pages/admin/edit/[id].astro', import.meta.url), 'utf8');
assert.match(editorPage, /id="btn-download"/, 'editor page must have a Download button');
assert.match(editorPage, /originalName:\s*img\.original_name/, 'editor page must pass the original name for the download filename');

const editor = readFileSync(new URL('../src/lib/editor.ts', import.meta.url), 'utf8');
assert.match(
  editor,
  /const btnDownload = document\.getElementById\('btn-download'\);/,
  'editor script must bind the Download button',
);
assert.match(
  editor,
  /btnDownload\.onclick = async \(\) => \{/,
  'editor script must handle the Download click',
);
assert.match(
  editor,
  /fetch\('\/api\/images\/' \+ imageId \+ '\/export',\s*\{\s*method:\s*'POST'/,
  'the download must POST the live recipe to the export endpoint',
);
assert.match(
  editor,
  /body:\s*JSON\.stringify\(\{\s*recipe\s*\}\)/,
  'the download must send the serialized render recipe',
);
assert.match(
  editor,
  /a\.download = filename;/,
  'the download must be saved to a file',
);

// ---- The gallery grid can download the saved edit ------------------------
const gallery = readFileSync(new URL('../src/pages/admin/galleries/[id].astro', import.meta.url), 'utf8');
assert.match(
  gallery,
  /href=\{`\/api\/images\/\$\{image\.id\}\/export`\}/,
  'the gallery grid must link edited photos to the export endpoint',
);

console.log('edited photos can be downloaded from the editor and the gallery grid');
