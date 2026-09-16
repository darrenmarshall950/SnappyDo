/**
 * GET /api/presets/top?n=10
 *
 * Top N presets — for now alphabetical since presets aren't tracked in
 * image_edits. Will hook up usage tracking when preset_id gets stored.
 */
import type { APIRoute } from 'astro';
import { readAdminSession } from '../../../lib/auth';
import { listTopPresets } from '../../../lib/presets';

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
  const rows = listTopPresets(session.user, n).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    builtin_key: r.builtin_key,
  }));
  return json({ presets: rows });
};
