/**
 * API: /api/presets/[id]
 *
 * DELETE — remove one of the current admin's user presets by id.
 * Built-ins are protected (lib returns false); returns 204 on success,
 * 403 if the preset is a built-in, 404 if not found.
 */
import type { APIRoute } from 'astro';
import { readAdminSession } from '../../../lib/auth';
import { deleteUserPreset, getPresetById } from '../../../lib/presets';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized() { return json({ error: 'Unauthorized' }, 401); }
function notFound() { return json({ error: 'Preset not found' }, 404); }
function forbidden() { return json({ error: 'Cannot delete a built-in preset' }, 403); }

export const DELETE: APIRoute = async ({ request, params }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return json({ error: 'invalid id' }, 400);
  const row = getPresetById(id);
  if (!row) return notFound();
  if (row.kind !== 'user') return forbidden();
  const ok = deleteUserPreset(id, session.user);
  if (!ok) return notFound();
  return new Response(null, { status: 204 });
};
