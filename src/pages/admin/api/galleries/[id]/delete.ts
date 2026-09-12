/**
 * Delete a gallery and all its photos. POST /admin/api/galleries/:id/delete
 * Protected by middleware. Cascades to images (DB FK) and uploads (file removal).
 */
import type { APIRoute } from 'astro';
import { deleteGallery } from '../../../../../lib/db';

export const prerender = false;

export const POST: APIRoute = async ({ params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) return redirect('/admin', 302);
  const ok = deleteGallery(id);
  return redirect(ok ? '/admin' : '/admin?error=delete-failed', 302);
};
