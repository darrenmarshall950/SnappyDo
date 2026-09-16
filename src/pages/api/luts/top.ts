/**
 * GET /api/luts/top?n=10
 *
 * Top N LUTs by usage count from image_edits.params_json. Built-ins
 * always appear even if unused.
 */
import type { APIRoute } from 'astro';
import { readAdminSession } from '../../../lib/auth';
import { listTopLuts, getLutSynthParams } from '../../../lib/luts';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function unauthorized() { return json({ error: 'Unauthorized' }, 401); }

export const GET: APIRoute = async ({ request }) => {
  const session = readAdminSession(request);
  if (!session) return unauthorized();
  const n = Math.max(1, Math.min(50, Number(new URL(request.url).searchParams.get('n')) || 10));
  const rows = listTopLuts(n).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    builtin_key: r.builtin_key,
    enabled_global: r.enabled_global,
    use_count: r.use_count,
    parent_id: r.parent_id,
    synth_params: getLutSynthParams(r.id),
  }));
  return json({ luts: rows });
};
