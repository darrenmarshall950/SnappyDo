/**
 * POST /api/luts/synth
 *
 * Synthesise a .cube LUT from slider ops applied to either an identity
 * grid (no base) or an existing LUT (base_lut_id). Original base LUT is
 * NEVER modified — this always creates a new row with parent_id pointing
 * at the base.
 *
 * Body: {
 *   name: string,
 *   params: { exposure?, brightness?, contrast?, saturation?, temp?, tint? },
 *   base_lut_id?: number | null,
 * }
 *
 * Returns: { lut: { id, name, kind, parent_id, synth_params, ... } }
 */
import type { APIRoute } from 'astro';
import { readAdminSession } from '../../../lib/auth';
import { synthesizeLut, getLutById, getLutSynthParams } from '../../../lib/luts';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function unauthorized() { return json({ error: 'Unauthorized' }, 401); }

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
  // Validate slider values
  for (const k of ['exposure', 'brightness', 'contrast', 'saturation', 'temp', 'tint']) {
    if (params[k] != null) {
      const v = Number(params[k]);
      if (!Number.isFinite(v)) return json({ error: `params.${k} must be a finite number` }, 400);
      // Clamp ranges silently — slider editor clamps too, this is defence in depth.
      const range: Record<string, [number, number]> = {
        exposure: [-200, 200], brightness: [-100, 100], contrast: [-100, 100],
        saturation: [-100, 100], temp: [-100, 100], tint: [-100, 100],
      };
      const [lo, hi] = range[k];
      params[k] = Math.max(lo, Math.min(hi, v));
    }
  }
  const baseLutId = body.base_lut_id != null ? Number(body.base_lut_id) : null;
  if (baseLutId !== null && (!Number.isFinite(baseLutId) || baseLutId <= 0)) {
    return json({ error: 'base_lut_id must be a positive integer or null' }, 400);
  }
  if (baseLutId !== null && !getLutById(baseLutId)) {
    return json({ error: 'base_lut_id not found' }, 400);
  }
  try {
    const row = synthesizeLut(name, params, baseLutId, session.user);
    return json({
      lut: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        parent_id: row.parent_id,
        synth_params: getLutSynthParams(row.id),
        enabled_global: row.enabled_global,
        size: row.size,
        created_at: row.created_at,
      },
    }, 201);
  } catch (e: any) {
    return json({ error: 'Synthesis failed: ' + (e?.message ?? String(e)) }, 500);
  }
};
