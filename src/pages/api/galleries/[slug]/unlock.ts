/**
 * Verify a gallery password and set the unlock cookie.
 * POST /api/galleries/:slug/unlock
 * Body (form-encoded): { password }
 * On success: sets HttpOnly signed cookie, redirects back to /g/:slug.
 * On failure: redirects back with ?error=invalid-password.
 *
 * Rate-limited: 5 attempts per IP per 5 minutes.
 */
import type { APIRoute } from 'astro';
import { getGalleryBySlug } from '../../../../lib/db';
import {
  createGalleryUnlockCookie,
  rateLimit,
  verifyPassword,
} from '../../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, clientAddress, redirect }) => {
  const slug = String(params.slug || '');
  const g = getGalleryBySlug(slug);
  if (!g) return redirect('/', 302);

  const ip = clientAddress || 'unknown';
  if (!rateLimit(`unlock:${ip}:${g.id}`, 5, 5 * 60 * 1000)) {
    return redirect(`/g/${slug}?error=ratelimit`, 302);
  }

  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!g.password_hash) {
    // Gallery is public — set cookie anyway so subsequent visits are quick
    const cookie = createGalleryUnlockCookie(request, g.id);
    return new Response(null, {
      status: 302,
      headers: { Location: `/g/${slug}`, 'Set-Cookie': cookie },
    });
  }

  const ok = await verifyPassword(password, g.password_hash);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 250));
    return redirect(`/g/${slug}?error=invalid-password`, 302);
  }

  const cookie = createGalleryUnlockCookie(request, g.id);
  return new Response(null, {
    status: 302,
    headers: { Location: `/g/${slug}`, 'Set-Cookie': cookie },
  });
};
