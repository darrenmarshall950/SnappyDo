import type { APIRoute } from 'astro';
import { join } from 'node:path';
import { getImage } from '../../../../lib/db';
import { readAdminSession } from '../../../../lib/auth';
import { renderWithSharp } from './edit';
export const prerender = false;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
export const POST: APIRoute = async ({ params, request }) => {
  if (!readAdminSession(request)) return new Response(JSON.stringify({error:'unauthorized'}), {status:401,headers:{'content-type':'application/json'}});
  const id=Number(params.id), img=getImage(id);
  if (!Number.isFinite(id)||!img) return new Response(JSON.stringify({error:'image not found'}), {status:404,headers:{'content-type':'application/json'}});
  let body:any; try { body=await request.json(); } catch { return new Response(JSON.stringify({error:'invalid JSON'}), {status:400,headers:{'content-type':'application/json'}}); }
  const recipeParams = body?.recipe?.params ?? body?.params;
  if (!recipeParams || typeof recipeParams !== 'object') return new Response(JSON.stringify({error:'params required'}), {status:400,headers:{'content-type':'application/json'}});
  try { const rendered=await renderWithSharp(join(UPLOAD_DIR,img.path), recipeParams); return new Response(rendered.buf, {status:200, headers:{'content-type':'image/jpeg','cache-control':'no-store','x-render-authority':'sharp'}}); }
  catch (e:any) { return new Response(JSON.stringify({error:'render failed: '+e.message}), {status:500,headers:{'content-type':'application/json'}}); }
};
