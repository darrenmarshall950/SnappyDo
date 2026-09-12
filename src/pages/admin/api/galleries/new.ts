/**
 * Create a new gallery. POST /admin/api/galleries/new
 * Body (form-encoded): { title, slug, description?, template_id?, password? }
 * Protected by middleware.
 */
import type { APIRoute } from 'astro';
import { insertGallery } from '../../../../lib/db';
import { VALID_TEMPLATES, type GalleryTemplateId } from '../../../../lib/gallery-schemas';
import { hashPassword } from '../../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const title = String(form.get('title') || '').trim();
  const slug = String(form.get('slug') || '').trim().toLowerCase();
  const description = String(form.get('description') || '').trim();
  const templateId = String(form.get('template_id') || 'masonry');
  const password = String(form.get('password') || '');

  if (!title || !slug) {
    return redirect('/admin/galleries/new?error=missing-fields', 302);
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return redirect('/admin/galleries/new?error=invalid-slug', 302);
  }
  if (!VALID_TEMPLATES.includes(templateId as GalleryTemplateId)) {
    return redirect('/admin/galleries/new?error=invalid-template', 302);
  }

  let passwordHash: string | null = null;
  if (password) {
    passwordHash = await hashPassword(password);
  }

  try {
    const gallery = insertGallery({
      slug,
      title,
      description,
      template_id: templateId,
      password_hash: passwordHash,
    });
    return redirect(`/admin/galleries/${gallery.id}?saved=1`, 302);
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) {
      return redirect('/admin/galleries/new?error=slug-taken', 302);
    }
    return redirect('/admin/galleries/new?error=unknown', 302);
  }
};
