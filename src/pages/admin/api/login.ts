/**
 * Admin login — POST /admin/api/login
 *
 * Body (form-encoded or JSON): { username, password, next? }
 * On success: sets HttpOnly signed cookie, redirects to ?next= or /admin.
 * On failure: redirects back to /admin/login?error=invalid
 *
 * Rate-limited: 5 attempts per IP per 5 minutes.
 */
import type { APIRoute } from 'astro';
import {
  adminAuthConfigured,
  createAdminSessionCookie,
  rateLimit,
  verifyAdminCredentials,
} from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request, clientAddress, redirect }) => {
  // Rate limit by IP
  const ip = clientAddress || 'unknown';
  if (!rateLimit(`login:${ip}`, 5, 5 * 60 * 1000)) {
    return redirect('/admin/login?error=ratelimit', 302);
  }

  if (!adminAuthConfigured()) {
    return redirect('/admin/login?error=not-configured', 302);
  }

  // Parse body (form-encoded or JSON)
  let username = '';
  let password = '';
  let next = '/admin';
  const contentType = request.headers.get('content-type') || '';
  try {
    if (contentType.includes('application/json')) {
      const body = await request.json();
      username = String(body.username || '');
      password = String(body.password || '');
      next = String(body.next || '/admin');
    } else {
      const form = await request.formData();
      username = String(form.get('username') || '');
      password = String(form.get('password') || '');
      const n = form.get('next');
      if (typeof n === 'string' && n.startsWith('/')) next = n;
    }
  } catch {
    return redirect('/admin/login?error=invalid', 302);
  }

  if (!username || !password) {
    return redirect('/admin/login?error=invalid', 302);
  }

  const ok = await verifyAdminCredentials(username, password);
  if (!ok) {
    // Slight delay to slow brute force
    await new Promise((r) => setTimeout(r, 250));
    return redirect('/admin/login?error=invalid', 302);
  }

  const cookie = createAdminSessionCookie(request, username);
  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      'Set-Cookie': cookie,
    },
  });
};
