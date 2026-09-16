/**
 * API: /api/presets
 *
 * GET    — list built-ins + the current admin's user presets.
 * POST   — save current editor params as a named user preset.
 * DELETE — remove one of the current admin's user presets by id.
 *
 * Scoping: user presets are scoped to the logged-in admin's username.
 * Built-ins are visible to everyone. A future multi-user build will swap
 * the session.user discriminator for a users.id FK — schema already supports it.
 */
import type { APIRoute } from 'astro';
import { readAdminSession } from '../../../lib/auth';
import { listAvailablePresets, saveUserPreset, deleteUserPreset, getPresetById, updateUserPreset } from '../../../lib/presets';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized() {
  return json({ error: 'Unauthorized' }, 401);
}

export const GET: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();
  const rows = listAvailablePresets(session.user);
  return json({
    presets: rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      builtin_key: r.builtin_key,
      username: r.username,
      params: safeParse(r.params_json),
      created_at: r.created_at,
    })),
  });
};

export const POST: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();

  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return json({ error: 'Expected application/json' }, 400);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON' }, 400);
  const name = String(body.name || '').trim();
  if (!name) return json({ error: 'name is required' }, 400);
  if (name.length > 60) return json({ error: 'name too long (max 60 chars)' }, 400);
  const params = body.params;
  if (!params || typeof params !== 'object') return json({ error: 'params object is required' }, 400);

  const row = saveUserPreset(name, params, session.user);
  return json({
    preset: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      username: row.username,
      params: safeParse(row.params_json),
      created_at: row.created_at,
    },
  }, 201);
};

export const DELETE: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isFinite(id) || id <= 0) return json({ error: 'invalid id' }, 400);
  const ok = deleteUserPreset(id, session.user);
  if (!ok) return json({ error: 'Preset not found or not yours' }, 400);
  return json({ ok: true });
};

/**
 * PATCH /api/presets?id=<id>
 * Body: { name?: string, params?: Record<string, any> }
 * Either or both fields may be supplied. Built-ins are read-only.
 */
export const PATCH: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isFinite(id) || id <= 0) return json({ error: 'invalid id' }, 400);

  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return json({ error: 'Expected application/json' }, 400);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON' }, 400);

  const patch: { name?: string; params?: Record<string, any> } = {};
  if (body.name !== undefined) patch.name = String(body.name).trim();
  if (body.params !== undefined) {
    if (typeof body.params !== 'object' || body.params === null) {
      return json({ error: 'params must be an object' }, 400);
    }
    patch.params = body.params as Record<string, any>;
  }
  if (patch.name !== undefined && !patch.name) {
    return json({ error: 'name cannot be empty' }, 400);
  }
  if (patch.name !== undefined && patch.name.length > 60) {
    return json({ error: 'name too long (max 60 chars)' }, 400);
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: 'no fields to update' }, 400);
  }

  const row = updateUserPreset(id, patch, session.user);
  if (!row) return json({ error: 'Preset not found, builtin, or not yours' }, 400);
  return json({
    preset: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      username: row.username,
      params: safeParse(row.params_json),
      created_at: row.created_at,
    },
  });
};

function safeParse(json: string): any {
  try { return JSON.parse(json); } catch { return {}; }
}
