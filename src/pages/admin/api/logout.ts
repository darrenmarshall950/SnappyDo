/**
 * Admin logout — POST /admin/api/logout
 * Clears the admin session cookie and redirects to /admin/login.
 */
import type { APIRoute } from 'astro';
import { clearAdminSessionCookie } from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const cookie = clearAdminSessionCookie(request);
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/admin/login',
      'Set-Cookie': cookie,
    },
  });
};

// Allow GET as a convenience (clickable logout link)
export const GET: APIRoute = async (ctx) => POST(ctx);
