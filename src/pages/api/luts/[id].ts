/**
 * API: /api/luts/[id] — returns the parsed LUT data for client-side
 * application during live preview.
 *
 * Response: { id, name, size, data: number[] } where data is the
 * RGB bytes in size³ order (index = ((b*size + g)*size + r) * 3).
 */
import type { APIRoute } from 'astro';
import { getLutById, getLutData } from '../../../lib/luts';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return json({ error: 'invalid id' }, 400);
  const row = getLutById(id);
  if (!row) return json({ error: 'LUT not found' }, 404);
  if (!row.enabled_global) return json({ error: 'LUT is disabled' }, 404);

  const { size, data } = getLutData(row);
  // Send as JSON array of numbers; client reconstructs Uint8Array.
  // For a 33³ LUT this is ~100 KB — acceptable for the first preview fetch.
  return json({
    id: row.id,
    name: row.name,
    size,
    data: Array.from(data),
  });
};
