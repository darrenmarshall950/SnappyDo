/**
 * Admin endpoint: save the chosen template + config patch for a gallery.
 *
 *   POST /api/galleries/:id/template
 *   Body: { template: 'framed', frame: 'gallery' }
 *
 * Persists to the gallery's template_id and merges config into
 * template_config_json. Returns the updated gallery row.
 *
 * For v0.4 this is unprotected (local-only access). When public access is
 * enabled, gate behind session auth.
 */
import type { APIRoute } from 'astro';
import { getGalleryById, updateGalleryTemplate } from '../../../../lib/db';
import { VALID_TEMPLATES, type GalleryTemplateId } from '../../../../lib/gallery-schemas';

export const prerender = false;

const VALID_FRAMES = ['none', 'matte', 'gallery', 'polaroid'];

export const POST: APIRoute = async ({ params, request }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return new Response(JSON.stringify({ error: 'Bad gallery id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!getGalleryById(id)) {
    return new Response(JSON.stringify({ error: 'Gallery not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { template?: string; frame?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const template = body.template as GalleryTemplateId | undefined;
  if (!template || !VALID_TEMPLATES.includes(template)) {
    return new Response(JSON.stringify({ error: `Invalid template: ${body.template}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const configPatch: Record<string, any> = {};
  if (body.frame) {
    if (!VALID_FRAMES.includes(body.frame)) {
      return new Response(JSON.stringify({ error: `Invalid frame: ${body.frame}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    configPatch.frame = body.frame;
  }

  const updated = updateGalleryTemplate(id, template, configPatch);
  return new Response(JSON.stringify({
    ok: true,
    gallery: {
      id: updated!.id,
      slug: updated!.slug,
      template_id: updated!.template_id,
      template_config_json: updated!.template_config_json,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
