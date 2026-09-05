// Health endpoint used by Docker HEALTHCHECK + load balancers
export const prerender = false;

export async function GET() {
  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'snappydo',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}
