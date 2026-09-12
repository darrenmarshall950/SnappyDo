/**
 * Astro middleware — runs on every request.
 *
 * Responsibilities:
 *   1. Gate /admin/* routes (except /admin/login): redirect to login if no session.
 *   2. Attach admin session to context.locals so pages can read it.
 *
 * Per-gallery password gating is handled in /g/[slug].astro itself
 * (we need the gallery row to check its password_hash; middleware
 * can't easily hit the DB without forcing it to load on every request).
 */
import { defineMiddleware } from 'astro:middleware';
import { readAdminSession } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url, locals, redirect } = context;
  locals.admin = null;

  const isAdminRoute = url.pathname.startsWith('/admin');
  const isAdminLogin = url.pathname === '/admin/login';
  const isAdminApi = url.pathname.startsWith('/admin/api/');

  // Allow admin login page + admin login POST without session
  if (isAdminRoute && !isAdminApi) {
    if (!isAdminLogin) {
      const session = readAdminSession(request);
      if (!session) {
        return redirect(`/admin/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
      }
      locals.admin = session;
    } else {
      // Already logged in? Skip the login page.
      const session = readAdminSession(request);
      if (session) {
        return redirect('/admin', 302);
      }
    }
  } else if (isAdminApi) {
    // Login + logout APIs are public — no session required
    const isPublicApi = ['/admin/api/login', '/admin/api/logout'].includes(url.pathname);
    if (!isPublicApi) {
      const session = readAdminSession(request);
      if (!session) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      locals.admin = session;
    }
  } else {
    // Non-admin requests — still expose admin state so the header can show login link
    const session = readAdminSession(request);
    if (session) locals.admin = session;
  }

  return next();
});
