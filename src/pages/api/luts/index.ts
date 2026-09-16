/**
 * API: /api/luts
 *
 * GET    — list globally enabled LUTs (built-ins + uploaded, enabled=1)
 * POST   — upload a new .cube LUT (multipart: name + file). Admin auth.
 * DELETE — remove an uploaded LUT by id (built-ins cannot be removed). Admin auth.
 */
import type { APIRoute } from 'astro';
import { readAdminSession } from '../../../lib/auth';
import { ensureLutDir, LUT_UPLOAD_DIR, listAvailableLuts, uploadLut, deleteLut, parseCube, synthesizeLut, listTopLuts, getLutSynthParams, getLutById } from '../../../lib/luts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized() {
  return json({ error: 'Unauthorized' }, 401);
}

export const GET: APIRoute = async () => {
  const rows = listAvailableLuts().map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    builtin_key: r.builtin_key,
    size: r.size,
    enabled_global: r.enabled_global,
  }));
  return json({ luts: rows });
};

export const POST: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();

  const ct = request.headers.get('content-type') || '';
  if (!ct.startsWith('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data with name + file' }, 400);
  }

  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const file = form.get('file');
  if (!name) return json({ error: 'name is required' }, 400);
  if (!(file instanceof File)) return json({ error: 'file is required' }, 400);
  if (!file.name.toLowerCase().endsWith('.cube')) {
    return json({ error: 'File must be a .cube LUT' }, 400);
  }

  const text = await file.text();
  let parsed: { size: number; data: Uint8Array };
  try {
    parsed = parseCube(text);
  } catch (e: any) {
    return json({ error: 'Invalid .cube file: ' + e.message }, 400);
  }

  ensureLutDir();
  const uuid = randomBytes(8).toString('hex');
  const relPath = `luts/${uuid}.cube`;
  const absPath = join(LUT_UPLOAD_DIR, `${uuid}.cube`);
  writeFileSync(absPath, text, 'utf8');

  const row = uploadLut(name, relPath, session.user, parsed.size);
  return json({
    lut: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      builtin_key: row.builtin_key,
      size: row.size,
      enabled_global: row.enabled_global,
    },
  }, 201);
};

export const DELETE: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isFinite(id) || id <= 0) return json({ error: 'invalid id' }, 400);
  const ok = deleteLut(id);
  if (!ok) return json({ error: 'LUT not found or is a built-in' }, 400);
  return json({ ok: true });
};


/**
 * POST /api/luts/synth
 * Body: { name, params: {exposure, brightness, contrast, saturation, temp, tint}, base_lut_id?: number }
 * Synthesises a .cube file from slider ops applied to identity or base LUT.
 * Returns the new LUT row. Original base LUT is unchanged.
 */
