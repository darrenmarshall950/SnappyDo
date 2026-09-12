/**
 * Update an existing gallery. POST /admin/api/galleries/:id
 * Body (form-encoded): { title, slug, description, template_id, password?, remove_password? }
 * Protected by middleware.
 */
import type { APIRoute } from 'astro';
import { getGalleryById, updateGallery } from '../../../../lib/db';
import { VALID_TEMPLATES, type GalleryTemplateId } from '../../../../lib/gallery-schemas';
import { hashPassword } from '../../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, redirect }) => {
  const id = Number(params.id);
  const g = Number.isFinite(id) ? getGalleryById(id) : undefined;
  if (!g) return redirect('/admin', 302);

  const form = await request.formData();
  const title = String(form.get('title') || '').trim();
  const slug = String(form.get('slug') || '').trim().toLowerCase();
  const description = String(form.get('description') || '').trim();
  const templateId = String(form.get('template_id') || g.template_id);
  const password = String(form.get('password') || '');
  const removePassword = form.get('remove_password') === '1';

  if (!title || !slug) return redirect(`/admin/galleries/${id}?error=missing-fields`, 302);
  if (!/^[a-z0-9-]+$/.test(slug)) return redirect(`/admin/galleries/${id}?error=invalid-slug`, 302);
  if (!VALID_TEMPLATES.includes(templateId as GalleryTemplateId)) {
    return redirect(`/admin/galleries/${id}?error=invalid-template`, 302);
  }

  let passwordHash: string | null | undefined = undefined;
  if (removePassword) {
    passwordHash = null;
  } else if (password) {
    passwordHash = await hashPassword(password);
  } else {
    passwordHash = g.password_hash; // keep existing
  }

  try {
    updateGallery(id, {
      title,
      slug,
      description,
      template_id: templateId,
      password_hash: passwordHash,
    });
    return redirect(`/admin/galleries/${id}?saved=1`, 302);
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) {
      return redirect(`/admin/galleries/${id}?error=slug-taken`, 302);
    }
    return redirect(`/admin/galleries/${id}?error=unknown`, 302);
  }
};
